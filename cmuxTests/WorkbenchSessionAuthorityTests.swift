import Foundation
import Testing
import Darwin

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
                .terminal?.resumeBinding?.checkpointId == replacementSessionID
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
