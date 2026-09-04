import Foundation
import Testing

#if canImport(cmux_DEV)
@testable import cmux_DEV
#elseif canImport(cmux)
@testable import cmux
#endif

@Suite("Workbench local supervision", .serialized)
struct WorkbenchLocalSupervisionTests {
    @Test func policyDefaultsToObserveOnlyAndFailsClosedForUnknownOrFutureValues() throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }

        #expect(WorkbenchSupervisionPolicy.load(defaults: defaults) == .dogfoodDefault)

        let unknown: [String: Any] = [
            "version": 1,
            "bossWatchEnabled": true,
            "autonomyMode": "future-mode",
            "notificationMode": "future-mode",
            "humanMutationMode": "future-mode",
        ]
        defaults.set(try JSONSerialization.data(withJSONObject: unknown), forKey: WorkbenchSupervisionPolicy.defaultsKey)
        let safeUnknown = WorkbenchSupervisionPolicy.load(defaults: defaults)
        #expect(safeUnknown.bossWatchEnabled)
        #expect(safeUnknown.autonomyMode == .observeOnly)
        #expect(safeUnknown.notificationMode == .off)
        #expect(safeUnknown.humanMutationMode == .never)

        defaults.set(
            try JSONSerialization.data(withJSONObject: ["version": 2, "bossWatchEnabled": true]),
            forKey: WorkbenchSupervisionPolicy.defaultsKey
        )
        #expect(WorkbenchSupervisionPolicy.load(defaults: defaults) == .failClosed)
    }

    @Test func strictDispositionParsingRejectsProseAndBoundsFields() {
        #expect(WorkbenchSupervisionDispositionResult.parse("no action") == nil)
        let parsed = WorkbenchSupervisionDispositionResult.parse(
            #"{"disposition":"ari_attention","summary":"needs Ari","reason":"judgment required"}"#
        )
        #expect(parsed?.disposition == .ariAttention)
        #expect(parsed?.summary == "needs Ari")
        #expect(parsed?.reason == "judgment required")
        #expect(
            WorkbenchSupervisionDispositionResult.parse(
                #"{"disposition":"unknown"}"#
            ) == nil
        )
    }

    @Test func exactSourceReplayProducesOneIsolatedPassAndContentFreeReceipt() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let runner = TurnRecorder(
            response: #"{"disposition":"no_action","summary":"secret user text","reason":"secret assistant text"}"#
        )
        let coordinator = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            clock: { Date(timeIntervalSince1970: 42) },
            evidenceProvider: { _ in
                WorkbenchSupervisionEvidence(
                    lastUserMessage: "secret user text",
                    assistantMessage: "secret assistant text"
                )
            },
            runTurn: runner.turnRunner
        )
        let first = event(
            eventId: "bus-1",
            sequence: 1,
            sourceEventId: "native-1"
        )
        let replay = event(
            eventId: "bus-2",
            sequence: 2,
            sourceEventId: "native-1"
        )

        await coordinator.processForTesting(first)
        await coordinator.processForTesting(replay)

        #expect(runner.calls.count == 1)
        #expect(runner.calls[0].requestId.hasPrefix("workbench-supervision:"))
        #expect(runner.calls[0].prompt.contains("secret assistant text"))
        let receipts = coordinator.receiptsForTesting()
        #expect(receipts.count == 1)
        #expect(receipts[0].status == .completed)
        #expect(receipts[0].disposition == .noAction)
        #expect(receipts[0].sourceRevision == "revision-1")
        #expect(receipts[0].causalChainId == "turn-1")
        let persisted = String(data: try #require(defaults.data(forKey: WorkbenchLocalSupervisionCoordinator.receiptDefaultsKey)), encoding: .utf8)
        #expect(persisted?.contains("secret user text") == false)
        #expect(persisted?.contains("secret assistant text") == false)
    }

    @Test func disabledWatchQueuesThePassForResumeAndInvalidOutputFailsClosedToHold() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        var disabled = WorkbenchSupervisionPolicy.dogfoodDefault
        disabled.bossWatchEnabled = false
        disabled.save(defaults: defaults)
        let disabledRunner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let disabledCoordinator = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            runTurn: disabledRunner.turnRunner
        )
        await disabledCoordinator.processForTesting(event(eventId: "disabled", sequence: 1))
        #expect(disabledRunner.calls.isEmpty)
        #expect(disabledCoordinator.receiptsForTesting().first?.status == .queued)
        #expect(disabledCoordinator.receiptsForTesting().first?.reasonCode == "boss_watch_paused")

        WorkbenchSupervisionPolicy.dogfoodDefault.save(defaults: defaults)
        await disabledCoordinator.resumeQueuedForTesting()
        #expect(disabledRunner.calls.count == 1)
        #expect(disabledCoordinator.receiptsForTesting().first?.status == .completed)

        defaults.removeObject(forKey: WorkbenchLocalSupervisionCoordinator.receiptDefaultsKey)
        let invalidRunner = TurnRecorder(response: "I would hold.")
        let invalidCoordinator = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            runTurn: invalidRunner.turnRunner
        )
        await invalidCoordinator.processForTesting(event(eventId: "invalid", sequence: 2))
        let receipt = try #require(invalidCoordinator.receiptsForTesting().first)
        #expect(receipt.status == .invalid)
        #expect(receipt.disposition == .hold)
        #expect(receipt.reasonCode == "boss_disposition_invalid")
    }

    @Test func eventSubscriptionReplaysAfterThePersistedCursorAndIgnoresFeedProjection() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let bus = CmuxEventBus(retainedEventLimit: 16)
        let firstRunner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let first = WorkbenchLocalSupervisionCoordinator(
            bus: bus,
            defaults: defaults,
            runTurn: firstRunner.turnRunner
        )
        first.start()
        bus.publish(
            name: "agent.hook.Stop",
            category: "agent",
            source: "copilot",
            workspaceId: Self.workspaceId,
            surfaceId: Self.surfaceId,
            payload: payload(sessionId: "copilot-one", sourceEventId: "native-one")
        )
        try await waitUntil { first.receiptsForTesting().count == 1 }
        first.stop()

        bus.publish(
            name: "feed.item.received",
            category: "feed",
            source: "copilot",
            workspaceId: Self.workspaceId,
            surfaceId: Self.surfaceId,
            payload: payload(sessionId: "copilot-feed", sourceEventId: "native-feed")
        )
        bus.publish(
            name: "agent.hook.SessionEnd",
            category: "agent",
            source: "copilot",
            workspaceId: Self.workspaceId,
            surfaceId: Self.surfaceId,
            payload: payload(sessionId: "copilot-two", sourceEventId: "native-two")
        )

        let secondRunner = TurnRecorder(response: #"{"disposition":"hold","reason":"ended"}"#)
        let second = WorkbenchLocalSupervisionCoordinator(
            bus: bus,
            defaults: defaults,
            runTurn: secondRunner.turnRunner
        )
        second.start()
        defer { second.stop() }
        try await waitUntil { second.receiptsForTesting().count == 2 }
        #expect(secondRunner.calls.count == 1)
        #expect(second.receiptsForTesting().last?.observation == .sessionEnded)
    }

    @Test func aNewEventBusBootReplaysRetainedEventsInsteadOfTrustingTheOldSequence() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let firstBus = CmuxEventBus(retainedEventLimit: 16)
        let first = WorkbenchLocalSupervisionCoordinator(
            bus: firstBus,
            defaults: defaults,
            runTurn: TurnRecorder(response: #"{"disposition":"no_action"}"#).turnRunner
        )
        first.start()
        firstBus.publish(
            name: "agent.hook.Stop",
            category: "agent",
            source: "copilot",
            workspaceId: Self.workspaceId,
            surfaceId: Self.surfaceId,
            payload: payload(sessionId: "copilot-old", sourceEventId: "old")
        )
        try await waitUntil { first.receiptsForTesting().count == 1 }
        first.stop()

        let newBus = CmuxEventBus(retainedEventLimit: 16)
        newBus.publish(
            name: "agent.hook.Stop",
            category: "agent",
            source: "copilot",
            workspaceId: Self.workspaceId,
            surfaceId: Self.surfaceId,
            payload: payload(sessionId: "copilot-new", sourceEventId: "new")
        )
        let newRunner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let second = WorkbenchLocalSupervisionCoordinator(
            bus: newBus,
            defaults: defaults,
            runTurn: newRunner.turnRunner
        )
        second.start()
        defer { second.stop() }
        try await waitUntil { second.receiptsForTesting().count == 2 }
        #expect(newRunner.calls.count == 1)
    }

    @Test func receivedAndCompletedProjectionsWithoutSourceEventIdProduceOnePass() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let runner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let coordinator = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            runTurn: runner.turnRunner
        )
        let received = event(
            eventId: "received",
            sequence: 1,
            sourceEventId: nil
        )
        var completed = event(
            eventId: "completed",
            sequence: 2,
            sourceEventId: nil
        )
        var completedPayload = try #require(completed["payload"] as? [String: Any])
        completedPayload["phase"] = "completed"
        completed["payload"] = completedPayload

        await coordinator.processForTesting(received)
        await coordinator.processForTesting(completed)
        #expect(runner.calls.count == 1)
        #expect(coordinator.receiptsForTesting().count == 1)
    }

    @Test func allSupportedObservationsMapToTypedReceipts() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let runner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let coordinator = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            runTurn: runner.turnRunner
        )
        let cases: [(String, WorkbenchSupervisionObservationKind, Bool)] = [
            ("agent.hook.Stop", .turnYielded, false),
            ("agent.hook.AskUserQuestion", .questionRequested, false),
            ("agent.hook.PermissionRequest", .permissionRequested, false),
            ("agent.hook.Notification", .turnFailed, true),
            ("workbench.process_exit_observed", .processExitObserved, false),
            ("workbench.silence_threshold_crossed", .silenceThresholdCrossed, false),
            ("agent.hook.SessionEnd", .sessionEnded, false),
        ]
        for (index, item) in cases.enumerated() {
            await coordinator.processForTesting(
                event(
                    name: item.0,
                    eventId: "typed-\(index)",
                    sequence: Int64(index + 1),
                    sourceEventId: "native-\(index)",
                    isError: item.2
                )
            )
        }
        #expect(coordinator.receiptsForTesting().map(\.observation) == cases.map(\.1))
        #expect(runner.calls.count == cases.count)

        await coordinator.processForTesting(
            event(
                name: "agent.hook.Notification",
                eventId: "non-error",
                sequence: 20,
                sourceEventId: "native-non-error"
            )
        )
        #expect(runner.calls.count == cases.count)
    }

    @Test func sameCausalChainWithoutNewStateTripsTheNoProgressBreaker() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let runner = TurnRecorder(response: #"{"disposition":"hold"}"#)
        let coordinator = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            runTurn: runner.turnRunner
        )
        await coordinator.processForTesting(
            event(eventId: "first-causal", sequence: 1, sourceEventId: "native-a")
        )
        await coordinator.processForTesting(
            event(eventId: "second-causal", sequence: 2, sourceEventId: "native-b")
        )

        #expect(runner.calls.count == 1)
        let receipts = coordinator.receiptsForTesting()
        #expect(receipts.count == 2)
        #expect(receipts.last?.status == .suppressed)
        #expect(receipts.last?.reasonCode == "same_causal_chain_no_new_state")

        await coordinator.processForTesting(
            event(
                eventId: "newer-causal",
                sequence: 3,
                sourceEventId: "native-c",
                sourceRevision: "revision-2"
            )
        )
        #expect(runner.calls.count == 2)
        #expect(coordinator.receiptsForTesting().last?.status == .completed)

        await coordinator.processForTesting(
            event(
                eventId: "missing-revision-a",
                sequence: 4,
                sourceEventId: "native-d",
                sessionId: "missing-revision",
                sourceRevision: ""
            )
        )
        await coordinator.processForTesting(
            event(
                eventId: "missing-revision-b",
                sequence: 5,
                sourceEventId: "native-e",
                sessionId: "missing-revision",
                sourceRevision: ""
            )
        )
        #expect(runner.calls.count == 4)
    }

    @Test func admissionIdentityIsDurableBeforeTheBossTurnCompletes() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let runner = SuspendedTurnRecorder()
        let coordinator = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            runTurn: runner.turnRunner
        )
        let processing = Task {
            await coordinator.processForTesting(
                event(
                    eventId: "pending-admission",
                    sequence: 1,
                    sourceEventId: "native-pending",
                    actionRequestId: "action-pending"
                )
            )
        }
        try await waitUntil { runner.hasStarted }
        let pending = try #require(coordinator.receiptsForTesting().first)
        #expect(pending.status == .pending)
        #expect(pending.sourceEventId == "native-pending")
        #expect(pending.sourceRevision == "revision-1")
        #expect(pending.causalChainId == "turn-1")
        #expect(pending.actionRequestId == "action-pending")

        runner.resume()
        await processing.value
        #expect(coordinator.receiptsForTesting().first?.status == .completed)
    }

    @Test func persistedPendingAdmissionBecomesInterruptedWithoutRetry() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let receipt = WorkbenchSupervisionReceipt(
            id: UUID(),
            createdAt: Date(timeIntervalSince1970: 1),
            policyVersion: 1,
            eventId: "interrupted",
            eventSequence: 1,
            dedupeKey: "interrupted",
            source: "copilot",
            sessionId: "copilot-session",
            workspaceId: Self.workspaceId,
            surfaceId: Self.surfaceId,
            cwd: "/tmp",
            observation: .turnYielded,
            sourceEventId: "native-interrupted",
            sourceRevision: "revision-1",
            causalChainId: "turn-1",
            actionRequestId: nil,
            toolName: nil,
            occurredAt: "2026-09-04T00:00:00Z",
            status: .pending,
            disposition: nil,
            reasonCode: nil
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        defaults.set(
            try encoder.encode([receipt]),
            forKey: WorkbenchLocalSupervisionCoordinator.receiptDefaultsKey
        )
        let runner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let coordinator = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            runTurn: runner.turnRunner
        )

        let recovered = try #require(coordinator.receiptsForTesting().first)
        #expect(recovered.status == .interrupted)
        #expect(recovered.disposition == .hold)
        #expect(recovered.reasonCode == "boss_turn_interrupted")
        await coordinator.processForTesting(event(eventId: "interrupted", sequence: 2))
        #expect(runner.calls.isEmpty)
    }

    @Test func subscriptionOverflowReplaysFromTheCursorAndContinuesSupervision() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let bus = CmuxEventBus(
            retainedEventLimit: 16,
            maxPendingEventsPerSubscription: 1
        )
        let runner = SuspendedTurnRecorder()
        let coordinator = WorkbenchLocalSupervisionCoordinator(
            bus: bus,
            defaults: defaults,
            runTurn: runner.turnRunner
        )
        coordinator.start()
        defer { coordinator.stop() }

        func publish(_ index: Int) {
            bus.publish(
                name: "agent.hook.Stop",
                category: "agent",
                source: "copilot",
                workspaceId: Self.workspaceId,
                surfaceId: Self.surfaceId,
                payload: payload(
                    sessionId: "copilot-\(index)",
                    sourceEventId: "native-\(index)",
                    sourceRevision: "revision-\(index)",
                    causalChainId: "turn-\(index)"
                )
            )
        }
        publish(1)
        try await waitUntil { runner.hasStarted }
        publish(2)
        publish(3)
        runner.resume()

        try await waitUntil(timeout: .seconds(4)) {
            coordinator.receiptsForTesting().filter { $0.status == .completed }.count == 3
        }
        #expect(runner.callCount == 3)
    }

    @Test func retentionGapIsRecordedAndCurrentSnapshotRecoveryRunsBeforeTheRetainedTail() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let bus = CmuxEventBus(retainedEventLimit: 1)
        let firstRunner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let first = WorkbenchLocalSupervisionCoordinator(
            bus: bus,
            defaults: defaults,
            runTurn: firstRunner.turnRunner
        )
        first.start()
        bus.publish(
            name: "agent.hook.Stop",
            category: "agent",
            source: "copilot",
            workspaceId: Self.workspaceId,
            surfaceId: Self.surfaceId,
            payload: payload(
                sessionId: "gap-first",
                sourceEventId: "gap-first",
                sourceRevision: "1",
                causalChainId: "gap-1"
            )
        )
        try await waitUntil { first.receiptsForTesting().count == 1 }
        first.stop()

        for index in 2...3 {
            bus.publish(
                name: "agent.hook.Stop",
                category: "agent",
                source: "copilot",
                workspaceId: Self.workspaceId,
                surfaceId: Self.surfaceId,
                payload: payload(
                    sessionId: "gap-\(index)",
                    sourceEventId: "gap-\(index)",
                    sourceRevision: "\(index)",
                    causalChainId: "gap-\(index)"
                )
            )
        }
        let recovery = event(
            eventId: "recovered-current",
            sequence: 0,
            sourceEventId: "recovered-current",
            sessionId: "gap-recovered",
            sourceRevision: "current",
            causalChainId: "gap-current"
        )
        let secondRunner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let second = WorkbenchLocalSupervisionCoordinator(
            bus: bus,
            defaults: defaults,
            recoveryProvider: { [recovery] },
            runTurn: secondRunner.turnRunner
        )
        second.start()
        defer { second.stop() }

        try await waitUntil { second.receiptsForTesting().count == 3 }
        #expect(second.gapsForTesting().count == 1)
        #expect(secondRunner.calls.count == 2)
        #expect(second.receiptsForTesting().suffix(2).map(\.sessionId) == ["gap-recovered", "gap-3"])
    }

    @Test func eventBusBootChangeRecoversUnseenStateBeforeNewBootReplay() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let firstBus = CmuxEventBus(retainedEventLimit: 4)
        let first = WorkbenchLocalSupervisionCoordinator(
            bus: firstBus,
            defaults: defaults,
            runTurn: TurnRecorder(response: #"{"disposition":"no_action"}"#).turnRunner
        )
        first.start()
        firstBus.publish(
            name: "agent.hook.Stop",
            category: "agent",
            source: "copilot",
            workspaceId: Self.workspaceId,
            surfaceId: Self.surfaceId,
            payload: payload(
                sessionId: "old-seen",
                sourceEventId: "old-seen",
                sourceRevision: "1",
                causalChainId: "old-seen"
            )
        )
        try await waitUntil { first.receiptsForTesting().count == 1 }
        first.stop()

        let secondBus = CmuxEventBus(retainedEventLimit: 4)
        secondBus.publish(
            name: "agent.hook.Stop",
            category: "agent",
            source: "copilot",
            workspaceId: Self.workspaceId,
            surfaceId: Self.surfaceId,
            payload: payload(
                sessionId: "new-boot",
                sourceEventId: "new-boot",
                sourceRevision: "1",
                causalChainId: "new-boot"
            )
        )
        let unseenOldBootState = event(
            eventId: "old-unseen",
            sequence: 2,
            sourceEventId: "old-unseen",
            sessionId: "old-unseen",
            sourceRevision: "2",
            causalChainId: "old-unseen"
        )
        let runner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let second = WorkbenchLocalSupervisionCoordinator(
            bus: secondBus,
            defaults: defaults,
            recoveryProvider: { [unseenOldBootState] },
            runTurn: runner.turnRunner
        )
        second.start()
        defer { second.stop() }

        try await waitUntil {
            second.receiptsForTesting().count == 3 && runner.calls.count == 2
        }
        #expect(second.receiptsForTesting().suffix(2).map(\.sessionId) == ["old-unseen", "new-boot"])
        let calls = runner.calls
        try #require(calls.count == 2)
        #expect(calls[0].prompt.contains(#""sessionId":"old-unseen""#))
        #expect(calls[1].prompt.contains(#""sessionId":"new-boot""#))
        let transition = try #require(second.gapsForTesting().last)
        #expect(transition.reason == "event_bus_boot_changed")
        #expect(transition.previousBootId != nil)
        #expect(transition.previousBootId != transition.bootId)
    }

    @Test func invalidIdentityAndCausalLoopEventsAreIgnored() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let runner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let coordinator = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            runTurn: runner.turnRunner
        )
        var invalidWorkspace = event(eventId: "invalid-workspace", sequence: 1)
        invalidWorkspace["workspace_id"] = "not-a-uuid"
        await coordinator.processForTesting(invalidWorkspace)
        await coordinator.processForTesting(
            event(
                eventId: "loop",
                sequence: 2,
                actionRequestId: "workbench-supervision:prior"
            )
        )
        await coordinator.processForTesting(
            event(
                eventId: "missing-source-identity",
                sequence: 3,
                sourceEventId: nil,
                sourceRevision: ""
            )
        )
        #expect(runner.calls.isEmpty)
        #expect(coordinator.receiptsForTesting().isEmpty)
    }

    @Test func queuedAdmissionsAreNeverEvictedByTerminalHistoryCap() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        var policy = WorkbenchSupervisionPolicy.dogfoodDefault
        policy.bossWatchEnabled = false
        policy.save(defaults: defaults)
        let coordinator = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            runTurn: TurnRecorder(response: #"{"disposition":"no_action"}"#).turnRunner
        )

        for index in 0...256 {
            await coordinator.processForTesting(
                event(
                    eventId: "queued-\(index)",
                    sequence: Int64(index + 1),
                    sourceEventId: "queued-\(index)",
                    sessionId: "copilot-\(index)",
                    sourceRevision: "\(index)",
                    causalChainId: "turn-\(index)"
                )
            )
        }

        #expect(coordinator.receiptsForTesting().count == 257)
        #expect(coordinator.receiptsForTesting().allSatisfy { $0.status == .queued })
    }

    @Test func ownedServerBuildsTokenScopedWebSocketURL() {
        let session = AgentChatOwnedServerSession(port: 1234, pid: 42, token: "token")
        #expect(session.webSocketURL.absoluteString == "ws://127.0.0.1:1234/token/ws")
    }

    private static let workspaceId = "11111111-1111-1111-1111-111111111111"
    private static let surfaceId = "22222222-2222-2222-2222-222222222222"

    private func event(
        name: String = "agent.hook.Stop",
        eventId: String,
        sequence: Int64,
        sourceEventId: String? = nil,
        actionRequestId: String? = nil,
        isError: Bool = false,
        sessionId: String = "copilot-session",
        sourceRevision: String = "revision-1",
        causalChainId: String = "turn-1"
    ) -> [String: Any] {
        [
            "name": name,
            "id": eventId,
            "seq": sequence,
            "boot_id": "boot",
            "source": "copilot",
            "occurred_at": "2026-09-04T00:00:00Z",
            "workspace_id": Self.workspaceId,
            "surface_id": Self.surfaceId,
            "payload": payload(
                sessionId: sessionId,
                sourceEventId: sourceEventId,
                actionRequestId: actionRequestId,
                isError: isError,
                sourceRevision: sourceRevision,
                causalChainId: causalChainId
            ),
        ]
    }

    private func payload(
        sessionId: String,
        sourceEventId: String?,
        actionRequestId: String? = nil,
        isError: Bool = false,
        sourceRevision: String = "revision-1",
        causalChainId: String = "turn-1"
    ) -> [String: Any] {
        [
            "session_id": sessionId,
            "workspace_id": Self.workspaceId,
            "surface_id": Self.surfaceId,
            "cwd": "/tmp",
            "_source_event_id": sourceEventId ?? NSNull(),
            "_source_revision": sourceRevision,
            "_causal_chain_id": causalChainId,
            "_action_request_id": actionRequestId ?? NSNull(),
            "is_error": isError,
            "phase": "received",
        ]
    }

    private func makeDefaults() throws -> UserDefaults {
        let name = "WorkbenchLocalSupervisionTests.\(UUID().uuidString)"
        return try #require(UserDefaults(suiteName: name))
    }

    private func clear(_ defaults: UserDefaults) {
        for key in defaults.dictionaryRepresentation().keys {
            defaults.removeObject(forKey: key)
        }
    }

    private func waitUntil(
        timeout: Duration = .seconds(2),
        condition: @escaping @Sendable () -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if condition() { return }
            try await clock.sleep(for: .milliseconds(20))
        }
        Issue.record("condition did not become true")
    }
}

private final class TurnRecorder: @unchecked Sendable {
    struct Call: Sendable {
        var requestId: String
        var prompt: String
        var cwd: String
    }

    private let lock = NSLock()
    private var recordedCalls: [Call] = []
    private let response: String

    init(response: String) {
        self.response = response
    }

    var calls: [Call] {
        lock.lock()
        defer { lock.unlock() }
        return recordedCalls
    }

    var turnRunner: WorkbenchLocalSupervisionCoordinator.TurnRunner {
        { [self] requestId, prompt, cwd in
            try await run(requestId: requestId, prompt: prompt, cwd: cwd)
        }
    }

    func run(requestId: String, prompt: String, cwd: String) async throws -> String {
        lock.withLock {
            recordedCalls.append(Call(requestId: requestId, prompt: prompt, cwd: cwd))
        }
        return response
    }
}

private final class SuspendedTurnRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var started = false
    private var calls = 0

    var hasStarted: Bool {
        lock.withLock { started }
    }

    var callCount: Int {
        lock.withLock { calls }
    }

    var turnRunner: WorkbenchLocalSupervisionCoordinator.TurnRunner {
        { [self] _, _, _ in
            let shouldSuspend = lock.withLock {
                calls += 1
                return calls == 1
            }
            if shouldSuspend {
                await withCheckedContinuation { continuation in
                    lock.withLock {
                        started = true
                        self.continuation = continuation
                    }
                }
            }
            return #"{"disposition":"no_action"}"#
        }
    }

    func resume() {
        let continuation = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            let pending = self.continuation
            self.continuation = nil
            return pending
        }
        continuation?.resume()
    }
}
