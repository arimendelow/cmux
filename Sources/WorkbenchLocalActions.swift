import CryptoKit
import CmuxControlSocket
import Foundation

enum WorkbenchLocalActionKind: String, Codable {
    case focus
    case flagForReview = "flag_for_review"
}

enum WorkbenchLocalActionStatus: String, Codable {
    case pending
    case completed
    case failed
}

struct WorkbenchLocalActionReceipt: Codable, Equatable {
    var requestId: String
    var fingerprint: String
    var action: WorkbenchLocalActionKind
    var workspaceId: UUID
    var surfaceId: UUID?
    var createdAt: Date
    var status: WorkbenchLocalActionStatus
    var resultCode: String?
    var notificationId: UUID?
}

@MainActor
enum WorkbenchLocalActionRouter {
    typealias FocusEffect = @MainActor (_ workspaceId: UUID, _ surfaceId: UUID) -> Bool
    typealias FlagEffect = @MainActor (_ requestId: String, _ workspaceId: UUID, _ surfaceId: UUID?, _ summary: String) -> UUID?

    static let receiptDefaultsKey = "workbench.local-actions.v1"
    private static let requestIdPattern = #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"#
    private static let receiptLimit = 256

    static func focus(
        params: [String: Any],
        defaults: UserDefaults = .standard,
        enabled: Bool = OuroWorkbenchProduct.isCurrentBundle,
        effect: FocusEffect? = nil
    ) -> TerminalController.V2CallResult {
        guard enabled else {
            return .err(code: "unsupported", message: "Workbench actions are unavailable outside Ouro Workbench", data: nil)
        }
        guard hasOnlyKeys(params, allowed: ["request_id", "workspace_id", "surface_id"]),
              let requestId = requestId(params["request_id"]),
              let workspaceId = uuid(params["workspace_id"]),
              let surfaceId = uuid(params["surface_id"]) else {
            return .err(code: "invalid_params", message: "focus requires request_id, workspace_id, and surface_id", data: nil)
        }
        return execute(
            action: .focus,
            requestId: requestId,
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            summary: nil,
            defaults: defaults
        ) {
            let succeeded = (effect ?? liveFocus)(workspaceId, surfaceId)
            return (succeeded, succeeded ? "focused" : "target_unavailable", nil)
        }
    }

    static func flagForReview(
        params: [String: Any],
        defaults: UserDefaults = .standard,
        enabled: Bool = OuroWorkbenchProduct.isCurrentBundle,
        effect: FlagEffect? = nil
    ) -> TerminalController.V2CallResult {
        guard enabled else {
            return .err(code: "unsupported", message: "Workbench actions are unavailable outside Ouro Workbench", data: nil)
        }
        guard hasOnlyKeys(params, allowed: ["request_id", "workspace_id", "surface_id", "summary"]),
              let requestId = requestId(params["request_id"]),
              let workspaceId = uuid(params["workspace_id"]),
              let summary = boundedSummary(params["summary"]) else {
            return .err(code: "invalid_params", message: "flag_for_review requires request_id, workspace_id, and a summary of at most 500 characters", data: nil)
        }
        let surfaceId: UUID?
        if params["surface_id"] == nil || params["surface_id"] is NSNull {
            surfaceId = nil
        } else if let parsed = uuid(params["surface_id"]) {
            surfaceId = parsed
        } else {
            return .err(code: "invalid_params", message: "surface_id must be a UUID when supplied", data: nil)
        }
        return execute(
            action: .flagForReview,
            requestId: requestId,
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            summary: summary,
            defaults: defaults
        ) {
            let notificationId = (effect ?? liveFlagForReview)(requestId, workspaceId, surfaceId, summary)
            return (notificationId != nil, notificationId == nil ? "target_unavailable" : "flagged", notificationId)
        }
    }

    private static func execute(
        action: WorkbenchLocalActionKind,
        requestId: String,
        workspaceId: UUID,
        surfaceId: UUID?,
        summary: String?,
        defaults: UserDefaults,
        effect: () -> (succeeded: Bool, resultCode: String, notificationId: UUID?)
    ) -> TerminalController.V2CallResult {
        guard var receipts = loadReceipts(defaults: defaults) else {
            return .err(code: "receipt_store_unavailable", message: "Workbench action receipts are unreadable", data: nil)
        }
        let fingerprint = fingerprint(
            action: action,
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            summary: summary
        )
        if let existing = receipts.first(where: { $0.requestId == requestId }) {
            guard existing.fingerprint == fingerprint else {
                return .err(code: "request_conflict", message: "request_id was already used for a different action", data: response(existing, replayed: true))
            }
            return result(existing, replayed: true)
        }

        let createdAt = Date()
        var receipt = WorkbenchLocalActionReceipt(
            requestId: requestId,
            fingerprint: fingerprint,
            action: action,
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            createdAt: createdAt,
            status: .pending,
            resultCode: nil,
            notificationId: nil
        )
        receipts.append(receipt)
        trim(&receipts)
        guard saveReceipts(receipts, defaults: defaults) else {
            return .err(code: "receipt_store_unavailable", message: "Workbench could not persist the action before execution", data: nil)
        }

        let outcome = effect()
        receipt.status = outcome.succeeded ? .completed : .failed
        receipt.resultCode = outcome.resultCode
        receipt.notificationId = outcome.notificationId
        receipts[receipts.index(before: receipts.endIndex)] = receipt
        guard saveReceipts(receipts, defaults: defaults) else {
            return .err(code: "action_outcome_unknown", message: "The action ran but its final receipt could not be persisted", data: response(receipt, replayed: false))
        }
        return result(receipt, replayed: false)
    }

    private static func result(
        _ receipt: WorkbenchLocalActionReceipt,
        replayed: Bool
    ) -> TerminalController.V2CallResult {
        switch receipt.status {
        case .completed:
            return .ok(response(receipt, replayed: replayed))
        case .failed:
            return .err(code: "action_failed", message: "Workbench could not complete the action", data: response(receipt, replayed: replayed))
        case .pending:
            return .err(code: "action_outcome_unknown", message: "A previous action with this request_id did not reach a durable outcome", data: response(receipt, replayed: replayed))
        }
    }

    private static func response(
        _ receipt: WorkbenchLocalActionReceipt,
        replayed: Bool
    ) -> [String: Any] {
        [
            "request_id": receipt.requestId,
            "action": receipt.action.rawValue,
            "workspace_id": receipt.workspaceId.uuidString,
            "surface_id": receipt.surfaceId?.uuidString ?? NSNull(),
            "status": receipt.status.rawValue,
            "result_code": receipt.resultCode ?? NSNull(),
            "notification_id": receipt.notificationId?.uuidString ?? NSNull(),
            "replayed": replayed,
        ]
    }

    private static func requestId(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.range(of: requestIdPattern, options: .regularExpression) != nil else { return nil }
        return trimmed
    }

    private static func hasOnlyKeys(_ params: [String: Any], allowed: Set<String>) -> Bool {
        params.keys.allSatisfy(allowed.contains)
    }

    private static func uuid(_ value: Any?) -> UUID? {
        guard let raw = value as? String else { return nil }
        return UUID(uuidString: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func boundedSummary(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 500 else { return nil }
        return trimmed
    }

    private static func fingerprint(
        action: WorkbenchLocalActionKind,
        workspaceId: UUID,
        surfaceId: UUID?,
        summary: String?
    ) -> String {
        let payload = [
            action.rawValue,
            workspaceId.uuidString,
            surfaceId?.uuidString ?? "",
            summary ?? "",
        ].joined(separator: "\u{0}")
        return SHA256.hash(data: Data(payload.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func loadReceipts(defaults: UserDefaults) -> [WorkbenchLocalActionReceipt]? {
        guard let data = defaults.data(forKey: receiptDefaultsKey) else { return [] }
        return try? JSONDecoder().decode([WorkbenchLocalActionReceipt].self, from: data)
    }

    private static func saveReceipts(
        _ receipts: [WorkbenchLocalActionReceipt],
        defaults: UserDefaults
    ) -> Bool {
        guard let data = try? JSONEncoder().encode(receipts) else { return false }
        defaults.set(data, forKey: receiptDefaultsKey)
        return true
    }

    private static func trim(_ receipts: inout [WorkbenchLocalActionReceipt]) {
        while receipts.count > receiptLimit,
              let terminal = receipts.firstIndex(where: { $0.status != .pending }) {
            receipts.remove(at: terminal)
        }
    }

    private static func liveFocus(workspaceId: UUID, surfaceId: UUID) -> Bool {
        let routing = ControlRoutingSelectors(
            hasWindowIDParam: false,
            windowID: nil,
            groupID: nil,
            workspaceID: workspaceId,
            surfaceID: surfaceId,
            paneID: nil
        )
        guard case .resolved = TerminalController.shared.controlSelectWorkspace(
            routing: routing,
            workspaceID: workspaceId
        ), case let .focused(_, resolvedWorkspaceId, resolvedSurfaceId) = TerminalController.shared.controlSurfaceFocus(
            routing: routing,
            surfaceID: surfaceId
        ) else {
            return false
        }
        _ = TerminalController.shared.controlSurfaceTriggerFlash(
            routing: routing,
            surfaceID: resolvedSurfaceId
        )
        return resolvedWorkspaceId == workspaceId && resolvedSurfaceId == surfaceId
    }

    private static func liveFlagForReview(
        requestId: String,
        workspaceId: UUID,
        surfaceId: UUID?,
        summary: String
    ) -> UUID? {
        guard let manager = AppDelegate.shared?.tabManagerFor(tabId: workspaceId),
              let workspace = manager.tabs.first(where: { $0.id == workspaceId }),
              surfaceId.map({ workspace.panels[$0] != nil }) ?? true else {
            return nil
        }
        let store = TerminalNotificationStore.shared
        let correlationKey = "workbench-action:\(requestId)"
        if let existing = store.notifications.first(where: { $0.correlationKey == correlationKey }) {
            return existing.id
        }
        store.addNotification(
            tabId: workspaceId,
            surfaceId: surfaceId,
            title: OuroWorkbenchProduct.agentChatSurfaceTitle(),
            subtitle: "",
            body: summary,
            cooldownKey: correlationKey,
            cooldownInterval: .greatestFiniteMagnitude,
            resolvedHooks: []
        )
        return store.notifications.first(where: { $0.correlationKey == correlationKey })?.id
    }
}

extension TerminalController {
    func v2WorkbenchFocus(params: [String: Any]) -> V2CallResult {
        WorkbenchLocalActionRouter.focus(params: params)
    }

    func v2WorkbenchFlagForReview(params: [String: Any]) -> V2CallResult {
        WorkbenchLocalActionRouter.flagForReview(params: params)
    }
}
