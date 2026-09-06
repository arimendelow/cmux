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

        var policy = WorkbenchSupervisionPolicy.dogfoodDefault
        policy.autonomyMode = .routine
        policy.humanMutationMode = .whenUnfocused
        #expect(!policy.allowsAutomatedLocalMutation(appIsActive: true))
        #expect(policy.allowsAutomatedLocalMutation(appIsActive: false))
        policy.humanMutationMode = .allowed
        #expect(policy.allowsAutomatedLocalMutation(appIsActive: true))
        policy.autonomyMode = .observeOnly
        #expect(!policy.allowsAutomatedLocalMutation(appIsActive: false))
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
        let guidance = WorkbenchSupervisionDispositionResult.parse(
            #"{"disposition":"draft_guidance","guidance":"continue with the shared helper"}"#
        )
        #expect(guidance?.disposition == .draftGuidance)
        #expect(guidance?.guidance == "continue with the shared helper")
        #expect(
            WorkbenchSupervisionDispositionResult.parse(
                #"{"disposition":"draft_guidance"}"#
            ) == nil
        )
    }

    @Test func localSessionProjectionTracksYieldedRevisionBoundedEvidenceAndInputEpoch() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let store = WorkbenchLocalSessionStateStore()
        let coordinator = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            evidenceProvider: { _ in
                WorkbenchSupervisionEvidence(
                    lastUserMessage: String(repeating: "u", count: 1_500),
                    assistantMessage: String(repeating: "a", count: 1_500)
                )
            },
            sessionStateStore: store,
            runTurn: TurnRecorder(response: #"{"disposition":"no_action"}"#).turnRunner
        )
        let workspaceId = try #require(UUID(uuidString: Self.workspaceId))
        let surfaceId = try #require(UUID(uuidString: Self.surfaceId))
        store.recordInput(
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            recordedAt: .distantPast
        )

        await coordinator.processForTesting(
            event(
                eventId: "yielded",
                sequence: 1,
                sourceEventId: "yielded",
                sourceRevision: "revision-yielded"
            )
        )

        let yielded = try #require(store.snapshot(workspaceId: workspaceId, surfaceId: surfaceId))
        #expect(yielded.phase == .yielded)
        #expect(yielded.sourceRevision == "revision-yielded")
        #expect(yielded.inputEpoch == 1)
        #expect(yielded.mutationEligible)
        #expect(yielded.evidence?.lastUserMessage?.count == 1_000)
        #expect(yielded.evidence?.assistantMessage?.count == 1_000)
        let draft = WorkbenchGuidanceDraft(
            requestId: "draft",
            sourceRevision: "revision-yielded",
            inputEpoch: 1,
            text: "continue"
        )
        #expect(
            store.storeGuidance(
                draft,
                workspaceId: workspaceId,
                surfaceId: surfaceId,
                sessionId: "copilot-session"
            )
        )
        await coordinator.processForTesting(
            event(
                eventId: "yielded-replay",
                sequence: 2,
                sourceEventId: "yielded",
                sourceRevision: "revision-yielded"
            )
        )
        #expect(
            store.snapshot(
                workspaceId: workspaceId,
                surfaceId: surfaceId
            )?.pendingGuidance == draft
        )

        await coordinator.processForTesting(
            event(
                name: "agent.hook.UserPromptSubmit",
                eventId: "active",
                sequence: 3,
                sourceEventId: "active",
                sourceRevision: "revision-active"
            )
        )

        let active = try #require(store.snapshot(workspaceId: workspaceId, surfaceId: surfaceId))
        #expect(active.phase == .active)
        #expect(active.sourceRevision == "revision-active")
        #expect(active.inputEpoch == 1)
    }

    @Test func localSessionProjectionPrefersSourceNativeSessionIdentity() throws {
        let store = WorkbenchLocalSessionStateStore()
        let workspaceId = try #require(UUID(uuidString: Self.workspaceId))
        let surfaceId = try #require(UUID(uuidString: Self.surfaceId))
        let lifecycle = event(
            name: "agent.hook.SessionStart",
            eventId: "native-session-start",
            sequence: 1,
            sourceEventId: "native-session-start",
            sessionId: "native-session"
        )

        store.observeLifecycleEvent(lifecycle)
        #expect(
            store.snapshot(
                workspaceId: workspaceId,
                surfaceId: surfaceId
            )?.sessionId == "native-session"
        )

        let stop = event(
            eventId: "native-stop",
            sequence: 2,
            sourceEventId: "native-stop",
            sessionId: "native-session"
        )
        let envelope = try #require(
            WorkbenchLocalSupervisionCoordinator.envelopeForTesting(stop)
        )
        #expect(envelope.sessionId == "native-session")
        #expect(envelope.workstreamId == "copilot-native-session")
        #expect(
            envelope.dedupeKey
                == "copilot\u{0}copilot-native-session\u{0}native-stop"
        )
    }

    @Test func recoveryHydratesReadOnlyProjectionBeforeReceiptDedupe() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let event = event(
            eventId: "recoverable",
            sequence: 1,
            sourceEventId: "recoverable",
            sourceRevision: "revision-recoverable"
        )
        let original = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            runTurn: TurnRecorder(response: #"{"disposition":"no_action"}"#).turnRunner
        )
        await original.processForTesting(event)
        #expect(original.receiptsForTesting().count == 1)

        let recoveredStore = WorkbenchLocalSessionStateStore()
        let recovered = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            sessionStateStore: recoveredStore,
            runTurn: { _, _, _ in
                Issue.record("persisted receipt dedupe must not rerun the Boss turn")
                return ""
            }
        )
        await recovered.processForTesting(
            event,
            mutationEligible: false
        )
        let workspaceId = try #require(UUID(uuidString: Self.workspaceId))
        let surfaceId = try #require(UUID(uuidString: Self.surfaceId))
        let projection = try #require(
            recoveredStore.snapshot(
                workspaceId: workspaceId,
                surfaceId: surfaceId
            )
        )
        #expect(projection.sourceRevision == "revision-recoverable")
        #expect(!projection.mutationEligible)
    }

    @Test func compareAndActClaimsRejectEveryStaleOrAmbiguousStateAndStayBounded() throws {
        let store = WorkbenchLocalSessionStateStore()
        let workspaceId = try #require(UUID(uuidString: Self.workspaceId))
        let surfaceId = try #require(UUID(uuidString: Self.surfaceId))
        func claim(
            requestId: String,
            targetSurfaceId: UUID? = nil,
            sessionId: String = "copilot-session",
            sourceRevision: String = "revision-1",
            inputEpoch: UInt64 = 0,
            phase: WorkbenchLocalSessionPhase = .yielded,
            requiresEvidence: Bool = false
        ) -> Result<Bool, WorkbenchLocalMutationFailure> {
            store.withMutationClaim(
                requestId: requestId,
                workspaceId: workspaceId,
                surfaceId: targetSurfaceId ?? surfaceId,
                sessionId: sessionId,
                sourceRevision: sourceRevision,
                inputEpoch: inputEpoch,
                requiredPhase: phase,
                requiresVerifiedEvidence: requiresEvidence
            ) { _ in
                true
            }
        }

        #expect(claim(requestId: "missing") == .failure(.targetUnavailable))

        let fractionalSurfaceId = UUID()
        store.recordInput(
            workspaceId: workspaceId,
            surfaceId: fractionalSurfaceId,
            recordedAt: .distantPast
        )
        store.observe(
            WorkbenchSupervisionEnvelope(
                id: "fractional",
                eventId: "fractional",
                eventSequence: 0,
                source: "copilot",
                sessionId: "fractional-session",
                workspaceId: workspaceId.uuidString,
                surfaceId: fractionalSurfaceId.uuidString,
                cwd: "/tmp",
                observation: .turnYielded,
                sourceEventId: "fractional-native",
                sourceRevision: "fractional-revision",
                causalChainId: "fractional-turn",
                actionRequestId: nil,
                toolName: nil,
                occurredAt: "2026-09-05T00:00:00.123Z",
                evidence: WorkbenchSupervisionEvidence(
                    lastUserMessage: "next",
                    assistantMessage: "waiting"
                )
            )
        )
        #expect(
            store.snapshot(
                workspaceId: workspaceId,
                surfaceId: fractionalSurfaceId
            )?.mutationEligible == true
        )

        let recoveredSurfaceId = UUID()
        store.observe(
            WorkbenchSupervisionEnvelope(
                id: "recovered",
                eventId: "recovered",
                eventSequence: 0,
                source: "copilot",
                sessionId: "recovered-session",
                workspaceId: workspaceId.uuidString,
                surfaceId: recoveredSurfaceId.uuidString,
                cwd: "/tmp",
                observation: .turnYielded,
                sourceEventId: "recovered-native",
                sourceRevision: "recovered-revision",
                causalChainId: "recovered-turn",
                actionRequestId: nil,
                toolName: nil,
                occurredAt: "2026-09-05T00:00:00Z",
                evidence: nil
            ),
            mutationEligible: false
        )
        #expect(
            claim(
                requestId: "recovered",
                targetSurfaceId: recoveredSurfaceId,
                sessionId: "recovered-session",
                sourceRevision: "recovered-revision"
            ) == .failure(.sourceStale)
        )

        let lateInputSurfaceId = UUID()
        store.recordInput(
            workspaceId: workspaceId,
            surfaceId: lateInputSurfaceId,
            recordedAt: .distantFuture
        )
        store.observe(
            WorkbenchSupervisionEnvelope(
                id: "late-input",
                eventId: "late-input",
                eventSequence: 1,
                source: "copilot",
                sessionId: "late-input-session",
                workspaceId: workspaceId.uuidString,
                surfaceId: lateInputSurfaceId.uuidString,
                cwd: "/tmp",
                observation: .turnYielded,
                sourceEventId: "late-input-native",
                sourceRevision: "late-input-revision",
                causalChainId: "late-input-turn",
                actionRequestId: nil,
                toolName: nil,
                occurredAt: "2026-09-05T00:00:00Z",
                evidence: WorkbenchSupervisionEvidence(
                    lastUserMessage: "next",
                    assistantMessage: "waiting"
                )
            )
        )
        #expect(
            claim(
                requestId: "late-input",
                targetSurfaceId: lateInputSurfaceId,
                sessionId: "late-input-session",
                sourceRevision: "late-input-revision",
                inputEpoch: 1,
                requiresEvidence: true
            ) == .failure(.sourceStale)
        )

        store.observe(
            WorkbenchSupervisionEnvelope(
                id: "yielded",
                eventId: "yielded",
                eventSequence: 1,
                source: "copilot",
                sessionId: "copilot-session",
                workspaceId: workspaceId.uuidString,
                surfaceId: surfaceId.uuidString,
                cwd: "/tmp",
                observation: .turnYielded,
                sourceEventId: "native-yielded",
                sourceRevision: "revision-1",
                causalChainId: "turn-1",
                actionRequestId: nil,
                toolName: nil,
                occurredAt: "2026-09-05T00:00:00Z",
                evidence: nil
            )
        )
        #expect(claim(requestId: "wrong-session", sessionId: "other-session") == .failure(.sessionMismatch))
        #expect(
            claim(
                requestId: "stale",
                sourceRevision: "revision-stale"
            ) == .failure(.sourceStale)
        )

        let first = store.withMutationClaim(
            requestId: "claim-1",
            workspaceId: workspaceId,
            surfaceId: surfaceId,
            sessionId: "copilot-session",
            sourceRevision: "revision-1",
            inputEpoch: 0,
            requiredPhase: .yielded
        ) { _ in
            let second = claim(requestId: "claim-2")
            #expect(second == .failure(.actionInFlight))
            return true
        }
        #expect(try first.get())
        store.recordInput(workspaceId: workspaceId, surfaceId: surfaceId)
        #expect(claim(requestId: "input-changed") == .failure(.inputChanged))
        #expect(
            claim(
                requestId: "fresh-inspection-after-input",
                inputEpoch: 1
            ) == .failure(.sourceStale)
        )

        store.observeLifecycleEvent(
            event(
                name: "agent.hook.UserPromptSubmit",
                eventId: "active",
                sequence: 2,
                sourceEventId: "active",
                sourceRevision: "revision-2"
            )
        )
        #expect(
            claim(
                requestId: "active",
                sourceRevision: "revision-2",
                inputEpoch: 1
            ) == .failure(.sessionNotYielded)
        )

        for index in 3...260 {
            let surface = UUID()
            store.observe(
                WorkbenchSupervisionEnvelope(
                    id: "bounded-\(index)",
                    eventId: "bounded-\(index)",
                    eventSequence: Int64(index),
                    source: "copilot",
                    sessionId: "session-\(index)",
                    workspaceId: workspaceId.uuidString,
                    surfaceId: surface.uuidString,
                    cwd: "/tmp",
                    observation: .turnYielded,
                    sourceEventId: "native-\(index)",
                    sourceRevision: "revision-\(index)",
                    causalChainId: "turn-\(index)",
                    actionRequestId: nil,
                    toolName: nil,
                    occurredAt: "2026-09-05T00:00:00Z",
                    evidence: nil
                )
            )
        }
        #expect(store.snapshots().count == 256)
    }

    @Test func ariAttentionRequiresSummaryAndInvokesTheNativeDispositionHandler() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let handled = TestLocked<[WorkbenchSupervisionDispositionResult]>([])
        let valid = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            dispositionHandler: { _, _, result, _ in
                handled.withLock { $0.append(result) }
                return true
            },
            runTurn: TurnRecorder(
                response: #"{"disposition":"ari_attention","summary":"Ari must choose the deployment target."}"#
            ).turnRunner
        )

        await valid.processForTesting(
            event(
                eventId: "attention-valid",
                sequence: 1,
                sourceEventId: "attention-valid",
                sessionId: "attention-valid"
            )
        )

        #expect(handled.withLock { $0.map(\.disposition) } == [.ariAttention])
        #expect(valid.receiptsForTesting().last?.status == .completed)

        let invalid = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            dispositionHandler: { _, _, _, _ in
                Issue.record("summary-less Ari attention must not reach the action plane")
                return true
            },
            runTurn: TurnRecorder(response: #"{"disposition":"ari_attention"}"#).turnRunner
        )
        await invalid.processForTesting(
            event(
                eventId: "attention-invalid",
                sequence: 2,
                sourceEventId: "attention-invalid",
                sessionId: "attention-invalid"
            )
        )
        #expect(invalid.receiptsForTesting().last?.status == .invalid)
        #expect(invalid.receiptsForTesting().last?.reasonCode == "boss_attention_summary_missing")

        let unroutable = WorkbenchLocalSupervisionCoordinator(
            defaults: defaults,
            dispositionHandler: { _, _, _, _ in false },
            runTurn: TurnRecorder(
                response: #"{"disposition":"ari_attention","summary":"Ari must inspect this worker."}"#
            ).turnRunner
        )
        await unroutable.processForTesting(
            event(
                eventId: "attention-unroutable",
                sequence: 3,
                sourceEventId: "attention-unroutable",
                sessionId: "attention-unroutable"
            )
        )
        #expect(unroutable.receiptsForTesting().last?.status == .failed)
        #expect(unroutable.receiptsForTesting().last?.reasonCode == "boss_disposition_route_failed")
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
        if let stopped = first.stop() {
            await stopped.value
        }

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
        try await waitUntil {
            second.receiptsForTesting().count == 2
                && secondRunner.calls.count == 1
        }
        #expect(secondRunner.calls.count == 1)
        #expect(second.receiptsForTesting().last?.observation == .sessionEnded)
    }

    @Test func aNewEventBusBootReplaysRetainedEventsInsteadOfTrustingTheOldSequence() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let firstBus = CmuxEventBus(retainedEventLimit: 16)
        let firstRunner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let first = WorkbenchLocalSupervisionCoordinator(
            bus: firstBus,
            defaults: defaults,
            runTurn: firstRunner.turnRunner
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
        try await waitUntil {
            first.receiptsForTesting().last?.status == .completed && firstRunner.calls.count == 1
        }
        if let stopped = first.stop() {
            await stopped.value
        }

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
        try await waitUntil {
            second.receiptsForTesting().count == 2 && newRunner.calls.count == 1
        }
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
            sessionId: "copilot-copilot-session",
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
        #expect(recovered.envelope.sessionId == "copilot-session")
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
        try await waitUntil {
            first.receiptsForTesting().last?.status == .completed && firstRunner.calls.count == 1
        }
        if let stopped = first.stop() {
            await stopped.value
        }

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

        try await waitUntil {
            second.receiptsForTesting().count == 3 && secondRunner.calls.count == 2
        }
        #expect(second.gapsForTesting().count == 1)
        #expect(secondRunner.calls.count == 2)
        #expect(second.receiptsForTesting().suffix(2).map(\.sessionId) == ["gap-recovered", "gap-3"])
    }

    @Test func eventBusBootChangeRecoversUnseenStateBeforeNewBootReplay() async throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let firstBus = CmuxEventBus(retainedEventLimit: 4)
        let firstRunner = TurnRecorder(response: #"{"disposition":"no_action"}"#)
        let first = WorkbenchLocalSupervisionCoordinator(
            bus: firstBus,
            defaults: defaults,
            runTurn: firstRunner.turnRunner
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
        try await waitUntil {
            first.receiptsForTesting().last?.status == .completed && firstRunner.calls.count == 1
        }
        if let stopped = first.stop() {
            await stopped.value
        }

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
            "session_id": "copilot-\(sessionId)",
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

@Suite("Workbench local actions", .serialized)
@MainActor
struct WorkbenchLocalActionTests {
    @Test func interruptStopAndResumeReuseGuardedReceiptsAndReadback() throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        var policy = WorkbenchSupervisionPolicy.dogfoodDefault
        policy.autonomyMode = .trusted
        policy.humanMutationMode = .allowed
        policy.save(defaults: defaults)
        let workspaceId = UUID()
        let surfaceId = UUID()
        let sessionId = "copilot-control"
        let store = WorkbenchLocalSessionStateStore()
        func observe(
            phase: WorkbenchSupervisionObservationKind,
            revision: String,
            epoch: UInt64
        ) {
            store.observe(
                WorkbenchSupervisionEnvelope(
                    id: revision,
                    eventId: revision,
                    eventSequence: Int64(epoch + 1),
                    source: "copilot",
                    sessionId: sessionId,
                    workspaceId: workspaceId.uuidString,
                    surfaceId: surfaceId.uuidString,
                    cwd: "/tmp",
                    observation: phase,
                    sourceEventId: revision,
                    sourceRevision: revision,
                    causalChainId: revision,
                    actionRequestId: nil,
                    toolName: nil,
                    occurredAt: "2099-01-01T00:00:00Z",
                    evidence: WorkbenchSupervisionEvidence(
                        lastUserMessage: "task",
                        assistantMessage: "working"
                    ),
                    inputEpoch: epoch
                )
            )
        }
        func params(
            requestId: String,
            revision: String,
            epoch: UInt64
        ) -> [String: Any] {
            [
                "request_id": requestId,
                "workspace_id": workspaceId.uuidString,
                "surface_id": surfaceId.uuidString,
                "session_id": sessionId,
                "expected_source_revision": revision,
                "expected_input_epoch": epoch,
            ]
        }

        observe(phase: .silenceThresholdCrossed, revision: "active-1", epoch: 0)
        let interrupted = WorkbenchLocalActionRouter.interrupt(
            params: params(requestId: "interrupt-1", revision: "active-1", epoch: 0),
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { workspace, surface, session in
                #expect(workspace == workspaceId)
                #expect(surface == surfaceId)
                #expect(session == sessionId)
                return true
            }
        )
        #expect(try successPayload(interrupted)["result_code"] as? String == "interrupt_sent")
        #expect(store.inputEpoch(workspaceId: workspaceId, surfaceId: surfaceId) == 1)

        observe(phase: .silenceThresholdCrossed, revision: "active-2", epoch: 1)
        let stopped = WorkbenchLocalActionRouter.stop(
            params: params(requestId: "stop-1", revision: "active-2", epoch: 1),
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { _, _, _ in true }
        )
        #expect(try successPayload(stopped)["result_code"] as? String == "stop_requested")
        #expect(store.inputEpoch(workspaceId: workspaceId, surfaceId: surfaceId) == 2)

        observe(phase: .sessionEnded, revision: "ended-1", epoch: 2)
        let resumed = WorkbenchLocalActionRouter.resume(
            params: params(requestId: "resume-1", revision: "ended-1", epoch: 2),
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { _, _, _ in true }
        )
        #expect(try successPayload(resumed)["result_code"] as? String == "resume_started")
        #expect(store.inputEpoch(workspaceId: workspaceId, surfaceId: surfaceId) == 3)

        let replay = WorkbenchLocalActionRouter.resume(
            params: params(requestId: "resume-1", revision: "ended-1", epoch: 2),
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in
                Issue.record("receipt replay must not re-evaluate authority")
                return nil
            },
            effect: { _, _, _ in
                Issue.record("receipt replay must not resume twice")
                return false
            }
        )
        #expect(try successPayload(replay)["replayed"] as? Bool == true)

        observe(phase: .turnYielded, revision: "yielded-1", epoch: 3)
        let inactive = WorkbenchLocalActionRouter.interrupt(
            params: params(requestId: "interrupt-idle", revision: "yielded-1", epoch: 3),
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { _, _, _ in false }
        )
        #expect(errorPayload(inactive)["result_code"] as? String == "session_not_active")

        let hub = WorkbenchLocalActionRouter.stop(
            params: params(requestId: "stop-hub", revision: "yielded-1", epoch: 3),
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledInAgencyHub },
            effect: { _, _, _ in false }
        )
        #expect(errorPayload(hub)["result_code"] as? String == "authority_denied")
    }

    @Test func inspectAndGuidanceUseExactRevisionEpochAuthorityAndIdempotency() throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let workspaceId = UUID()
        let surfaceId = UUID()
        let sessionId = "copilot-session"
        let store = WorkbenchLocalSessionStateStore()
        store.observe(
            WorkbenchSupervisionEnvelope(
                id: "yielded",
                eventId: "yielded",
                eventSequence: 1,
                source: "copilot",
                sessionId: sessionId,
                workspaceId: workspaceId.uuidString,
                surfaceId: surfaceId.uuidString,
                cwd: "/tmp",
                observation: .turnYielded,
                sourceEventId: "native-yielded",
                sourceRevision: "revision-1",
                causalChainId: "turn-1",
                actionRequestId: nil,
                toolName: nil,
                occurredAt: "2026-09-05T00:00:00Z",
                evidence: WorkbenchSupervisionEvidence(
                    lastUserMessage: "continue?",
                    assistantMessage: "I need the shared helper."
                )
            )
        )

        let inspect = WorkbenchLocalActionRouter.inspect(
            params: [
                "workspace_id": workspaceId.uuidString,
                "surface_id": surfaceId.uuidString,
            ],
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere }
        )
        let inspected = try successPayload(inspect)
        #expect(inspected["session_id"] as? String == sessionId)
        #expect(inspected["phase"] as? String == "yielded")
        #expect(inspected["source_revision"] as? String == "revision-1")
        #expect(inspected["input_epoch"] as? UInt64 == 0)
        #expect(inspected["authority"] as? String == "controlledHere")

        let draft = WorkbenchGuidanceDraft(
            requestId: "guidance-1",
            sourceRevision: "revision-1",
            inputEpoch: 0,
            text: "Use the shared helper and continue."
        )
        #expect(
            store.storeGuidance(
                draft,
                workspaceId: workspaceId,
                surfaceId: surfaceId,
                sessionId: sessionId
            )
        )
        let drafted = try successPayload(
            WorkbenchLocalActionRouter.inspect(
                params: [
                    "workspace_id": workspaceId.uuidString,
                    "surface_id": surfaceId.uuidString,
                ],
                stateStore: store,
                enabled: true,
                authority: { _, _, _ in .controlledHere }
            )
        )
        #expect(drafted["pending_guidance"] as? String == draft.text)

        let listed = WorkbenchLocalActionRouter.list(
            params: [:],
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere }
        )
        let listPayload = try successPayload(listed)
        let listedSessions = try #require(listPayload["sessions"] as? [[String: Any]])
        #expect(listedSessions.count == 1)
        #expect(listedSessions[0]["has_pending_guidance"] as? Bool == true)
        #expect(listedSessions[0]["pending_guidance"] == nil)

        let calls = TestLocked(0)
        let params: [String: Any] = [
            "request_id": "guidance-1",
            "workspace_id": workspaceId.uuidString,
            "surface_id": surfaceId.uuidString,
            "session_id": sessionId,
            "expected_source_revision": "revision-1",
            "expected_input_epoch": UInt64(0),
            "text": "Use the shared helper and continue.",
        ]
        #expect(errorCode(WorkbenchLocalActionRouter.sendGuidance(
            params: params,
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { _, _, _ in
                Issue.record("observe-only policy must block automated input")
                return true
            }
        )) == "policy_denied")
        var policy = WorkbenchSupervisionPolicy.dogfoodDefault
        policy.autonomyMode = .routine
        policy.humanMutationMode = .allowed
        policy.save(defaults: defaults)

        let sent = WorkbenchLocalActionRouter.sendGuidance(
            params: params,
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { workspace, surface, text in
                #expect(workspace == workspaceId)
                #expect(surface == surfaceId)
                #expect(text == "Use the shared helper and continue.")
                calls.withLock { $0 += 1 }
                store.recordInput(workspaceId: workspaceId, surfaceId: surfaceId)
                return true
            }
        )
        let sentPayload = try successPayload(sent)
        #expect(sentPayload["result_code"] as? String == "guidance_sent")
        #expect(sentPayload["input_epoch"] as? UInt64 == 1)
        let afterSend = try successPayload(
            WorkbenchLocalActionRouter.inspect(
                params: [
                    "workspace_id": workspaceId.uuidString,
                    "surface_id": surfaceId.uuidString,
                ],
                stateStore: store,
                enabled: true,
                authority: { _, _, _ in .controlledHere }
            )
        )
        #expect(afterSend["pending_guidance"] is NSNull)
        #expect(afterSend["mutation_eligible"] as? Bool == false)

        policy.autonomyMode = .observeOnly
        policy.humanMutationMode = .never
        policy.save(defaults: defaults)
        let replay = WorkbenchLocalActionRouter.sendGuidance(
            params: params,
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { _, _, _ in
                Issue.record("an exact replay must not send guidance twice")
                return false
            }
        )
        #expect(try successPayload(replay)["replayed"] as? Bool == true)
        #expect(calls.withLock { $0 } == 1)
        policy.autonomyMode = .routine
        policy.humanMutationMode = .allowed
        policy.save(defaults: defaults)

        let stale = WorkbenchLocalActionRouter.sendGuidance(
            params: params.merging(["request_id": "guidance-stale"]) { _, new in new },
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { _, _, _ in false }
        )
        #expect(errorPayload(stale)["result_code"] as? String == "input_changed")

        let staleRevision = WorkbenchLocalActionRouter.sendGuidance(
            params: params.merging([
                "request_id": "guidance-stale-revision",
                "expected_source_revision": "revision-stale",
                "expected_input_epoch": UInt64(1),
            ]) { _, new in new },
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { _, _, _ in false }
        )
        #expect(errorPayload(staleRevision)["result_code"] as? String == "source_stale")

        let hub = WorkbenchLocalActionRouter.sendGuidance(
            params: params.merging([
                "request_id": "guidance-hub",
                "expected_input_epoch": UInt64(1),
            ]) { _, new in new },
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledInAgencyHub },
            effect: { _, _, _ in false }
        )
        #expect(errorPayload(hub)["result_code"] as? String == "authority_denied")

        let noEvidenceSurfaceId = UUID()
        store.observe(
            WorkbenchSupervisionEnvelope(
                id: "no-evidence",
                eventId: "no-evidence",
                eventSequence: 2,
                source: "copilot",
                sessionId: "no-evidence-session",
                workspaceId: workspaceId.uuidString,
                surfaceId: noEvidenceSurfaceId.uuidString,
                cwd: "/tmp",
                observation: .turnYielded,
                sourceEventId: "no-evidence-native",
                sourceRevision: "no-evidence-revision",
                causalChainId: "no-evidence-turn",
                actionRequestId: nil,
                toolName: nil,
                occurredAt: "2026-09-05T00:00:00Z",
                evidence: nil
            )
        )
        let noEvidence = WorkbenchLocalActionRouter.sendGuidance(
            params: [
                "request_id": "guidance-no-evidence",
                "workspace_id": workspaceId.uuidString,
                "surface_id": noEvidenceSurfaceId.uuidString,
                "session_id": "no-evidence-session",
                "expected_source_revision": "no-evidence-revision",
                "expected_input_epoch": UInt64(0),
                "text": "continue",
            ],
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { _, _, _ in false }
        )
        #expect(errorPayload(noEvidence)["result_code"] as? String == "evidence_unavailable")

        store.observe(
            WorkbenchSupervisionEnvelope(
                id: "yielded-again",
                eventId: "yielded-again",
                eventSequence: 3,
                source: "copilot",
                sessionId: sessionId,
                workspaceId: workspaceId.uuidString,
                surfaceId: surfaceId.uuidString,
                cwd: "/tmp",
                observation: .turnYielded,
                sourceEventId: "native-yielded-again",
                sourceRevision: "revision-2",
                causalChainId: "turn-2",
                actionRequestId: nil,
                toolName: nil,
                occurredAt: "2099-01-01T00:00:00Z",
                evidence: WorkbenchSupervisionEvidence(
                    lastUserMessage: "continue?",
                    assistantMessage: "I still need the shared helper."
                ),
                inputEpoch: 1
            )
        )
        let revisedParams = params.merging([
            "expected_source_revision": "revision-2",
            "expected_input_epoch": UInt64(1),
        ]) { _, new in new }
        let deliveryFailed = WorkbenchLocalActionRouter.sendGuidance(
            params: revisedParams.merging([
                "request_id": "guidance-delivery-failed",
            ]) { _, new in new },
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { _, _, _ in false }
        )
        #expect(errorPayload(deliveryFailed)["result_code"] as? String == "delivery_failed")

        let readbackFailed = WorkbenchLocalActionRouter.sendGuidance(
            params: revisedParams.merging([
                "request_id": "guidance-readback-failed",
            ]) { _, new in new },
            defaults: defaults,
            stateStore: store,
            enabled: true,
            authority: { _, _, _ in .controlledHere },
            effect: { _, _, _ in true }
        )
        #expect(errorPayload(readbackFailed)["result_code"] as? String == "readback_failed")
    }

    @Test func focusIsWriteAheadIdempotentAndRejectsRequestReuse() throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let workspaceId = UUID()
        let surfaceId = UUID()
        let calls = TestLocked(0)
        let params: [String: Any] = [
            "request_id": "focus-1",
            "workspace_id": workspaceId.uuidString,
            "surface_id": surfaceId.uuidString,
        ]

        let first = WorkbenchLocalActionRouter.focus(
            params: params,
            defaults: defaults,
            enabled: true,
            effect: { workspace, surface in
                calls.withLock { $0 += 1 }
                return workspace == workspaceId && surface == surfaceId
            }
        )
        let firstPayload = try successPayload(first)
        #expect(firstPayload["status"] as? String == "completed")
        #expect(firstPayload["replayed"] as? Bool == false)

        let replay = WorkbenchLocalActionRouter.focus(
            params: params,
            defaults: defaults,
            enabled: true,
            effect: { _, _ in
                Issue.record("an exact replay must not repeat focus")
                return false
            }
        )
        #expect(try successPayload(replay)["replayed"] as? Bool == true)
        #expect(calls.withLock { $0 } == 1)

        let conflict = WorkbenchLocalActionRouter.focus(
            params: params.merging(["surface_id": UUID().uuidString]) { _, new in new },
            defaults: defaults,
            enabled: true,
            effect: { _, _ in false }
        )
        #expect(errorCode(conflict) == "request_conflict")

        let pendingParams = params.merging(["request_id": "focus-pending"]) { _, new in new }
        _ = WorkbenchLocalActionRouter.focus(
            params: pendingParams,
            defaults: defaults,
            enabled: true,
            effect: { _, _ in true }
        )
        let receiptData = try #require(defaults.data(forKey: WorkbenchLocalActionRouter.receiptDefaultsKey))
        var receipts = try JSONDecoder().decode([WorkbenchLocalActionReceipt].self, from: receiptData)
        let pendingIndex = try #require(receipts.firstIndex(where: { $0.requestId == "focus-pending" }))
        receipts[pendingIndex].status = .pending
        defaults.set(try JSONEncoder().encode(receipts), forKey: WorkbenchLocalActionRouter.receiptDefaultsKey)
        #expect(errorCode(WorkbenchLocalActionRouter.focus(
            params: pendingParams,
            defaults: defaults,
            enabled: true,
            effect: { _, _ in
                Issue.record("an interrupted action must not be retried implicitly")
                return true
            }
        )) == "action_outcome_unknown")
    }

    @Test func flagForReviewValidatesBoundsPersistsFailureAndReplaysSuccess() throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let workspaceId = UUID()
        let surfaceId = UUID()
        let params: [String: Any] = [
            "request_id": "review-1",
            "workspace_id": workspaceId.uuidString,
            "surface_id": surfaceId.uuidString,
            "summary": "Ari needs to choose a rollout ring.",
        ]
        let notificationId = UUID()

        let first = WorkbenchLocalActionRouter.flagForReview(
            params: params,
            defaults: defaults,
            enabled: true,
            effect: { requestId, workspace, surface, summary in
                #expect(requestId == "review-1")
                #expect(workspace == workspaceId)
                #expect(surface == surfaceId)
                #expect(summary == "Ari needs to choose a rollout ring.")
                return notificationId
            }
        )
        let payload = try successPayload(first)
        #expect(payload["notification_id"] as? String == notificationId.uuidString)

        let replay = WorkbenchLocalActionRouter.flagForReview(
            params: params,
            defaults: defaults,
            enabled: true,
            effect: { _, _, _, _ in
                Issue.record("an exact replay must not create another notification")
                return nil
            }
        )
        #expect(try successPayload(replay)["replayed"] as? Bool == true)

        let invalid = WorkbenchLocalActionRouter.flagForReview(
            params: params.merging([
                "summary": String(repeating: "x", count: 501),
                "unexpected": true,
            ]) { _, new in new },
            defaults: defaults,
            enabled: true,
            effect: { _, _, _, _ in nil }
        )
        #expect(errorCode(invalid) == "invalid_params")

        let failed = WorkbenchLocalActionRouter.flagForReview(
            params: params.merging(["request_id": "review-failed"]) { _, new in new },
            defaults: defaults,
            enabled: true,
            effect: { _, _, _, _ in nil }
        )
        #expect(errorCode(failed) == "action_failed")
        let failedReplay = WorkbenchLocalActionRouter.flagForReview(
            params: params.merging(["request_id": "review-failed"]) { _, new in new },
            defaults: defaults,
            enabled: true,
            effect: { _, _, _, _ in
                Issue.record("a failed durable request must not be retried implicitly")
                return notificationId
            }
        )
        #expect(errorCode(failedReplay) == "action_failed")

        let workspaceFlag = WorkbenchLocalActionRouter.flagForReview(
            params: [
                "request_id": "review-workspace",
                "workspace_id": workspaceId.uuidString,
                "summary": "Workspace-level review.",
            ],
            defaults: defaults,
            enabled: true,
            effect: { _, _, surface, _ in
                #expect(surface == nil)
                return UUID()
            }
        )
        #expect(try successPayload(workspaceFlag)["status"] as? String == "completed")
    }

    @Test func actionPlaneFailsClosedOutsideWorkbenchAndOnCorruptReceipts() throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let params: [String: Any] = [
            "request_id": "focus-closed",
            "workspace_id": UUID().uuidString,
            "surface_id": UUID().uuidString,
        ]

        #expect(errorCode(WorkbenchLocalActionRouter.focus(
            params: params,
            defaults: defaults,
            enabled: false,
            effect: { _, _ in true }
        )) == "unsupported")

        #expect(errorCode(WorkbenchLocalActionRouter.list(
            params: ["unexpected": true],
            stateStore: WorkbenchLocalSessionStateStore(),
            enabled: true,
            authority: { _, _, _ in .controlledHere }
        )) == "invalid_params")
        #expect(errorCode(WorkbenchLocalActionRouter.inspect(
            params: [
                "workspace_id": UUID().uuidString,
                "surface_id": UUID().uuidString,
            ],
            stateStore: WorkbenchLocalSessionStateStore(),
            enabled: true,
            authority: { _, _, _ in .controlledHere }
        )) == "target_unavailable")
        #expect(errorCode(WorkbenchLocalActionRouter.focus(
            params: params.merging(["unexpected": true]) { _, new in new },
            defaults: defaults,
            enabled: true,
            effect: { _, _ in true }
        )) == "invalid_params")
        #expect(errorCode(WorkbenchLocalActionRouter.flagForReview(
            params: [
                "request_id": "review-closed",
                "workspace_id": UUID().uuidString,
                "summary": "Review.",
            ],
            defaults: defaults,
            enabled: false,
            effect: { _, _, _, _ in UUID() }
        )) == "unsupported")
        #expect(errorCode(WorkbenchLocalActionRouter.flagForReview(
            params: [
                "request_id": "review-invalid-surface",
                "workspace_id": UUID().uuidString,
                "surface_id": "not-a-uuid",
                "summary": "Review.",
            ],
            defaults: defaults,
            enabled: true,
            effect: { _, _, _, _ in UUID() }
        )) == "invalid_params")

        defaults.set(Data("corrupt".utf8), forKey: WorkbenchLocalActionRouter.receiptDefaultsKey)
        #expect(errorCode(WorkbenchLocalActionRouter.focus(
            params: params,
            defaults: defaults,
            enabled: true,
            effect: { _, _ in true }
        )) == "receipt_store_unavailable")
    }

    @Test func liveActionEffectsFocusAndFlagTheExactSurface() throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let previousShared = AppDelegate.shared
        let app = previousShared ?? AppDelegate()
        let previousManager = app.tabManager
        let previousStore = app.notificationStore
        let store = TerminalNotificationStore.shared
        let manager = TabManager()
        AppDelegate.shared = app
        app.tabManager = manager
        app.notificationStore = store
        store.replaceNotificationsForTesting([])
        store.configureNotificationDeliveryHandlerForTesting { _, _ in }
        defer {
            store.replaceNotificationsForTesting([])
            store.resetNotificationDeliveryHandlerForTesting()
            app.tabManager = previousManager
            app.notificationStore = previousStore
            AppDelegate.shared = previousShared
        }
        let first = manager.addWorkspace(title: "First", select: true)
        let target = manager.addWorkspace(title: "Target", select: false)
        let surfaceId = try #require(target.focusedPanelId)
        #expect(manager.selectedTabId == first.id)

        let focus = WorkbenchLocalActionRouter.focus(
            params: [
                "request_id": "focus-live",
                "workspace_id": target.id.uuidString,
                "surface_id": surfaceId.uuidString,
            ],
            defaults: defaults,
            enabled: true
        )
        #expect(try successPayload(focus)["status"] as? String == "completed")
        #expect(manager.selectedTabId == target.id)
        #expect(target.focusedPanelId == surfaceId)

        let flag = WorkbenchLocalActionRouter.flagForReview(
            params: [
                "request_id": "review-live",
                "workspace_id": target.id.uuidString,
                "surface_id": surfaceId.uuidString,
                "summary": "Ari needs to inspect this worker.",
            ],
            defaults: defaults,
            enabled: true
        )
        let notificationIdString = try #require(successPayload(flag)["notification_id"] as? String)
        let notificationId = try #require(UUID(uuidString: notificationIdString))
        let notification = try #require(store.notifications.first(where: { $0.id == notificationId }))
        #expect(notification.tabId == target.id)
        #expect(notification.surfaceId == surfaceId)
        #expect(notification.body == "Ari needs to inspect this worker.")

        let missingTarget = WorkbenchLocalActionRouter.focus(
            params: [
                "request_id": "focus-missing",
                "workspace_id": UUID().uuidString,
                "surface_id": UUID().uuidString,
            ],
            defaults: defaults,
            enabled: true
        )
        #expect(errorCode(missingTarget) == "action_failed")
        let missingReviewTarget = WorkbenchLocalActionRouter.flagForReview(
            params: [
                "request_id": "review-missing",
                "workspace_id": UUID().uuidString,
                "summary": "Missing target.",
            ],
            defaults: defaults,
            enabled: true
        )
        #expect(errorCode(missingReviewTarget) == "action_failed")

        let completedSessionId = "completed-session"
        target.restoredAgentSnapshotsByPanelId[surfaceId] = SessionRestorableAgentSnapshot(
            kind: .copilot,
            sessionId: completedSessionId,
            workingDirectory: "/tmp",
            launchCommand: nil,
            workbenchAuthority: .controlledHere
        )
        target.restoredAgentResumeStatesByPanelId[surfaceId] = .completedAgentExit
        #expect(
            WorkbenchLocalActionRouter.liveAuthorityForTesting(
                workspaceId: target.id,
                surfaceId: surfaceId,
                sessionId: completedSessionId
            ) == nil
        )

        let hubResumeSnapshot = SessionRestorableAgentSnapshot(
            kind: .copilot,
            sessionId: completedSessionId,
            workingDirectory: "/tmp",
            launchCommand: nil,
            workbenchAuthority: nil
        )
        target.restoredAgentSnapshotsByPanelId[surfaceId] = hubResumeSnapshot
        target.restoredAgentResumeStatesByPanelId[surfaceId] = .manualResumeAvailable
        target.surfaceResumeBindingsByPanelId[surfaceId] = SurfaceResumeBindingSnapshot(
            name: "Copilot",
            kind: "copilot",
            command: "agency copilot --hub",
            cwd: "/tmp",
            checkpointId: completedSessionId,
            source: "agent-hook",
            launchCommand: AgentLaunchCommandSnapshot(
                launcher: "agency",
                executablePath: "/usr/local/bin/agency",
                arguments: ["agency", "copilot", "--hub"],
                workingDirectory: "/tmp"
            ),
            autoResume: false
        )
        let targetPanel = try #require(target.panels[surfaceId] as? TerminalPanel)
        #expect(
            targetPanel.enterAgentHibernation(
                agent: hubResumeSnapshot,
                lastActivityAt: .distantPast
            )
        )
        #expect(
            WorkbenchLocalActionRouter.liveResumeAuthorityForTesting(
                workspaceId: target.id,
                surfaceId: surfaceId,
                sessionId: completedSessionId
            ) == .controlledInAgencyHub
        )

        let existingRequestId = "review-existing"
        store.addNotification(
            tabId: target.id,
            surfaceId: surfaceId,
            title: "Boss",
            subtitle: "",
            body: "Already flagged.",
            cooldownKey: "workbench-action:\(existingRequestId)",
            cooldownInterval: .greatestFiniteMagnitude,
            resolvedHooks: []
        )
        let existing = try #require(store.notifications.first(where: {
            $0.correlationKey == "workbench-action:\(existingRequestId)"
        }))
        let existingResult = WorkbenchLocalActionRouter.flagForReview(
            params: [
                "request_id": existingRequestId,
                "workspace_id": target.id.uuidString,
                "surface_id": surfaceId.uuidString,
                "summary": "Already flagged.",
            ],
            defaults: defaults,
            enabled: true
        )
        #expect(try successPayload(existingResult)["notification_id"] as? String == existing.id.uuidString)

        #expect(errorCode(TerminalController.shared.v2WorkbenchFocus(params: [
            "request_id": "v2-disabled-focus",
            "workspace_id": target.id.uuidString,
            "surface_id": surfaceId.uuidString,
        ])) == "unsupported")
        #expect(errorCode(TerminalController.shared.v2WorkbenchFlagForReview(params: [
            "request_id": "v2-disabled-review",
            "workspace_id": target.id.uuidString,
            "summary": "Review.",
        ])) == "unsupported")
    }

    @Test func actionReceiptHistoryTrimsOnlyTerminalRecords() throws {
        let defaults = try makeDefaults()
        defer { clear(defaults) }
        let workspaceId = UUID()
        var receipts = (0..<256).map { index in
            WorkbenchLocalActionReceipt(
                requestId: "old-\(index)",
                fingerprint: "fingerprint-\(index)",
                action: .focus,
                workspaceId: workspaceId,
                surfaceId: UUID(),
                createdAt: Date(timeIntervalSince1970: TimeInterval(index)),
                status: .completed,
                resultCode: "focused",
                notificationId: nil
            )
        }
        receipts.append(
            WorkbenchLocalActionReceipt(
                requestId: "pending",
                fingerprint: "pending-fingerprint",
                action: .focus,
                workspaceId: workspaceId,
                surfaceId: UUID(),
                createdAt: Date(),
                status: .pending,
                resultCode: nil,
                notificationId: nil
            )
        )
        defaults.set(try JSONEncoder().encode(receipts), forKey: WorkbenchLocalActionRouter.receiptDefaultsKey)

        _ = WorkbenchLocalActionRouter.focus(
            params: [
                "request_id": "new",
                "workspace_id": workspaceId.uuidString,
                "surface_id": UUID().uuidString,
            ],
            defaults: defaults,
            enabled: true,
            effect: { _, _ in true }
        )

        let data = try #require(defaults.data(forKey: WorkbenchLocalActionRouter.receiptDefaultsKey))
        let trimmed = try JSONDecoder().decode([WorkbenchLocalActionReceipt].self, from: data)
        #expect(trimmed.count == 256)
        #expect(trimmed.contains(where: { $0.requestId == "pending" }))
        #expect(trimmed.contains(where: { $0.requestId == "new" }))
    }

    private func makeDefaults() throws -> UserDefaults {
        try #require(UserDefaults(suiteName: "WorkbenchLocalActionTests.\(UUID().uuidString)"))
    }

    private func clear(_ defaults: UserDefaults) {
        for key in defaults.dictionaryRepresentation().keys {
            defaults.removeObject(forKey: key)
        }
    }

    private func successPayload(_ result: TerminalController.V2CallResult) throws -> [String: Any] {
        guard case .ok(let raw) = result else {
            Issue.record("expected action success, got \(result)")
            return [:]
        }
        return try #require(raw as? [String: Any])
    }

    private func errorCode(_ result: TerminalController.V2CallResult) -> String? {
        guard case .err(let code, _, _) = result else { return nil }
        return code
    }

    private func errorPayload(_ result: TerminalController.V2CallResult) -> [String: Any] {
        guard case .err(_, _, let raw) = result else {
            Issue.record("expected action failure, got \(result)")
            return [:]
        }
        return (raw as? [String: Any]) ?? [:]
    }
}

private final class TestLocked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    func withLock<Result>(_ body: (inout Value) -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
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
