import CMUXAgentLaunch
import Foundation

enum WorkbenchSupervisionAutonomyMode: String, Codable, Sendable {
    case observeOnly
    case routine
    case trusted
}

enum WorkbenchSupervisionNotificationMode: String, Codable, Sendable {
    case all
    case humanOnly
    case off
}

enum WorkbenchSupervisionHumanMutationMode: String, Codable, Sendable {
    case never
    case whenUnfocused
    case allowed
}

struct WorkbenchSupervisionPolicy: Equatable, Sendable {
    static let currentVersion = 1
    static let defaultsKey = "workbench.supervision.policy.v1"

    var version: Int
    var bossWatchEnabled: Bool
    var autonomyMode: WorkbenchSupervisionAutonomyMode
    var notificationMode: WorkbenchSupervisionNotificationMode
    var humanMutationMode: WorkbenchSupervisionHumanMutationMode

    static let dogfoodDefault = WorkbenchSupervisionPolicy(
        version: currentVersion,
        bossWatchEnabled: true,
        autonomyMode: .observeOnly,
        notificationMode: .humanOnly,
        humanMutationMode: .never
    )

    static let failClosed = WorkbenchSupervisionPolicy(
        version: currentVersion,
        bossWatchEnabled: false,
        autonomyMode: .observeOnly,
        notificationMode: .off,
        humanMutationMode: .never
    )

    private struct Stored: Codable {
        var version: Int
        var bossWatchEnabled: Bool?
        var autonomyMode: String?
        var notificationMode: String?
        var humanMutationMode: String?
    }

    static func load(defaults: UserDefaults, key: String = defaultsKey) -> WorkbenchSupervisionPolicy {
        guard let data = defaults.data(forKey: key) else { return .dogfoodDefault }
        guard let stored = try? JSONDecoder().decode(Stored.self, from: data),
              stored.version == currentVersion else {
            return .failClosed
        }
        return WorkbenchSupervisionPolicy(
            version: currentVersion,
            bossWatchEnabled: stored.bossWatchEnabled ?? false,
            autonomyMode: WorkbenchSupervisionAutonomyMode(rawValue: stored.autonomyMode ?? "") ?? .observeOnly,
            notificationMode: WorkbenchSupervisionNotificationMode(rawValue: stored.notificationMode ?? "") ?? .off,
            humanMutationMode: WorkbenchSupervisionHumanMutationMode(rawValue: stored.humanMutationMode ?? "") ?? .never
        )
    }

    func save(defaults: UserDefaults, key: String = defaultsKey) {
        let stored = Stored(
            version: version,
            bossWatchEnabled: bossWatchEnabled,
            autonomyMode: autonomyMode.rawValue,
            notificationMode: notificationMode.rawValue,
            humanMutationMode: humanMutationMode.rawValue
        )
        if let data = try? JSONEncoder().encode(stored) {
            defaults.set(data, forKey: key)
        }
    }
}

enum WorkbenchSupervisionObservationKind: String, Codable, Sendable {
    case turnYielded
    case questionRequested
    case permissionRequested
    case turnFailed
    case processExitObserved
    case silenceThresholdCrossed
    case sessionEnded
}

struct WorkbenchSupervisionEvidence: Codable, Equatable, Sendable {
    var lastUserMessage: String?
    var assistantMessage: String?
}

struct WorkbenchSupervisionEnvelope: Codable, Equatable, Sendable {
    var id: String
    var eventId: String
    var eventSequence: Int64
    var source: String
    var sessionId: String
    var workspaceId: String
    var surfaceId: String?
    var cwd: String?
    var observation: WorkbenchSupervisionObservationKind
    var sourceEventId: String?
    var sourceRevision: String?
    var causalChainId: String?
    var actionRequestId: String?
    var toolName: String?
    var occurredAt: String?
    var evidence: WorkbenchSupervisionEvidence?

    var dedupeKey: String {
        if let sourceEventId, !sourceEventId.isEmpty {
            return "\(source)\u{0}\(sessionId)\u{0}\(sourceEventId)"
        }
        if let sourceRevision, !sourceRevision.isEmpty {
            return [
                source,
                sessionId,
                observation.rawValue,
                sourceRevision,
                causalChainId ?? "",
            ].joined(separator: "\u{0}")
        }
        return eventId
    }
}

enum WorkbenchSupervisionDisposition: String, Codable, Sendable {
    case noAction = "no_action"
    case ariAttention = "ari_attention"
    case hold
}

enum WorkbenchSupervisionReceiptStatus: String, Codable, Sendable {
    case pending
    case queued
    case completed
    case suppressed
    case invalid
    case failed
    case interrupted
}

struct WorkbenchSupervisionReceipt: Codable, Equatable, Sendable {
    var id: UUID
    var createdAt: Date
    var policyVersion: Int
    var eventId: String
    var eventSequence: Int64
    var dedupeKey: String
    var source: String
    var sessionId: String
    var workspaceId: String
    var surfaceId: String?
    var cwd: String?
    var observation: WorkbenchSupervisionObservationKind
    var sourceEventId: String?
    var sourceRevision: String?
    var causalChainId: String?
    var actionRequestId: String?
    var toolName: String?
    var occurredAt: String?
    var status: WorkbenchSupervisionReceiptStatus
    var disposition: WorkbenchSupervisionDisposition?
    var reasonCode: String?

    var envelope: WorkbenchSupervisionEnvelope {
        WorkbenchSupervisionEnvelope(
            id: eventId,
            eventId: eventId,
            eventSequence: eventSequence,
            source: source,
            sessionId: sessionId,
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            cwd: cwd,
            observation: observation,
            sourceEventId: sourceEventId,
            sourceRevision: sourceRevision,
            causalChainId: causalChainId,
            actionRequestId: actionRequestId,
            toolName: toolName,
            occurredAt: occurredAt,
            evidence: nil
        )
    }
}

struct WorkbenchSupervisionGapRecord: Codable, Equatable, Sendable {
    var detectedAt: Date
    var bootId: String
    var requestedAfterSequence: Int64?
    var oldestSequence: Int64?
    var latestSequence: Int64?
    var reason: String?
    var previousBootId: String?
}

struct WorkbenchSupervisionDispositionResult: Equatable, Sendable {
    var disposition: WorkbenchSupervisionDisposition
    var summary: String?
    var reason: String?

    private struct Raw: Decodable {
        var disposition: String
        var summary: String?
        var reason: String?
    }

    static func parse(_ text: String) -> WorkbenchSupervisionDispositionResult? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
              let raw = try? JSONDecoder().decode(Raw.self, from: data),
              let disposition = WorkbenchSupervisionDisposition(rawValue: raw.disposition) else {
            return nil
        }
        return WorkbenchSupervisionDispositionResult(
            disposition: disposition,
            summary: bounded(raw.summary, limit: 500),
            reason: bounded(raw.reason, limit: 500)
        )
    }

    private static func bounded(_ value: String?, limit: Int) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return String(value.prefix(limit))
    }
}

final class WorkbenchLocalSupervisionCoordinator: @unchecked Sendable {
    typealias TurnRunner = @Sendable (_ requestId: String, _ prompt: String, _ cwd: String) async throws -> String
    typealias EvidenceProvider = @Sendable (WorkbenchSupervisionEnvelope) -> WorkbenchSupervisionEvidence?
    typealias RecoveryProvider = @Sendable () -> [[String: Any]]

    static let receiptDefaultsKey = "workbench.supervision.receipts.v1"
    static let cursorDefaultsKey = "workbench.supervision.cursor.v1"
    static let gapDefaultsKey = "workbench.supervision.gaps.v1"
    static let eventNames: Set<String> = [
        "agent.hook.Stop",
        "agent.hook.AskUserQuestion",
        "agent.hook.PermissionRequest",
        "agent.hook.Notification",
        "agent.hook.SessionEnd",
        "workbench.process_exit_observed",
        "workbench.silence_threshold_crossed",
    ]

    private struct Cursor: Codable {
        var bootId: String
        var sequence: Int64
    }

    private struct SubscriptionPlan {
        var snapshot: CmuxEventSubscriptionSnapshot
        var recoveryReason: String?
        var previousBootId: String?
    }

    enum AgentChatHeadlessTurnError: LocalizedError {
        case invalidMessage
        case provider(String)
        case permissionWithoutReject
        case responseTooLarge

        var errorDescription: String? {
            switch self {
            case .invalidMessage:
                return "Agent Chat returned an invalid message"
            case .provider(let message):
                return message
            case .permissionWithoutReject:
                return "Headless supervision cannot grant the requested permission"
            case .responseTooLarge:
                return "Headless supervision response exceeded its limit"
            }
        }
    }

    final class AgentChatHeadlessTurnClient: @unchecked Sendable {
        private static let responseLimit = 16 * 1024
        private let ownedSession: AgentChatOwnedServerSession

        init(ownedSession: AgentChatOwnedServerSession) {
            self.ownedSession = ownedSession
        }

        func run(requestId: String, prompt: String, cwd: String) async throws -> String {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 30
            configuration.timeoutIntervalForResource = 120
            let session = URLSession(configuration: configuration)
            let socket = session.webSocketTask(with: ownedSession.webSocketURL)
            socket.resume()
            defer {
                socket.cancel(with: .goingAway, reason: nil)
                session.invalidateAndCancel()
            }
            try await send(
                [
                    "op": "headless-start",
                    "requestId": requestId,
                    "provider": "ouro-boss",
                    "cwd": cwd,
                    "prompt": prompt,
                    "autoApprove": false,
                    "options": [:] as [String: Any],
                ],
                socket: socket
            )

            var sessionId: String?
            var response = ""
            let timeout = Task {
                try await Task.sleep(for: .seconds(120))
                socket.cancel(with: .goingAway, reason: Data("timeout".utf8))
            }
            defer { timeout.cancel() }
            return try await withTaskCancellationHandler {
                do {
                    while !Task.isCancelled {
                        let message = try await socket.receive()
                        guard case .string(let text) = message,
                              let data = text.data(using: .utf8),
                              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let kind = object["kind"] as? String else {
                            throw AgentChatHeadlessTurnError.invalidMessage
                        }
                        if kind == "session-created",
                           (object["requestId"] as? String) == requestId,
                           let summary = object["session"] as? [String: Any],
                           let createdId = summary["id"] as? String {
                            sessionId = createdId
                            continue
                        }
                        if kind == "error" {
                            let matchingRequest = (object["requestId"] as? String).map { $0 == requestId } ?? true
                            let matchingSession = (object["sessionId"] as? String).map { $0 == sessionId } ?? true
                            if matchingRequest, matchingSession {
                                throw AgentChatHeadlessTurnError.provider(
                                    (object["message"] as? String) ?? "Headless Boss turn failed"
                                )
                            }
                            continue
                        }
                        guard let sessionId else { continue }
                        if kind == "session-status",
                           (object["sessionId"] as? String) == sessionId,
                           let status = object["status"] as? String,
                           status == "error" || status == "exited" {
                            throw AgentChatHeadlessTurnError.provider("Headless Boss session \(status)")
                        }
                        guard kind == "event",
                              (object["sessionId"] as? String) == sessionId,
                              let event = object["evt"] as? [String: Any],
                              let eventKind = event["kind"] as? String else {
                            continue
                        }
                        switch eventKind {
                        case "delta", "assistant":
                            if let text = event["text"] as? String {
                                guard response.utf8.count + text.utf8.count <= Self.responseLimit else {
                                    throw AgentChatHeadlessTurnError.responseTooLarge
                                }
                                response += text
                            }
                        case "permission-request":
                            guard let permissionRequestId = event["requestId"] as? String,
                                  let options = event["options"] as? [[String: Any]],
                                  let reject = options.first(where: {
                                      (($0["kind"] as? String)?.contains("reject") == true)
                                          || (($0["optionId"] as? String)?.contains("reject") == true)
                                  }),
                                  let optionId = reject["optionId"] as? String else {
                                throw AgentChatHeadlessTurnError.permissionWithoutReject
                            }
                            try await send(
                                [
                                    "op": "permission-response",
                                    "sessionId": sessionId,
                                    "requestId": permissionRequestId,
                                    "optionId": optionId,
                                ],
                                socket: socket
                            )
                        case "elicitation-request":
                            if let elicitationRequestId = event["requestId"] as? String {
                                try await send(
                                    [
                                        "op": "elicitation-response",
                                        "sessionId": sessionId,
                                        "requestId": elicitationRequestId,
                                        "action": "cancel",
                                    ],
                                    socket: socket
                                )
                            }
                        case "error":
                            throw AgentChatHeadlessTurnError.provider(
                                (event["message"] as? String) ?? "Headless Boss turn failed"
                            )
                        case "connection":
                            if (event["state"] as? String) == "failed" {
                                throw AgentChatHeadlessTurnError.provider(
                                    (event["message"] as? String) ?? "Headless Boss connection failed"
                                )
                            }
                        case "done":
                            return response.trimmingCharacters(in: .whitespacesAndNewlines)
                        default:
                            continue
                        }
                    }
                    throw CancellationError()
                } catch {
                    if let sessionId {
                        try? await send(["op": "stop", "sessionId": sessionId], socket: socket)
                    }
                    throw error
                }
            } onCancel: {
                socket.cancel(with: .goingAway, reason: Data("cancelled".utf8))
            }
        }

        private func send(_ object: [String: Any], socket: URLSessionWebSocketTask) async throws {
            guard JSONSerialization.isValidJSONObject(object),
                  let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
                  let text = String(data: data, encoding: .utf8) else {
                throw AgentChatHeadlessTurnError.invalidMessage
            }
            try await socket.send(.string(text))
        }
    }

    private let bus: CmuxEventBus
    private let defaults: UserDefaults
    private let runTurn: TurnRunner
    private let evidenceProvider: EvidenceProvider
    private let recoveryProvider: RecoveryProvider
    private let clock: @Sendable () -> Date
    private let stateLock = NSLock()
    private var subscription: CmuxEventSubscription?
    private var task: Task<Void, Never>?
    private var isStarting = false
    private var lifecycleGeneration = 0
    private var seenDedupeKeys: Set<String>

    init(
        bus: CmuxEventBus = .shared,
        defaults: UserDefaults = .standard,
        clock: @escaping @Sendable () -> Date = { Date() },
        evidenceProvider: @escaping EvidenceProvider = { _ in nil },
        recoveryProvider: @escaping RecoveryProvider = { [] },
        runTurn: @escaping TurnRunner
    ) {
        self.bus = bus
        self.defaults = defaults
        self.clock = clock
        self.evidenceProvider = evidenceProvider
        self.recoveryProvider = recoveryProvider
        self.runTurn = runTurn
        var receipts = Self.loadReceipts(defaults: defaults)
        var changed = false
        for index in receipts.indices where receipts[index].status == .pending {
            receipts[index].status = .interrupted
            receipts[index].disposition = .hold
            receipts[index].reasonCode = "boss_turn_interrupted"
            changed = true
        }
        if changed {
            Self.saveReceipts(receipts, defaults: defaults)
        }
        self.seenDedupeKeys = Set(receipts.map(\.dedupeKey))
    }

    func start() {
        let generation = stateLock.withLock { () -> Int? in
            guard self.task == nil, !isStarting else { return nil }
            isStarting = true
            lifecycleGeneration += 1
            return lifecycleGeneration
        }
        guard let generation else { return }
        let plan = subscriptionPlan()
        let workerTask = Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            await self.run(generation: generation, initialPlan: plan)
        }
        let installed = stateLock.withLock {
            guard isStarting, lifecycleGeneration == generation else { return false }
            isStarting = false
            subscription = plan.snapshot.subscription
            self.task = workerTask
            return true
        }
        if !installed {
            workerTask.cancel()
            bus.unsubscribe(plan.snapshot.subscription)
        }
    }

    @discardableResult
    func stop() -> Task<Void, Never>? {
        let captured = stateLock.withLock { () -> (CmuxEventSubscription?, Task<Void, Never>?) in
            let current = (self.subscription, self.task)
            self.subscription = nil
            self.task = nil
            isStarting = false
            lifecycleGeneration += 1
            return current
        }
        let (activeSubscription, workerTask) = captured
        workerTask?.cancel()
        if let activeSubscription {
            bus.unsubscribe(activeSubscription)
        }
        return workerTask
    }

    func processForTesting(_ event: [String: Any]) async {
        await process(event)
    }

    func resumeQueuedForTesting() async {
        await drainQueuedIfEnabled()
    }

    func receiptsForTesting() -> [WorkbenchSupervisionReceipt] {
        Self.loadReceipts(defaults: defaults)
    }

    func gapsForTesting() -> [WorkbenchSupervisionGapRecord] {
        Self.loadGaps(defaults: defaults)
    }

    private func process(_ event: [String: Any], advanceCursor: Bool = true) async {
        guard var envelope = Self.envelope(from: event) else {
            if advanceCursor { persistCursor(from: event) }
            return
        }
        envelope.evidence = evidenceProvider(envelope)
        let policy = WorkbenchSupervisionPolicy.load(defaults: defaults)

        let isDuplicate = stateLock.withLock {
            let duplicate = seenDedupeKeys.contains(envelope.dedupeKey)
            if !duplicate {
                seenDedupeKeys.insert(envelope.dedupeKey)
            }
            return duplicate
        }
        guard !isDuplicate else {
            if advanceCursor { persistCursor(from: event) }
            return
        }

        if hasNoNewState(envelope) {
            writeReceipt(
                envelope: envelope,
                policy: policy,
                status: .suppressed,
                disposition: .hold,
                reasonCode: "same_causal_chain_no_new_state"
            )
            if advanceCursor { persistCursor(from: event) }
            return
        }

        if !policy.bossWatchEnabled {
            writeReceipt(
                envelope: envelope,
                policy: policy,
                status: .queued,
                disposition: nil,
                reasonCode: "boss_watch_paused"
            )
            if advanceCursor { persistCursor(from: event) }
            return
        }

        let receiptId = writeReceipt(
            envelope: envelope,
            policy: policy,
            status: .pending,
            disposition: nil,
            reasonCode: nil
        )
        if advanceCursor { persistCursor(from: event) }
        await execute(envelope: envelope, policy: policy, receiptId: receiptId)
    }

    private func execute(
        envelope: WorkbenchSupervisionEnvelope,
        policy: WorkbenchSupervisionPolicy,
        receiptId: UUID
    ) async -> Bool {
        do {
            let response = try await runTurn(
                "workbench-supervision:\(envelope.id)",
                Self.prompt(for: envelope, policy: policy),
                envelope.cwd ?? FileManager.default.homeDirectoryForCurrentUser.path
            )
            if let result = WorkbenchSupervisionDispositionResult.parse(response) {
                updateReceipt(
                    id: receiptId,
                    status: .completed,
                    disposition: result.disposition,
                    reasonCode: nil
                )
            } else {
                updateReceipt(
                    id: receiptId,
                    status: .invalid,
                    disposition: .hold,
                    reasonCode: "boss_disposition_invalid"
                )
            }
            return true
        } catch is CancellationError {
            updateReceipt(
                id: receiptId,
                status: .interrupted,
                disposition: .hold,
                reasonCode: "boss_turn_cancelled"
            )
            return false
        } catch {
            updateReceipt(
                id: receiptId,
                status: .failed,
                disposition: .hold,
                reasonCode: "boss_turn_failed"
            )
            return true
        }
    }

    private func drainQueuedIfEnabled() async {
        let policy = WorkbenchSupervisionPolicy.load(defaults: defaults)
        guard policy.bossWatchEnabled else { return }
        let queued = Self.loadReceipts(defaults: defaults).filter { $0.status == .queued }
        for receipt in queued {
            if Task.isCancelled { return }
            let currentPolicy = WorkbenchSupervisionPolicy.load(defaults: defaults)
            guard currentPolicy.bossWatchEnabled else { return }
            var envelope = receipt.envelope
            envelope.evidence = evidenceProvider(envelope)
            updateReceipt(
                id: receipt.id,
                status: .pending,
                disposition: nil,
                reasonCode: nil
            )
            guard await execute(
                envelope: envelope,
                policy: currentPolicy,
                receiptId: receipt.id
            ) else {
                return
            }
        }
    }

    @discardableResult
    private func writeReceipt(
        envelope: WorkbenchSupervisionEnvelope,
        policy: WorkbenchSupervisionPolicy,
        status: WorkbenchSupervisionReceiptStatus,
        disposition: WorkbenchSupervisionDisposition?,
        reasonCode: String?
    ) -> UUID {
        var receipts = Self.loadReceipts(defaults: defaults)
        if status == .queued {
            receipts.removeAll {
                $0.status == .queued
                    && $0.source == envelope.source
                    && $0.sessionId == envelope.sessionId
                    && $0.observation == envelope.observation
            }
        }
        let id = UUID()
        receipts.append(
            WorkbenchSupervisionReceipt(
                id: id,
                createdAt: clock(),
                policyVersion: policy.version,
                eventId: envelope.eventId,
                eventSequence: envelope.eventSequence,
                dedupeKey: envelope.dedupeKey,
                source: envelope.source,
                sessionId: envelope.sessionId,
                workspaceId: envelope.workspaceId,
                surfaceId: envelope.surfaceId,
                cwd: envelope.cwd,
                observation: envelope.observation,
                sourceEventId: envelope.sourceEventId,
                sourceRevision: envelope.sourceRevision,
                causalChainId: envelope.causalChainId,
                actionRequestId: envelope.actionRequestId,
                toolName: envelope.toolName,
                occurredAt: envelope.occurredAt,
                status: status,
                disposition: disposition,
                reasonCode: reasonCode
            )
        )
        while receipts.count > 256,
              let terminalIndex = receipts.firstIndex(where: {
                  $0.status != .pending && $0.status != .queued
              }) {
            receipts.remove(at: terminalIndex)
        }
        Self.saveReceipts(receipts, defaults: defaults)
        return id
    }

    private func updateReceipt(
        id: UUID,
        status: WorkbenchSupervisionReceiptStatus,
        disposition: WorkbenchSupervisionDisposition?,
        reasonCode: String?
    ) {
        var receipts = Self.loadReceipts(defaults: defaults)
        guard let index = receipts.firstIndex(where: { $0.id == id }) else { return }
        receipts[index].status = status
        receipts[index].disposition = disposition
        receipts[index].reasonCode = reasonCode
        Self.saveReceipts(receipts, defaults: defaults)
    }

    private func hasNoNewState(_ envelope: WorkbenchSupervisionEnvelope) -> Bool {
        guard let causalChainId = envelope.causalChainId, !causalChainId.isEmpty,
              let sourceRevision = envelope.sourceRevision, !sourceRevision.isEmpty else {
            return false
        }
        return Self.loadReceipts(defaults: defaults).contains { receipt in
            receipt.source == envelope.source
                && receipt.sessionId == envelope.sessionId
                && receipt.observation == envelope.observation
                && receipt.causalChainId == causalChainId
                && receipt.sourceRevision == sourceRevision
                && receipt.status != .pending
                && receipt.status != .queued
        }
    }

    private func subscriptionPlan() -> SubscriptionPlan {
        let cursor = Self.loadCursor(defaults: defaults)
        var snapshot = bus.subscribe(
            afterSequence: cursor?.sequence,
            names: Self.eventNames,
            categories: []
        )
        let currentBootId = snapshot.ack["boot_id"] as? String
        let replayGap = ((snapshot.ack["resume"] as? [String: Any])?["gap"] as? Bool) == true
        let bootChanged = cursor.map { $0.bootId != currentBootId } ?? false
        let recoveryReason = bootChanged
            ? "event_bus_boot_changed"
            : (replayGap ? "retention_gap" : nil)
        if let cursor, cursor.bootId != currentBootId || replayGap {
            bus.unsubscribe(snapshot.subscription)
            snapshot = bus.subscribe(
                afterSequence: 0,
                names: Self.eventNames,
                categories: []
            )
        }
        return SubscriptionPlan(
            snapshot: snapshot,
            recoveryReason: recoveryReason,
            previousBootId: bootChanged ? cursor?.bootId : nil
        )
    }

    private func run(
        generation: Int,
        initialPlan: SubscriptionPlan
    ) async {
        var plan = initialPlan
        while !Task.isCancelled {
            if let recoveryReason = plan.recoveryReason {
                recordRecoveryBoundary(
                    plan.snapshot,
                    reason: recoveryReason,
                    previousBootId: plan.previousBootId
                )
                for event in recoveryProvider() {
                    if Task.isCancelled { break }
                    await process(event, advanceCursor: false)
                }
                if !Task.isCancelled, plan.snapshot.replay.isEmpty,
                   let bootId = plan.snapshot.ack["boot_id"] as? String,
                   let latestSequence = Self.int64(
                       (plan.snapshot.ack["resume"] as? [String: Any])?["latest_seq"]
                   ) {
                    persistCursor(bootId: bootId, sequence: latestSequence)
                }
            }
            await drainQueuedIfEnabled()
            for event in plan.snapshot.replay {
                if Task.isCancelled { break }
                await process(event)
            }
            while !Task.isCancelled, !plan.snapshot.subscription.isClosed {
                if let event = plan.snapshot.subscription.next(timeout: 0.5) {
                    await process(event)
                } else {
                    await drainQueuedIfEnabled()
                }
            }
            if Task.isCancelled { break }
            bus.unsubscribe(plan.snapshot.subscription)
            plan = subscriptionPlan()
            let installed = stateLock.withLock {
                guard lifecycleGeneration == generation else { return false }
                subscription = plan.snapshot.subscription
                return true
            }
            if !installed {
                bus.unsubscribe(plan.snapshot.subscription)
                break
            }
        }
        stateLock.withLock {
            guard lifecycleGeneration == generation else { return }
            subscription = nil
            task = nil
        }
    }

    private func recordRecoveryBoundary(
        _ snapshot: CmuxEventSubscriptionSnapshot,
        reason: String,
        previousBootId: String?
    ) {
        let resume = snapshot.ack["resume"] as? [String: Any]
        var gaps = Self.loadGaps(defaults: defaults)
        gaps.append(
            WorkbenchSupervisionGapRecord(
                detectedAt: clock(),
                bootId: (snapshot.ack["boot_id"] as? String) ?? "unknown",
                requestedAfterSequence: Self.int64(resume?["requested_after_seq"]),
                oldestSequence: Self.int64(resume?["oldest_seq"]),
                latestSequence: Self.int64(resume?["latest_seq"]),
                reason: reason,
                previousBootId: previousBootId
            )
        )
        if gaps.count > 32 {
            gaps.removeFirst(gaps.count - 32)
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(gaps) {
            defaults.set(data, forKey: Self.gapDefaultsKey)
        }
    }

    private func persistCursor(from event: [String: Any]) {
        guard let bootId = event["boot_id"] as? String,
              let sequence = Self.int64(event["seq"]) else {
            return
        }
        persistCursor(bootId: bootId, sequence: sequence)
    }

    private func persistCursor(bootId: String, sequence: Int64) {
        if let data = try? JSONEncoder().encode(Cursor(bootId: bootId, sequence: sequence)) {
            defaults.set(data, forKey: Self.cursorDefaultsKey)
        }
    }

    private static func loadCursor(defaults: UserDefaults) -> Cursor? {
        guard let data = defaults.data(forKey: cursorDefaultsKey) else { return nil }
        return try? JSONDecoder().decode(Cursor.self, from: data)
    }

    private static func loadReceipts(defaults: UserDefaults) -> [WorkbenchSupervisionReceipt] {
        guard let data = defaults.data(forKey: receiptDefaultsKey) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([WorkbenchSupervisionReceipt].self, from: data)) ?? []
    }

    private static func loadGaps(defaults: UserDefaults) -> [WorkbenchSupervisionGapRecord] {
        guard let data = defaults.data(forKey: gapDefaultsKey) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([WorkbenchSupervisionGapRecord].self, from: data)) ?? []
    }

    private static func saveReceipts(
        _ receipts: [WorkbenchSupervisionReceipt],
        defaults: UserDefaults
    ) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(receipts) {
            defaults.set(data, forKey: receiptDefaultsKey)
        }
    }

    private static func envelope(from event: [String: Any]) -> WorkbenchSupervisionEnvelope? {
        guard let name = event["name"] as? String,
              eventNames.contains(name),
              let eventId = event["id"] as? String,
              let sequence = int64(event["seq"]),
              let source = nonEmpty(event["source"]),
              let payload = event["payload"] as? [String: Any],
              let sessionId = nonEmpty(payload["session_id"]),
              let workspaceId = nonEmpty(event["workspace_id"] ?? payload["workspace_id"]),
              UUID(uuidString: workspaceId) != nil else {
            return nil
        }

        let surfaceId = nonEmpty(event["surface_id"] ?? payload["surface_id"])
        if let surfaceId, UUID(uuidString: surfaceId) == nil {
            return nil
        }
        let observation: WorkbenchSupervisionObservationKind
        switch name {
        case "agent.hook.Stop":
            observation = .turnYielded
        case "agent.hook.AskUserQuestion":
            observation = .questionRequested
        case "agent.hook.PermissionRequest":
            observation = .permissionRequested
        case "agent.hook.Notification":
            guard bool(payload["is_error"]) == true else { return nil }
            observation = .turnFailed
        case "agent.hook.SessionEnd":
            observation = .sessionEnded
        case "workbench.process_exit_observed":
            observation = .processExitObserved
        case "workbench.silence_threshold_crossed":
            observation = .silenceThresholdCrossed
        default:
            return nil
        }
        let actionRequestId = nonEmpty(payload["_action_request_id"])
        if actionRequestId?.hasPrefix("workbench-supervision:") == true {
            return nil
        }
        if name.hasPrefix("agent.hook."),
           nonEmpty(payload["phase"]) != "received" {
            return nil
        }
        let sourceEventId = nonEmpty(payload["_source_event_id"])
        let sourceRevision = nonEmpty(payload["_source_revision"])
        guard sourceEventId != nil || sourceRevision != nil else {
            return nil
        }
        return WorkbenchSupervisionEnvelope(
            id: eventId,
            eventId: eventId,
            eventSequence: sequence,
            source: source,
            sessionId: sessionId,
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            cwd: nonEmpty(payload["cwd"]),
            observation: observation,
            sourceEventId: sourceEventId,
            sourceRevision: sourceRevision,
            causalChainId: nonEmpty(payload["_causal_chain_id"]),
            actionRequestId: actionRequestId,
            toolName: nonEmpty(payload["tool_name"]),
            occurredAt: nonEmpty(event["occurred_at"]),
            evidence: nil
        )
    }

    static func envelopeForTesting(_ event: [String: Any]) -> WorkbenchSupervisionEnvelope? {
        envelope(from: event)
    }

    private static func prompt(
        for envelope: WorkbenchSupervisionEnvelope,
        policy: WorkbenchSupervisionPolicy
    ) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let payload = (try? encoder.encode(envelope)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return """
        You are the Ouro Workbench Boss supervising one local worker observation. This pass is isolated and observe-only. Do not call tools, send input, approve, stop, resume, or mutate anything. Return exactly one JSON object with disposition equal to no_action, ari_attention, or hold, plus optional summary and reason strings. Use ari_attention only when the supplied evidence proves Ari must decide; use hold when evidence or authority is insufficient. Policy version: \(policy.version). Autonomy mode: \(policy.autonomyMode.rawValue). Notification mode: \(policy.notificationMode.rawValue). Human mutation mode: \(policy.humanMutationMode.rawValue). Observation: \(payload)
        """
    }

    private static func nonEmpty(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func int64(_ value: Any?) -> Int64? {
        if let value = value as? Int64 { return value }
        if let value = value as? Int { return Int64(value) }
        if let value = value as? NSNumber { return value.int64Value }
        return nil
    }

    private static func bool(_ value: Any?) -> Bool? {
        if let value = value as? Bool { return value }
        if let value = value as? NSNumber { return value.boolValue }
        return nil
    }
}
