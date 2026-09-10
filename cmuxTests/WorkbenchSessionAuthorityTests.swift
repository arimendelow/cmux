import Foundation
import Testing
import Darwin
import CmuxControlSocket

#if canImport(cmux_DEV)
@testable import cmux_DEV
#elseif canImport(cmux)
@testable import cmux
#endif

@Suite("Workbench session authority")
struct WorkbenchSessionAuthorityTests {
    @Test func MissingAuthorityFailsClosedUntilAProducerAttestsOwnership() {
        let launch = AgentLaunchCommandSnapshot(
            launcher: "external-wrapper",
            executablePath: "/usr/local/bin/external-wrapper",
            arguments: ["external-wrapper", "agent"],
            workingDirectory: "/tmp"
        )

        #expect(WorkbenchSessionAuthority.resolved(
            agent: nil,
            binding: nil,
            missingAuthority: .unknown
        ) == .unknown)
        #expect(WorkbenchSessionAuthority.resolved(
            agent: SessionRestorableAgentSnapshot(
                kind: .copilot,
                sessionId: "11111111-1111-4111-8111-111111111111",
                workingDirectory: "/tmp",
                launchCommand: launch
            ),
            binding: nil,
            missingAuthority: .unknown
        ) == .unknown)
        #expect(!WorkbenchSessionAuthority.unknown.allowsLocalAutoResume(
            globalEnabled: true,
            wasRunning: true
        ))
    }

    @Test func GenericAuthorityRoundTripsAndLegacyValuesFailClosed() throws {
        let local = try JSONDecoder().decode(
            WorkbenchSessionAuthority.self,
            from: Data(#""controlledHere""#.utf8)
        )
        let external = try JSONDecoder().decode(
            WorkbenchSessionAuthority.self,
            from: Data(#""legacy-external-owner""#.utf8)
        )

        #expect(local == .controlledHere)
        #expect(external == .controlledExternally)
        #expect(String(data: try JSONEncoder().encode(external), encoding: .utf8) == #""controlledExternally""#)
    }

    @Test func LauncherAuthorityEvidenceRoundTripsAndLegacyBindingsRemainInferred() throws {
        let legacy = try JSONDecoder().decode(
            SurfaceResumeBindingSnapshot.self,
            from: Data(#"{"command":"copilot --resume legacy","workbenchAuthority":"controlledHere"}"#.utf8)
        )
        #expect(legacy.workbenchAuthorityEvidence == .inferred)

        let launcherOwned = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "stable-launcher --resume session",
            checkpointId: "session",
            source: "private-launcher",
            workbenchAuthority: .controlledHere,
            workbenchAuthorityEvidence: .launcherOwned
        )
        let decoded = try JSONDecoder().decode(
            SurfaceResumeBindingSnapshot.self,
            from: JSONEncoder().encode(launcherOwned)
        )
        #expect(decoded.workbenchAuthorityEvidence == .launcherOwned)
        #expect(decoded.isAgentHookBinding)
    }

    @Test func BindingAuthorityIsExplicitAndCanBeTakenOverOnlyByUserAction() {
        let sessionId = "22222222-2222-4222-8222-222222222222"
        let binding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "external-wrapper agent --resume \(sessionId)",
            checkpointId: sessionId,
            source: "agent-hook",
            workbenchAuthority: .controlledExternally
        )

        #expect(WorkbenchSessionAuthority.resolved(agent: nil, binding: binding) == .controlledExternally)
        #expect(WorkbenchSessionAuthority.localTakeoverSnapshot(agent: nil, binding: binding)?.workbenchAuthority == .controlledHere)
    }

    @Test func ReplacementBindingTakeoverTargetsTheReplacementSession() throws {
        var oldAgent = localSnapshot()
        oldAgent.workbenchAuthority = .controlledExternally
        let replacementSessionID = "33333333-3333-4333-8333-333333333333"
        let replacementBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "external-wrapper agent --resume \(replacementSessionID)",
            checkpointId: replacementSessionID,
            source: "agent-hook",
            workbenchAuthority: .controlledExternally
        )

        let takeover = try #require(
            WorkbenchSessionAuthority.localTakeoverSnapshot(
                agent: oldAgent,
                binding: replacementBinding
            )
        )

        #expect(takeover.sessionId == replacementSessionID)
        #expect(takeover.workbenchAuthority == .controlledHere)
    }

    @Test func NonAgentBindingsRemainLocalWhenWorkbenchAgentAuthorityIsUnknown() {
        let binding = SurfaceResumeBindingSnapshot(
            kind: "tmux",
            command: "tmux attach -t work",
            checkpointId: "work",
            source: "cli"
        )

        #expect(WorkbenchSessionAuthority.resolved(
            agent: nil,
            binding: binding,
            missingAuthority: .unknown
        ) == .controlledHere)
    }

    @Test func LocalAuthorityStillRequiresTheGlobalPreferenceAndRunningEvidence() {
        #expect(!WorkbenchSessionAuthority.controlledHere.allowsLocalAutoResume(
            globalEnabled: false,
            wasRunning: true
        ))
        #expect(!WorkbenchSessionAuthority.controlledHere.allowsLocalAutoResume(
            globalEnabled: true,
            wasRunning: false
        ))
        let local = localSnapshot()
        #expect(
            WorkbenchSessionAuthority.preservingExplicitLocalAuthority(
                observed: local,
                current: nil
            ).workbenchAuthority == nil
        )
        #expect(
            WorkbenchSessionAuthority.localTakeoverSnapshot(
                agent: local,
                binding: nil
            ) == nil
        )
        #expect(WorkbenchSessionAuthority.localTakeoverSnapshot(
            agent: nil,
            binding: SurfaceResumeBindingSnapshot(
                kind: "claude",
                command: "external-wrapper agent",
                checkpointId: "session",
                source: "agent-hook",
                workbenchAuthority: .controlledExternally
            )
        ) == nil)
        var wrongKind = local
        wrongKind.workbenchAuthority = .controlledExternally
        #expect(
            WorkbenchSessionAuthority.localTakeoverSnapshot(
                agent: wrongKind,
                binding: nil
            ) == nil
        )
    }

    @Test func LauncherBindingVerificationRequiresEveryTransportAndSessionProof() {
        let snapshot = localSnapshot()
        let target = WorkbenchLauncherBindingTarget(
            snapshot: snapshot,
            agentProcessIDs: [410]
        )
        let verifier = WorkbenchLauncherBindingVerifier(
            processIsDescendant: { caller, agent in
                caller == 420 && agent == 410
            }
        )
        let validEvidence = ControlCommandCallerEvidence(
            processID: 420,
            hasSameUserID: true,
            hasVerifiedSocketCapability: true
        )

        #expect(verifier.verifiedSnapshot(
            agentSessionID: snapshot.sessionId,
            callerEvidence: validEvidence,
            target: target
        )?.sessionId == snapshot.sessionId)
        #expect(verifier.verifiedSnapshot(
            agentSessionID: "different-session",
            callerEvidence: validEvidence,
            target: target
        ) == nil)
        #expect(verifier.verifiedSnapshot(
            agentSessionID: snapshot.sessionId,
            callerEvidence: ControlCommandCallerEvidence(
                processID: 420,
                hasSameUserID: false,
                hasVerifiedSocketCapability: true
            ),
            target: target
        ) == nil)
        #expect(verifier.verifiedSnapshot(
            agentSessionID: snapshot.sessionId,
            callerEvidence: ControlCommandCallerEvidence(
                processID: 420,
                hasSameUserID: true,
                hasVerifiedSocketCapability: false
            ),
            target: target
        ) == nil)
        #expect(verifier.verifiedSnapshot(
            agentSessionID: snapshot.sessionId,
            callerEvidence: ControlCommandCallerEvidence(
                processID: 421,
                hasSameUserID: true,
                hasVerifiedSocketCapability: true
            ),
            target: target
        ) == nil)
    }

    @Test func LauncherOwnedBindingsOutrankLowerTrustHookUpdatesAndClears() {
        let sessionID = "launcher-owned-session"
        let trusted = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "stable-launcher --resume \(sessionID)",
            checkpointId: sessionID,
            source: "private-launcher",
            autoResume: true,
            workbenchAuthority: .controlledHere,
            workbenchAuthorityEvidence: .launcherOwned
        )
        let inferred = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume \(sessionID)",
            checkpointId: sessionID,
            source: "agent-hook",
            autoResume: false,
            workbenchAuthority: .unknown
        )

        #expect(WorkbenchSessionAuthority.lowerTrustBindingCannotReplace(
            current: trusted,
            incoming: inferred
        ))
        let preserved =
            WorkbenchSessionAuthority.preservingExplicitLocalBindingAuthority(
                observed: inferred,
                current: trusted
            )
        #expect(preserved.command == trusted.command)
        #expect(preserved.workbenchAuthority == .controlledHere)
        #expect(preserved.workbenchAuthorityEvidence == .launcherOwned)
        #expect(preserved.autoResume == true)

        var staleLocalSnapshot = localSnapshot()
        staleLocalSnapshot.workbenchAuthority = .controlledHere
        var externallyAttested = trusted
        externallyAttested.workbenchAuthority = .controlledExternally
        externallyAttested.workbenchAuthorityEvidence = .launcherAttested
        #expect(WorkbenchSessionAuthority.resolved(
            agent: staleLocalSnapshot,
            binding: externallyAttested
        ) == .controlledExternally)
    }

    @MainActor
    @Test func SurfaceResumeSetAppliesVerifiedLauncherOwnershipAndAuthorityOnlyUpdates() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        defer { TerminalController.shared.setActiveTabManager(nil) }
        TerminalController.shared.setActiveTabManager(manager)
        let workspace = try #require(manager.selectedWorkspace)
        let panelID = try #require(workspace.focusedPanelId)
        let sessionID = "verified-launcher-session"
        workspace.restoredAgentSnapshotsByPanelId[panelID] =
            SessionRestorableAgentSnapshot(
                kind: .copilot,
                sessionId: sessionID,
                workingDirectory: "/tmp"
            )
        _ = workspace.recordAgentPID(
            key: "verified-launcher",
            pid: getpid(),
            panelId: panelID
        )
        let routing = ControlRoutingSelectors(
            hasWindowIDParam: false,
            windowID: nil,
            groupID: nil,
            workspaceID: workspace.id,
            surfaceID: panelID,
            paneID: nil
        )
        let callerEvidence = ControlCommandCallerEvidence(
            processID: getpid(),
            hasSameUserID: true,
            hasVerifiedSocketCapability: true
        )

        let local = TerminalController.shared.controlSurfaceResumeSet(
            routing: routing,
            explicitTargetID: panelID,
            hasResolvedWindowID: false,
            inputs: ControlSurfaceResumeSetInputs(
                name: "Boss worker",
                kind: "agent-session",
                command: "stable-launcher --resume \(sessionID)",
                cwd: "/tmp",
                checkpointID: sessionID,
                agentSessionID: sessionID,
                authority: .local,
                source: "private-launcher",
                environment: nil,
                launchCommand: nil,
                permissionMode: nil,
                autoResume: false,
                remoteWorkspaceID: nil,
                remoteRelayParameters: nil,
                callerEvidence: callerEvidence
            )
        )
        guard case .result = local else {
            Issue.record("expected verified local binding")
            return
        }
        let trusted = try #require(
            workspace.managedAgentResumeBinding(panelId: panelID)
        )
        #expect(trusted.command.contains("stable-launcher"))
        #expect(trusted.kind == "copilot")
        #expect(trusted.workbenchAuthority == .controlledHere)
        #expect(trusted.workbenchAuthorityEvidence == .launcherOwned)
        #expect(trusted.autoResume == true)

        let external = TerminalController.shared.controlSurfaceResumeSet(
            routing: routing,
            explicitTargetID: panelID,
            hasResolvedWindowID: false,
            inputs: ControlSurfaceResumeSetInputs(
                name: nil,
                kind: nil,
                command: nil,
                cwd: nil,
                checkpointID: nil,
                agentSessionID: sessionID,
                authority: .external,
                source: "private-launcher",
                environment: nil,
                launchCommand: nil,
                permissionMode: nil,
                autoResume: false,
                remoteWorkspaceID: nil,
                remoteRelayParameters: nil,
                callerEvidence: callerEvidence
            )
        )
        guard case .result = external else {
            Issue.record("expected authority-only update")
            return
        }
        let externallyControlled = try #require(
            workspace.managedAgentResumeBinding(panelId: panelID)
        )
        #expect(externallyControlled.command == trusted.command)
        #expect(externallyControlled.workbenchAuthority == .controlledExternally)
        #expect(externallyControlled.workbenchAuthorityEvidence == .launcherAttested)
        #expect(
            workspace.restoredAgentSnapshotsByPanelId[panelID]?
                .workbenchAuthority == .controlledExternally
        )

        let target = ControlSurfaceResumeTarget.workspace(
            tabManager: manager,
            workspace: workspace,
            surfaceID: panelID
        )
        #expect(target.bindingForClear(
            expectedCheckpointID: sessionID,
            expectedSource: "agent-hook",
            agentSessionEnded: false
        ) == nil)

        let rejected = TerminalController.shared.controlSurfaceResumeSet(
            routing: routing,
            explicitTargetID: panelID,
            hasResolvedWindowID: false,
            inputs: ControlSurfaceResumeSetInputs(
                name: nil,
                kind: nil,
                command: nil,
                cwd: nil,
                checkpointID: nil,
                agentSessionID: sessionID,
                authority: .unknown,
                source: "private-launcher",
                environment: nil,
                launchCommand: nil,
                permissionMode: nil,
                autoResume: false,
                remoteWorkspaceID: nil,
                remoteRelayParameters: nil,
                callerEvidence: ControlCommandCallerEvidence(
                    processID: getpid(),
                    hasSameUserID: true,
                    hasVerifiedSocketCapability: false
                )
            )
        )
        #expect(rejected == .authorityRejected)
    }

    @Test func ExternalAuthorityBlocksEveryLocalContinuationUntilExplicitTakeover() throws {
        var snapshot = localSnapshot()
        snapshot.workbenchAuthority = .controlledExternally

        #expect(snapshot.effectiveWorkbenchAuthority == .controlledExternally)
        #expect(!snapshot.effectiveWorkbenchAuthority.allowsLocalAutoResume(globalEnabled: true, wasRunning: true))
        #expect(snapshot.preparedResumeArguments(
            launchCommand: snapshot.launchCommand,
            workingDirectory: snapshot.workingDirectory,
            observedPermissionMode: nil
        ) == nil)
        #expect(snapshot.resumeCommand == nil)
        #expect(snapshot.resumeStartupInput() == nil)
        #expect(snapshot.forkCommand == nil)
        #expect(snapshot.forkStartupInput() == nil)

        snapshot.workbenchAuthority = .controlledHere
        #expect(snapshot.effectiveWorkbenchAuthority == .controlledHere)
        #expect(snapshot.effectiveWorkbenchAuthority.allowsLocalAutoResume(globalEnabled: true, wasRunning: true))
        #expect(snapshot.resumeCommand != nil)
        #expect(WorkbenchSessionAuthority.resolved(
            agent: snapshot,
            binding: SurfaceResumeBindingSnapshot(
                command: "external-wrapper agent",
                workbenchAuthority: .controlledExternally
            )
        ) == .controlledHere)
    }

    @Test func AuthorityRoundTripsAndLegacySnapshotsRemainUnknownWithoutAttestation() throws {
        var explicit = localSnapshot()
        explicit.workbenchAuthority = .controlledExternally
        let decoded = try JSONDecoder().decode(
            SessionRestorableAgentSnapshot.self,
            from: JSONEncoder().encode(explicit)
        )
        #expect(decoded.workbenchAuthority == .controlledExternally)

        let legacy = SessionRestorableAgentSnapshot(
            kind: .codex,
            sessionId: "11111111-1111-4111-8111-111111111111",
            workingDirectory: "/tmp",
            launchCommand: AgentLaunchCommandSnapshot(
                launcher: "external-wrapper",
                executablePath: "/usr/local/bin/external-wrapper",
                arguments: ["external-wrapper", "agent"],
                workingDirectory: "/tmp"
            )
        )
        let inferred = try JSONDecoder().decode(
            SessionRestorableAgentSnapshot.self,
            from: JSONEncoder().encode(legacy)
        )
        #expect(inferred.workbenchAuthority == nil)
        #expect(WorkbenchSessionAuthority.resolved(
            agent: inferred,
            binding: nil,
            missingAuthority: .unknown
        ) == .unknown)
    }

    @Test func AutosaveFingerprintIncludesAuthority() {
        let local = localSnapshot()
        var external = local
        external.workbenchAuthority = .controlledExternally

        #expect(
            TabManager.restorableAgentSnapshotFingerprint(local) !=
                TabManager.restorableAgentSnapshotFingerprint(external)
        )
    }

    @MainActor
    @Test func ProductionAutosaveFingerprintChangesForSnapshotOnlyTakeover() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        var external = SessionRestorableAgentSnapshot(
            kind: .copilot,
            sessionId: "77777777-7777-4777-8777-777777777777",
            workingDirectory: "/tmp",
            launchCommand: AgentLaunchCommandSnapshot(
                launcher: "copilot",
                executablePath: "/usr/local/bin/copilot",
                arguments: ["/usr/local/bin/copilot"],
                workingDirectory: "/tmp"
            )
        )
        external.workbenchAuthority = .controlledExternally
        workspace.restoredAgentSnapshotsByPanelId[panelId] = external
        workspace.restoredAgentResumeStatesByPanelId[panelId] = .manualResumeAvailable
        let before = manager.sessionAutosaveFingerprint()

        #expect(workspace.takeControlOfExternalSession(panelId: panelId) { _, _ in true })
        #expect(manager.sessionAutosaveFingerprint() != before)
    }

    @Test func HookIndexDoesNotInferAuthorityFromLaunchMetadata() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("workbench-external-authority-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: root) }
        let repo = root.appendingPathComponent("repo", isDirectory: true)
        let transcript = root.appendingPathComponent("rollout.jsonl")
        try fileManager.createDirectory(at: repo, withIntermediateDirectories: true)
        try #"{"type":"event_msg","payload":{"type":"task_complete"}}"#
            .write(to: transcript, atomically: true, encoding: .utf8)
        let sessionId = "33333333-3333-4333-8333-333333333333"
        let workspaceId = UUID()
        let panelId = UUID()
        let stateDirectory = root.appendingPathComponent(".cmuxterm", isDirectory: true)
        try fileManager.createDirectory(at: stateDirectory, withIntermediateDirectories: true)
        let record: [String: Any] = [
            "sessionId": sessionId,
            "workspaceId": workspaceId.uuidString,
            "surfaceId": panelId.uuidString,
            "cwd": repo.path,
            "pid": NSNull(),
            "transcriptPath": transcript.path,
            "updatedAt": 1,
            "launchCommand": [
                "launcher": "external-wrapper",
                "executablePath": "/usr/local/bin/external-wrapper",
                "arguments": ["external-wrapper", "agent"],
                "workingDirectory": repo.path,
                "capturedAt": 1,
                "source": "process",
            ],
        ]
        let data = try JSONSerialization.data(
            withJSONObject: ["version": 1, "sessions": [sessionId: record]],
            options: [.sortedKeys]
        )
        try data.write(
            to: stateDirectory.appendingPathComponent("copilot-hook-sessions.json"),
            options: .atomic
        )

        let snapshot = RestorableAgentSessionIndex.load(
            homeDirectory: root.path,
            fileManager: fileManager
        ).snapshot(workspaceId: workspaceId, panelId: panelId)
        #expect(snapshot?.kind == .copilot)
        #expect(snapshot?.workbenchAuthority == nil)
    }

    @MainActor
    @Test func WorkspaceRestoreKeepsAnExternalSessionManualWhenGlobalAutoResumeIsOn() throws {
        let defaults = UserDefaults.standard
        let key = AgentSessionAutoResumeSettings.autoResumeAgentSessionsKey
        let previous = defaults.object(forKey: key)
        defaults.set(true, forKey: key)
        defer {
            if let previous {
                defaults.set(previous, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }

        let source = Workspace()
        source.currentDirectory = "/tmp"
        let panelId = try #require(source.focusedPanelId)
        source.updatePanelDirectory(panelId: panelId, directory: "/tmp")
        var agent = localSnapshot()
        agent.workbenchAuthority = .controlledExternally
        source.updatePanelShellActivityState(panelId: panelId, state: .commandRunning)
        source.setRestoredAgentSnapshotForTesting(agent, panelId: panelId)
        let snapshot = source.sessionSnapshot(includeScrollback: false)
        let sourcePanel = try #require(snapshot.panels.first(where: { $0.id == panelId }))
        #expect(sourcePanel.terminal?.agent?.effectiveWorkbenchAuthority == .controlledExternally)

        let restored = Workspace()
        let restoredPanelId = try #require(restored.restoreSessionSnapshot(snapshot)[panelId])
        #expect(restored.restoredAgentResumeStatesByPanelId[restoredPanelId] == .manualResumeAvailable)
    }

    @MainActor
    @Test func ManualLocalRestoreRebindsWithoutInjectingStartupInput() throws {
        let suiteName = "workbench-manual-local-rebind-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.set(
            false,
            forKey: AgentSessionAutoResumeSettings.autoResumeAgentSessionsKey
        )
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let sessionID = "manual-local-rebind-session"
        let source = Workspace(agentSessionAutoResumeDefaults: defaults)
        let panelID = try #require(source.focusedPanelId)
        let agent = SessionRestorableAgentSnapshot(
            kind: .copilot,
            sessionId: sessionID,
            workingDirectory: "/tmp",
            workbenchAuthority: .controlledHere
        )
        let binding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume \(sessionID)",
            cwd: "/tmp",
            checkpointId: sessionID,
            source: "agent-hook",
            autoResume: true,
            workbenchAuthority: .controlledHere
        )
        source.restoredAgentSnapshotsByPanelId[panelID] = agent
        source.restoredAgentResumeStatesByPanelId[panelID] =
            .observedAgentCommandRunning
        source.surfaceResumeBindingsByPanelId[panelID] = binding
        source.managedAgentResumeBindingsByPanelId[panelID] = binding
        let snapshot = source.sessionSnapshot(includeScrollback: false)
        var resumeIntentCount = 0
        AgentChatTranscriptService.recordResumeIntentObserverForTesting = {
            observedSessionID,
            _,
            _ in
            if observedSessionID == sessionID {
                resumeIntentCount += 1
            }
        }
        defer {
            AgentChatTranscriptService.recordResumeIntentObserverForTesting = nil
        }

        let restored = Workspace(agentSessionAutoResumeDefaults: defaults)
        let restoredPanelID = try #require(
            restored.restoreSessionSnapshot(snapshot)[panelID]
        )

        #expect(
            restored.terminalPanel(for: restoredPanelID)?
                .surface.debugInitialInputForTesting() == nil
        )
        #expect(resumeIntentCount == 1)
        #expect(
            restored.restoredAgentResumeStatesByPanelId[restoredPanelID] ==
                .manualResumeAvailable
        )
    }

    @MainActor
    @Test func BindingOnlyExternalRestoreCannotBypassAuthority() throws {
        let defaults = UserDefaults.standard
        let key = AgentSessionAutoResumeSettings.autoResumeAgentSessionsKey
        let previous = defaults.object(forKey: key)
        defaults.set(true, forKey: key)
        defer {
            if let previous {
                defaults.set(previous, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }

        let source = Workspace()
        source.currentDirectory = "/tmp"
        let panelId = try #require(source.focusedPanelId)
        source.updatePanelDirectory(panelId: panelId, directory: "/tmp")
        source.updatePanelShellActivityState(panelId: panelId, state: .commandRunning)
        let sessionId = "22222222-2222-4222-8222-222222222222"
        let bindingIndex = SurfaceResumeBindingIndex(bindingsByPanel: [
            SurfaceResumeBindingIndex.PanelKey(workspaceId: source.id, panelId: panelId):
                SurfaceResumeBindingSnapshot(
                    name: "Copilot",
                    kind: "copilot",
                    command: "external-wrapper agent --resume \(sessionId)",
                    cwd: "/tmp",
                    checkpointId: sessionId,
                    source: "agent-hook",
                    launchCommand: AgentLaunchCommandSnapshot(
                        launcher: "external-wrapper",
                        executablePath: "/usr/local/bin/external-wrapper",
                        arguments: ["external-wrapper", "agent"],
                        workingDirectory: "/tmp"
                    ),
                    autoResume: true,
                    workbenchAuthority: .controlledExternally,
                    updatedAt: 1
                ),
        ])
        let snapshot = source.sessionSnapshot(
            includeScrollback: false,
            surfaceResumeBindingIndex: bindingIndex
        )
        let savedTerminal = try #require(
            snapshot.panels.first(where: { $0.id == panelId })?.terminal
        )
        #expect(savedTerminal.agent == nil)
        let savedBinding = try #require(savedTerminal.resumeBinding)
        #expect(savedBinding.workbenchAuthority == .controlledExternally)
        #expect(Workspace.surfaceResumeStartupInput(
            savedBinding,
            autoResumeAgentSessions: true,
            promptForApproval: false
        ) != nil)

        let restored = Workspace()
        let restoredPanelId = try #require(restored.restoreSessionSnapshot(snapshot)[panelId])
        let restoredPanel = try #require(restored.terminalPanel(for: restoredPanelId))
        #expect(!restoredPanel.surface.debugInitialInputMetadata().hasInitialInput)
        #expect(restored.restoredAgentResumeStatesByPanelId[restoredPanelId] != .awaitingAutoResumeCommand)
        #expect(restored.restoredAgentResumeStatesByPanelId[restoredPanelId] != .autoResumeCommandRunning)
        restored.updatePanelShellActivityState(panelId: restoredPanelId, state: .promptIdle)
        let restoredBinding = try #require(
            restored.surfaceResumeBindingsByPanelId[restoredPanelId]
        )
        #expect(restoredBinding.workbenchAuthority == .controlledExternally)
        #expect(restored.restoredAgentResumeStatesByPanelId[restoredPanelId] == nil)
        #expect(restored.canTakeControlOfExternalSession(panelId: restoredPanelId))
        #expect(restored.takeControlOfExternalSession(panelId: restoredPanelId) { _, _ in true })
    }

    @MainActor
    @Test func DockBindingOnlyExternalRestoreCannotBypassAuthority() throws {
        let suiteName = "WorkbenchSessionAuthorityTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(true, forKey: AgentSessionAutoResumeSettings.autoResumeAgentSessionsKey)
        let savedPanelId = UUID()
        let sessionId = "44444444-4444-4444-8444-444444444444"
        let binding = SurfaceResumeBindingSnapshot(
            name: "Copilot",
            kind: "copilot",
            command: "external-wrapper agent --resume \(sessionId)",
            cwd: "/tmp",
            checkpointId: sessionId,
            source: "agent-hook",
            launchCommand: AgentLaunchCommandSnapshot(
                launcher: "external-wrapper",
                executablePath: "/usr/local/bin/external-wrapper",
                arguments: ["external-wrapper", "agent"],
                workingDirectory: "/tmp"
            ),
            autoResume: true,
            workbenchAuthority: .controlledExternally,
            updatedAt: 1
        )
        let panelSnapshot = SessionPanelSnapshot(
            id: savedPanelId,
            type: .terminal,
            title: "Externally controlled",
            customTitle: nil,
            directory: "/tmp",
            isPinned: false,
            isManuallyUnread: false,
            gitBranch: nil,
            listeningPorts: [],
            ttyName: nil,
            terminal: SessionTerminalPanelSnapshot(
                workingDirectory: "/tmp",
                agent: nil,
                resumeBinding: binding,
                wasAgentRunning: true
            ),
            browser: nil,
            markdown: nil,
            filePreview: nil,
            rightSidebarTool: nil,
            project: nil
        )
        let store = DockSplitStore(
            workspaceId: UUID(),
            baseDirectoryProvider: { nil },
            agentSessionAutoResumeDefaults: defaults
        )
        defer { store.closeAllPanels() }

        let restoredPanelId = try #require(store.restoreSessionSnapshot(
            SessionSplitContainerSnapshot(
                focusedPanelId: savedPanelId,
                layout: .pane(SessionPaneLayoutSnapshot(
                    panelIds: [savedPanelId],
                    selectedPanelId: savedPanelId
                )),
                panels: [panelSnapshot]
            )
        )[savedPanelId])
        #expect(
            store.restoredAgentLifecycle.resumeStatesByPanelId[restoredPanelId] ==
                .manualResumeAvailable
        )
        var sent = ""
        #expect(store.canTakeControlOfExternalSession(panelId: restoredPanelId))
        #expect(store.takeControlOfExternalSession(panelId: restoredPanelId) { _, input in
            sent = input
            return true
        })
        #expect(sent.contains("copilot"))
        #expect(sent.contains("--resume"))
        #expect(
            store.restoredAgentLifecycle.snapshotsByPanelId[restoredPanelId]?
                .workbenchAuthority == .controlledHere
        )
        let localBinding = try #require(
            store.surfaceResumeBinding(panelId: restoredPanelId)
        )
        #expect(localBinding.checkpointId == sessionId)
        #expect(localBinding.workbenchAuthority == .controlledHere)
        #expect(localBinding.launchCommand == nil)
        #expect(
            store.managedAgentResumeBinding(panelId: restoredPanelId) ==
                localBinding
        )
    }

    @MainActor
    @Test func DockRestoreUsesProtectedManagedAgentHookBinding() throws {
        let suiteName = "workbench-dock-protected-restore-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.set(true, forKey: AgentSessionAutoResumeSettings.autoResumeAgentSessionsKey)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let savedPanelID = UUID()
        let sessionID = "dock-protected-session"
        let safeManagedBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume \(sessionID)",
            cwd: "/tmp/safe",
            checkpointId: sessionID,
            source: "agent-hook",
            autoResume: true,
            workbenchAuthority: .controlledHere
        )
        let observedEffectiveBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "external-wrapper agent --resume \(sessionID)",
            cwd: "/tmp/observed",
            checkpointId: sessionID,
            source: "agent-hook",
            launchCommand: AgentLaunchCommandSnapshot(
                launcher: "external-wrapper",
                executablePath: "/usr/local/bin/external-wrapper",
                arguments: ["external-wrapper", "agent"],
                workingDirectory: "/tmp/observed"
            ),
            autoResume: true,
            workbenchAuthority: .unknown
        )
        let panelSnapshot = SessionPanelSnapshot(
            id: savedPanelID,
            type: .terminal,
            title: "Dock protected restore",
            directory: "/tmp/safe",
            isPinned: false,
            isManuallyUnread: false,
            gitBranch: nil,
            listeningPorts: [],
            ttyName: nil,
            terminal: SessionTerminalPanelSnapshot(
                workingDirectory: "/tmp/safe",
                agent: SessionRestorableAgentSnapshot(
                    kind: .copilot,
                    sessionId: sessionID,
                    workingDirectory: "/tmp/safe",
                    workbenchAuthority: .controlledHere
                ),
                resumeBinding: observedEffectiveBinding,
                managedAgentResumeBinding: safeManagedBinding,
                wasAgentRunning: true
            ),
            browser: nil,
            markdown: nil,
            filePreview: nil,
            rightSidebarTool: nil,
            project: nil
        )
        let store = DockSplitStore(
            workspaceId: UUID(),
            baseDirectoryProvider: { nil },
            agentSessionAutoResumeDefaults: defaults
        )
        defer { store.closeAllPanels() }
        let restoredPanelID = try #require(store.restoreSessionSnapshot(
            SessionSplitContainerSnapshot(
                focusedPanelId: savedPanelID,
                layout: .pane(
                    SessionPaneLayoutSnapshot(
                        panelIds: [savedPanelID],
                        selectedPanelId: savedPanelID
                    )
                ),
                panels: [panelSnapshot]
            )
        )[savedPanelID])
        let initialInput = try #require(
            (store.panels[restoredPanelID] as? TerminalPanel)?
                .surface.debugInitialInputForTesting()
        )

        #expect(initialInput.contains("copilot"))
        #expect(!initialInput.contains("external-wrapper"))
        let restoredManagedBinding = try #require(
            store.managedAgentResumeBinding(panelId: restoredPanelID)
        )
        #expect(restoredManagedBinding.checkpointId == sessionID)
        #expect(restoredManagedBinding.workbenchAuthority == .controlledHere)
        #expect(restoredManagedBinding.launchCommand == nil)
        #expect(!restoredManagedBinding.command.contains("external-wrapper"))
    }

    @MainActor
    @Test func ExplicitLocalTakeoverResumesRawCopilotAndPersistsTheAuthorityChange() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let sessionId = "55555555-5555-4555-8555-555555555555"
        let externalLaunch = AgentLaunchCommandSnapshot(
            launcher: "copilot",
            executablePath: "/usr/local/bin/copilot",
            arguments: ["/usr/local/bin/copilot", "--no-auto-update"],
            workingDirectory: "/tmp"
        )
        workspace.restoredAgentSnapshotsByPanelId[panelId] = SessionRestorableAgentSnapshot(
            kind: .copilot,
            sessionId: sessionId,
            workingDirectory: "/tmp",
            launchCommand: externalLaunch,
            workbenchAuthority: .controlledExternally
        )
        workspace.restoredAgentResumeStatesByPanelId[panelId] = .manualResumeAvailable
        workspace.surfaceResumeBindingsByPanelId[panelId] = SurfaceResumeBindingSnapshot(
            name: "Copilot",
            kind: "copilot",
            command: "external-wrapper agent --resume \(sessionId)",
            cwd: "/tmp",
            checkpointId: sessionId,
            source: "agent-hook",
            launchCommand: externalLaunch,
            autoResume: true,
            workbenchAuthority: .controlledExternally
        )
        var sent = ""

        #expect(workspace.canTakeControlOfExternalSession(panelId: panelId))
        #expect(workspace.takeControlOfExternalSession(panelId: panelId) { _, input in
            sent = input
            return true
        })
        #expect(sent.contains("copilot"))
        #expect(sent.contains("--resume"))
        #expect(!sent.contains("external-wrapper"))
        #expect(
            workspace.restoredAgentSnapshotsByPanelId[panelId]?.workbenchAuthority ==
                .controlledHere
        )
        #expect(workspace.restoredAgentSnapshotsByPanelId[panelId]?.launchCommand == nil)
        let localBinding = try #require(
            workspace.surfaceResumeBindingsByPanelId[panelId]
        )
        #expect(localBinding.checkpointId == sessionId)
        #expect(localBinding.workbenchAuthority == .controlledHere)
        #expect(localBinding.launchCommand == nil)
        #expect(!localBinding.command.contains("external-wrapper"))
        #expect(workspace.setSurfaceResumeBinding(
            SurfaceResumeBindingSnapshot(
                name: "Refreshed Copilot",
                kind: "copilot",
                command: "external-wrapper agent --resume \(sessionId)",
                cwd: "/tmp/refreshed",
                checkpointId: sessionId,
                source: "agent-hook",
                launchCommand: externalLaunch,
                permissionMode: "acceptEdits",
                autoResume: true,
                workbenchAuthority: .unknown,
                updatedAt: 99
            ),
            panelId: panelId
        ))
        let refreshedBinding = try #require(
            workspace.managedAgentResumeBinding(panelId: panelId)
        )
        #expect(refreshedBinding.name == "Refreshed Copilot")
        #expect(refreshedBinding.cwd == "/tmp/refreshed")
        #expect(refreshedBinding.permissionMode == "acceptEdits")
        #expect(refreshedBinding.updatedAt == 99)
        #expect(refreshedBinding.workbenchAuthority == .controlledHere)
        #expect(refreshedBinding.launchCommand == nil)
        #expect(!refreshedBinding.command.contains("external-wrapper"))
        #expect(refreshedBinding.command.contains("/tmp/refreshed"))
        let selectorTarget = ControlSurfaceResumeTarget.workspace(
            tabManager: TabManager(autoWelcomeIfNeeded: false),
            workspace: workspace,
            surfaceID: panelId
        )
        let unqualifiedBinding = selectorTarget.bindingForGet(
            expectedKind: nil,
            expectedCheckpointID: nil
        )
        #expect(unqualifiedBinding?.command.contains("external-wrapper") == true)
        #expect(
            selectorTarget.protectedRestoreBinding(
                selectedBinding: unqualifiedBinding
            ) == refreshedBinding
        )
        #expect(
            selectorTarget.bindingForGet(
                expectedKind: "copilot",
                expectedCheckpointID: sessionId
            ) == refreshedBinding
        )
        #expect(
            workspace.restoredAgentResumeStatesByPanelId[panelId] ==
                .awaitingAutoResumeCommand
        )

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("workbench-takeover-persistence-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let transcript = root.appendingPathComponent("events.jsonl")
        let stateDirectory = root.appendingPathComponent(".cmuxterm", isDirectory: true)
        try FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true)
        try #"{"type":"event_msg","payload":{"type":"task_complete"}}"#
            .write(to: transcript, atomically: true, encoding: .utf8)
        let hookRecord: [String: Any] = [
            "sessionId": sessionId,
            "workspaceId": workspace.id.uuidString,
            "surfaceId": panelId.uuidString,
            "cwd": "/tmp",
            "pid": NSNull(),
            "transcriptPath": transcript.path,
            "updatedAt": 2,
            "launchCommand": [
                "launcher": "copilot",
                "executablePath": "/usr/local/bin/copilot",
                "arguments": ["/usr/local/bin/copilot", "--no-auto-update"],
                "workingDirectory": "/tmp",
                "capturedAt": 2,
                "source": "process",
            ],
        ]
        let hookData = try JSONSerialization.data(
            withJSONObject: ["version": 1, "sessions": [sessionId: hookRecord]]
        )
        try hookData.write(
            to: stateDirectory.appendingPathComponent("copilot-hook-sessions.json"),
            options: .atomic
        )
        workspace.restoredAgentResumeStatesByPanelId[panelId] =
            .observedAgentCommandRunning
        workspace.panelShellActivityStates[panelId] = .commandRunning
        workspace.terminalPanel(for: panelId)?.updateShellActivityState(
            .commandRunning
        )
        let persisted = workspace.sessionSnapshot(
            includeScrollback: false,
            restorableAgentIndex: RestorableAgentSessionIndex.load(
                homeDirectory: root.path,
                fileManager: .default
            )
        )
        let persistedAgent = try #require(
            persisted.panels.first(where: { $0.id == panelId })?.terminal?.agent
        )
        #expect(persistedAgent.workbenchAuthority == .controlledHere)
        #expect(persistedAgent.launchCommand == nil)
        let restoreDefaultsName = "workbench-protected-takeover-\(UUID().uuidString)"
        let restoreDefaults = try #require(
            UserDefaults(suiteName: restoreDefaultsName)
        )
        restoreDefaults.set(
            true,
            forKey: AgentSessionAutoResumeSettings.autoResumeAgentSessionsKey
        )
        defer {
            restoreDefaults.removePersistentDomain(
                forName: restoreDefaultsName
            )
        }
        let protectedRestore = Workspace(
            agentSessionAutoResumeDefaults: restoreDefaults
        )
        let protectedPanelID = try #require(
            protectedRestore.restoreSessionSnapshot(persisted)[panelId]
        )
        let protectedInput = try #require(
            protectedRestore.terminalPanel(for: protectedPanelID)?
                .surface.debugInitialInputForTesting()
        )
        #expect(protectedInput.contains("copilot"))
        #expect(!protectedInput.contains("external-wrapper"))

        workspace.restoredAgentSnapshotsByPanelId[panelId]?.workbenchAuthority =
            .controlledExternally
        workspace.restoredAgentResumeStatesByPanelId[panelId] = .manualResumeAvailable
        workspace.surfaceResumeBindingsByPanelId[panelId] = SurfaceResumeBindingSnapshot(
            command: "external-wrapper agent",
            launchCommand: externalLaunch,
            workbenchAuthority: .controlledExternally
        )
        #expect(!workspace.takeControlOfExternalSession(panelId: panelId) { _, _ in false })
        #expect(
            workspace.restoredAgentSnapshotsByPanelId[panelId]?.workbenchAuthority ==
                .controlledExternally
        )
        #expect(workspace.surfaceResumeBindingsByPanelId[panelId] != nil)
    }

    @MainActor
    @Test func BindingOnlyWorkspaceExternalSessionCanBeTakenOverExplicitly() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let sessionId = "66666666-6666-4666-8666-666666666666"
        workspace.restoredAgentResumeStatesByPanelId[panelId] = .manualResumeAvailable
        workspace.surfaceResumeBindingsByPanelId[panelId] = SurfaceResumeBindingSnapshot(
            name: "Copilot",
            kind: "copilot",
            command: "copilot --resume \(sessionId)",
            cwd: nil,
            checkpointId: sessionId,
            source: "agent-hook",
            launchCommand: AgentLaunchCommandSnapshot(
                launcher: "copilot",
                executablePath: "/usr/local/bin/copilot",
                arguments: ["/usr/local/bin/copilot", "--no-auto-update"],
                workingDirectory: "/tmp"
            ),
            autoResume: true,
            workbenchAuthority: .controlledExternally
        )

        #expect(workspace.canTakeControlOfExternalSession(panelId: panelId))
        #expect(workspace.takeControlOfExternalSession(panelId: panelId) { _, _ in true })
        #expect(
            workspace.restoredAgentSnapshotsByPanelId[panelId]?.workbenchAuthority ==
                .controlledHere
        )
        let localBinding = try #require(
            workspace.surfaceResumeBindingsByPanelId[panelId]
        )
        #expect(localBinding.checkpointId == sessionId)
        #expect(localBinding.workbenchAuthority == .controlledHere)
    }

    @MainActor
    @Test func ReplacementWorkspaceBindingCanTakeOverTheReplacementSession() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let terminal = try #require(workspace.terminalPanel(for: panelId))
        let replacementSessionID = "77777777-7777-4777-8777-777777777778"
        workspace.restoredAgentSnapshotsByPanelId[panelId] =
            SessionRestorableAgentSnapshot(
                kind: .copilot,
                sessionId: "superseded-session",
                workbenchAuthority: .controlledExternally
            )
        workspace.restoredAgentResumeStatesByPanelId[panelId] = .completedAgentExit
        workspace.panelShellActivityStates[panelId] = .promptIdle
        terminal.updateShellActivityState(.promptIdle)
        workspace.surfaceResumeBindingsByPanelId[panelId] =
            SurfaceResumeBindingSnapshot(
                kind: "copilot",
                command: "copilot --resume \(replacementSessionID)",
                checkpointId: replacementSessionID,
                source: "agent-hook",
                workbenchAuthority: .controlledExternally
            )
        let staleRuntimeKey = "copilot.superseded-session"
        let processID = getpid()
        let processIdentity = try #require(AgentPIDProcessIdentity(pid: processID))
        workspace.agentPIDs[staleRuntimeKey] = processID
        workspace.agentPIDProcessIdentitiesByKey[staleRuntimeKey] = processIdentity
        workspace.agentPIDPanelIdsByKey[staleRuntimeKey] = panelId
        workspace.agentPIDKeysByPanelId[panelId] = [staleRuntimeKey]
        var sent = ""

        #expect(workspace.canTakeControlOfExternalSession(panelId: panelId))
        #expect(workspace.takeControlOfExternalSession(panelId: panelId) { _, input in
            sent = input
            return true
        })
        #expect(sent.contains(replacementSessionID))
        #expect(workspace.restoredAgentSnapshotsByPanelId[panelId]?.sessionId == replacementSessionID)
        #expect(
            workspace.restoredAgentSnapshotsByPanelId[panelId]?.workbenchAuthority ==
                .controlledHere
        )
        #expect(workspace.agentPIDKeysByPanelId[panelId] == nil)
        #expect(workspace.agentPIDs[staleRuntimeKey] == nil)
        let tmuxBinding = SurfaceResumeBindingSnapshot(
            kind: "tmux",
            command: "tmux attach-session -t workbench",
            checkpointId: "workbench",
            source: "process-detected",
            autoResume: true
        )
        workspace.reconcileSurfaceResumeBindings(
            using: SurfaceResumeBindingIndex(bindingsByPanel: [
                .init(workspaceId: workspace.id, panelId: panelId): tmuxBinding,
            ])
        )
        #expect(workspace.surfaceResumeBinding(panelId: panelId) == tmuxBinding)
        #expect(
            workspace.managedAgentResumeBinding(panelId: panelId)?.checkpointId ==
                replacementSessionID
        )
        #expect(
            workspace.restoredAgentResumeStatesByPanelId[panelId] ==
                .awaitingAutoResumeCommand
        )
        #expect(workspace.restoredAgentLifecycle.startupInput(panelId: panelId) != nil)
        #expect(workspace.setSurfaceResumeBinding(
            SurfaceResumeBindingSnapshot(
                kind: "copilot",
                command: "copilot --resume \(replacementSessionID)",
                checkpointId: replacementSessionID,
                source: "agent-hook",
                workbenchAuthority: .unknown
            ),
            panelId: panelId
        ))
        #expect(
            workspace.restoredAgentResumeStatesByPanelId[panelId] ==
                .awaitingAutoResumeCommand
        )
        #expect(workspace.restoredAgentLifecycle.startupInput(panelId: panelId) != nil)
        workspace.reconcileSurfaceResumeBindings(
            using: SurfaceResumeBindingIndex(bindingsByPanel: [
                .init(workspaceId: workspace.id, panelId: panelId): tmuxBinding,
            ])
        )
        let staleIndex = RestorableAgentSessionIndex.load(
            homeDirectory: "/tmp/workbench-takeover-stale-index",
            fileManager: .default,
            registry: CmuxVaultAgentRegistry(registrations: []),
            detectedSnapshots: [
                .init(workspaceId: workspace.id, panelId: panelId): (
                    snapshot: SessionRestorableAgentSnapshot(
                        kind: .copilot,
                        sessionId: "superseded-session",
                        workbenchAuthority: .controlledExternally
                    ),
                    updatedAt: 1,
                    processIDs: [],
                    agentProcessIDs: [],
                    sessionIDSource: .explicit
                ),
            ]
        )
        let persisted = workspace.sessionSnapshot(
            includeScrollback: false,
            restorableAgentIndex: staleIndex
        )
        #expect(
            persisted.panels.first(where: { $0.id == panelId })?
                .terminal?.resumeBinding?.kind == "tmux"
        )
        #expect(
            persisted.panels.first(where: { $0.id == panelId })?
                .terminal?.managedAgentResumeBinding?.checkpointId ==
                replacementSessionID
        )
        #expect(workspace.restoredAgentSnapshotsByPanelId[panelId]?.sessionId == replacementSessionID)
        #expect(workspace.restoredAgentLifecycle.startupInput(panelId: panelId) != nil)
    }

    @MainActor
    @Test func ReplacementDockBindingCanTakeOverTheReplacementSession() throws {
        let source = Workspace()
        let terminal = try #require(source.focusedTerminalPanel)
        let oldSessionID = "88888888-8888-4888-8888-888888888888"
        source.restoredAgentSnapshotsByPanelId[terminal.id] =
            SessionRestorableAgentSnapshot(
                kind: .copilot,
                sessionId: oldSessionID,
                workbenchAuthority: .controlledExternally
            )
        source.restoredAgentResumeStatesByPanelId[terminal.id] = .completedAgentExit
        source.panelShellActivityStates[terminal.id] = .promptIdle
        terminal.updateShellActivityState(.promptIdle)
        source.surfaceResumeBindingsByPanelId[terminal.id] =
            SurfaceResumeBindingSnapshot(
                kind: "copilot",
                command: "copilot --resume \(oldSessionID)",
                checkpointId: oldSessionID,
                source: "agent-hook",
                workbenchAuthority: .controlledExternally
            )
        let detached = try #require(source.detachSurface(panelId: terminal.id))
        let store = DockSplitStore(
            workspaceId: UUID(),
            baseDirectoryProvider: { nil }
        )
        defer { store.closeAllPanels() }
        let rootPane = try #require(store.bonsplitController.allPaneIds.first)
        #expect(
            store.attachDetachedSurface(
                detached,
                inPane: rootPane,
                focus: false
            ) == terminal.id
        )
        let replacementSessionID = "88888888-8888-4888-8888-888888888889"
        #expect(
            store.setSurfaceResumeBinding(
                SurfaceResumeBindingSnapshot(
                    kind: "copilot",
                    command: "copilot --resume \(replacementSessionID)",
                    checkpointId: replacementSessionID,
                    source: "agent-hook",
                    workbenchAuthority: .controlledExternally
                ),
                panelId: terminal.id
            )
        )
        #expect(store.replacedCachedTransferAgentSessionPanelIds.contains(terminal.id))
        let staleRuntime = Workspace.DetachedAgentRuntimeState(
            panelId: terminal.id,
            statusEntries: [:],
            agentPIDs: ["copilot.\(oldSessionID)": getpid()],
            agentPIDProcessIdentities: [:],
            agentPIDKeys: ["copilot.\(oldSessionID)"]
        )
        store.agentRuntimeByPanelId[terminal.id] = staleRuntime
        var cachedTransfer = try #require(
            store.detachedSurfaceTransfersByPanelId[terminal.id]
        )
        cachedTransfer.agentRuntime = staleRuntime
        store.setDetachedSurfaceTransfer(cachedTransfer, forPanelID: terminal.id)
        terminal.updateShellActivityState(.promptIdle)
        var sent = ""

        #expect(store.canTakeControlOfExternalSession(panelId: terminal.id))
        #expect(store.takeControlOfExternalSession(panelId: terminal.id) { _, input in
            sent = input
            return true
        })
        #expect(sent.contains(replacementSessionID))
        #expect(!store.invalidatedCachedTransferAgentSessionPanelIds.contains(terminal.id))
        #expect(!store.replacedCachedTransferAgentSessionPanelIds.contains(terminal.id))
        #expect(store.agentRuntimeByPanelId[terminal.id] == nil)
        let rebasedTransfer = try #require(
            store.detachedSurfaceTransfersByPanelId[terminal.id]
        )
        #expect(rebasedTransfer.restorableAgent?.sessionId == replacementSessionID)
        #expect(
            rebasedTransfer.restorableAgent?.workbenchAuthority ==
                .controlledHere
        )
        #expect(
            rebasedTransfer.restorableAgentResumeState ==
                .awaitingAutoResumeCommand
        )
        #expect(rebasedTransfer.resumeBinding?.checkpointId == replacementSessionID)
        #expect(
            rebasedTransfer.resumeBinding?.workbenchAuthority ==
                .controlledHere
        )
        #expect(
            rebasedTransfer.managedAgentResumeBinding?.checkpointId ==
                replacementSessionID
        )
        #expect(rebasedTransfer.agentRuntime == nil)
        #expect(
            store.restoredAgentLifecycle.snapshotsByPanelId[terminal.id]?.sessionId ==
                replacementSessionID
        )
        #expect(store.setSurfaceResumeBinding(
            SurfaceResumeBindingSnapshot(
                kind: "copilot",
                command: "external-wrapper agent --resume \(replacementSessionID)",
                cwd: "/tmp/refreshed-dock",
                checkpointId: replacementSessionID,
                source: "agent-hook",
                launchCommand: AgentLaunchCommandSnapshot(
                    launcher: "external-wrapper",
                    executablePath: "/usr/local/bin/external-wrapper",
                    arguments: ["external-wrapper", "agent"],
                    workingDirectory: "/tmp/refreshed-dock"
                ),
                workbenchAuthority: .unknown,
                updatedAt: 100
            ),
            panelId: terminal.id
        ))
        let refreshedManagedBinding = try #require(
            store.managedAgentResumeBinding(panelId: terminal.id)
        )
        #expect(refreshedManagedBinding.cwd == "/tmp/refreshed-dock")
        #expect(refreshedManagedBinding.workbenchAuthority == .controlledHere)
        #expect(refreshedManagedBinding.launchCommand == nil)
        #expect(!refreshedManagedBinding.command.contains("external-wrapper"))
    }

    @MainActor
    @Test func SnapshotlessCompletedStateClearsWhenNewBindingArrives() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        workspace.restoredAgentResumeStatesByPanelId[panelId] = .completedAgentExit
        let binding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume new-session",
            checkpointId: "new-session",
            source: "agent-hook",
            workbenchAuthority: .controlledExternally
        )
        #expect(workspace.setSurfaceResumeBinding(binding, panelId: panelId))
        #expect(workspace.restoredAgentResumeStatesByPanelId[panelId] == nil)

        let dock = DockSplitStore(
            workspaceId: UUID(),
            baseDirectoryProvider: { nil }
        )
        let terminal = TerminalPanel(workspaceId: dock.workspaceId)
        dock.panels[terminal.id] = terminal
        dock.restoredAgentLifecycle.resumeStatesByPanelId[terminal.id] =
            .completedAgentExit
        #expect(dock.setSurfaceResumeBinding(binding, panelId: terminal.id))
        #expect(dock.restoredAgentLifecycle.resumeStatesByPanelId[terminal.id] == nil)
    }

    @MainActor
    @Test func AgentHookClearPreservesEffectiveTmuxBinding() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        let tmuxBinding = SurfaceResumeBindingSnapshot(
            kind: "tmux",
            command: "tmux attach-session -t workbench",
            checkpointId: "workbench",
            source: "process-detected",
            autoResume: true
        )
        let managedBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume managed-session",
            checkpointId: "managed-session",
            source: "agent-hook",
            workbenchAuthority: .controlledHere
        )
        workspace.surfaceResumeBindingsByPanelId[panelId] = tmuxBinding
        workspace.managedAgentResumeBindingsByPanelId[panelId] = managedBinding
        let target = ControlSurfaceResumeTarget.workspace(
            tabManager: manager,
            workspace: workspace,
            surfaceID: panelId
        )
        let checkpointCandidate = target.bindingForClear(
            expectedCheckpointID: "managed-session",
            expectedSource: nil,
            agentSessionEnded: false
        )

        #expect(checkpointCandidate == managedBinding)
        target.clearBinding(checkpointCandidate, agentSessionEnded: true)

        #expect(workspace.surfaceResumeBinding(panelId: panelId) == tmuxBinding)
        #expect(workspace.managedAgentResumeBinding(panelId: panelId) == nil)
    }

    @MainActor
    @Test func EffectiveTmuxClearPreservesManagedAgentBinding() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        let tmuxBinding = SurfaceResumeBindingSnapshot(
            kind: "tmux",
            command: "tmux attach-session -t workbench",
            checkpointId: "workbench",
            source: "process-detected",
            autoResume: true
        )
        let managedBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume managed-session",
            checkpointId: "managed-session",
            source: "agent-hook",
            workbenchAuthority: .controlledHere
        )
        workspace.surfaceResumeBindingsByPanelId[panelId] = tmuxBinding
        workspace.managedAgentResumeBindingsByPanelId[panelId] = managedBinding
        let target = ControlSurfaceResumeTarget.workspace(
            tabManager: manager,
            workspace: workspace,
            surfaceID: panelId
        )

        #expect(
            target.bindingForClear(
                expectedCheckpointID: nil,
                expectedSource: nil,
                agentSessionEnded: false
            ) == tmuxBinding
        )
        target.clearBinding(tmuxBinding, agentSessionEnded: false)

        #expect(workspace.surfaceResumeBinding(panelId: panelId) == nil)
        #expect(workspace.managedAgentResumeBinding(panelId: panelId) == managedBinding)
        #expect(!target.clearBinding(nil, agentSessionEnded: false))
        #expect(
            target.bindingForGet(
                expectedKind: nil,
                expectedCheckpointID: nil
            ) == nil
        )
        #expect(
            target.bindingForGet(
                expectedKind: "copilot",
                expectedCheckpointID: "managed-session"
            ) == managedBinding
        )
        #expect(
            target.bindingForGet(
                expectedKind: "copilot",
                expectedCheckpointID: "different-session"
            ) == nil
        )
        let collidingCustomBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "echo custom-copilot-command",
            checkpointId: "managed-session",
            source: "cli",
            autoResume: true
        )
        workspace.surfaceResumeBindingsByPanelId[panelId] =
            collidingCustomBinding
        #expect(
            target.bindingForGet(
                expectedKind: "copilot",
                expectedCheckpointID: "managed-session"
            ) == collidingCustomBinding
        )
        #expect(
            target.bindingForClear(
                expectedCheckpointID: "managed-session",
                expectedSource: nil,
                agentSessionEnded: false
            ) == collidingCustomBinding
        )
    }

    @MainActor
    @Test func ManagedAgentEndClearsContinuationButPreservesTmux() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        let sessionID = "ended-managed-session"
        let tmuxBinding = SurfaceResumeBindingSnapshot(
            kind: "tmux",
            command: "tmux attach-session -t workbench",
            checkpointId: "workbench",
            source: "process-detected",
            autoResume: true
        )
        let managedBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume \(sessionID)",
            checkpointId: sessionID,
            source: "agent-hook",
            workbenchAuthority: .controlledHere
        )
        workspace.surfaceResumeBindingsByPanelId[panelId] = tmuxBinding
        workspace.managedAgentResumeBindingsByPanelId[panelId] = managedBinding
        workspace.restoredAgentSnapshotsByPanelId[panelId] =
            SessionRestorableAgentSnapshot(
                kind: .copilot,
                sessionId: sessionID,
                workbenchAuthority: .controlledHere
            )
        workspace.restoredAgentResumeStatesByPanelId[panelId] =
            .awaitingAutoResumeCommand
        workspace.restoredAgentLifecycle.registerStartupInput(
            " copilot --resume \(sessionID)\n",
            panelId: panelId
        )
        let target = ControlSurfaceResumeTarget.workspace(
            tabManager: manager,
            workspace: workspace,
            surfaceID: panelId
        )

        target.clearBinding(managedBinding, agentSessionEnded: true)

        #expect(workspace.surfaceResumeBinding(panelId: panelId) == tmuxBinding)
        #expect(workspace.managedAgentResumeBinding(panelId: panelId) == nil)
        #expect(
            workspace.restoredAgentResumeStatesByPanelId[panelId] ==
                .completedAgentExit
        )
        #expect(workspace.restoredAgentLifecycle.startupInput(panelId: panelId) == nil)
    }

    @MainActor
    @Test func NormalManagedClearPreservesCompletedGeneration() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        let snapshot = SessionRestorableAgentSnapshot(
            kind: .copilot,
            sessionId: "completed-session",
            workbenchAuthority: .controlledHere
        )
        let binding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume completed-session",
            checkpointId: "completed-session",
            source: "agent-hook",
            workbenchAuthority: .controlledHere
        )
        workspace.restoredAgentSnapshotsByPanelId[panelId] = snapshot
        workspace.surfaceResumeBindingsByPanelId[panelId] = binding
        workspace.managedAgentResumeBindingsByPanelId[panelId] = binding
        workspace.markRestoredAgentCompleted(panelId: panelId, snapshot: snapshot)
        let completedAt = try #require(
            workspace.restoredAgentLifecycle.completedGeneration(
                panelId: panelId
            )?.completedAt
        )
        let target = ControlSurfaceResumeTarget.workspace(
            tabManager: manager,
            workspace: workspace,
            surfaceID: panelId
        )

        #expect(target.clearBinding(binding, agentSessionEnded: false))

        #expect(
            workspace.restoredAgentResumeStatesByPanelId[panelId] ==
                .completedAgentExit
        )
        #expect(
            workspace.restoredAgentLifecycle.completedGeneration(
                panelId: panelId
            )?.completedAt == completedAt
        )
    }

    @MainActor
    @Test func LateManagedClearDoesNotDestroyReplacementContinuation() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let oldBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume old-session",
            checkpointId: "old-session",
            source: "agent-hook",
            workbenchAuthority: .controlledExternally
        )
        workspace.managedAgentResumeBindingsByPanelId[panelId] = oldBinding
        workspace.restoredAgentSnapshotsByPanelId[panelId] =
            SessionRestorableAgentSnapshot(
                kind: .copilot,
                sessionId: "replacement-session",
                workbenchAuthority: .controlledHere
            )
        workspace.restoredAgentResumeStatesByPanelId[panelId] =
            .awaitingAutoResumeCommand
        workspace.restoredResumeSessionWorkingDirectoriesByPanelId[panelId] =
            "/tmp/replacement"
        workspace.restoredAgentLifecycle.registerStartupInput(
            " copilot --resume replacement-session\n",
            panelId: panelId
        )

        #expect(workspace.clearManagedAgentResumeBinding(
            panelId: panelId,
            matching: oldBinding,
            agentSessionEnded: true
        ))

        #expect(
            workspace.restoredAgentSnapshotsByPanelId[panelId]?.sessionId ==
                "replacement-session"
        )
        #expect(
            workspace.restoredAgentResumeStatesByPanelId[panelId] ==
                .awaitingAutoResumeCommand
        )
        #expect(
            workspace.restoredResumeSessionWorkingDirectoriesByPanelId[panelId] ==
                "/tmp/replacement"
        )
        #expect(workspace.restoredAgentLifecycle.startupInput(panelId: panelId) != nil)
    }

    @MainActor
    @Test func LegacyAgentBindingSeedsManagedIdentityOnRestore() throws {
        let workspace = Workspace()
        let savedPanelID = UUID()
        let binding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume legacy-managed-session",
            checkpointId: "legacy-managed-session",
            source: "agent-hook",
            workbenchAuthority: .controlledExternally
        )
        let panelSnapshot = SessionPanelSnapshot(
            id: savedPanelID,
            type: .terminal,
            title: "Legacy managed binding",
            directory: "/tmp",
            isPinned: false,
            isManuallyUnread: false,
            gitBranch: nil,
            listeningPorts: [],
            ttyName: nil,
            terminal: SessionTerminalPanelSnapshot(
                workingDirectory: "/tmp",
                agent: nil,
                resumeBinding: binding,
                managedAgentResumeBinding: nil,
                wasAgentRunning: true
            ),
            browser: nil,
            markdown: nil,
            filePreview: nil,
            rightSidebarTool: nil,
            project: nil
        )
        let restoredID = try #require(workspace.restoreSessionSnapshot(
            SessionWorkspaceSnapshot(
                workspaceId: workspace.id,
                processTitle: "Legacy",
                customTitle: nil,
                customDescription: nil,
                customColor: nil,
                isPinned: false,
                groupId: nil,
                currentDirectory: "/tmp",
                focusedPanelId: savedPanelID,
                layout: .pane(
                    SessionPaneLayoutSnapshot(
                        panelIds: [savedPanelID],
                        selectedPanelId: savedPanelID
                    )
                ),
                layoutMode: nil,
                panels: [panelSnapshot],
                statusEntries: [],
                logEntries: []
            )
        )[savedPanelID])

        #expect(
            workspace.managedAgentResumeBinding(panelId: restoredID) ==
                binding
        )
    }

    @MainActor
    @Test func ConflictingManagedRestoreFailsClosed() throws {
        let suiteName = "workbench-conflicting-managed-restore-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.set(true, forKey: AgentSessionAutoResumeSettings.autoResumeAgentSessionsKey)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let workspace = Workspace(agentSessionAutoResumeDefaults: defaults)
        let replacementSessionID = "blocked-conflict-session"
        var replacementResumeIntentCount = 0
        AgentChatTranscriptService.recordResumeIntentObserverForTesting = {
            sessionID,
            _,
            _ in
            if sessionID == replacementSessionID {
                replacementResumeIntentCount += 1
            }
        }
        defer {
            AgentChatTranscriptService.recordResumeIntentObserverForTesting = nil
        }
        let savedPanelID = UUID()
        let effectiveTmux = SurfaceResumeBindingSnapshot(
            kind: "tmux",
            command: "tmux attach-session -t workbench",
            checkpointId: "workbench",
            source: "process-detected",
            autoResume: true
        )
        let staleManaged = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume stale-session",
            checkpointId: "stale-session",
            source: "agent-hook",
            autoResume: true,
            workbenchAuthority: .controlledHere
        )
        let replacementAgent = SessionRestorableAgentSnapshot(
            kind: .copilot,
            sessionId: replacementSessionID,
            workbenchAuthority: .controlledExternally
        )
        let panelSnapshot = SessionPanelSnapshot(
            id: savedPanelID,
            type: .terminal,
            title: "Conflicting managed restore",
            directory: "/tmp",
            isPinned: false,
            isManuallyUnread: false,
            gitBranch: nil,
            listeningPorts: [],
            ttyName: nil,
            terminal: SessionTerminalPanelSnapshot(
                workingDirectory: "/tmp",
                agent: replacementAgent,
                resumeBinding: effectiveTmux,
                managedAgentResumeBinding: staleManaged,
                wasAgentRunning: true
            ),
            browser: nil,
            markdown: nil,
            filePreview: nil,
            rightSidebarTool: nil,
            project: nil
        )
        let restoredID = try #require(workspace.restoreSessionSnapshot(
            SessionWorkspaceSnapshot(
                workspaceId: workspace.id,
                processTitle: "Conflict",
                customTitle: nil,
                customDescription: nil,
                customColor: nil,
                isPinned: false,
                groupId: nil,
                currentDirectory: "/tmp",
                focusedPanelId: savedPanelID,
                layout: .pane(
                    SessionPaneLayoutSnapshot(
                        panelIds: [savedPanelID],
                        selectedPanelId: savedPanelID
                    )
                ),
                layoutMode: nil,
                panels: [panelSnapshot],
                statusEntries: [],
                logEntries: []
            )
        )[savedPanelID])

        #expect(
            workspace.terminalPanel(for: restoredID)?
                .surface.debugInitialInputForTesting() == nil
        )
        #expect(workspace.managedAgentResumeBinding(panelId: restoredID) == nil)
        #expect(
            workspace.surfaceResumeBinding(panelId: restoredID)?
                .workbenchAuthority == .unknown
        )
        #expect(
            workspace.restoredAgentSnapshotsByPanelId[restoredID]?.sessionId ==
                replacementSessionID
        )
        #expect(
            workspace.restoredAgentSnapshotsByPanelId[restoredID]?
                .workbenchAuthority == .unknown
        )
        #expect(replacementResumeIntentCount == 0)
    }

    @MainActor
    @Test func LegacyAliasedManagedConflictDropsStaleBinding() throws {
        let workspace = Workspace()
        let savedPanelID = UUID()
        let staleBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume stale-session",
            checkpointId: "stale-session",
            source: "agent-hook",
            autoResume: true,
            workbenchAuthority: .controlledHere
        )
        let replacementAgent = SessionRestorableAgentSnapshot(
            kind: .copilot,
            sessionId: "replacement-session",
            workbenchAuthority: .controlledExternally
        )
        let panelSnapshot = SessionPanelSnapshot(
            id: savedPanelID,
            type: .terminal,
            title: "Legacy aliased conflict",
            directory: "/tmp",
            isPinned: false,
            isManuallyUnread: false,
            gitBranch: nil,
            listeningPorts: [],
            ttyName: nil,
            terminal: SessionTerminalPanelSnapshot(
                workingDirectory: "/tmp",
                agent: replacementAgent,
                resumeBinding: staleBinding,
                managedAgentResumeBinding: nil,
                wasAgentRunning: true
            ),
            browser: nil,
            markdown: nil,
            filePreview: nil,
            rightSidebarTool: nil,
            project: nil
        )
        let restoredID = try #require(workspace.restoreSessionSnapshot(
            SessionWorkspaceSnapshot(
                workspaceId: workspace.id,
                processTitle: "Legacy conflict",
                customTitle: nil,
                customDescription: nil,
                customColor: nil,
                isPinned: false,
                groupId: nil,
                currentDirectory: "/tmp",
                focusedPanelId: savedPanelID,
                layout: .pane(
                    SessionPaneLayoutSnapshot(
                        panelIds: [savedPanelID],
                        selectedPanelId: savedPanelID
                    )
                ),
                layoutMode: nil,
                panels: [panelSnapshot],
                statusEntries: [],
                logEntries: []
            )
        )[savedPanelID])

        #expect(workspace.surfaceResumeBinding(panelId: restoredID) == nil)
        #expect(workspace.managedAgentResumeBinding(panelId: restoredID) == nil)
        #expect(
            workspace.restoredAgentSnapshotsByPanelId[restoredID]?.sessionId ==
                "replacement-session"
        )
        let staleIndex = RestorableAgentSessionIndex.load(
            homeDirectory: "/tmp/workbench-legacy-conflict-index",
            fileManager: .default,
            registry: CmuxVaultAgentRegistry(registrations: []),
            detectedSnapshots: [
                .init(workspaceId: workspace.id, panelId: restoredID): (
                    snapshot: SessionRestorableAgentSnapshot(
                        kind: .copilot,
                        sessionId: "stale-session",
                        workbenchAuthority: .controlledHere
                    ),
                    updatedAt: 1,
                    processIDs: [],
                    agentProcessIDs: [],
                    sessionIDSource: .explicit
                ),
            ]
        )
        let roundTrip = workspace.sessionSnapshot(
            includeScrollback: false,
            restorableAgentIndex: staleIndex
        )
        let roundTripPanel = try #require(
            roundTrip.panels.first(where: { $0.id == restoredID })?.terminal
        )
        #expect(roundTripPanel.resumeBinding == nil)
        #expect(roundTripPanel.managedAgentResumeBinding == nil)
        #expect(roundTripPanel.agent?.sessionId == "replacement-session")
        #expect(roundTripPanel.agent?.workbenchAuthority == .unknown)
    }

    @MainActor
    @Test func ManagedBindingMutationChangesAutosaveFingerprint() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        workspace.surfaceResumeBindingsByPanelId[panelId] =
            SurfaceResumeBindingSnapshot(
                kind: "tmux",
                command: "tmux attach-session -t workbench",
                checkpointId: "workbench",
                source: "process-detected",
                autoResume: true
            )
        var managedBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume managed-session",
            checkpointId: "managed-session",
            source: "agent-hook",
            autoResume: true,
            workbenchAuthority: .controlledHere
        )
        workspace.managedAgentResumeBindingsByPanelId[panelId] = managedBinding
        let before = manager.sessionAutosaveFingerprint()

        managedBinding.autoResume = false
        workspace.managedAgentResumeBindingsByPanelId[panelId] = managedBinding
        let after = manager.sessionAutosaveFingerprint()

        #expect(before != after)
    }

    @MainActor
    @Test func IncompleteAgentHookBindingClearsItsEffectiveRecord() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        let incompleteBinding = SurfaceResumeBindingSnapshot(
            command: "copilot",
            source: "agent-hook",
            workbenchAuthority: .unknown
        )
        workspace.surfaceResumeBindingsByPanelId[panelId] = incompleteBinding
        let target = ControlSurfaceResumeTarget.workspace(
            tabManager: manager,
            workspace: workspace,
            surfaceID: panelId
        )

        #expect(target.clearBinding(incompleteBinding, agentSessionEnded: false))
        #expect(workspace.surfaceResumeBinding(panelId: panelId) == nil)
    }

    @MainActor
    @Test func RespawnClearsManagedAgentBinding() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        workspace.managedAgentResumeBindingsByPanelId[panelId] =
            SurfaceResumeBindingSnapshot(
                kind: "copilot",
                command: "copilot --resume stale-session",
                checkpointId: "stale-session",
                source: "agent-hook",
                workbenchAuthority: .controlledHere
            )

        let respawned = try #require(
            workspace.respawnTerminalSurface(
                panelId: panelId,
                command: "true"
            )
        )

        #expect(respawned.id == panelId)
        #expect(workspace.managedAgentResumeBinding(panelId: panelId) == nil)
    }

    @Test func ManagedAgentDirectoryOutranksTmuxFallbackForResumeIntent() {
        let managedBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume managed-session",
            cwd: "/tmp/managed-agent",
            checkpointId: "managed-session",
            source: "agent-hook",
            workbenchAuthority: .controlledHere
        )

        #expect(
            Workspace.resumeIntentWorkingDirectory(
                managedResumeBinding: managedBinding,
                restorableAgent: nil,
                fallback: "/tmp/tmux-client"
            ) == "/tmp/managed-agent"
        )
    }

    @MainActor
    @Test func ManagedRestoreRecordDirectoryOutranksTmuxTransientDirectory() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        let tmuxBinding = SurfaceResumeBindingSnapshot(
            kind: "tmux",
            command: "tmux attach-session -t workbench",
            cwd: "/tmp/tmux-client",
            checkpointId: "workbench",
            source: "process-detected",
            autoResume: true
        )
        let managedBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume managed-session",
            cwd: "/tmp/managed-agent",
            checkpointId: "managed-session",
            source: "agent-hook",
            workbenchAuthority: .controlledHere
        )
        workspace.surfaceResumeBindingsByPanelId[panelId] = tmuxBinding
        workspace.managedAgentResumeBindingsByPanelId[panelId] = managedBinding
        workspace.restoredResumeSessionWorkingDirectoriesByPanelId[panelId] =
            "/tmp/tmux-transient"
        let target = ControlSurfaceResumeTarget.workspace(
            tabManager: manager,
            workspace: workspace,
            surfaceID: panelId
        )

        #expect(
            target.bindingForGet(
                expectedKind: nil,
                expectedCheckpointID: nil
            ) == tmuxBinding
        )
        #expect(
            target.bindingForGet(
                expectedKind: "tmux",
                expectedCheckpointID: "workbench"
            ) == tmuxBinding
        )
        #expect(
            target.bindingForGet(
                expectedKind: "copilot",
                expectedCheckpointID: "managed-session"
            ) == managedBinding
        )
        #expect(
            target.restoreWorkingDirectory(
                binding: managedBinding,
                agent: nil
            ) == "/tmp/managed-agent"
        )
    }

    @MainActor
    @Test func EffectiveTmuxRestoreStillRequiresManagedAuthority() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        let tmuxBinding = SurfaceResumeBindingSnapshot(
            kind: "tmux",
            command: "tmux attach-session -t workbench",
            checkpointId: "workbench",
            source: "process-detected",
            autoResume: true
        )
        workspace.surfaceResumeBindingsByPanelId[panelId] = tmuxBinding
        workspace.managedAgentResumeBindingsByPanelId[panelId] =
            SurfaceResumeBindingSnapshot(
                kind: "copilot",
                command: "copilot --resume managed-session",
                checkpointId: "managed-session",
                source: "agent-hook",
                workbenchAuthority: .controlledExternally
            )
        let target = ControlSurfaceResumeTarget.workspace(
            tabManager: manager,
            workspace: workspace,
            surfaceID: panelId
        )

        #expect(
            target.restoreAuthority(selectedBinding: tmuxBinding) ==
                .controlledExternally
        )
        workspace.restoredAgentSnapshotsByPanelId[panelId] =
            SessionRestorableAgentSnapshot(
                kind: .copilot,
                sessionId: "replacement-session",
                workbenchAuthority: .controlledExternally
            )
        workspace.managedAgentResumeBindingsByPanelId[panelId] =
            SurfaceResumeBindingSnapshot(
                kind: "copilot",
                command: "copilot --resume stale-session",
                checkpointId: "stale-session",
                source: "agent-hook",
                workbenchAuthority: .controlledHere
            )
        #expect(
            target.restoreAuthority(selectedBinding: tmuxBinding) ==
                .unknown
        )
        #expect(
            target.restoreAuthority(selectedBinding: nil) ==
                .controlledExternally
        )
        workspace.managedAgentResumeBindingsByPanelId.removeValue(
            forKey: panelId
        )
        workspace.restoredAgentSnapshotsByPanelId.removeValue(forKey: panelId)
        #expect(
            target.restoreAuthority(selectedBinding: tmuxBinding) ==
                .controlledHere
        )
        let customBinding = SurfaceResumeBindingSnapshot(
            kind: "custom-command",
            command: "echo custom",
            checkpointId: "custom",
            source: "cli",
            autoResume: true
        )
        workspace.surfaceResumeBindingsByPanelId[panelId] = customBinding
        workspace.managedAgentResumeBindingsByPanelId[panelId] =
            SurfaceResumeBindingSnapshot(
                kind: "copilot",
                command: "copilot --resume external-session",
                checkpointId: "external-session",
                source: "agent-hook",
                workbenchAuthority: .controlledExternally
            )
        #expect(
            target.restoreAuthority(selectedBinding: customBinding) ==
                .controlledHere
        )
    }

    @MainActor
    @Test func TypedRestoreAllowsMatchingSnapshotWithoutBinding() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        let sessionID = "snapshot-only-session"
        workspace.restoredAgentSnapshotsByPanelId[panelId] =
            SessionRestorableAgentSnapshot(
                kind: .copilot,
                sessionId: sessionID,
                workbenchAuthority: .controlledHere
            )
        let target = ControlSurfaceResumeTarget.workspace(
            tabManager: manager,
            workspace: workspace,
            surfaceID: panelId
        )

        #expect(target.bindingForGet(
            expectedKind: "copilot",
            expectedCheckpointID: sessionID
        ) == nil)
        #expect(target.restorableAgentMatches(
            expectedKind: "copilot",
            expectedCheckpointID: sessionID
        ))
        #expect(!target.restorableAgentMatches(
            expectedKind: "copilot",
            expectedCheckpointID: "different-session"
        ))
    }

    @MainActor
    @Test func PiEquivalentCheckpointSelectsManagedClearCandidate() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        let sessionID = "019fbf0f-7fcd-70aa-9388-f44c4e27fa0c"
        let binding = SurfaceResumeBindingSnapshot(
            kind: "pi",
            command: "pi --session \(sessionID)",
            checkpointId: sessionID,
            source: "agent-hook",
            workbenchAuthority: .controlledHere
        )
        workspace.surfaceResumeBindingsByPanelId[panelId] = binding
        workspace.managedAgentResumeBindingsByPanelId[panelId] = binding
        let target = ControlSurfaceResumeTarget.workspace(
            tabManager: manager,
            workspace: workspace,
            surfaceID: panelId
        )
        let path = "/tmp/2026-09-09_\(sessionID).jsonl"

        #expect(target.checkpointMatches(path, binding: binding))
        #expect(
            target.bindingForClear(
                expectedCheckpointID: path,
                expectedSource: nil,
                agentSessionEnded: false
            ) == binding
        )
    }

    @Test func DuplicateActiveSessionSuppressesManagedResumeRebinding() {
        let managedBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume active-session",
            checkpointId: "active-session",
            source: "agent-hook",
            workbenchAuthority: .controlledHere
        )

        #expect(
            Workspace.resumeReboundSession(
                restorableAgent: nil,
                managedResumeBinding: managedBinding,
                effectiveResumeBinding: nil,
                agentSessionAlreadyActive: true,
                shouldRebindSession: true
            ) == nil
        )
        #expect(
            Workspace.resumeReboundSession(
                restorableAgent: nil,
                managedResumeBinding: managedBinding,
                effectiveResumeBinding: nil,
                agentSessionAlreadyActive: false,
                shouldRebindSession: true
            )?.sessionID == "active-session"
        )
        #expect(
            Workspace.resumeReboundSession(
                restorableAgent: nil,
                managedResumeBinding: managedBinding,
                effectiveResumeBinding: nil,
                agentSessionAlreadyActive: false,
                shouldRebindSession: false
            ) == nil
        )
    }

    @Test func LocalAuthorityRefreshRetargetsTrustedExecutionDirectory() {
        let sessionID = "trusted-refresh-session"
        let current = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "cd -- '/tmp/old' 2>/dev/null || [ ! -d '/tmp/old' ] && /opt/agency copilot",
            cwd: "/tmp/old",
            checkpointId: sessionID,
            source: "agent-hook",
            launchCommand: AgentLaunchCommandSnapshot(
                launcher: "agency",
                executablePath: "/opt/agency",
                arguments: ["/opt/agency", "copilot"],
                workingDirectory: "/tmp/old"
            ),
            workbenchAuthority: .controlledHere
        )
        let observed = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "external-wrapper copilot",
            cwd: "/tmp/new",
            checkpointId: sessionID,
            source: "agent-hook",
            permissionMode: "acceptEdits",
            workbenchAuthority: .unknown,
            updatedAt: 200
        )

        let refreshed =
            WorkbenchSessionAuthority.preservingExplicitLocalBindingAuthority(
                observed: observed,
                current: current
            )

        #expect(refreshed.cwd == "/tmp/new")
        #expect(refreshed.command.contains("/tmp/new"))
        #expect(!refreshed.command.contains("/tmp/old"))
        #expect(refreshed.command.contains("/opt/agency"))
        #expect(!refreshed.command.contains("external-wrapper"))
        #expect(refreshed.launchCommand?.workingDirectory == "/tmp/new")
        #expect(refreshed.permissionMode == "acceptEdits")
        #expect(refreshed.updatedAt == 200)
        #expect(refreshed.workbenchAuthority == .controlledHere)
    }

    @MainActor
    @Test func SnapshotlessManagedEndRecordsCompletionFence() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        let binding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume ended-session",
            checkpointId: "ended-session",
            source: "agent-hook",
            workbenchAuthority: .controlledHere
        )
        workspace.surfaceResumeBindingsByPanelId[panelId] = binding
        workspace.managedAgentResumeBindingsByPanelId[panelId] = binding
        workspace.restoredAgentResumeStatesByPanelId[panelId] =
            .awaitingAutoResumeCommand
        let target = ControlSurfaceResumeTarget.workspace(
            tabManager: manager,
            workspace: workspace,
            surfaceID: panelId
        )

        #expect(target.clearBinding(binding, agentSessionEnded: true))

        #expect(
            workspace.restoredAgentResumeStatesByPanelId[panelId] ==
                .completedAgentExit
        )
        #expect(
            workspace.restoredAgentLifecycle.completedGeneration(panelId: panelId) != nil
        )
    }

    @MainActor
    @Test func RestoredTmuxOverlayKeepsManagedAgentLifecycle() throws {
        let suiteName = "workbench-managed-tmux-restore-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.set(true, forKey: AgentSessionAutoResumeSettings.autoResumeAgentSessionsKey)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let source = Workspace(agentSessionAutoResumeDefaults: defaults)
        let panelId = try #require(source.focusedPanelId)
        let sessionID = "tmux-managed-session"
        source.restoredAgentSnapshotsByPanelId[panelId] =
            SessionRestorableAgentSnapshot(
                kind: .copilot,
                sessionId: sessionID,
                workbenchAuthority: .controlledHere
            )
        source.restoredAgentResumeStatesByPanelId[panelId] =
            .observedAgentCommandRunning
        source.surfaceResumeBindingsByPanelId[panelId] =
            SurfaceResumeBindingSnapshot(
                kind: "tmux",
                command: "tmux attach-session -t workbench",
                cwd: "/tmp/tmux-client",
                checkpointId: "workbench",
                source: "process-detected",
                autoResume: true
            )
        source.managedAgentResumeBindingsByPanelId[panelId] =
            SurfaceResumeBindingSnapshot(
                kind: "copilot",
                command: "copilot --resume \(sessionID)",
                cwd: "/tmp/managed-agent",
                checkpointId: sessionID,
                source: "agent-hook",
                autoResume: true,
                workbenchAuthority: .controlledHere
            )
        let snapshot = source.sessionSnapshot(includeScrollback: false)
        let restored = Workspace(agentSessionAutoResumeDefaults: defaults)
        let restoredPanelId = try #require(
            restored.restoreSessionSnapshot(snapshot)[panelId]
        )

        #expect(
            restored.restoredAgentResumeStatesByPanelId[restoredPanelId] ==
                .awaitingAutoResumeCommand
        )
        #expect(
            restored.managedAgentResumeBinding(panelId: restoredPanelId)?
                .checkpointId == sessionID
        )
        #expect(
            restored.restoredAgentLifecycle.startupInput(panelId: restoredPanelId) != nil
        )
        #expect(
            restored.restoredResumeSessionWorkingDirectoriesByPanelId[
                restoredPanelId
            ] == "/tmp/managed-agent"
        )
        #expect(restored.setSurfaceResumeBinding(
            SurfaceResumeBindingSnapshot(
                kind: "copilot",
                command: "copilot --resume \(sessionID)",
                cwd: "/tmp/managed-refreshed",
                checkpointId: sessionID,
                source: "agent-hook",
                autoResume: true,
                workbenchAuthority: .controlledHere
            ),
            panelId: restoredPanelId
        ))
        #expect(
            restored.restoredResumeSessionWorkingDirectoriesByPanelId[
                restoredPanelId
            ] == "/tmp/managed-refreshed"
        )
    }

    @MainActor
    @Test func RetiredManagedAgentIsNotReboundWhenTmuxRestores() throws {
        let suiteName = "workbench-retired-managed-tmux-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.set(true, forKey: AgentSessionAutoResumeSettings.autoResumeAgentSessionsKey)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let sessionID = "retired-managed-tmux-session"
        var resumeIntentCount = 0
        AgentChatTranscriptService.recordResumeIntentObserverForTesting = {
            observedSessionID,
            _,
            _ in
            if observedSessionID == sessionID {
                resumeIntentCount += 1
            }
        }
        defer {
            AgentChatTranscriptService.recordResumeIntentObserverForTesting = nil
        }
        let savedPanelID = UUID()
        let panelSnapshot = SessionPanelSnapshot(
            id: savedPanelID,
            type: .terminal,
            title: "Retired managed tmux",
            directory: "/tmp",
            isPinned: false,
            isManuallyUnread: false,
            gitBranch: nil,
            listeningPorts: [],
            ttyName: nil,
            terminal: SessionTerminalPanelSnapshot(
                workingDirectory: "/tmp",
                agent: nil,
                resumeBinding: SurfaceResumeBindingSnapshot(
                    kind: "tmux",
                    command: "tmux attach-session -t workbench",
                    checkpointId: "workbench",
                    source: "process-detected",
                    autoResume: true
                ),
                managedAgentResumeBinding: SurfaceResumeBindingSnapshot(
                    kind: "copilot",
                    command: "copilot --resume \(sessionID)",
                    checkpointId: sessionID,
                    source: "agent-hook",
                    autoResume: false,
                    workbenchAuthority: .controlledHere
                ),
                wasAgentRunning: false
            ),
            browser: nil,
            markdown: nil,
            filePreview: nil,
            rightSidebarTool: nil,
            project: nil
        )
        let workspace = Workspace(agentSessionAutoResumeDefaults: defaults)
        let restoredID = try #require(workspace.restoreSessionSnapshot(
            SessionWorkspaceSnapshot(
                workspaceId: workspace.id,
                processTitle: "Retired",
                customTitle: nil,
                customDescription: nil,
                customColor: nil,
                isPinned: false,
                groupId: nil,
                currentDirectory: "/tmp",
                focusedPanelId: savedPanelID,
                layout: .pane(
                    SessionPaneLayoutSnapshot(
                        panelIds: [savedPanelID],
                        selectedPanelId: savedPanelID
                    )
                ),
                layoutMode: nil,
                panels: [panelSnapshot],
                statusEntries: [],
                logEntries: []
            )
        )[savedPanelID])

        #expect(resumeIntentCount == 0)
        #expect(
            workspace.restoredAgentResumeStatesByPanelId[restoredID] !=
                .awaitingAutoResumeCommand
        )
        #expect(
            workspace.restoredAgentLifecycle.startupInput(panelId: restoredID) ==
                nil
        )
    }

    @Test func OnlyProcessDetectedTmuxLaunchIsAttributedToManagedAgent() {
        let tmuxBinding = SurfaceResumeBindingSnapshot(
            kind: "tmux",
            command: "tmux attach-session -t workbench",
            checkpointId: "workbench",
            source: "process-detected",
            autoResume: true
        )
        let customBinding = SurfaceResumeBindingSnapshot(
            kind: "custom-command",
            command: "echo hello",
            checkpointId: "custom",
            source: "cli",
            autoResume: true
        )

        #expect(Workspace.effectiveBindingLaunchesManagedAgent(tmuxBinding))
        #expect(!Workspace.effectiveBindingLaunchesManagedAgent(customBinding))
        #expect(!Workspace.effectiveBindingLaunchesManagedAgent(nil))
    }

    @Test func ConfirmedManagedAgentExitOverridesRunningTmuxContainer() {
        let sessionID = "managed-agent-exited"
        let tmuxBinding = SurfaceResumeBindingSnapshot(
            kind: "tmux",
            command: "tmux attach-session -t workbench",
            checkpointId: "workbench",
            source: "process-detected",
            autoResume: true
        )
        let managedBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume \(sessionID)",
            checkpointId: sessionID,
            source: "agent-hook",
            autoResume: true,
            workbenchAuthority: .controlledHere
        )
        let observedAgent = SessionRestorableAgentSnapshot(
            kind: .copilot,
            sessionId: sessionID,
            workbenchAuthority: .controlledHere
        )

        #expect(Workspace.managedAgentExitOverridesContainerLifecycle(
            effectiveBinding: tmuxBinding,
            managedBinding: managedBinding,
            observedAgent: observedAgent,
            processLiveness: .exited
        ))
        #expect(!Workspace.managedAgentExitOverridesContainerLifecycle(
            effectiveBinding: tmuxBinding,
            managedBinding: managedBinding,
            observedAgent: observedAgent,
            processLiveness: .running
        ))
        #expect(!Workspace.managedAgentExitOverridesContainerLifecycle(
            effectiveBinding: nil,
            managedBinding: managedBinding,
            observedAgent: observedAgent,
            processLiveness: .exited
        ))
        #expect(!Workspace.managedAgentExitOverridesContainerLifecycle(
            effectiveBinding: tmuxBinding,
            managedBinding: managedBinding,
            observedAgent: observedAgent,
            processLiveness: .exited,
            hasConfirmedRuntimeProcess: true
        ))
    }

    @MainActor
    @Test func CustomRestoreRunsWithoutRebindingRetainedManagedAgent() throws {
        let suiteName = "workbench-custom-managed-restore-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.set(true, forKey: AgentSessionAutoResumeSettings.autoResumeAgentSessionsKey)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let managedSessionID = "retained-external-session"
        var resumeIntentCount = 0
        AgentChatTranscriptService.recordResumeIntentObserverForTesting = {
            observedSessionID,
            _,
            _ in
            if observedSessionID == managedSessionID {
                resumeIntentCount += 1
            }
        }
        defer {
            AgentChatTranscriptService.recordResumeIntentObserverForTesting = nil
        }
        let savedPanelID = UUID()
        let panelSnapshot = SessionPanelSnapshot(
            id: savedPanelID,
            type: .terminal,
            title: "Custom restore",
            directory: "/tmp",
            isPinned: false,
            isManuallyUnread: false,
            gitBranch: nil,
            listeningPorts: [],
            ttyName: nil,
            terminal: SessionTerminalPanelSnapshot(
                workingDirectory: "/tmp",
                agent: SessionRestorableAgentSnapshot(
                    kind: .copilot,
                    sessionId: managedSessionID,
                    workbenchAuthority: .controlledExternally
                ),
                resumeBinding: SurfaceResumeBindingSnapshot(
                    kind: "custom-command",
                    command: "echo custom-restore",
                    checkpointId: "custom",
                    source: "process-detected",
                    autoResume: false
                ),
                managedAgentResumeBinding: SurfaceResumeBindingSnapshot(
                    kind: "copilot",
                    command: "copilot --resume \(managedSessionID)",
                    checkpointId: managedSessionID,
                    source: "agent-hook",
                    autoResume: true,
                    workbenchAuthority: .controlledExternally
                ),
                wasAgentRunning: true
            ),
            browser: nil,
            markdown: nil,
            filePreview: nil,
            rightSidebarTool: nil,
            project: nil
        )
        let workspace = Workspace(agentSessionAutoResumeDefaults: defaults)
        let restoredID = try #require(workspace.restoreSessionSnapshot(
            SessionWorkspaceSnapshot(
                workspaceId: workspace.id,
                processTitle: "Custom",
                customTitle: nil,
                customDescription: nil,
                customColor: nil,
                isPinned: false,
                groupId: nil,
                currentDirectory: "/tmp",
                focusedPanelId: savedPanelID,
                layout: .pane(
                    SessionPaneLayoutSnapshot(
                        panelIds: [savedPanelID],
                        selectedPanelId: savedPanelID
                    )
                ),
                layoutMode: nil,
                panels: [panelSnapshot],
                statusEntries: [],
                logEntries: []
            )
        )[savedPanelID])

        #expect(
            Workspace.restoreWorkbenchAuthority(
                effectiveBinding: panelSnapshot.terminal?.resumeBinding,
                agentCompatibilityBinding:
                    panelSnapshot.terminal?.managedAgentResumeBinding,
                restorableAgent: panelSnapshot.terminal?.agent,
                managedBindingConflictsWithSnapshot: false
            ) == .controlledHere
        )
        #expect(resumeIntentCount == 0)
        #expect(
            workspace.restoredAgentResumeStatesByPanelId[restoredID] !=
                .awaitingAutoResumeCommand
        )
    }

    @MainActor
    @Test func PersistentRemoteReattachRestoresBothBindingLayers() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let effectiveBinding = SurfaceResumeBindingSnapshot(
            kind: "tmux",
            command: "tmux attach-session -t remote-workbench",
            checkpointId: "remote-workbench",
            source: "process-detected",
            autoResume: true
        )
        let managedBinding = SurfaceResumeBindingSnapshot(
            kind: "copilot",
            command: "copilot --resume remote-managed-session",
            checkpointId: "remote-managed-session",
            source: "agent-hook",
            workbenchAuthority: .controlledHere
        )
        workspace.restorePersistentReattachResumeBindings(
            panelId: panelId,
            effectiveBinding: effectiveBinding,
            managedBinding: managedBinding
        )

        #expect(workspace.surfaceResumeBinding(panelId: panelId) == effectiveBinding)
        #expect(
            workspace.managedAgentResumeBinding(panelId: panelId) ==
                managedBinding
        )
    }

    private func localSnapshot() -> SessionRestorableAgentSnapshot {
        SessionRestorableAgentSnapshot(
            kind: .claude,
            sessionId: "11111111-1111-4111-8111-111111111111",
            workingDirectory: "/tmp",
            launchCommand: AgentLaunchCommandSnapshot(
                launcher: "claude",
                executablePath: "/usr/local/bin/claude",
                arguments: ["claude", "--resume", "11111111-1111-4111-8111-111111111111"],
                workingDirectory: "/tmp"
            )
        )
    }
}
