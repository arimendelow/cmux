import CmuxWorkspaces
import Foundation

extension Workspace {
    func canTakeControlOfExternalSession(panelId: UUID) -> Bool {
        externalSessionLocalTakeover(panelId: panelId) != nil
    }

    @discardableResult
    func takeControlOfExternalSession(
        panelId: UUID,
        send: (TerminalPanel, String) -> Bool
    ) -> Bool {
        guard let terminal = terminalPanel(for: panelId),
              let takeover = externalSessionLocalTakeover(panelId: panelId),
              let localBinding = WorkbenchSessionAuthority.localTakeoverBinding(
                  snapshot: takeover.snapshot,
                  replacing: surfaceResumeBindingsByPanelId[panelId]
              ),
              send(terminal, takeover.input) else {
            return false
        }
        clearAgentRuntimeState(panelId: panelId)
        restoredAgentSnapshotsByPanelId[panelId] = takeover.snapshot
        surfaceResumeBindingsByPanelId[panelId] = localBinding
        managedAgentResumeBindingsByPanelId[panelId] = localBinding
        restoredAgentResumeStatesByPanelId[panelId] = .awaitingAutoResumeCommand
        restoredAgentLifecycle.registerStartupInput(takeover.input, panelId: panelId)
        invalidatedRestoredAgentFingerprintsByPanelId.removeValue(forKey: panelId)
        return true
    }

    private func externalSessionLocalTakeover(
        panelId: UUID
    ) -> (snapshot: SessionRestorableAgentSnapshot, input: String)? {
        let agent = restoredAgentSnapshotsByPanelId[panelId]
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
                restoredAgentResumeStatesByPanelId[panelId] == .manualResumeAvailable &&
                !bindingSupersedesAgent
            ) ||
            (
                compatibleAgent == nil &&
                binding != nil &&
                panelShellActivityStates[panelId] == .promptIdle
            )
        guard canResume,
              !isRemoteTerminalContext(panelId),
              let snapshot = WorkbenchSessionAuthority.localTakeoverSnapshot(
                agent: agent,
                binding: binding
              ),
              let command = snapshot.resumeCommand else {
            return nil
        }
        return (snapshot, command + "\r")
    }

    func allowsAgentContinuation(forPanelId panelId: UUID) -> Bool {
        restoredAgentResumeStatesByPanelId[panelId] != .completedAgentExit ||
            restoredAgentSnapshotForContinuation(panelId: panelId) != nil
    }

    func restoredAgentSnapshotForContinuation(
        panelId: UUID
    ) -> SessionRestorableAgentSnapshot? {
        restoredAgentLifecycle.continuationSnapshot(
            panelId: panelId,
            observation: SharedLiveAgentIndex.shared.index?.entry(
                workspaceId: id,
                panelId: panelId
            ),
            currentProcessIdentity: Self.agentPIDProcessIdentity(pid:)
        )
    }

    func reconcileCompletedRestoredAgent(
        panelId: UUID,
        observation: RestorableAgentSessionIndex.Entry
    ) {
        restoredAgentLifecycle.reconcileCompletedAgent(
            panelId: panelId,
            observation: observation,
            currentProcessIdentity: Self.agentPIDProcessIdentity(pid:)
        )
    }

    func markRestoredAgentCompleted(
        panelId: UUID,
        snapshot: SessionRestorableAgentSnapshot
    ) {
        markRestoredAgentCompleted(panelId: panelId)
    }

    func markRestoredAgentCompleted(panelId: UUID) {
        let runtimeProcessIdentities = Set((agentPIDKeysByPanelId[panelId] ?? []).compactMap {
            agentPIDProcessIdentitiesByKey[$0]
        })
        restoredAgentLifecycle.markCompleted(
            panelId: panelId,
            observation: SharedLiveAgentIndex.shared.index?.entry(
                workspaceId: id,
                panelId: panelId
            ),
            runtimeProcessIdentities: runtimeProcessIdentities
        )
    }

    func restoredAgentResumeStateForAcceptedSnapshot(panelId: UUID) -> RestoredAgentResumeState {
        panelShellActivityStates[panelId] == .commandRunning
            ? .observedAgentCommandRunning
            : .manualResumeAvailable
    }

    func updateRestoredAgentResumeState(
        panelId: UUID,
        restoredAgent: SessionRestorableAgentSnapshot,
        shellState: PanelShellActivityState
    ) {
        switch shellState {
        case .commandRunning:
            switch restoredAgentResumeStatesByPanelId[panelId] {
            case .some(.awaitingAutoResumeCommand):
                restoredAgentResumeStatesByPanelId[panelId] = .autoResumeCommandRunning
                restoredAgentLifecycle.clearStartupInput(panelId: panelId)
            case .some(.autoResumeCommandRunning), .some(.observedAgentCommandRunning),
                 .some(.completedAgentExit):
                break
            case .some(.manualResumeAvailable), nil:
                invalidateRestoredAgentSnapshot(panelId: panelId, restoredAgent: restoredAgent)
            }
        case .promptIdle:
            switch restoredAgentResumeStatesByPanelId[panelId] {
            case .some(.autoResumeCommandRunning), .some(.observedAgentCommandRunning):
                markRestoredAgentCompleted(panelId: panelId, snapshot: restoredAgent)
                restoredResumeSessionWorkingDirectoriesByPanelId.removeValue(forKey: panelId)
                retireAgentHookResumeBinding(panelId: panelId, matching: restoredAgent)
            case .some(.awaitingAutoResumeCommand):
                scheduleRestoredStartupInputResend(panelId: panelId)
            case .some(.manualResumeAvailable), .some(.completedAgentExit), nil:
                break
            }
        case .unknown:
            break
        }
    }

    func updateBindingOnlyRestoredAgentResumeState(
        panelId: UUID,
        shellState: PanelShellActivityState
    ) {
        switch (shellState, restoredAgentResumeStatesByPanelId[panelId]) {
        case (.commandRunning, .some(.awaitingAutoResumeCommand)):
            restoredAgentResumeStatesByPanelId[panelId] = .autoResumeCommandRunning
            restoredAgentLifecycle.clearStartupInput(panelId: panelId)
        case (.promptIdle, .some(.awaitingAutoResumeCommand)):
            scheduleRestoredStartupInputResend(panelId: panelId)
        case (.promptIdle, .some(.autoResumeCommandRunning)),
             (.promptIdle, .some(.observedAgentCommandRunning)):
            restoredAgentResumeStatesByPanelId.removeValue(forKey: panelId)
            restoredResumeSessionWorkingDirectoriesByPanelId.removeValue(forKey: panelId)
            retireAgentHookResumeBinding(panelId: panelId)
        default:
            break
        }
    }

    static var restoredStartupInputResendGrace: TimeInterval = 2

    func scheduleRestoredStartupInputResend(panelId: UUID) {
        guard restoredAgentLifecycle.armStartupInputResend(panelId: panelId) else { return }
        let grace = Self.restoredStartupInputResendGrace
        DispatchQueue.main.asyncAfter(deadline: .now() + grace) { [weak self] in
            Task { @MainActor [weak self] in
                self?.resendRestoredStartupInputIfStillIdle(panelId: panelId)
            }
        }
    }

    func resendRestoredStartupInputIfStillIdle(panelId: UUID) {
        let shellState = panelShellActivityStates[panelId] ?? .unknown
        guard let terminal = panels[panelId] as? TerminalPanel,
              let input = restoredAgentLifecycle.takeStartupInputForResend(
                  panelId: panelId,
                  shellState: shellState
              ),
              terminal.surface.surface != nil else {
            return
        }
        _ = terminal.sendInputResult(input)
    }

    private func invalidateRestoredAgentSnapshot(
        panelId: UUID,
        restoredAgent: SessionRestorableAgentSnapshot
    ) {
        let fingerprint = TabManager.restorableAgentSnapshotFingerprint(restoredAgent)
        invalidatedRestoredAgentFingerprintsByPanelId[panelId] = fingerprint
        retireAgentHookResumeBinding(panelId: panelId, matching: restoredAgent)
        clearRestoredAgentSnapshot(panelId: panelId)
#if DEBUG
        cmuxDebugLog(
            "session.restore.agent.invalidate panel=\(panelId.uuidString.prefix(5)) " +
            "kind=\(restoredAgent.kind.rawValue) session=\(restoredAgent.sessionId.prefix(8))"
        )
#endif
    }

    /// Keep the checkpoint available to an explicit `cmux restore`, while
    /// preventing an exited or superseded agent from replaying automatically.
    func retireAgentHookResumeBinding(
        panelId: UUID,
        matching restoredAgent: SessionRestorableAgentSnapshot? = nil
    ) {
        guard var binding = managedAgentResumeBinding(panelId: panelId),
              binding.isAgentHookBinding else {
            return
        }
        if let restoredAgent,
           let checkpointId = binding.checkpointId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !ManagedAgentSessionIdentity.sessionIDsMatch(
               kind: restoredAgent.kind.rawValue,
               lhs: checkpointId,
               rhs: restoredAgent.sessionId
           ) {
            return
        }
        binding.autoResume = false
        managedAgentResumeBindingsByPanelId[panelId] = binding
        if let effectiveBinding = surfaceResumeBindingsByPanelId[panelId],
           effectiveBinding.isSameManagedSession(as: binding) {
            surfaceResumeBindingsByPanelId[panelId] = binding
        }
    }

    /// Keep an in-flight restored launch tied to the same structured binding
    /// so a later, unrelated binding cannot inherit its lifecycle evidence.
    func restoredAgentLifecycleOwns(
        _ binding: SurfaceResumeBindingSnapshot,
        panelId: UUID
    ) -> Bool {
        guard binding.isAgentHookBinding,
              restoredAgentLifecycle.ownsInFlightRestoredCommand(panelId: panelId) else {
            return false
        }
        if let storedBinding = managedAgentResumeBinding(panelId: panelId)
            ?? surfaceResumeBindingsByPanelId[panelId] {
            return storedBinding.isSameManagedSession(as: binding)
        }
        guard let restoredAgent = restoredAgentSnapshotsByPanelId[panelId] else {
            return false
        }
        return Self.restorableAgentForSessionRestore(
            restoredAgent,
            resumeBinding: binding
        ) != nil
    }

    /// A real shell callback has advanced this binding's restored launch from
    /// queued input to a running command.
    func restoredAgentLifecycleConfirmsRunning(
        _ binding: SurfaceResumeBindingSnapshot,
        panelId: UUID
    ) -> Bool {
        restoredAgentLifecycle.confirmsRunningRestoredCommand(panelId: panelId) &&
            restoredAgentLifecycleOwns(binding, panelId: panelId)
    }

    /// Preserve restore lifecycle state across a same-session hook refresh,
    /// but never let a replacement binding reuse the prior session's observed
    /// command-running phase.
    func invalidateRestoredAgentLifecycleIfBindingIsReplaced(
        by binding: SurfaceResumeBindingSnapshot,
        panelId: UUID
    ) {
        guard restoredAgentResumeStatesByPanelId[panelId] != nil ||
            restoredAgentSnapshotsByPanelId[panelId] != nil else {
            return
        }
        let continuesRestoredSession: Bool
        if let storedBinding = managedAgentResumeBinding(panelId: panelId)
            ?? surfaceResumeBindingsByPanelId[panelId] {
            continuesRestoredSession = storedBinding == binding ||
                storedBinding.isSameManagedSession(as: binding)
        } else if let restoredAgent = restoredAgentSnapshotsByPanelId[panelId] {
            continuesRestoredSession = Self.restorableAgentForSessionRestore(
                restoredAgent,
                resumeBinding: binding
            ) != nil
        } else {
            continuesRestoredSession = false
        }
        guard !continuesRestoredSession else { return }
        clearRestoredAgentSnapshot(panelId: panelId)
        invalidatedRestoredAgentFingerprintsByPanelId.removeValue(forKey: panelId)
    }

    /// True when `binding` is a plain (non-tmux) agent-hook resume binding
    /// whose session no longer shows up as a live process. Generalizes the
    /// tmux-only `isProcessDetected` staleness signal in
    /// `reconcileSurfaceResumeBindings` so a normal exit of a resumed
    /// non-tmux agent doesn't leave a binding that gets replayed automatically
    /// on the next relaunch (#8446).
    ///
    /// `restorableAgentIndex`, when supplied, is a freshly loaded index from
    /// the same scan generation as the caller's `SurfaceResumeBindingIndex`
    /// (see `ProcessDetectedResumeIndexes.load()`); prefer it over the
    /// separately TTL-cached `SharedLiveAgentIndex.shared.index` so pruning
    /// and the binding scan it is paired with always describe the same
    /// point-in-time snapshot instead of two independently stale ones.
    func isStaleAgentHookBinding(
        _ binding: SurfaceResumeBindingSnapshot,
        panelId: UUID,
        restorableAgentIndex: RestorableAgentSessionIndex? = nil
    ) -> Bool {
        // `RestorableAgentSessionIndex` / `SharedLiveAgentIndex` are built by
        // scanning LOCAL processes (pid/sysctl-based). A `.persistentSSH`
        // agent-hook binding's process runs on the remote host and can never
        // appear in that local scan, so treating it as this function's kind
        // of "stale" would prune every live remote agent-hook binding on the
        // very next reconciliation. Only judge local-launch bindings here;
        // remote bindings are left to whatever governs their own lifecycle.
        guard binding.isAgentHookBinding,
              binding.launchFlavor == .local,
              let checkpointId = binding.checkpointId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !checkpointId.isEmpty,
              let kind = binding.kind?.trimmingCharacters(in: .whitespacesAndNewlines),
              !kind.isEmpty else {
            return false
        }
        if restoredAgentLifecycleOwns(binding, panelId: panelId) {
            return false
        }
        let liveIndex = restorableAgentIndex ?? SharedLiveAgentIndex.shared.index
        guard let liveEntry = liveIndex?.entry(workspaceId: id, panelId: panelId),
              liveEntry.snapshot.kind.rawValue == kind,
              ManagedAgentSessionIdentity.sessionIDsMatch(
                  kind: kind,
                  lhs: liveEntry.snapshot.sessionId,
                  rhs: checkpointId
              ) else {
            return false
        }
        guard Self.sameAgentLaunchGeneration(
            binding.launchCommand,
            liveEntry.snapshot.launchCommand
        ) else {
            return false
        }
        if let bindingKind = RestorableAgentKind(rawValue: kind),
           !confirmedRuntimeAgentProcessIdentities(
               kind: bindingKind,
               sessionId: checkpointId,
               panelId: panelId,
               currentProcessIdentity: { processID in
                   guard let pid = pid_t(exactly: processID) else { return nil }
                   return Self.agentPIDProcessIdentity(pid: pid)
               }
           ).isEmpty {
            return false
        }
        return liveEntry.processLiveness == .exited
    }

    private nonisolated static func sameAgentLaunchGeneration(
        _ bindingLaunch: AgentLaunchCommandSnapshot?,
        _ observedLaunch: AgentLaunchCommandSnapshot?
    ) -> Bool {
        guard let bindingLaunch,
              let observedLaunch,
              let bindingCapturedAt = bindingLaunch.capturedAt,
              let observedCapturedAt = observedLaunch.capturedAt,
              bindingCapturedAt > 0,
              bindingCapturedAt == observedCapturedAt else {
            return false
        }
        return bindingLaunch.launcher == observedLaunch.launcher &&
            bindingLaunch.executablePath == observedLaunch.executablePath &&
            bindingLaunch.arguments == observedLaunch.arguments
    }

    func seedSessionRestoredAgentState(
        panelId: UUID,
        restorableAgent: SessionRestorableAgentSnapshot?,
        willRunStartupCommand: Bool,
        willRunStartupInput: Bool
    ) {
        if let restorableAgent {
            restoredAgentSnapshotsByPanelId[panelId] = restorableAgent
        } else {
            restoredAgentSnapshotsByPanelId.removeValue(forKey: panelId)
        }
        if willRunStartupCommand {
            restoredAgentResumeStatesByPanelId[panelId] = .autoResumeCommandRunning
        } else if willRunStartupInput {
            restoredAgentResumeStatesByPanelId[panelId] = .awaitingAutoResumeCommand
        } else if restorableAgent != nil {
            restoredAgentResumeStatesByPanelId[panelId] = .manualResumeAvailable
        } else {
            restoredAgentResumeStatesByPanelId.removeValue(forKey: panelId)
        }
        invalidatedRestoredAgentFingerprintsByPanelId.removeValue(forKey: panelId)
    }

    func seedDetachedRestoredAgentState(from detached: DetachedSurfaceTransfer) {
        if let shellActivityState = detached.shellActivityState {
            panelShellActivityStates[detached.panelId] = shellActivityState
            (detached.panel as? TerminalPanel)?.updateShellActivityState(shellActivityState)
        } else {
            panelShellActivityStates.removeValue(forKey: detached.panelId)
        }
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
        invalidatedRestoredAgentFingerprintsByPanelId.removeValue(forKey: detached.panelId)
    }

    func setAgentLifecycle(
        key: String,
        panelId: UUID?,
        lifecycle: AgentHibernationLifecycleState
    ) {
        let targetPanelId = panelId ?? focusedPanelId
        guard let targetPanelId, panels[targetPanelId] != nil else { return }
        agentLifecycleStatesByPanelId[targetPanelId, default: [:]][key] = lifecycle
        if !AgentHibernationLifecycleStatusKeys.isManualKey(key) {
            recordAgentLifecycleChange(panelId: targetPanelId)
        }
    }

    @discardableResult
    func clearAgentLifecycle(key: String, panelId: UUID? = nil) -> Bool {
        var didClear = false
        let recordsHibernationActivity = !AgentHibernationLifecycleStatusKeys.isManualKey(key)
        let panelIds = panelId.map { [$0] } ?? Array(agentLifecycleStatesByPanelId.keys)
        for panelId in panelIds {
            guard agentLifecycleStatesByPanelId[panelId]?[key] != nil else { continue }
            agentLifecycleStatesByPanelId[panelId]?.removeValue(forKey: key)
            if agentLifecycleStatesByPanelId[panelId]?.isEmpty == true {
                agentLifecycleStatesByPanelId.removeValue(forKey: panelId)
            }
            didClear = true
            if recordsHibernationActivity {
                recordAgentLifecycleChange(panelId: panelId)
            }
        }
        return didClear
    }

    func hasRunningAgentLifecycle(key: String, panelId: UUID? = nil) -> Bool {
        if let panelId {
            return agentLifecycleStatesByPanelId[panelId]?[key] == .running
        }
        return agentLifecycleStatesByPanelId.values.contains { $0[key] == .running }
    }

    func clearAgentLifecycleStates(panelId: UUID) {
        guard let removed = agentLifecycleStatesByPanelId.removeValue(forKey: panelId) else { return }
        let manualStates = removed.filter { AgentHibernationLifecycleStatusKeys.isManualKey($0.key) }
        if !manualStates.isEmpty {
            let host: UUID? = if panels[panelId] != nil {
                panelId
            } else if let focused = focusedPanelId, focused != panelId, panels[focused] != nil {
                focused
            } else {
                panels.keys.first(where: { $0 != panelId })
            }
            if let host {
                for (key, lifecycle) in manualStates {
                    agentLifecycleStatesByPanelId[host, default: [:]][key] = lifecycle
                }
            }
        }
        recordAgentLifecycleChange(panelId: panelId)
    }

    func clearAllAgentLifecycleStates() {
        let panelIds = Array(agentLifecycleStatesByPanelId.keys)
        guard !panelIds.isEmpty else { return }
        agentLifecycleStatesByPanelId.removeAll()
        for panelId in panelIds {
            recordAgentLifecycleChange(panelId: panelId)
        }
    }

    func agentHibernationLifecycleState(
        panelId: UUID,
        fallback: AgentHibernationLifecycleState?
    ) -> AgentHibernationLifecycleState {
        let states = (agentLifecycleStatesByPanelId[panelId] ?? [:])
            .filter { !AgentHibernationLifecycleStatusKeys.isManualKey($0.key) }
            .map(\.value)
        guard !states.isEmpty else {
            return fallback ?? .unknown
        }
        if states.contains(.running) { return .running }
        if states.contains(.needsInput) { return .needsInput }
        if states.contains(.unknown) { return .unknown }
        if states.contains(.idle) { return .idle }
        return fallback ?? .unknown
    }

    private func recordAgentLifecycleChange(panelId: UUID) {
        AgentHibernationController.shared.recordAgentLifecycleChange(
            workspaceId: id,
            panelId: panelId
        )
    }
}
