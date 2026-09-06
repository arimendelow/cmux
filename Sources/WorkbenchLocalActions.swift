import AppKit
import CryptoKit
import CmuxControlSocket
import Foundation

enum WorkbenchLocalActionKind: String, Codable {
    case focus
    case sendGuidance = "send_guidance"
    case interrupt
    case stop
    case resume
    case flagForReview = "flag_for_review"
}

enum WorkbenchLocalActionStatus: String, Codable {
    case pending
    case completed
    case failed
}

enum WorkbenchGuidanceDeliveryOutcome: Equatable {
    case submitted
    case pasteFailed
    case pastedNotSubmitted
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
    var sessionId: String? = nil
    var sourceRevision: String? = nil
    var expectedInputEpoch: UInt64? = nil
    var observedInputEpoch: UInt64? = nil
}

@MainActor
enum WorkbenchLocalActionRouter {
    typealias FocusEffect = @MainActor (_ workspaceId: UUID, _ surfaceId: UUID) -> Bool
    typealias FlagEffect = @MainActor (_ requestId: String, _ workspaceId: UUID, _ surfaceId: UUID?, _ summary: String) -> UUID?
    typealias GuidanceEffect = @MainActor (
        _ workspaceId: UUID,
        _ surfaceId: UUID,
        _ text: String
    ) -> WorkbenchGuidanceDeliveryOutcome
    typealias ControlEffect = @MainActor (_ workspaceId: UUID, _ surfaceId: UUID, _ sessionId: String) -> Bool
    typealias AuthorityResolver = @MainActor (_ workspaceId: UUID, _ surfaceId: UUID, _ sessionId: String) -> WorkbenchSessionAuthority?

    static let receiptDefaultsKey = "workbench.local-actions.v1"
    private static let requestIdPattern = #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"#
    private static let receiptLimit = 256

    static func list(
        params: [String: Any],
        stateStore: WorkbenchLocalSessionStateStore = .shared,
        enabled: Bool = OuroWorkbenchProduct.isCurrentBundle,
        authority: AuthorityResolver? = nil
    ) -> TerminalController.V2CallResult {
        guard enabled else {
            return .err(code: "unsupported", message: "Workbench actions are unavailable outside Ouro Workbench", data: nil)
        }
        guard params.isEmpty else {
            return .err(code: "invalid_params", message: "list accepts no parameters", data: nil)
        }
        let resolveAuthority = authority ?? liveAuthority
        let sessions = stateStore.snapshots().prefix(100).map {
            projectionResponse(
                $0,
                authority: resolveAuthority($0.workspaceId, $0.surfaceId, $0.sessionId),
                includeEvidence: false
            )
        }
        return .ok(["sessions": Array(sessions)])
    }

    static func inspect(
        params: [String: Any],
        stateStore: WorkbenchLocalSessionStateStore = .shared,
        enabled: Bool = OuroWorkbenchProduct.isCurrentBundle,
        authority: AuthorityResolver? = nil
    ) -> TerminalController.V2CallResult {
        guard enabled else {
            return .err(code: "unsupported", message: "Workbench actions are unavailable outside Ouro Workbench", data: nil)
        }
        guard hasOnlyKeys(params, allowed: ["workspace_id", "surface_id"]),
              let workspaceId = uuid(params["workspace_id"]),
              let surfaceId = uuid(params["surface_id"]) else {
            return .err(code: "invalid_params", message: "inspect requires workspace_id and surface_id", data: nil)
        }
        guard let projection = stateStore.snapshot(workspaceId: workspaceId, surfaceId: surfaceId) else {
            return .err(code: "target_unavailable", message: "Workbench has no current state for that session", data: nil)
        }
        let resolvedAuthority = (authority ?? liveAuthority)(workspaceId, surfaceId, projection.sessionId)
        return .ok(
            projectionResponse(
                projection,
                authority: resolvedAuthority,
                includeEvidence: true
            )
        )
    }

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
            return (succeeded, succeeded ? "focused" : "target_unavailable", nil, nil)
        }
    }

    static func sendGuidance(
        params: [String: Any],
        defaults: UserDefaults = .standard,
        stateStore: WorkbenchLocalSessionStateStore = .shared,
        enabled: Bool = OuroWorkbenchProduct.isCurrentBundle,
        authority: AuthorityResolver? = nil,
        effect: GuidanceEffect? = nil
    ) -> TerminalController.V2CallResult {
        guard enabled else {
            return .err(code: "unsupported", message: "Workbench actions are unavailable outside Ouro Workbench", data: nil)
        }
        guard hasOnlyKeys(
            params,
            allowed: [
                "request_id",
                "workspace_id",
                "surface_id",
                "session_id",
                "expected_source_revision",
                "expected_input_epoch",
                "text",
            ]
        ),
        let requestId = requestId(params["request_id"]),
        let workspaceId = uuid(params["workspace_id"]),
        let surfaceId = uuid(params["surface_id"]),
        let sessionId = boundedIdentifier(params["session_id"]),
        let sourceRevision = boundedIdentifier(params["expected_source_revision"]),
        let inputEpoch = uint64(params["expected_input_epoch"]),
        let text = boundedGuidance(params["text"]) else {
            return .err(
                code: "invalid_params",
                message: "send_guidance requires exact target identity, source revision, input epoch, and one line of text up to 4000 characters",
                data: nil
            )
        }
        let resolveAuthority = authority ?? liveAuthority
        return execute(
            action: .sendGuidance,
            requestId: requestId,
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            summary: nil,
            sessionId: sessionId,
            sourceRevision: sourceRevision,
            expectedInputEpoch: inputEpoch,
            fingerprintExtras: [sessionId, sourceRevision, String(inputEpoch), text],
            defaults: defaults,
            authorizeNewRequest: {
                guard WorkbenchSupervisionPolicy.load(defaults: defaults)
                    .allowsAutomatedLocalMutation(appIsActive: NSApp.isActive) else {
                    return .err(
                        code: "policy_denied",
                        message: "Workbench policy does not permit automated local input",
                        data: nil
                    )
                }
                return nil
            }
        ) {
            guard resolveAuthority(workspaceId, surfaceId, sessionId) == .controlledHere else {
                return (false, "authority_denied", nil, nil)
            }
            let claimed = stateStore.withMutationClaim(
                requestId: requestId,
                workspaceId: workspaceId,
                surfaceId: surfaceId,
                sessionId: sessionId,
                sourceRevision: sourceRevision,
                inputEpoch: inputEpoch,
                requiredPhase: .yielded,
                requiresVerifiedEvidence: true
            ) { _ -> (
                succeeded: Bool,
                resultCode: String,
                notificationId: UUID?,
                observedInputEpoch: UInt64?
            ) in
                let delivery = (effect ?? liveSendGuidance)(workspaceId, surfaceId, text)
                guard delivery != .pasteFailed else {
                    return (false, "delivery_failed", nil, nil)
                }
                let observedEpoch = stateStore.inputEpoch(
                    workspaceId: workspaceId,
                    surfaceId: surfaceId
                )
                guard observedEpoch > inputEpoch else {
                    return (false, "readback_failed", nil, observedEpoch)
                }
                let resultCode = delivery == .submitted
                    ? "guidance_sent"
                    : "guidance_pasted_not_submitted"
                return (true, resultCode, nil, observedEpoch)
            }
            switch claimed {
            case .success(let outcome):
                return outcome
            case .failure(let failure):
                return (false, failure.rawValue, nil, nil)
            }
        }
    }

    static func interrupt(
        params: [String: Any],
        defaults: UserDefaults = .standard,
        stateStore: WorkbenchLocalSessionStateStore = .shared,
        enabled: Bool = OuroWorkbenchProduct.isCurrentBundle,
        authority: AuthorityResolver? = nil,
        effect: ControlEffect? = nil
    ) -> TerminalController.V2CallResult {
        guardedControlAction(
            action: .interrupt,
            resultCode: "interrupt_sent",
            allowedPhases: [.active, .waiting, .stalled],
            params: params,
            defaults: defaults,
            stateStore: stateStore,
            enabled: enabled,
            authority: authority ?? liveAuthority,
            effect: effect ?? liveInterrupt
        )
    }

    static func stop(
        params: [String: Any],
        defaults: UserDefaults = .standard,
        stateStore: WorkbenchLocalSessionStateStore = .shared,
        enabled: Bool = OuroWorkbenchProduct.isCurrentBundle,
        authority: AuthorityResolver? = nil,
        effect: ControlEffect? = nil
    ) -> TerminalController.V2CallResult {
        guardedControlAction(
            action: .stop,
            resultCode: "stop_requested",
            allowedPhases: [.active, .waiting, .stalled],
            params: params,
            defaults: defaults,
            stateStore: stateStore,
            enabled: enabled,
            authority: authority ?? liveAuthority,
            effect: effect ?? liveStop
        )
    }

    static func resume(
        params: [String: Any],
        defaults: UserDefaults = .standard,
        stateStore: WorkbenchLocalSessionStateStore = .shared,
        enabled: Bool = OuroWorkbenchProduct.isCurrentBundle,
        authority: AuthorityResolver? = nil,
        effect: ControlEffect? = nil
    ) -> TerminalController.V2CallResult {
        guardedControlAction(
            action: .resume,
            resultCode: "resume_started",
            allowedPhases: [.ended, .yielded],
            params: params,
            defaults: defaults,
            stateStore: stateStore,
            enabled: enabled,
            authority: authority ?? liveResumeAuthority,
            effect: effect ?? liveResume
        )
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
            return (
                notificationId != nil,
                notificationId == nil ? "target_unavailable" : "flagged",
                notificationId,
                nil
            )
        }
    }

    private static func execute(
        action: WorkbenchLocalActionKind,
        requestId: String,
        workspaceId: UUID,
        surfaceId: UUID?,
        summary: String?,
        sessionId: String? = nil,
        sourceRevision: String? = nil,
        expectedInputEpoch: UInt64? = nil,
        fingerprintExtras: [String] = [],
        defaults: UserDefaults,
        authorizeNewRequest: () -> TerminalController.V2CallResult? = { nil },
        effect: () -> (
            succeeded: Bool,
            resultCode: String,
            notificationId: UUID?,
            observedInputEpoch: UInt64?
        )
    ) -> TerminalController.V2CallResult {
        guard var receipts = loadReceipts(defaults: defaults) else {
            return .err(code: "receipt_store_unavailable", message: "Workbench action receipts are unreadable", data: nil)
        }
        let fingerprint = fingerprint(
            action: action,
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            summary: summary,
            extras: fingerprintExtras
        )
        if let existing = receipts.first(where: { $0.requestId == requestId }) {
            guard existing.fingerprint == fingerprint else {
                return .err(code: "request_conflict", message: "request_id was already used for a different action", data: response(existing, replayed: true))
            }
            return result(existing, replayed: true)
        }
        if let denied = authorizeNewRequest() {
            return denied
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
            notificationId: nil,
            sessionId: sessionId,
            sourceRevision: sourceRevision,
            expectedInputEpoch: expectedInputEpoch,
            observedInputEpoch: nil
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
        receipt.observedInputEpoch = outcome.observedInputEpoch
        receipts[receipts.index(before: receipts.endIndex)] = receipt
        guard saveReceipts(receipts, defaults: defaults) else {
            return .err(code: "action_outcome_unknown", message: "The action ran but its final receipt could not be persisted", data: response(receipt, replayed: false))
        }
        return result(receipt, replayed: false)
    }

    private static func guardedControlAction(
        action: WorkbenchLocalActionKind,
        resultCode: String,
        allowedPhases: [WorkbenchLocalSessionPhase],
        params: [String: Any],
        defaults: UserDefaults,
        stateStore: WorkbenchLocalSessionStateStore,
        enabled: Bool,
        authority: @escaping AuthorityResolver,
        effect: @escaping ControlEffect
    ) -> TerminalController.V2CallResult {
        guard enabled else {
            return .err(code: "unsupported", message: "Workbench actions are unavailable outside Ouro Workbench", data: nil)
        }
        guard hasOnlyKeys(
            params,
            allowed: [
                "request_id",
                "workspace_id",
                "surface_id",
                "session_id",
                "expected_source_revision",
                "expected_input_epoch",
            ]
        ),
        let requestId = requestId(params["request_id"]),
        let workspaceId = uuid(params["workspace_id"]),
        let surfaceId = uuid(params["surface_id"]),
        let sessionId = boundedIdentifier(params["session_id"]),
        let sourceRevision = boundedIdentifier(params["expected_source_revision"]),
        let inputEpoch = uint64(params["expected_input_epoch"]) else {
            return .err(
                code: "invalid_params",
                message: "\(action.rawValue) requires exact target identity, source revision, and input epoch",
                data: nil
            )
        }
        return execute(
            action: action,
            requestId: requestId,
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            summary: nil,
            sessionId: sessionId,
            sourceRevision: sourceRevision,
            expectedInputEpoch: inputEpoch,
            fingerprintExtras: [sessionId, sourceRevision, String(inputEpoch)],
            defaults: defaults,
            authorizeNewRequest: {
                guard WorkbenchSupervisionPolicy.load(defaults: defaults)
                    .allowsAutomatedLocalMutation(appIsActive: NSApp.isActive) else {
                    return .err(
                        code: "policy_denied",
                        message: "Workbench policy does not permit automated local control",
                        data: nil
                    )
                }
                return nil
            }
        ) {
            guard authority(workspaceId, surfaceId, sessionId) == .controlledHere else {
                return (false, "authority_denied", nil, nil)
            }
            guard let projection = stateStore.snapshot(
                workspaceId: workspaceId,
                surfaceId: surfaceId
            ), allowedPhases.contains(projection.phase) else {
                return (false, "session_not_active", nil, nil)
            }
            let claimed = stateStore.withMutationClaim(
                requestId: requestId,
                workspaceId: workspaceId,
                surfaceId: surfaceId,
                sessionId: sessionId,
                sourceRevision: sourceRevision,
                inputEpoch: inputEpoch,
                requiredPhase: projection.phase
            ) { _ -> (
                succeeded: Bool,
                resultCode: String,
                notificationId: UUID?,
                observedInputEpoch: UInt64?
            ) in
                guard effect(workspaceId, surfaceId, sessionId) else {
                    return (false, "control_failed", nil, nil)
                }
                if stateStore.inputEpoch(
                    workspaceId: workspaceId,
                    surfaceId: surfaceId
                ) == inputEpoch {
                    stateStore.recordInput(
                        workspaceId: workspaceId,
                        surfaceId: surfaceId
                    )
                }
                let observedEpoch = stateStore.inputEpoch(
                    workspaceId: workspaceId,
                    surfaceId: surfaceId
                )
                return (true, resultCode, nil, observedEpoch)
            }
            switch claimed {
            case .success(let outcome):
                return outcome
            case .failure(let failure):
                return (false, failure.rawValue, nil, nil)
            }
        }
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
            "session_id": receipt.sessionId ?? NSNull(),
            "source_revision": receipt.sourceRevision ?? NSNull(),
            "expected_input_epoch": receipt.expectedInputEpoch ?? NSNull(),
            "input_epoch": receipt.observedInputEpoch ?? NSNull(),
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

    private static func boundedIdentifier(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 256 else { return nil }
        return trimmed
    }

    private static func boundedGuidance(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed.count <= 4_000,
              !trimmed.unicodeScalars.contains(where: { CharacterSet.newlines.contains($0) || $0.value == 0 }) else {
            return nil
        }
        return trimmed
    }

    private static func uint64(_ value: Any?) -> UInt64? {
        if let value = value as? UInt64 { return value }
        if let value = value as? Int, value >= 0 { return UInt64(value) }
        if let value = value as? NSNumber, value.int64Value >= 0 {
            return UInt64(value.int64Value)
        }
        return nil
    }

    private static func fingerprint(
        action: WorkbenchLocalActionKind,
        workspaceId: UUID,
        surfaceId: UUID?,
        summary: String?,
        extras: [String]
    ) -> String {
        let payload = ([
            action.rawValue,
            workspaceId.uuidString,
            surfaceId?.uuidString ?? "",
            summary ?? "",
        ] + extras).joined(separator: "\u{0}")
        return SHA256.hash(data: Data(payload.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func projectionResponse(
        _ projection: WorkbenchLocalSessionProjection,
        authority: WorkbenchSessionAuthority?,
        includeEvidence: Bool
    ) -> [String: Any] {
        var response: [String: Any] = [
            "source": projection.source,
            "session_id": projection.sessionId,
            "workspace_id": projection.workspaceId.uuidString,
            "surface_id": projection.surfaceId.uuidString,
            "source_revision": projection.sourceRevision,
            "phase": projection.phase.rawValue,
            "input_epoch": projection.inputEpoch,
            "mutation_eligible": projection.mutationEligible,
            "authority": authority?.rawValue ?? "unadopted",
        ]
        if includeEvidence {
            response["pending_guidance"] = projection.pendingGuidance?.text ?? NSNull()
            response["last_user_message"] = projection.evidence?.lastUserMessage ?? NSNull()
            response["assistant_message"] = projection.evidence?.assistantMessage ?? NSNull()
        } else {
            response["has_pending_guidance"] = projection.pendingGuidance != nil
        }
        return response
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

    private static func liveSendGuidance(
        workspaceId: UUID,
        surfaceId: UUID,
        text: String
    ) -> WorkbenchGuidanceDeliveryOutcome {
        guard let manager = AppDelegate.shared?.tabManagerFor(tabId: workspaceId),
              let workspace = manager.tabs.first(where: { $0.id == workspaceId }),
              let terminal = workspace.panels[surfaceId] as? TerminalPanel,
              terminal.surface.hasLiveSurface else {
            return .pasteFailed
        }
        return deliverGuidance(
            text,
            paste: { terminal.sendText($0) },
            sendNamedKey: { terminal.sendNamedKeyResult($0).accepted }
        )
    }

    static func deliverGuidance(
        _ text: String,
        paste: (String) -> Bool,
        sendNamedKey: (String) -> Bool
    ) -> WorkbenchGuidanceDeliveryOutcome {
        guard paste(text) else { return .pasteFailed }
        return sendNamedKey("return") ? .submitted : .pastedNotSubmitted
    }

    private static func liveInterrupt(
        workspaceId: UUID,
        surfaceId: UUID,
        sessionId: String
    ) -> Bool {
        _ = sessionId
        guard let terminal = liveTerminal(
            workspaceId: workspaceId,
            surfaceId: surfaceId
        ) else {
            return false
        }
        return terminal.sendNamedKeyResult("escape") == .sent
    }

    private static func liveStop(
        workspaceId: UUID,
        surfaceId: UUID,
        sessionId: String
    ) -> Bool {
        _ = sessionId
        guard let terminal = liveTerminal(
            workspaceId: workspaceId,
            surfaceId: surfaceId
        ) else {
            return false
        }
        return terminal.sendNamedKeyResult("ctrl-c") == .sent
    }

    private static func liveResume(
        workspaceId: UUID,
        surfaceId: UUID,
        sessionId: String
    ) -> Bool {
        guard let manager = AppDelegate.shared?.tabManagerFor(tabId: workspaceId),
              let workspace = manager.tabs.first(where: { $0.id == workspaceId }),
              let terminal = workspace.panels[surfaceId] as? TerminalPanel,
              terminal.isAgentHibernated,
              workspace.resumeAgentHibernation(
                  panelId: surfaceId,
                  focus: false
              ),
              !terminal.isAgentHibernated,
              let resumed = workspace.restoredAgentSnapshotsByPanelId[surfaceId],
              let state = workspace.restoredAgentResumeStatesByPanelId[surfaceId],
              state == .awaitingAutoResumeCommand || state == .autoResumeCommandRunning,
              ManagedAgentSessionIdentity.sessionIDsMatch(
                  kind: resumed.kind.rawValue,
                  lhs: resumed.sessionId,
                  rhs: sessionId
              ) else {
            return false
        }
        return true
    }

    private static func liveTerminal(
        workspaceId: UUID,
        surfaceId: UUID
    ) -> TerminalPanel? {
        guard let manager = AppDelegate.shared?.tabManagerFor(tabId: workspaceId),
              let workspace = manager.tabs.first(where: { $0.id == workspaceId }),
              let terminal = workspace.panels[surfaceId] as? TerminalPanel,
              !terminal.isAgentHibernated,
              terminal.surface.hasLiveSurface else {
            return nil
        }
        return terminal
    }

    private static func liveAuthority(
        workspaceId: UUID,
        surfaceId: UUID,
        sessionId: String
    ) -> WorkbenchSessionAuthority? {
        guard let manager = AppDelegate.shared?.tabManagerFor(tabId: workspaceId),
              let workspace = manager.tabs.first(where: { $0.id == workspaceId }),
              workspace.panels[surfaceId] is TerminalPanel else {
            return nil
        }
        let agent = workspace.restoredAgentSnapshotsByPanelId[surfaceId]
        let binding = workspace.surfaceResumeBindingsByPanelId[surfaceId]
        guard workspace.restoredAgentResumeStatesByPanelId[surfaceId] != .completedAgentExit else {
            return nil
        }
        if let agent {
            guard ManagedAgentSessionIdentity.sessionIDsMatch(
                kind: agent.kind.rawValue,
                lhs: agent.sessionId,
                rhs: sessionId
            ), AgentResumeLiveness.hasLiveProcess(
                for: SharedLiveAgentIndex.shared.index?.entry(
                    workspaceId: workspaceId,
                    panelId: surfaceId
                ),
                kind: agent.kind.rawValue,
                sessionId: agent.sessionId
            ) else {
                return nil
            }
        } else if let binding,
                  binding.isAgentHookBinding,
                  let kind = binding.kind,
                  let checkpointId = binding.checkpointId {
            guard ManagedAgentSessionIdentity.sessionIDsMatch(
                kind: kind,
                lhs: checkpointId,
                rhs: sessionId
            ), AgentResumeLiveness.hasLiveProcess(
                for: SharedLiveAgentIndex.shared.index?.entry(
                    workspaceId: workspaceId,
                    panelId: surfaceId
                ),
                kind: kind,
                sessionId: checkpointId
            ) else {
                return nil
            }
        } else {
            return nil
        }
        return WorkbenchSessionAuthority.resolved(agent: agent, binding: binding)
    }

    private static func liveResumeAuthority(
        workspaceId: UUID,
        surfaceId: UUID,
        sessionId: String
    ) -> WorkbenchSessionAuthority? {
        guard let manager = AppDelegate.shared?.tabManagerFor(tabId: workspaceId),
              let workspace = manager.tabs.first(where: { $0.id == workspaceId }),
              let terminal = workspace.panels[surfaceId] as? TerminalPanel,
              terminal.isAgentHibernated,
              workspace.restoredAgentResumeStatesByPanelId[surfaceId] == .manualResumeAvailable,
              let agent = workspace.restoredAgentSnapshotsByPanelId[surfaceId],
              ManagedAgentSessionIdentity.sessionIDsMatch(
                  kind: agent.kind.rawValue,
                  lhs: agent.sessionId,
                  rhs: sessionId
              ) else {
            return nil
        }
        return WorkbenchSessionAuthority.resolved(
            agent: agent,
            binding: workspace.surfaceResumeBindingsByPanelId[surfaceId]
        )
    }

#if DEBUG
    static func liveAuthorityForTesting(
        workspaceId: UUID,
        surfaceId: UUID,
        sessionId: String
    ) -> WorkbenchSessionAuthority? {
        liveAuthority(
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            sessionId: sessionId
        )
    }

    static func liveResumeAuthorityForTesting(
        workspaceId: UUID,
        surfaceId: UUID,
        sessionId: String
    ) -> WorkbenchSessionAuthority? {
        liveResumeAuthority(
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            sessionId: sessionId
        )
    }
#endif
}

extension TerminalController {
    func v2WorkbenchList(params: [String: Any]) -> V2CallResult {
        WorkbenchLocalActionRouter.list(params: params)
    }

    func v2WorkbenchInspect(params: [String: Any]) -> V2CallResult {
        WorkbenchLocalActionRouter.inspect(params: params)
    }

    func v2WorkbenchFocus(params: [String: Any]) -> V2CallResult {
        WorkbenchLocalActionRouter.focus(params: params)
    }

    func v2WorkbenchSendGuidance(params: [String: Any]) -> V2CallResult {
        WorkbenchLocalActionRouter.sendGuidance(params: params)
    }

    func v2WorkbenchInterrupt(params: [String: Any]) -> V2CallResult {
        WorkbenchLocalActionRouter.interrupt(params: params)
    }

    func v2WorkbenchStop(params: [String: Any]) -> V2CallResult {
        WorkbenchLocalActionRouter.stop(params: params)
    }

    func v2WorkbenchResume(params: [String: Any]) -> V2CallResult {
        WorkbenchLocalActionRouter.resume(params: params)
    }

    func v2WorkbenchFlagForReview(params: [String: Any]) -> V2CallResult {
        WorkbenchLocalActionRouter.flagForReview(params: params)
    }
}
