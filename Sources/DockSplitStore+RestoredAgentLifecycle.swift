import CmuxWorkspaces
import CmuxSidebar
import Darwin
import Foundation

extension DockSplitStore {
    func clearSessionRestoreState(panelId: UUID) {
        restoredTerminalScrollbackByPanelId.removeValue(forKey: panelId)
        restoredAgentLifecycle.snapshotsByPanelId.removeValue(forKey: panelId)
        restoredAgentLifecycle.resumeStatesByPanelId.removeValue(forKey: panelId)
        restoredAgentLifecycle.invalidatedFingerprintsByPanelId.removeValue(forKey: panelId)
        surfaceResumeBindingsByPanelId.removeValue(forKey: panelId)
        managedAgentResumeBindingsByPanelId.removeValue(forKey: panelId)
        invalidatedCachedTransferAgentSessionPanelIds.remove(panelId)
        replacedCachedTransferAgentSessionPanelIds.remove(panelId)
        restoredResumeSessionWorkingDirectoriesByPanelId.removeValue(forKey: panelId)
        restoredAgentLifecycle.clearStartupInput(panelId: panelId)
        agentRuntimeByPanelId.removeValue(forKey: panelId)
    }

    func canTakeControlOfExternalSession(panelId: UUID) -> Bool {
        externalSessionLocalTakeover(panelId: panelId) != nil
    }

    @discardableResult
    func takeControlOfExternalSession(
        panelId: UUID,
        send: (TerminalPanel, String) -> Bool
    ) -> Bool {
        guard let terminal = panels[panelId] as? TerminalPanel,
              let takeover = externalSessionLocalTakeover(panelId: panelId),
              let localBinding = WorkbenchSessionAuthority.localTakeoverBinding(
                  snapshot: takeover.snapshot,
                  replacing: managedAgentResumeBinding(panelId: panelId)
                      ?? surfaceResumeBindingsByPanelId[panelId]
              ),
              send(terminal, takeover.input) else {
            return false
        }
        restoredAgentLifecycle.snapshotsByPanelId[panelId] = takeover.snapshot
        surfaceResumeBindingsByPanelId[panelId] = localBinding
        managedAgentResumeBindingsByPanelId[panelId] = localBinding
        restoredAgentLifecycle.resumeStatesByPanelId[panelId] = .awaitingAutoResumeCommand
        restoredAgentLifecycle.registerStartupInput(takeover.input, panelId: panelId)
        restoredAgentLifecycle.invalidatedFingerprintsByPanelId.removeValue(forKey: panelId)
        agentRuntimeByPanelId.removeValue(forKey: panelId)
        invalidatedCachedTransferAgentSessionPanelIds.remove(panelId)
        replacedCachedTransferAgentSessionPanelIds.remove(panelId)
        if var transfer = detachedSurfaceTransfersByPanelId[panelId] {
            transfer.restorableAgent = takeover.snapshot
            transfer.restorableAgentResumeState = .awaitingAutoResumeCommand
            transfer.restoredAgentCompletedGeneration = nil
            transfer.restoredResumeSessionWorkingDirectory = takeover.snapshot.workingDirectory
            transfer.restoredStartupInput = takeover.input
            transfer.resumeBinding = localBinding
            transfer.managedAgentResumeBinding = localBinding
            transfer.agentRuntime = nil
            setDetachedSurfaceTransfer(transfer, forPanelID: panelId)
        }
        return true
    }

    private func externalSessionLocalTakeover(
        panelId: UUID
    ) -> (snapshot: SessionRestorableAgentSnapshot, input: String)? {
        let agent = restoredAgentLifecycle.snapshotsByPanelId[panelId]
        let binding = managedAgentResumeBinding(panelId: panelId)
            ?? surfaceResumeBindingsByPanelId[panelId]
        let compatibleAgent = Workspace.restorableAgentForSessionRestore(
            agent,
            resumeBinding: binding
        )
        let bindingSupersedesAgent =
            agent != nil && binding?.isAgentHookBinding == true && compatibleAgent == nil
        let canResume =
            (
                restoredAgentLifecycle.resumeStatesByPanelId[panelId] == .manualResumeAvailable &&
                !bindingSupersedesAgent
            ) ||
            (
                compatibleAgent == nil &&
                binding != nil &&
                (panels[panelId] as? TerminalPanel)?.shellActivity.state == .promptIdle
            )
        guard canResume,
              detachedSurfaceTransfersByPanelId[panelId]?.isRemoteTerminal != true,
              let snapshot = WorkbenchSessionAuthority.localTakeoverSnapshot(
                agent: agent,
                binding: binding
              ),
              let command = snapshot.resumeCommand else {
            return nil
        }
        return (snapshot, command + "\r")
    }

    func updatePanelShellActivityState(panelId: UUID, state: PanelShellActivityState) {
        guard let terminal = panels[panelId] as? TerminalPanel else { return }
        terminal.updateShellActivityState(state)
        let restoredAgent = restoredAgentLifecycle.snapshotsByPanelId[panelId]

        switch (state, restoredAgentLifecycle.resumeStatesByPanelId[panelId]) {
        case (.commandRunning, .some(.awaitingAutoResumeCommand)):
            restoredAgentLifecycle.resumeStatesByPanelId[panelId] = .autoResumeCommandRunning
            restoredAgentLifecycle.clearStartupInput(panelId: panelId)
        case (.promptIdle, .some(.awaitingAutoResumeCommand)):
            scheduleRestoredStartupInputResend(panelId: panelId)
        case (.commandRunning, .some(.manualResumeAvailable)):
            restoredAgentLifecycle.snapshotsByPanelId.removeValue(forKey: panelId)
            restoredAgentLifecycle.resumeStatesByPanelId.removeValue(forKey: panelId)
            retireAgentHookResumeBinding(panelId: panelId)
        case (.promptIdle, .some(.autoResumeCommandRunning)),
             (.promptIdle, .some(.observedAgentCommandRunning)):
            if restoredAgent != nil {
                markRestoredAgentCompleted(panelId: panelId)
            } else {
                restoredAgentLifecycle.resumeStatesByPanelId.removeValue(forKey: panelId)
            }
            restoredResumeSessionWorkingDirectoriesByPanelId.removeValue(forKey: panelId)
            retireAgentHookResumeBinding(panelId: panelId, matching: restoredAgent)
        default:
            break
        }
    }

    func adoptSessionRestoreState(from detached: Workspace.DetachedSurfaceTransfer) {
        if let shellActivityState = detached.shellActivityState {
            (detached.panel as? TerminalPanel)?.updateShellActivityState(shellActivityState)
        }
        invalidatedCachedTransferAgentSessionPanelIds.remove(detached.panelId)
        replacedCachedTransferAgentSessionPanelIds.remove(detached.panelId)
        restoredAgentLifecycle.seedTransferredState(
            panelId: detached.panelId,
            snapshot: detached.restorableAgent,
            resumeState: detached.restorableAgentResumeState,
            completedGeneration: detached.restoredAgentCompletedGeneration,
            startupInput: detached.restoredStartupInput
        )
        if detached.shellActivityState == .promptIdle {
            scheduleRestoredStartupInputResend(panelId: detached.panelId)
        }
        managedAgentResumeBindingsByPanelId.removeValue(forKey: detached.panelId)
        if let resumeBinding = detached.resumeBinding {
            surfaceResumeBindingsByPanelId[detached.panelId] = resumeBinding
        }
        if let transferredManagedBinding = detached.resolvedManagedAgentResumeBinding {
            managedAgentResumeBindingsByPanelId[detached.panelId] = transferredManagedBinding
        }
        if let directory = detached.restoredResumeSessionWorkingDirectory {
            restoredResumeSessionWorkingDirectoriesByPanelId[detached.panelId] = directory
        }
        if let runtime = detached.agentRuntime {
            agentRuntimeByPanelId[detached.panelId] = runtime
        } else {
            agentRuntimeByPanelId.removeValue(forKey: detached.panelId)
        }
    }

    func configureAgentHibernationResume(for terminal: TerminalPanel) {
        terminal.surface.onExplicitInput = { [weak self, weak terminal] in
            guard let self, let terminal else { return }
            self.restoredAgentLifecycle.clearStartupInput(panelId: terminal.id)
        }
        terminal.onRequestAgentHibernationResume = { [weak self, weak terminal] focus in
            guard let self, let terminal else { return false }
            return self.resumeAgentHibernation(panelId: terminal.id, focus: focus)
        }
    }

    func scheduleRestoredStartupInputResend(panelId: UUID) {
        guard restoredAgentLifecycle.armStartupInputResend(panelId: panelId) else { return }
        let grace = Workspace.restoredStartupInputResendGrace
        DispatchQueue.main.asyncAfter(deadline: .now() + grace) { [weak self] in
            Task { @MainActor [weak self] in
                self?.resendRestoredStartupInputIfStillIdle(panelId: panelId)
            }
        }
    }

    func resendRestoredStartupInputIfStillIdle(panelId: UUID) {
        guard let terminal = panels[panelId] as? TerminalPanel,
              let input = restoredAgentLifecycle.takeStartupInputForResend(
                  panelId: panelId,
                  shellState: terminal.shellActivity.state
              ),
              terminal.surface.surface != nil else {
            return
        }
        _ = terminal.sendInputResult(input)
    }

    @discardableResult
    func resumeAgentHibernation(panelId: UUID, focus: Bool) -> Bool {
        guard let terminal = panels[panelId] as? TerminalPanel,
              terminal.isAgentHibernated else {
            return false
        }
        let preparation = terminal.prepareAgentHibernationResume()
        guard preparation.didResume else { return false }
        if restoredAgentLifecycle.snapshotsByPanelId[panelId] != nil {
            restoredAgentLifecycle.resumeStatesByPanelId[panelId] = preparation.queuedStartupInput
                ? .awaitingAutoResumeCommand
                : .manualResumeAvailable
            restoredAgentLifecycle.invalidatedFingerprintsByPanelId.removeValue(forKey: panelId)
        }
        AgentHibernationController.shared.recordTerminalFocus(
            workspaceId: workspaceId,
            panelId: panelId
        )
        if focus { focusPanel(panelId) }
        return true
    }

    private func retireAgentHookResumeBinding(
        panelId: UUID,
        matching restoredAgent: SessionRestorableAgentSnapshot? = nil
    ) {
        guard var binding = managedAgentResumeBinding(panelId: panelId)
            ?? surfaceResumeBindingsByPanelId[panelId],
            binding.isAgentHookBinding else {
            return
        }
        if let restoredAgent {
            let checkpointId = binding.checkpointId?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard checkpointId == nil || checkpointId == restoredAgent.sessionId else {
                return
            }
        }
        let originalBinding = binding
        binding.autoResume = false
        if binding.hasCompleteManagedSessionIdentity {
            managedAgentResumeBindingsByPanelId[panelId] = binding
        }
        if let effectiveBinding = surfaceResumeBindingsByPanelId[panelId] {
            if effectiveBinding == originalBinding || effectiveBinding.isSameManagedSession(as: binding) {
                surfaceResumeBindingsByPanelId[panelId] = binding
            }
        } else {
            surfaceResumeBindingsByPanelId[panelId] = binding
        }
    }

    func markRestoredAgentCompleted(panelId: UUID) {
        // A live completion belongs to the current session generation. Keep
        // older cached metadata invalidated, but no longer classify this
        // current tombstone as the cached generation that was replaced.
        replacedCachedTransferAgentSessionPanelIds.remove(panelId)
        let runtimeIdentities = Set(
            (agentRuntimeByPanelId[panelId]
                ?? detachedSurfaceTransfersByPanelId[panelId]?.agentRuntime)?
                .agentPIDProcessIdentities.values.map { $0 } ?? []
        )
        restoredAgentLifecycle.markCompleted(
            panelId: panelId,
            observation: SharedLiveAgentIndex.shared.index?.entry(
                workspaceId: detachedSurfaceTransfersByPanelId[panelId]?.sessionRestoreWorkspaceId
                    ?? workspaceId,
                panelId: panelId
            ),
            runtimeProcessIdentities: runtimeIdentities
        )
    }

    func agentRuntimeStatusEntry(key: String, panelId: UUID) -> SidebarStatusEntry? {
        agentRuntimeByPanelId[panelId]?.statusEntries[key]
    }

    func setAgentRuntimeStatusEntry(
        _ entry: SidebarStatusEntry,
        key: String,
        panelId: UUID
    ) {
        mutateAgentRuntime(panelId: panelId) {
            $0.statusEntries[key] = entry
        }
    }

    func clearAgentRuntimeStatusEntry(key: String, panelId: UUID) {
        mutateAgentRuntime(panelId: panelId) {
            $0.statusEntries.removeValue(forKey: key)
        }
    }

    @discardableResult
    func recordAgentPID(key: String, pid: pid_t, panelId: UUID) -> Bool {
        var didReplaceRuntime = false
        mutateAgentRuntime(panelId: panelId) { runtime in
            if Self.isStructuredAgentHookPIDKey(key, runtime: runtime) {
                let staleKeys = runtime.agentPIDKeys.filter {
                    $0 != key && Self.isStructuredAgentHookPIDKey($0, runtime: runtime)
                }
                for staleKey in staleKeys {
                    Self.clearAgentPID(
                        key: staleKey,
                        clearStatus: true,
                        runtime: &runtime
                    )
                }
                didReplaceRuntime = !staleKeys.isEmpty
            }
            runtime.agentPIDs[key] = pid
            if let identity = Workspace.agentPIDProcessIdentity(pid: pid) {
                runtime.agentPIDProcessIdentities[key] = identity
            } else {
                runtime.agentPIDProcessIdentities.removeValue(forKey: key)
            }
            runtime.agentPIDKeys.insert(key)
        }
        return didReplaceRuntime
    }

    func setAgentLifecycle(
        key: String,
        panelId: UUID,
        lifecycle: AgentHibernationLifecycleState
    ) {
        mutateAgentRuntime(panelId: panelId) {
            $0.agentLifecycleStates[key] = lifecycle
        }
    }

    @discardableResult
    func clearAgentPID(
        key: String,
        panelId: UUID,
        clearStatus: Bool,
        requireOwnedKey: Bool = false
    ) -> Bool {
        if requireOwnedKey,
           agentRuntimeByPanelId[panelId]?.agentPIDKeys.contains(key) != true {
            return false
        }
        var didChange = false
        mutateAgentRuntime(panelId: panelId) {
            didChange = Self.clearAgentPID(
                key: key,
                clearStatus: clearStatus,
                runtime: &$0
            )
        }
        return didChange
    }

    private func mutateAgentRuntime(
        panelId: UUID,
        mutation: (inout Workspace.DetachedAgentRuntimeState) -> Void
    ) {
        guard panels[panelId] != nil else { return }
        var runtime = agentRuntimeByPanelId[panelId] ?? Workspace.DetachedAgentRuntimeState(
            panelId: panelId,
            statusEntries: [:],
            agentPIDs: [:],
            agentPIDProcessIdentities: [:],
            agentPIDKeys: []
        )
        mutation(&runtime)
        let shouldKeep = !runtime.statusEntries.isEmpty
            || !runtime.agentPIDs.isEmpty
            || !runtime.agentPIDKeys.isEmpty
            || !runtime.agentLifecycleStates.isEmpty
        if shouldKeep {
            agentRuntimeByPanelId[panelId] = runtime
        } else {
            agentRuntimeByPanelId.removeValue(forKey: panelId)
        }
        if var transfer = detachedSurfaceTransfersByPanelId[panelId] {
            transfer.agentRuntime = shouldKeep ? runtime : nil
            detachedSurfaceTransfersByPanelId[panelId] = transfer
        }
    }

    @discardableResult
    private static func clearAgentPID(
        key: String,
        clearStatus: Bool,
        runtime: inout Workspace.DetachedAgentRuntimeState
    ) -> Bool {
        let statusKey = agentStatusKey(forAgentPIDKey: key, runtime: runtime)
        var didChange = false
        if runtime.agentPIDs.removeValue(forKey: key) != nil { didChange = true }
        if runtime.agentPIDProcessIdentities.removeValue(forKey: key) != nil { didChange = true }
        if runtime.agentPIDKeys.remove(key) != nil { didChange = true }
        if runtime.agentLifecycleStates.removeValue(forKey: statusKey) != nil {
            didChange = true
        }
        if clearStatus,
           !runtime.agentPIDKeys.contains(where: {
               agentStatusKey(forAgentPIDKey: $0, runtime: runtime) == statusKey
           }),
           runtime.statusEntries.removeValue(forKey: statusKey) != nil {
            didChange = true
        }
        return didChange
    }

    private static func isStructuredAgentHookPIDKey(
        _ key: String,
        runtime: Workspace.DetachedAgentRuntimeState
    ) -> Bool {
        AgentHibernationLifecycleStatusKeys.allowedStatusKeys.contains(
            agentStatusKey(forAgentPIDKey: key, runtime: runtime)
        )
    }

    private static func agentStatusKey(
        forAgentPIDKey key: String,
        runtime: Workspace.DetachedAgentRuntimeState
    ) -> String {
        if runtime.statusEntries[key] != nil {
            return key
        }
        guard let dotIndex = key.firstIndex(of: ".") else {
            return key
        }
        return String(key[..<dotIndex])
    }
}
