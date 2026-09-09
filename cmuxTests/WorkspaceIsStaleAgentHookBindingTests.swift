import Foundation
import Testing
import Darwin

#if canImport(cmux_DEV)
@testable import cmux_DEV
#elseif canImport(cmux)
@testable import cmux
#endif

/// Regression coverage for #8446: `isStaleAgentHookBinding` must only judge
/// staleness for `.local` agent-hook bindings. `RestorableAgentSessionIndex`
/// is built from a local process scan, so a `.persistentSSH` binding's
/// remote-host process can never appear in it; treating that absence as
/// "stale" would prune every live remote agent-hook binding on the very next
/// reconciliation.
@MainActor
@Suite(.serialized)
struct WorkspaceIsStaleAgentHookBindingTests {
    private static let piSessionID = "019fbf0f-7fcd-70aa-9388-f44c4e27fa0c"
    private static let piSessionPath =
        "/Users/test/.pi/agent/sessions/--Users-test-project--/" +
        "2026-08-01T18-39-09-000Z_\(piSessionID).jsonl"

    private static func agentHookBinding(
        launchFlavor: SurfaceResumeLaunchFlavor
    ) -> SurfaceResumeBindingSnapshot {
        SurfaceResumeBindingSnapshot(
            kind: "claude",
            command: "claude --resume session-1",
            checkpointId: "session-1",
            source: "agent-hook",
            launchFlavor: launchFlavor
        )
    }

    private static func piAgentHookBinding() -> SurfaceResumeBindingSnapshot {
        SurfaceResumeBindingSnapshot(
            kind: "pi",
            command: "pi --session \(piSessionID)",
            checkpointId: piSessionID,
            source: "agent-hook"
        )
    }

    private static func codexAgentHookBinding(
        sessionID: String,
        autoResume: Bool? = nil,
        updatedAt: TimeInterval = Date().timeIntervalSince1970
    ) -> SurfaceResumeBindingSnapshot {
        SurfaceResumeBindingSnapshot(
            kind: "codex",
            command: "codex resume \(sessionID)",
            checkpointId: sessionID,
            source: "agent-hook",
            autoResume: autoResume,
            updatedAt: updatedAt
        )
    }

    private static func livePiIndex(
        workspaceId: UUID,
        panelId: UUID
    ) -> RestorableAgentSessionIndex {
        let key = RestorableAgentSessionIndex.PanelKey(
            workspaceId: workspaceId,
            panelId: panelId
        )
        return RestorableAgentSessionIndex.load(
            homeDirectory: "/tmp/cmux-pi-repeat-restore-empty-home",
            fileManager: .default,
            registry: CmuxVaultAgentRegistry(registrations: []),
            detectedSnapshots: [
                key: (
                    snapshot: SessionRestorableAgentSnapshot(
                        kind: .custom("pi"),
                        sessionId: piSessionPath
                    ),
                    updatedAt: 1,
                    processIDs: [31_398],
                    agentProcessIDs: [31_398],
                    sessionIDSource: .explicit
                ),
            ],
            processIdentityProvider: { _ in nil }
        )
    }

    @Test
    func missingScanEntryDoesNotRetireLocalAgentHookBinding() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let binding = Self.agentHookBinding(launchFlavor: .local)

        #expect(
            workspace.isStaleAgentHookBinding(
                binding,
                panelId: panelId,
                restorableAgentIndex: .empty
            ) == false
        )
    }

    @Test
    func confirmedExitedMatchingSessionIsStale() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let sessionID = "confirmed-exited-session"
        let fixture = try Self.exitedCodexIndex(
            workspaceID: workspace.id,
            panelID: panelId,
            sessionID: sessionID
        )
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let binding = Self.codexAgentHookBinding(
            sessionID: sessionID,
            updatedAt: fixture.updatedAt
        )

        #expect(
            workspace.isStaleAgentHookBinding(
                binding,
                panelId: panelId,
                restorableAgentIndex: fixture.index
            )
        )
    }

    @Test
    func olderExitedObservationDoesNotRetireFreshSameSessionBinding() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let sessionID = "same-session-new-generation"
        let fixture = try Self.exitedCodexIndex(
            workspaceID: workspace.id,
            panelID: panelId,
            sessionID: sessionID
        )
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let binding = Self.codexAgentHookBinding(
            sessionID: sessionID,
            updatedAt: fixture.updatedAt + 1
        )

        #expect(
            workspace.isStaleAgentHookBinding(
                binding,
                panelId: panelId,
                restorableAgentIndex: fixture.index
            ) == false
        )
    }

    @Test
    func currentRuntimeGenerationOverridesCachedExit() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let sessionID = "same-session-live-runtime"
        let fixture = try Self.exitedCodexIndex(
            workspaceID: workspace.id,
            panelID: panelId,
            sessionID: sessionID
        )
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let binding = Self.codexAgentHookBinding(
            sessionID: sessionID,
            updatedAt: fixture.updatedAt
        )
        let processID = getpid()
        let processIdentity = try #require(AgentPIDProcessIdentity(pid: processID))
        let key = "codex.\(sessionID)"
        workspace.agentPIDs[key] = processID
        workspace.agentPIDProcessIdentitiesByKey[key] = processIdentity
        workspace.agentPIDKeysByPanelId[panelId] = [key]

        #expect(
            workspace.isStaleAgentHookBinding(
                binding,
                panelId: panelId,
                restorableAgentIndex: fixture.index
            ) == false
        )
    }

    @Test
    func exitedDifferentSessionDoesNotRetireNewerBinding() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let fixture = try Self.exitedCodexIndex(
            workspaceID: workspace.id,
            panelID: panelId,
            sessionID: "older-exited-session"
        )
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let binding = Self.codexAgentHookBinding(sessionID: "newer-published-session")

        #expect(
            workspace.isStaleAgentHookBinding(
                binding,
                panelId: panelId,
                restorableAgentIndex: fixture.index
            ) == false
        )
    }

    @Test
    func persistentSSHAgentHookBindingIsNeverConsideredStaleByLocalScan() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let remoteContext = SurfaceResumeRemoteContext(
            workspaceID: workspace.id,
            surfaceID: panelId,
            persistentPTYSessionID: "remote-pty-1"
        )
        let binding = Self.agentHookBinding(launchFlavor: .persistentSSH(remoteContext))

        // No local process can ever exist for a remote agent, so this must
        // NOT be reported as stale (that would delete a still-live remote
        // binding on the next reconciliation).
        #expect(workspace.isStaleAgentHookBinding(binding, panelId: panelId) == false)
    }

    @Test
    func missingScanEntryPreservesAutomaticBinding() throws {
        let workspace = Workspace()
        defer { workspace.teardownAllPanels() }
        let panelId = try #require(workspace.focusedPanelId)
        let binding = Self.codexAgentHookBinding(
            sessionID: "scan-not-caught-up",
            autoResume: true
        )
        #expect(workspace.setSurfaceResumeBinding(binding, panelId: panelId))

        workspace.reconcileSurfaceResumeBindings(
            using: .empty,
            restorableAgentIndex: .empty
        )

        let retainedBinding = try #require(workspace.surfaceResumeBinding(panelId: panelId))
        #expect(retainedBinding.checkpointId == binding.checkpointId)
        #expect(retainedBinding.autoResume == true)
    }

    @Test
    func confirmedExitedBindingIsRetainedForManualRestore() throws {
        let workspace = Workspace()
        defer { workspace.teardownAllPanels() }
        let panelId = try #require(workspace.focusedPanelId)
        let sessionID = "confirmed-exited-manual-restore"
        let fixture = try Self.exitedCodexIndex(
            workspaceID: workspace.id,
            panelID: panelId,
            sessionID: sessionID
        )
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let binding = Self.codexAgentHookBinding(
            sessionID: sessionID,
            autoResume: true,
            updatedAt: fixture.updatedAt
        )
        #expect(workspace.setSurfaceResumeBinding(binding, panelId: panelId))

        workspace.reconcileSurfaceResumeBindings(
            using: .empty,
            restorableAgentIndex: fixture.index
        )

        let retainedBinding = try #require(workspace.surfaceResumeBinding(panelId: panelId))
        #expect(retainedBinding.checkpointId == binding.checkpointId)
        #expect(retainedBinding.autoResume == false)
    }

    @Test
    func reconciliationKeepsPiBindingAfterResumeScannerResolvesUUIDToSessionPath() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let binding = Self.piAgentHookBinding()
        let index = Self.livePiIndex(workspaceId: workspace.id, panelId: panelId)
        try #require(workspace.setSurfaceResumeBinding(binding, panelId: panelId))

        workspace.reconcileSurfaceResumeBindings(
            using: .empty,
            restorableAgentIndex: index
        )

        #expect(workspace.surfaceResumeBinding(panelId: panelId) == binding)
    }

    @Test
    func sessionRestoreMatchesPiBindingUUIDToDetectedSessionPath() throws {
        let workspace = Workspace()
        let panelId = try #require(workspace.focusedPanelId)
        let binding = Self.piAgentHookBinding()
        let index = Self.livePiIndex(workspaceId: workspace.id, panelId: panelId)
        let detectedSnapshot = try #require(
            index.snapshot(workspaceId: workspace.id, panelId: panelId)
        )

        let restoredSnapshot = Workspace.restorableAgentForSessionRestore(
            detectedSnapshot,
            resumeBinding: binding
        )

        #expect(restoredSnapshot?.sessionId == Self.piSessionPath)
    }

    private static func exitedCodexIndex(
        workspaceID: UUID,
        panelID: UUID,
        sessionID: String
    ) throws -> (
        root: URL,
        index: RestorableAgentSessionIndex,
        updatedAt: TimeInterval
    ) {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent(
                "cmux-stale-binding-\(UUID().uuidString)",
                isDirectory: true
            )
        let updatedAt: TimeInterval = 1_777_777_777
        let storeURL = RestorableAgentKind.codex.hookStoreFileURL(
            homeDirectory: root.path,
            environment: [:]
        )
        try fileManager.createDirectory(
            at: storeURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let record: [String: Any] = [
            "sessionId": sessionID,
            "workspaceId": workspaceID.uuidString,
            "surfaceId": panelID.uuidString,
            "cwd": "/tmp/repo",
            "pid": 987_654_321,
            "isRestorable": true,
            "updatedAt": updatedAt,
            "launchCommand": [
                "launcher": "codex",
                "executablePath": "/usr/local/bin/codex",
                "arguments": ["/usr/local/bin/codex"],
                "workingDirectory": "/tmp/repo",
                "capturedAt": updatedAt,
                "source": "test",
            ],
        ]
        let data = try JSONSerialization.data(
            withJSONObject: ["version": 1, "sessions": [sessionID: record]],
            options: [.prettyPrinted, .sortedKeys]
        )
        try data.write(to: storeURL, options: .atomic)
        let index = RestorableAgentSessionIndex.load(
            homeDirectory: root.path,
            fileManager: fileManager,
            registry: CmuxVaultAgentRegistry(registrations: []),
            detectedSnapshots: [:],
            processArgumentsProvider: { _ in nil },
            processPresenceProvider: { _ in .absent },
            processIdentityProvider: { _ in nil }
        )
        #expect(
            index.entry(
                workspaceId: workspaceID,
                panelId: panelID
            )?.processLiveness == .exited
        )
        return (root, index, updatedAt)
    }
}
