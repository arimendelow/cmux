import AppKit
import CMUXAgentLaunch
import CmuxControlSocket
import Foundation

@MainActor
enum ControlSurfaceResumeTarget {
    case workspace(tabManager: TabManager, workspace: Workspace, surfaceID: UUID)
    case dock(tabManager: TabManager, dock: DockSplitStore, surfaceID: UUID)

    var tabManager: TabManager {
        switch self {
        case .workspace(let tabManager, _, _), .dock(let tabManager, _, _): tabManager
        }
    }

    var surfaceID: UUID {
        switch self {
        case .workspace(_, _, let surfaceID), .dock(_, _, let surfaceID): surfaceID
        }
    }

    var workspaceID: UUID {
        switch self {
        case .workspace(_, let workspace, _): workspace.id
        case .dock(_, let dock, _): dock.workspaceId
        }
    }

    var paneID: UUID? {
        switch self {
        case .workspace(_, let workspace, let surfaceID):
            workspace.paneId(forPanelId: surfaceID)?.id
        case .dock(_, let dock, let surfaceID):
            dock.paneId(forPanelId: surfaceID)?.id
        }
    }

    var binding: SurfaceResumeBindingSnapshot? {
        switch self {
        case .workspace(_, let workspace, let surfaceID):
            workspace.surfaceResumeBinding(panelId: surfaceID)
        case .dock(_, let dock, let surfaceID):
            dock.surfaceResumeBinding(panelId: surfaceID)
        }
    }

    var managedBinding: SurfaceResumeBindingSnapshot? {
        switch self {
        case .workspace(_, let workspace, let surfaceID):
            workspace.managedAgentResumeBinding(panelId: surfaceID)
        case .dock(_, let dock, let surfaceID):
            dock.managedAgentResumeBinding(panelId: surfaceID)
        }
    }

    var restorableAgent: SessionRestorableAgentSnapshot? {
        switch self {
        case .workspace(_, let workspace, let surfaceID):
            workspace.restoredAgentSnapshotsByPanelId[surfaceID]
        case .dock(_, let dock, let surfaceID):
            dock.restoredAgentLifecycle.snapshotsByPanelId[surfaceID]
        }
    }

    var restoredResumeWorkingDirectory: String? {
        switch self {
        case .workspace(_, let workspace, let surfaceID):
            workspace.restoredResumeSessionWorkingDirectoriesByPanelId[surfaceID]
        case .dock(_, let dock, let surfaceID):
            dock.restoredResumeSessionWorkingDirectoriesByPanelId[surfaceID]
        }
    }

    func launcherBindingTarget(
        agentSessionID: String
    ) -> WorkbenchLauncherBindingTarget? {
        func matches(_ snapshot: SessionRestorableAgentSnapshot?) -> Bool {
            guard let snapshot else { return false }
            return ManagedAgentSessionIdentity.sessionIDsMatch(
                kind: snapshot.kind.rawValue,
                lhs: snapshot.sessionId,
                rhs: agentSessionID
            )
        }

        let cachedEntry = SharedLiveAgentIndex.shared.index?.entry(
            workspaceId: workspaceID,
            panelId: surfaceID
        )
        let managedSnapshot: SessionRestorableAgentSnapshot? =
            managedBinding.flatMap { binding -> SessionRestorableAgentSnapshot? in
            guard let rawKind = binding.kind,
                  let kind = RestorableAgentKind(rawValue: rawKind),
                  let sessionID = binding.checkpointId else {
                return nil
            }
            return SessionRestorableAgentSnapshot(
                kind: kind,
                sessionId: sessionID,
                workingDirectory: binding.cwd,
                launchCommand: binding.launchCommand,
                permissionMode: binding.permissionMode,
                workbenchAuthority: binding.workbenchAuthority
            )
        }
        let candidates: [SessionRestorableAgentSnapshot?] = [
            cachedEntry?.snapshot,
            restorableAgent,
            managedSnapshot,
        ]
        let inMemorySnapshot = candidates
            .compactMap { $0 }
            .first(where: matches)
        return WorkbenchLauncherBindingTarget(
            surfaceID: surfaceID,
            snapshot: inMemorySnapshot
        )
    }

    func restoreWorkingDirectory(
        binding: SurfaceResumeBindingSnapshot?,
        agent: SessionRestorableAgentSnapshot?
    ) -> String? {
        let managedBindingOwnsDirectory =
            binding.map {
                managedBinding?.isSameManagedSession(as: $0) == true &&
                    self.binding?.isSameManagedSession(as: $0) != true
            } ?? false
        if managedBindingOwnsDirectory {
            return binding?.cwd
                ?? agent?.workingDirectory
                ?? binding?.launchCommand?.workingDirectory
                ?? restoredResumeWorkingDirectory
        }
        return restoredResumeWorkingDirectory
            ?? binding?.cwd
            ?? agent?.workingDirectory
            ?? binding?.launchCommand?.workingDirectory
    }

    func bindingForGet(
        expectedKind: String?,
        expectedCheckpointID: String?
    ) -> SurfaceResumeBindingSnapshot? {
        let effectiveBinding = binding
        guard expectedKind != nil || expectedCheckpointID != nil else {
            return effectiveBinding
        }
        func matches(_ candidate: SurfaceResumeBindingSnapshot) -> Bool {
            let kindMatches =
                expectedKind == nil ||
                candidate.kind == expectedKind
            let checkpointMatches: Bool
            if let expectedCheckpointID,
               let kind = candidate.kind,
               let checkpointID = candidate.checkpointId {
                checkpointMatches = ManagedAgentSessionIdentity.sessionIDsMatch(
                    kind: kind,
                    lhs: checkpointID,
                    rhs: expectedCheckpointID
                )
            } else {
                checkpointMatches =
                    expectedCheckpointID == nil ||
                    candidate.checkpointId == expectedCheckpointID
            }
            return kindMatches && checkpointMatches
        }
        if let effectiveBinding, matches(effectiveBinding) {
            if effectiveBinding.isAgentHookBinding,
               let managedBinding,
               managedBinding.isSameManagedSession(as: effectiveBinding),
               matches(managedBinding) {
                return managedBinding
            }
            return effectiveBinding
        }
        if let managedBinding, matches(managedBinding) {
            return managedBinding
        }
        return nil
    }

    @discardableResult
    func setBinding(_ binding: SurfaceResumeBindingSnapshot) -> Bool {
        switch self {
        case .workspace(_, let workspace, let surfaceID):
            workspace.setSurfaceResumeBinding(binding, panelId: surfaceID)
        case .dock(_, let dock, let surfaceID):
            dock.setSurfaceResumeBinding(binding, panelId: surfaceID)
        }
    }

    func bindingForClear(
        expectedCheckpointID: String?,
        expectedSource: String?,
        agentSessionEnded: Bool
    ) -> SurfaceResumeBindingSnapshot? {
        if agentSessionEnded {
            let candidate = managedBinding ?? binding
            return candidate?.workbenchAuthorityEvidence
                .isVerifiedLauncherEvidence == true
                ? nil
                : candidate
        }
        if expectedCheckpointID != nil || expectedSource != nil {
            func matches(_ candidate: SurfaceResumeBindingSnapshot) -> Bool {
                if expectedSource != nil,
                   candidate.workbenchAuthorityEvidence
                    .isVerifiedLauncherEvidence {
                    return false
                }
                let matchesCheckpoint =
                    expectedCheckpointID == nil ||
                    checkpointMatches(
                        expectedCheckpointID,
                        binding: candidate
                    )
                let sourceMatches =
                    expectedSource == nil ||
                    candidate.source == expectedSource
                return matchesCheckpoint && sourceMatches
            }
            if let effectiveBinding = binding, matches(effectiveBinding) {
                if effectiveBinding.isAgentHookBinding,
                   let managedBinding,
                   managedBinding.isSameManagedSession(as: effectiveBinding),
                   matches(managedBinding) {
                    return managedBinding
                }
                return effectiveBinding
            }
            if let managedBinding, matches(managedBinding) {
                return managedBinding
            }
            return nil
        }
        return binding
    }

    @discardableResult
    func applyAuthorityAttestation(
        _ authority: WorkbenchSessionAuthority,
        evidence: WorkbenchAuthorityEvidence,
        snapshot: SessionRestorableAgentSnapshot
    ) -> Bool {
        func attested(
            _ binding: SurfaceResumeBindingSnapshot?
        ) -> SurfaceResumeBindingSnapshot? {
            guard var binding,
                  let kind = binding.kind,
                  let checkpointID = binding.checkpointId,
                  kind == snapshot.kind.rawValue,
                  ManagedAgentSessionIdentity.sessionIDsMatch(
                      kind: kind,
                      lhs: checkpointID,
                      rhs: snapshot.sessionId
                  ) else {
                return binding
            }
            binding.workbenchAuthority = authority
            binding.workbenchAuthorityEvidence = evidence
            return binding
        }

        var updatedSnapshot = snapshot
        updatedSnapshot.workbenchAuthority = authority
        switch self {
        case .workspace(_, let workspace, let surfaceID):
            workspace.restoredAgentSnapshotsByPanelId[surfaceID] =
                updatedSnapshot
            workspace.surfaceResumeBindingsByPanelId[surfaceID] =
                attested(workspace.surfaceResumeBindingsByPanelId[surfaceID])
            workspace.managedAgentResumeBindingsByPanelId[surfaceID] =
                attested(
                    workspace.managedAgentResumeBindingsByPanelId[surfaceID]
                )
        case .dock(_, let dock, let surfaceID):
            dock.restoredAgentLifecycle.snapshotsByPanelId[surfaceID] =
                updatedSnapshot
            dock.surfaceResumeBindingsByPanelId[surfaceID] =
                attested(dock.surfaceResumeBindingsByPanelId[surfaceID])
            dock.managedAgentResumeBindingsByPanelId[surfaceID] =
                attested(
                    dock.managedAgentResumeBindingsByPanelId[surfaceID]
                )
        }
        return true
    }

    func checkpointMatches(
        _ expectedCheckpointID: String?,
        binding: SurfaceResumeBindingSnapshot?
    ) -> Bool {
        guard let expectedCheckpointID else { return true }
        guard let binding,
              let checkpointID = binding.checkpointId else {
            return false
        }
        guard let kind = binding.kind else {
            return checkpointID == expectedCheckpointID
        }
        return ManagedAgentSessionIdentity.sessionIDsMatch(
            kind: kind,
            lhs: checkpointID,
            rhs: expectedCheckpointID
        )
    }

    func restoreAuthority(
        selectedBinding: SurfaceResumeBindingSnapshot?
    ) -> WorkbenchSessionAuthority {
        let agent = restorableAgent
        let authorityBinding: SurfaceResumeBindingSnapshot?
        if let selectedBinding, !selectedBinding.isAgentHookBinding {
            if Workspace.effectiveBindingLaunchesManagedAgent(selectedBinding),
               let managedBinding {
                if agent == nil || Workspace.restorableAgentForSessionRestore(
                    agent,
                    resumeBinding: managedBinding
                ) != nil {
                    authorityBinding = managedBinding
                } else {
                    return .unknown
                }
            } else {
                authorityBinding = selectedBinding
            }
        } else if let selectedBinding, selectedBinding.isAgentHookBinding {
            if let managedBinding,
               managedBinding.isSameManagedSession(as: selectedBinding) {
                authorityBinding = managedBinding
            } else {
                authorityBinding = selectedBinding
            }
        } else if let managedBinding,
                  Workspace.restorableAgentForSessionRestore(
                      agent,
                      resumeBinding: managedBinding
                  ) != nil {
            authorityBinding = managedBinding
        } else {
            authorityBinding = nil
        }
        let authorityAgent: SessionRestorableAgentSnapshot? =
            if let selectedBinding,
               !selectedBinding.isAgentHookBinding,
               !Workspace.effectiveBindingLaunchesManagedAgent(
                   selectedBinding
               ) {
                nil
            } else {
                Workspace.restorableAgentForSessionRestore(
                    agent,
                    resumeBinding: authorityBinding
                )
            }
        return WorkbenchSessionAuthority.resolved(
            agent: authorityAgent,
            binding: authorityBinding
        )
    }

    func protectedRestoreBinding(
        selectedBinding: SurfaceResumeBindingSnapshot?
    ) -> SurfaceResumeBindingSnapshot? {
        guard let selectedBinding,
              selectedBinding.isAgentHookBinding,
              let managedBinding,
              managedBinding.isSameManagedSession(as: selectedBinding) else {
            return selectedBinding
        }
        return managedBinding
    }

    func restorableAgentMatches(
        expectedKind: String?,
        expectedCheckpointID: String?
    ) -> Bool {
        guard let agent = restorableAgent else { return false }
        if let expectedKind, agent.kind.rawValue != expectedKind {
            return false
        }
        guard let expectedCheckpointID else { return true }
        return ManagedAgentSessionIdentity.sessionIDsMatch(
            kind: agent.kind.rawValue,
            lhs: agent.sessionId,
            rhs: expectedCheckpointID
        )
    }

    @discardableResult
    func clearBinding(
        _ binding: SurfaceResumeBindingSnapshot?,
        agentSessionEnded: Bool
    ) -> Bool {
        guard let binding else { return false }
        switch self {
        case .workspace(_, let workspace, let surfaceID):
            if binding.isAgentHookBinding,
               workspace.managedAgentResumeBinding(panelId: surfaceID)?
                   .isSameManagedSession(as: binding) == true {
                return workspace.clearManagedAgentResumeBinding(
                    panelId: surfaceID,
                    matching: binding,
                    agentSessionEnded: agentSessionEnded
                )
            }
            return workspace.clearSurfaceResumeBinding(
                panelId: surfaceID,
                matching: binding
            )
        case .dock(_, let dock, let surfaceID):
            return dock.clearSurfaceResumeBinding(
                panelId: surfaceID,
                binding: binding,
                agentSessionEnded: agentSessionEnded
            )
        }
    }

    func registeredBinding(
        _ binding: SurfaceResumeBindingSnapshot,
        inputs: ControlSurfaceResumeSetInputs
    ) -> SurfaceResumeBindingSnapshot? {
        guard let remoteWorkspaceID = inputs.remoteWorkspaceID else { return binding }
        guard let relayParameters = inputs.remoteRelayParameters else { return nil }

        switch self {
        case .workspace(_, let workspace, let surfaceID):
            guard remoteWorkspaceID == workspace.id,
                  WorkspaceRemoteRelayCommandRewriter.authenticatesRemoteResumeParameters(
                      relayParameters.mapValues(\.foundationObject),
                      remoteRelayTokenHex: workspace.remoteConfiguration?.relayToken
                  ),
                  let context = workspace.persistentSSHResumeContext(panelID: surfaceID) else {
                return nil
            }
            return binding.registeredForPersistentSSH(context)
        case .dock(_, let dock, let surfaceID):
            guard let registration = dock.persistentSSHResumeRegistration(panelId: surfaceID),
                  remoteWorkspaceID == registration.context.workspaceID,
                  WorkspaceRemoteRelayCommandRewriter.authenticatesRemoteResumeParameters(
                      relayParameters.mapValues(\.foundationObject),
                      remoteRelayTokenHex: registration.relayToken
                  ) else {
                return nil
            }
            return binding.registeredForPersistentSSH(registration.context)
        }
    }
}

extension TerminalController {
    private func resolveSurfaceResumeTarget(
        routing: ControlRoutingSelectors,
        explicitTargetID: UUID?,
        hasResolvedWindowID: Bool,
        fallbackTabManager: TabManager
    ) -> ControlSurfaceResumeTarget? {
        if let explicitSurfaceID = explicitTargetID {
            if let explicitWorkspaceID = routing.workspaceID,
               let workspace = fallbackTabManager.tabs.first(where: { $0.id == explicitWorkspaceID }),
               workspace.terminalPanel(for: explicitSurfaceID) != nil {
                return .workspace(
                    tabManager: fallbackTabManager,
                    workspace: workspace,
                    surfaceID: explicitSurfaceID
                )
            }
            if let dockTarget = resolveDockSurfaceResumeTarget(
                routing: routing,
                surfaceID: explicitSurfaceID,
                hasResolvedWindowID: hasResolvedWindowID,
                fallbackTabManager: fallbackTabManager
            ) {
                return dockTarget
            }
            if routing.workspaceID != nil { return nil }
            if hasResolvedWindowID {
                guard let workspace = fallbackTabManager.tabs.first(where: {
                    $0.terminalPanel(for: explicitSurfaceID) != nil
                }) else {
                    return nil
                }
                return .workspace(
                    tabManager: fallbackTabManager,
                    workspace: workspace,
                    surfaceID: explicitSurfaceID
                )
            }
            if let located = AppDelegate.shared?.locateSurface(surfaceId: explicitSurfaceID),
               let workspace = located.tabManager.tabs.first(where: { $0.id == located.workspaceId }),
               workspace.terminalPanel(for: explicitSurfaceID) != nil {
                return .workspace(
                    tabManager: located.tabManager,
                    workspace: workspace,
                    surfaceID: explicitSurfaceID
                )
            }
            if let workspace = fallbackTabManager.tabs.first(where: {
                $0.terminalPanel(for: explicitSurfaceID) != nil
            }) {
                return .workspace(
                    tabManager: fallbackTabManager,
                    workspace: workspace,
                    surfaceID: explicitSurfaceID
                )
            }
            if let workspace = resolveSurfaceWorkspace(routing: routing, tabManager: fallbackTabManager),
               workspace.terminalPanel(for: explicitSurfaceID) != nil {
                return .workspace(
                    tabManager: fallbackTabManager,
                    workspace: workspace,
                    surfaceID: explicitSurfaceID
                )
            }
            return nil
        }

        if let dock = windowDockForRouting(routing, tabManager: fallbackTabManager),
           let surfaceID = dock.focusedPanelId,
           dock.panels[surfaceID] is TerminalPanel {
            return .dock(tabManager: dockOwnerTabManager(for: dock, fallback: fallbackTabManager), dock: dock, surfaceID: surfaceID)
        }
        guard let workspace = resolveSurfaceWorkspace(routing: routing, tabManager: fallbackTabManager),
              let surfaceID = workspace.focusedPanelId,
              workspace.terminalPanel(for: surfaceID) != nil else {
            return nil
        }
        return .workspace(tabManager: fallbackTabManager, workspace: workspace, surfaceID: surfaceID)
    }

    private func resolveDockSurfaceResumeTarget(
        routing: ControlRoutingSelectors,
        surfaceID: UUID,
        hasResolvedWindowID: Bool,
        fallbackTabManager: TabManager
    ) -> ControlSurfaceResumeTarget? {
        guard let dock = DockSplitStore.liveStores.first(where: {
            $0.containsPanel(surfaceID) && $0.panels[surfaceID] is TerminalPanel
        }),
        let location = locateDockSurface(surfaceID) else {
            return nil
        }
        if hasResolvedWindowID, location.tabManager !== fallbackTabManager { return nil }
        if let explicitWorkspaceID = routing.workspaceID {
            switch dock.scope {
            case .workspace:
                guard explicitWorkspaceID == dock.workspaceId else { return nil }
            case .global:
                if AppDelegate.isWindowDockRoutingId(explicitWorkspaceID),
                   windowDockMismatchesExplicitSelectors(
                       routing,
                       dock: dock,
                       aliasTabManager: fallbackTabManager
                   ) {
                    return nil
                }
            }
        }
        return .dock(tabManager: location.tabManager, dock: dock, surfaceID: surfaceID)
    }

    private func surfaceResumeSnapshot(
        target: ControlSurfaceResumeTarget,
        binding: SurfaceResumeBindingSnapshot?,
        cleared: Bool,
        allowsAgentSnapshotFallback: Bool = true
    ) -> ControlSurfaceResumeSnapshot {
        ControlSurfaceResumeSnapshot(
            windowID: target.windowID(using: self),
            workspaceID: target.workspaceID,
            paneID: target.paneID,
            surfaceID: target.surfaceID,
            cleared: cleared,
            binding: controlResumeBinding(from: binding),
            restoreRecord: cleared
                ? nil
                : controlSurfaceRestoreRecord(
                    target: target,
                    binding: binding,
                    allowsAgentSnapshotFallback: allowsAgentSnapshotFallback
                )
        )
    }

    private func controlSurfaceRestoreRecord(
        target: ControlSurfaceResumeTarget,
        binding selectedBinding: SurfaceResumeBindingSnapshot?,
        allowsAgentSnapshotFallback: Bool
    ) -> ControlSurfaceRestoreRecord? {
        if selectedBinding == nil, !allowsAgentSnapshotFallback {
            return nil
        }
        guard target.restoreAuthority(selectedBinding: selectedBinding) == .controlledHere else {
            return nil
        }
        let binding = target.protectedRestoreBinding(
            selectedBinding: selectedBinding
        )
        let isLauncherOwned = binding?.workbenchAuthorityEvidence == .launcherOwned
        // Structured fields remain untouched; only the explicit legacy fallback
        // receives restore-time provider refreshes that older records depended on.
        let compatibilityBinding = binding.map {
            Workspace.makeSessionRestorePolicyService()
                .bindingForCompatibilityShellRestore($0)
        }
        // A hook can replace the live binding after this surface was restored,
        // while the restore-time agent snapshot still names the previous
        // conversation. Reuse the session-restore identity gate so the record
        // returned to the CLI always agrees with the binding that generated its
        // typed `cmux restore <kind> <checkpoint>` selector.
        let compatibleAgent: SessionRestorableAgentSnapshot? =
            if binding == nil || binding?.isAgentHookBinding == true {
                Workspace.restorableAgentForSessionRestore(
                    target.restorableAgent,
                    resumeBinding: binding
                ) ?? binding.flatMap { binding in
                    guard binding.isAgentHookBinding,
                          let rawKind = binding.kind,
                          let kind = RestorableAgentKind(rawValue: rawKind),
                          let sessionID = binding.checkpointId?.trimmingCharacters(
                              in: .whitespacesAndNewlines
                          ),
                          !sessionID.isEmpty else {
                        return nil
                    }
                    return SessionRestorableAgentSnapshot(
                        kind: kind,
                        sessionId: sessionID,
                        workingDirectory: binding.cwd ?? binding.launchCommand?.workingDirectory,
                        launchCommand: binding.launchCommand,
                        permissionMode: binding.permissionMode,
                        workbenchAuthority: binding.workbenchAuthority
                    )
                }
            } else {
                nil
            }
        if let agent = compatibleAgent {
            let bindingReplacedAgent = target.restorableAgent != nil
                && target.restorableAgent?.sessionId != agent.sessionId
            let source = target.restorableAgent == nil
                || bindingReplacedAgent
                ? binding?.source ?? "session-snapshot"
                : "session-snapshot"
            let launchCommand = isLauncherOwned
                ? binding?.launchCommand
                : binding?.launchCommand ?? agent.launchCommand
            let workingDirectory = target.restoreWorkingDirectory(
                binding: binding,
                agent: agent
            )
            let permissionMode = binding?.permissionMode ?? agent.permissionMode
            let launcherOwnedArguments: [String]? =
                if isLauncherOwned,
                   let arguments = binding?.launchCommand?.arguments,
                   !arguments.isEmpty {
                    arguments
                } else {
                    nil
                }
            let mode: AgentRestoreRequestMode =
                if isLauncherOwned {
                    .direct
                } else if agent.kind.restoreMode == .relaunchCommand {
                    .relaunchAgent
                } else {
                    .resumeAgent
                }
            let preparedArguments: [String]? =
                if isLauncherOwned {
                    launcherOwnedArguments
                } else if agent.kind.restoreMode == .resumeSession {
                    agent.preparedResumeArguments(
                        launchCommand: launchCommand,
                        workingDirectory: workingDirectory,
                        observedPermissionMode: permissionMode
                    )
                } else {
                    nil
                }
            return ControlSurfaceRestoreRecord(
                modeRawValue: mode.rawValue,
                kind: agent.kind.rawValue,
                checkpointID: agent.sessionId,
                source: source,
                workingDirectory: workingDirectory,
                environment: binding?.environment ?? [:],
                launchCommand: launchCommand.map {
                    controlAgentLaunchCommand(
                        $0,
                        replaySafeEnvironmentFor: agent.kind.rawValue
                    )
                },
                preparedArguments: isLauncherOwned
                    ? preparedArguments
                    : (target.restorableAgent == nil ? nil : preparedArguments),
                preparedArgumentsWorkingDirectory: preparedArguments == nil
                    ? nil
                    : workingDirectory,
                permissionMode: permissionMode,
                legacyCommand: isLauncherOwned
                    ? binding?.command
                    : bindingReplacedAgent
                        ? binding?.command ?? compatibilityBinding?.command
                        : compatibilityBinding?.inlineStartupInput
            )
        }
        guard let binding else { return nil }
        let trimmedKind = binding.kind?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedKind = trimmedKind.flatMap { $0.isEmpty ? nil : $0 } ?? "command"
        let mode: AgentRestoreRequestMode = binding.isAgentHookBinding && !isLauncherOwned
            ? .resumeAgent
            : .direct
        return ControlSurfaceRestoreRecord(
            modeRawValue: mode.rawValue,
            kind: normalizedKind,
            checkpointID: binding.checkpointId,
            source: binding.source,
            workingDirectory: target.restoreWorkingDirectory(
                binding: binding,
                agent: nil
            ),
            environment: binding.environment ?? [:],
            launchCommand: binding.launchCommand.map {
                controlAgentLaunchCommand(
                    $0,
                    replaySafeEnvironmentFor: normalizedKind
                )
            },
            preparedArguments: mode == .direct ? binding.launchCommand?.arguments : nil,
            preparedArgumentsWorkingDirectory: nil,
            permissionMode: binding.permissionMode,
            legacyCommand: isLauncherOwned ? binding.command : compatibilityBinding?.inlineStartupInput
        )
    }

    func controlAgentLaunchCommand(
        _ command: AgentLaunchCommandSnapshot,
        replaySafeEnvironmentFor kind: String? = nil
    ) -> ControlAgentLaunchCommand {
        let environment = kind.flatMap { kind in
            command.environment.map {
                AgentLaunchEnvironmentPolicy().selectedRestoreEnvironment(
                    from: $0,
                    kind: kind
                )
            }
        } ?? command.environment
        return ControlAgentLaunchCommand(
            launcher: command.launcher,
            executablePath: command.executablePath,
            arguments: command.arguments,
            workingDirectory: command.workingDirectory,
            environment: environment,
            capturedAt: command.capturedAt,
            source: command.source
        )
    }

    private func surfaceResumeBindingWithApproval(
        _ binding: SurfaceResumeBindingSnapshot
    ) -> SurfaceResumeApprovalLookup<SurfaceResumeBindingSnapshot> {
        let context: (
            effectiveBinding: SurfaceResumeBindingSnapshot,
            existingRecord: SurfaceResumeApprovalRecord?
        )
        switch SurfaceResumeApprovalStore.approvalProposalContext(for: binding) {
        case .pendingSigningSecret:
            return .pendingSigningSecret
        case let .resolved(resolvedContext):
            context = resolvedContext
        }
        var effectiveBinding = context.effectiveBinding
        if let promptlessCLIManualBinding = SurfaceResumeApprovalStore.applyingPromptlessCLIManualApprovalIfNeeded(
            to: binding,
            existingRecord: context.existingRecord
        ) {
            return .resolved(promptlessCLIManualBinding)
        }
        guard SurfaceResumeApprovalStore.shouldPromptForProposal(
            binding: binding,
            existingRecord: context.existingRecord,
            isMainThread: Thread.isMainThread,
            isRunningTests: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        ) else {
            return .resolved(effectiveBinding)
        }
        let approval = surfacePromptForResumeApproval(binding: effectiveBinding)
        guard let record = SurfaceResumeApprovalStore.approve(
            binding: binding,
            policy: approval.policy,
            commandPrefix: approval.commandPrefix
        ) else {
            return .resolved(effectiveBinding)
        }
        effectiveBinding.approvalPolicy = record.policy
        effectiveBinding.approvalRecordId = record.id
        effectiveBinding.autoResume = record.policy == .auto
        return .resolved(effectiveBinding)
    }

    private var surfaceResumeApprovalPendingMessage: String {
        String(
            localized: "surfaceResumeApproval.pending.message",
            defaultValue: "Resume approval data is still loading. Retry the request."
        )
    }

    private func surfacePromptForResumeApproval(
        binding: SurfaceResumeBindingSnapshot
    ) -> (policy: SurfaceResumeApprovalPolicy, commandPrefix: [String]?) {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = String(
            localized: "surfaceResumeApproval.proposal.title",
            defaultValue: "Allow Resume Command?"
        )
        let cwd = binding.cwd ?? String(localized: "surfaceResumeApproval.cwd.none", defaultValue: "None")
        let informativeText = String(
            format: String(
                localized: "surfaceResumeApproval.proposal.message",
                defaultValue: "A process wants cmux to keep this resume command for the current terminal:\n\nWorking directory: %@\n\n%@"
            ),
            cwd,
            binding.command
        )
        alert.addButton(withTitle: String(localized: "surfaceResumeApproval.proposal.auto", defaultValue: "Auto-Restore"))
        alert.addButton(withTitle: String(localized: "surfaceResumeApproval.proposal.ask", defaultValue: "Ask Each Time"))
        alert.addButton(withTitle: String(localized: "surfaceResumeApproval.proposal.manual", defaultValue: "Keep Manual"))
        let generalizedPrefix = SurfaceResumeCommandCanonicalizer.generalizedApprovalPrefix(
            forCommand: binding.command
        )
        let folderScopedGeneralizedPrefix =
            SurfaceResumeCommandCanonicalizer.normalizedCWD(binding.cwd) == nil
            ? nil
            : generalizedPrefix
        if let generalizedPrefix = folderScopedGeneralizedPrefix {
            let renderedPrefix = generalizedPrefix
                .map(SurfaceResumeCommandCanonicalizer.shellQuoted)
                .joined(separator: " ")
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = String(
                format: String(
                    localized: "surfaceResumeApproval.proposal.applyToPrefix",
                    defaultValue: "Apply to all commands starting with “%@” in this folder"
                ),
                renderedPrefix
            )
        }
        let content = CmuxAlertContent(
            flattenedText: informativeText,
            separatingScrollableDetails: binding.command
        )
        content.apply(to: alert, presentingWindow: nil)

        let response = alert.runModal()
        let commandPrefix = alert.suppressionButton?.state == .on
            ? folderScopedGeneralizedPrefix
            : nil
        return switch response {
        case .alertFirstButtonReturn: (.auto, commandPrefix)
        case .alertSecondButtonReturn: (.prompt, commandPrefix)
        default: (.manual, commandPrefix)
        }
    }

    func controlSurfaceResumeSet(
        routing: ControlRoutingSelectors,
        explicitTargetID: UUID?,
        hasResolvedWindowID: Bool,
        inputs: ControlSurfaceResumeSetInputs
    ) -> ControlSurfaceResumeResolution {
        guard let tabManager = resolveTabManager(routing: routing) else {
            return .windowUnavailable
        }
        guard let target = resolveSurfaceResumeTarget(
            routing: routing,
            explicitTargetID: explicitTargetID,
            hasResolvedWindowID: hasResolvedWindowID,
            fallbackTabManager: tabManager
        ) else {
            return .surfaceNotFound
        }

        let verifiedSnapshot: SessionRestorableAgentSnapshot?
        if let authority = inputs.authority,
           let agentSessionID = inputs.agentSessionID {
            verifiedSnapshot = WorkbenchLauncherBindingVerifier(
                processIsDescendant: {
                    self.transport.isProcessDescendant($0, of: $1)
                }
            ).verifiedSnapshot(
                agentSessionID: agentSessionID,
                callerEvidence: inputs.callerEvidence,
                target: target.launcherBindingTarget(
                    agentSessionID: agentSessionID
                )
            )
            guard let verifiedSnapshot else {
                return .authorityRejected
            }
            if authority != .local {
                _ = target.applyAuthorityAttestation(
                    authority.workbenchAuthority,
                    evidence: .launcherAttested,
                    snapshot: verifiedSnapshot
                )
                return .result(surfaceResumeSnapshot(
                    target: target,
                    binding: target.binding,
                    cleared: false
                ))
            }
        } else {
            verifiedSnapshot = nil
        }

        guard let command = inputs.command else {
            return .emptyResumeCommand
        }
        let binding = SurfaceResumeBindingSnapshot(
            name: inputs.name,
            kind: verifiedSnapshot?.kind.rawValue ?? inputs.kind,
            command: command,
            cwd: inputs.cwd,
            checkpointId: inputs.agentSessionID ?? inputs.checkpointID,
            source: inputs.source,
            environment: inputs.environment,
            launchCommand: inputs.launchCommand.map {
                AgentLaunchCommandSnapshot(
                    launcher: $0.launcher,
                    executablePath: $0.executablePath,
                    arguments: $0.arguments,
                    workingDirectory: $0.workingDirectory,
                    environment: $0.environment,
                    capturedAt: $0.capturedAt,
                    source: $0.source
                )
            },
            permissionMode: inputs.permissionMode,
            autoResume: verifiedSnapshot == nil ? inputs.autoResume : true,
            workbenchAuthority: inputs.authority?.workbenchAuthority,
            workbenchAuthorityEvidence: verifiedSnapshot == nil
                ? .inferred
                : .launcherOwned,
            updatedAt: Date.now.timeIntervalSince1970
        )
        guard let locatedBinding = target.registeredBinding(binding, inputs: inputs) else {
            return .setFailed
        }
        let effectiveBinding: SurfaceResumeBindingSnapshot
        switch surfaceResumeBindingWithApproval(locatedBinding) {
        case .pendingSigningSecret:
            return .approvalPending(message: surfaceResumeApprovalPendingMessage)
        case let .resolved(binding):
            effectiveBinding = binding
        }
        guard target.setBinding(effectiveBinding) else {
            return .emptyResumeCommand
        }
        if let verifiedSnapshot,
           let authority = inputs.authority {
            _ = target.applyAuthorityAttestation(
                authority.workbenchAuthority,
                evidence: .launcherOwned,
                snapshot: verifiedSnapshot
            )
        }
        return .result(surfaceResumeSnapshot(target: target, binding: effectiveBinding, cleared: false))
    }

    func controlSurfaceResumeGet(
        routing: ControlRoutingSelectors,
        explicitTargetID: UUID?,
        hasResolvedWindowID: Bool,
        expectedKind: String?,
        expectedCheckpointID: String?
    ) -> ControlSurfaceResumeResolution {
        guard let tabManager = resolveTabManager(routing: routing) else {
            return .windowUnavailable
        }
        guard let target = resolveSurfaceResumeTarget(
            routing: routing,
            explicitTargetID: explicitTargetID,
            hasResolvedWindowID: hasResolvedWindowID,
            fallbackTabManager: tabManager
        ) else {
            return .surfaceNotFound
        }
        let binding = target.bindingForGet(
            expectedKind: expectedKind,
            expectedCheckpointID: expectedCheckpointID
        )
        if let binding,
           case .pendingSigningSecret = SurfaceResumeApprovalStore.applyingStoredApprovalLookup(to: binding) {
            return .approvalPending(message: surfaceResumeApprovalPendingMessage)
        }
        let selectorRequested = expectedKind != nil || expectedCheckpointID != nil
        let matchingSnapshotAvailable = target.restorableAgentMatches(
            expectedKind: expectedKind,
            expectedCheckpointID: expectedCheckpointID
        )
        return .result(
            surfaceResumeSnapshot(
                target: target,
                binding: binding,
                cleared: false,
                allowsAgentSnapshotFallback:
                    !selectorRequested || binding != nil || matchingSnapshotAvailable
            )
        )
    }

    func controlSurfaceResumeClear(
        routing: ControlRoutingSelectors,
        explicitTargetID: UUID?,
        hasResolvedWindowID: Bool,
        expectedCheckpointID: String?,
        expectedSource: String?,
        agentSessionEnded: Bool
    ) -> ControlSurfaceResumeResolution {
        guard let tabManager = resolveTabManager(routing: routing) else {
            return .windowUnavailable
        }
        guard let target = resolveSurfaceResumeTarget(
            routing: routing,
            explicitTargetID: explicitTargetID,
            hasResolvedWindowID: hasResolvedWindowID,
            fallbackTabManager: tabManager
        ) else {
            return .surfaceNotFound
        }
        let bindingForClear = target.bindingForClear(
            expectedCheckpointID: expectedCheckpointID,
            expectedSource: expectedSource,
            agentSessionEnded: agentSessionEnded
        )
        if !target.checkpointMatches(
            expectedCheckpointID,
            binding: bindingForClear
        ) {
            return .result(surfaceResumeSnapshot(target: target, binding: target.binding, cleared: false))
        }
        if let expectedSource, bindingForClear?.source != expectedSource {
            return .result(surfaceResumeSnapshot(target: target, binding: target.binding, cleared: false))
        }
        let cleared = target.clearBinding(
            bindingForClear,
            agentSessionEnded: agentSessionEnded
        )
        let remainingBinding = target.managedBinding ?? target.binding
        return .result(
            surfaceResumeSnapshot(
                target: target,
                binding: remainingBinding,
                cleared: cleared
            )
        )
    }
}

private extension ControlSurfaceResumeTarget {
    func windowID(using controller: TerminalController) -> UUID? {
        switch self {
        case .workspace(let tabManager, _, _):
            controller.v2ResolveWindowId(tabManager: tabManager)
        case .dock(let tabManager, let dock, _):
            controller.dockResultWindowId(for: dock, tabManager: tabManager)
        }
    }
}
