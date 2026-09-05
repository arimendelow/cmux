import Foundation
import Testing

#if canImport(cmux_DEV)
@testable import cmux_DEV
#elseif canImport(cmux)
@testable import cmux
#endif

@Suite("Workbench session authority")
struct WorkbenchSessionAuthorityTests {
    @Test(arguments: [
        ["/usr/local/bin/agency", "copilot", "--hub"],
        ["agency", "--no-aec", "cp", "--session-manager"],
        ["agency", "--verbosity", "debug", "copilot", "--hub"],
        ["copilot", "--hub"],
    ])
    func exactAgencyHubLaunchesAreDetected(_ arguments: [String]) {
        let launch = AgentLaunchCommandSnapshot(
            launcher: "agency",
            executablePath: "/usr/local/bin/agency",
            arguments: arguments,
            workingDirectory: "/tmp",
            environment: nil,
            capturedAt: 1,
            source: "test"
        )
        #expect(WorkbenchSessionAuthority.inferred(from: launch) == .controlledInAgencyHub)
    }

    @Test func AgencyManagedCopilotChildRetainsHubAuthority() {
        let launch = AgentLaunchCommandSnapshot(
            launcher: "copilot",
            executablePath: "/usr/local/bin/copilot",
            arguments: ["/usr/local/bin/copilot", "--no-auto-update"],
            workingDirectory: "/tmp",
            environment: ["CMUX_AGENT_LAUNCH_AUTHORITY": "agency-hub"]
        )
        #expect(WorkbenchSessionAuthority.inferred(from: launch) == .controlledInAgencyHub)
    }

    @Test func similarLaunchesRemainControlledHere() {
        for launch in [
            AgentLaunchCommandSnapshot(
                launcher: "copilot",
                executablePath: "/usr/local/bin/copilot",
                arguments: ["copilot", "--hub"],
                workingDirectory: nil
            ),
            AgentLaunchCommandSnapshot(
                launcher: "agency",
                executablePath: "/usr/local/bin/agency",
                arguments: ["agency", "copilot", "--", "--hub"],
                workingDirectory: nil
            ),
            AgentLaunchCommandSnapshot(
                launcher: "agency",
                executablePath: "/usr/local/bin/agency",
                arguments: ["agency", "claude", "--hub"],
                workingDirectory: nil
            ),
        ] {
            #expect(WorkbenchSessionAuthority.inferred(from: launch) == .controlledHere)
        }
    }

    @Test func MissingAuthorityEvidencePreservesLocalBehavior() {
        #expect(WorkbenchSessionAuthority.inferred(from: nil) == .controlledHere)
        #expect(WorkbenchSessionAuthority.inferred(from: AgentLaunchCommandSnapshot(
            launcher: nil,
            executablePath: nil,
            arguments: [],
            workingDirectory: nil
        )) == .controlledHere)
        #expect(WorkbenchSessionAuthority.resolved(agent: nil, binding: nil) == .controlledHere)
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
                command: "agency copilot --hub",
                checkpointId: "session",
                source: "agent-hook",
                launchCommand: AgentLaunchCommandSnapshot(
                    launcher: "agency",
                    executablePath: "/usr/local/bin/agency",
                    arguments: ["agency", "copilot", "--hub"],
                    workingDirectory: "/tmp"
                )
            )
        ) == nil)
        var wrongKind = local
        wrongKind.workbenchAuthority = .controlledInAgencyHub
        #expect(
            WorkbenchSessionAuthority.localTakeoverSnapshot(
                agent: wrongKind,
                binding: nil
            ) == nil
        )
    }

    @Test func HubAuthorityBlocksEveryLocalContinuationUntilExplicitTakeover() throws {
        var snapshot = localSnapshot()
        snapshot.workbenchAuthority = .controlledInAgencyHub

        #expect(snapshot.effectiveWorkbenchAuthority == .controlledInAgencyHub)
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
                command: "agency copilot --hub",
                launchCommand: AgentLaunchCommandSnapshot(
                    launcher: "agency",
                    executablePath: "/usr/local/bin/agency",
                    arguments: ["agency", "copilot", "--hub"],
                    workingDirectory: "/tmp"
                )
            )
        ) == .controlledHere)
    }

    @Test func AuthorityRoundTripsAndLegacySnapshotsInferFromLaunchProvenance() throws {
        var explicit = localSnapshot()
        explicit.workbenchAuthority = .controlledInAgencyHub
        let decoded = try JSONDecoder().decode(
            SessionRestorableAgentSnapshot.self,
            from: JSONEncoder().encode(explicit)
        )
        #expect(decoded.workbenchAuthority == .controlledInAgencyHub)

        let legacy = SessionRestorableAgentSnapshot(
            kind: .codex,
            sessionId: "11111111-1111-4111-8111-111111111111",
            workingDirectory: "/tmp",
            launchCommand: AgentLaunchCommandSnapshot(
                launcher: "agency",
                executablePath: "/usr/local/bin/agency",
                arguments: ["agency", "copilot", "--hub"],
                workingDirectory: "/tmp"
            )
        )
        let inferred = try JSONDecoder().decode(
            SessionRestorableAgentSnapshot.self,
            from: JSONEncoder().encode(legacy)
        )
        #expect(inferred.workbenchAuthority == nil)
        #expect(inferred.effectiveWorkbenchAuthority == .controlledInAgencyHub)
    }

    @Test func AutosaveFingerprintIncludesAuthority() {
        let local = localSnapshot()
        var hub = local
        hub.workbenchAuthority = .controlledInAgencyHub

        #expect(
            TabManager.restorableAgentSnapshotFingerprint(local) !=
                TabManager.restorableAgentSnapshotFingerprint(hub)
        )
    }

    @MainActor
    @Test func ProductionAutosaveFingerprintChangesForSnapshotOnlyTakeover() throws {
        let manager = TabManager(autoWelcomeIfNeeded: false)
        let workspace = try #require(manager.selectedWorkspace)
        let panelId = try #require(workspace.focusedPanelId)
        var hub = SessionRestorableAgentSnapshot(
            kind: .copilot,
            sessionId: "77777777-7777-4777-8777-777777777777",
            workingDirectory: "/tmp",
            launchCommand: AgentLaunchCommandSnapshot(
                launcher: "copilot",
                executablePath: "/usr/local/bin/copilot",
                arguments: ["/usr/local/bin/copilot"],
                workingDirectory: "/tmp",
                environment: ["CMUX_AGENT_LAUNCH_AUTHORITY": "agency-hub"]
            )
        )
        hub.workbenchAuthority = .controlledInAgencyHub
        workspace.restoredAgentSnapshotsByPanelId[panelId] = hub
        workspace.restoredAgentResumeStatesByPanelId[panelId] = .manualResumeAvailable
        let before = manager.sessionAutosaveFingerprint()

        #expect(workspace.takeControlOfHubSession(panelId: panelId) { _, _ in true })
        #expect(manager.sessionAutosaveFingerprint() != before)
    }

    @Test func HookIndexPreservesHubAuthorityBeforeAgencyWrapperNormalization() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("workbench-hub-authority-\(UUID().uuidString)", isDirectory: true)
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
                "launcher": "agency",
                "executablePath": "/usr/local/bin/agency",
                "arguments": ["agency", "copilot", "--hub"],
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
        #expect(snapshot?.workbenchAuthority == .controlledInAgencyHub)
        #expect(snapshot?.launchCommand == nil)
    }

    @MainActor
    @Test func WorkspaceRestoreKeepsAHubSessionManualWhenGlobalAutoResumeIsOn() throws {
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
        agent.workbenchAuthority = .controlledInAgencyHub
        source.updatePanelShellActivityState(panelId: panelId, state: .commandRunning)
        source.setRestoredAgentSnapshotForTesting(agent, panelId: panelId)
        let snapshot = source.sessionSnapshot(includeScrollback: false)
        let sourcePanel = try #require(snapshot.panels.first(where: { $0.id == panelId }))
        #expect(sourcePanel.terminal?.agent?.effectiveWorkbenchAuthority == .controlledInAgencyHub)

        let restored = Workspace()
        let restoredPanelId = try #require(restored.restoreSessionSnapshot(snapshot)[panelId])
        #expect(restored.restoredAgentResumeStatesByPanelId[restoredPanelId] == .manualResumeAvailable)
    }

    @MainActor
    @Test func BindingOnlyHubRestoreCannotBypassAuthority() throws {
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
                    command: "agency copilot --hub",
                    cwd: "/tmp",
                    checkpointId: sessionId,
                    source: "agent-hook",
                    launchCommand: AgentLaunchCommandSnapshot(
                        launcher: "agency",
                        executablePath: "/usr/local/bin/agency",
                        arguments: ["agency", "copilot", "--hub"],
                        workingDirectory: "/tmp"
                    ),
                    autoResume: true,
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
        #expect(
            WorkbenchSessionAuthority.inferred(from: savedBinding.launchCommand) ==
                .controlledInAgencyHub
        )
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
        #expect(
            WorkbenchSessionAuthority.inferred(from: restoredBinding.launchCommand) ==
                .controlledInAgencyHub
        )
        #expect(restored.restoredAgentResumeStatesByPanelId[restoredPanelId] == nil)
        #expect(restored.canTakeControlOfHubSession(panelId: restoredPanelId))
        #expect(restored.takeControlOfHubSession(panelId: restoredPanelId) { _, _ in true })
    }

    @MainActor
    @Test func DockBindingOnlyHubRestoreCannotBypassAuthority() throws {
        let suiteName = "WorkbenchSessionAuthorityTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(true, forKey: AgentSessionAutoResumeSettings.autoResumeAgentSessionsKey)
        let savedPanelId = UUID()
        let sessionId = "44444444-4444-4444-8444-444444444444"
        let binding = SurfaceResumeBindingSnapshot(
            name: "Copilot",
            kind: "copilot",
            command: "agency copilot --hub",
            cwd: "/tmp",
            checkpointId: sessionId,
            source: "agent-hook",
            launchCommand: AgentLaunchCommandSnapshot(
                launcher: "agency",
                executablePath: "/usr/local/bin/agency",
                arguments: ["agency", "copilot", "--hub"],
                workingDirectory: "/tmp"
            ),
            autoResume: true,
            updatedAt: 1
        )
        let panelSnapshot = SessionPanelSnapshot(
            id: savedPanelId,
            type: .terminal,
            title: "Hub-owned",
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
        #expect(store.canTakeControlOfHubSession(panelId: restoredPanelId))
        #expect(store.takeControlOfHubSession(panelId: restoredPanelId) { _, input in
            sent = input
            return true
        })
        #expect(sent.contains("copilot"))
        #expect(sent.contains("--resume"))
        #expect(
            store.restoredAgentLifecycle.snapshotsByPanelId[restoredPanelId]?
                .workbenchAuthority == .controlledHere
        )
        #expect(store.surfaceResumeBinding(panelId: restoredPanelId) == nil)
        #expect(store.managedAgentResumeBinding(panelId: restoredPanelId) == nil)
    }

    @MainActor
    @Test func ExplicitLocalTakeoverResumesRawCopilotAndPersistsTheAuthorityChange() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let sessionId = "55555555-5555-4555-8555-555555555555"
        let hubLaunch = AgentLaunchCommandSnapshot(
            launcher: "copilot",
            executablePath: "/usr/local/bin/copilot",
            arguments: ["/usr/local/bin/copilot", "--no-auto-update"],
            workingDirectory: "/tmp",
            environment: ["CMUX_AGENT_LAUNCH_AUTHORITY": "agency-hub"]
        )
        workspace.restoredAgentSnapshotsByPanelId[panelId] = SessionRestorableAgentSnapshot(
            kind: .copilot,
            sessionId: sessionId,
            workingDirectory: "/tmp",
            launchCommand: hubLaunch,
            workbenchAuthority: .controlledInAgencyHub
        )
        workspace.restoredAgentResumeStatesByPanelId[panelId] = .manualResumeAvailable
        workspace.surfaceResumeBindingsByPanelId[panelId] = SurfaceResumeBindingSnapshot(
            name: "Copilot",
            kind: "copilot",
            command: "agency copilot --hub",
            cwd: "/tmp",
            checkpointId: sessionId,
            source: "agent-hook",
            launchCommand: hubLaunch,
            autoResume: true
        )
        var sent = ""

        #expect(workspace.canTakeControlOfHubSession(panelId: panelId))
        #expect(workspace.takeControlOfHubSession(panelId: panelId) { _, input in
            sent = input
            return true
        })
        #expect(sent.contains("copilot"))
        #expect(sent.contains("--resume"))
        #expect(!sent.contains("agency"))
        #expect(!sent.contains("--hub"))
        #expect(
            workspace.restoredAgentSnapshotsByPanelId[panelId]?.workbenchAuthority ==
                .controlledHere
        )
        #expect(workspace.restoredAgentSnapshotsByPanelId[panelId]?.launchCommand == nil)
        #expect(workspace.surfaceResumeBindingsByPanelId[panelId] == nil)
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
                "environment": ["CMUX_AGENT_LAUNCH_AUTHORITY": "agency-hub"],
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
            .controlledInAgencyHub
        workspace.restoredAgentResumeStatesByPanelId[panelId] = .manualResumeAvailable
        workspace.surfaceResumeBindingsByPanelId[panelId] = SurfaceResumeBindingSnapshot(
            command: "agency copilot --hub",
            launchCommand: hubLaunch
        )
        #expect(!workspace.takeControlOfHubSession(panelId: panelId) { _, _ in false })
        #expect(
            workspace.restoredAgentSnapshotsByPanelId[panelId]?.workbenchAuthority ==
                .controlledInAgencyHub
        )
        #expect(workspace.surfaceResumeBindingsByPanelId[panelId] != nil)
    }

    @MainActor
    @Test func BindingOnlyWorkspaceHubSessionCanBeTakenOverExplicitly() throws {
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
                workingDirectory: "/tmp",
                environment: ["CMUX_AGENT_LAUNCH_AUTHORITY": "agency-hub"]
            ),
            autoResume: true
        )

        #expect(workspace.canTakeControlOfHubSession(panelId: panelId))
        #expect(workspace.takeControlOfHubSession(panelId: panelId) { _, _ in true })
        #expect(
            workspace.restoredAgentSnapshotsByPanelId[panelId]?.workbenchAuthority ==
                .controlledHere
        )
        #expect(workspace.surfaceResumeBindingsByPanelId[panelId] == nil)
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
