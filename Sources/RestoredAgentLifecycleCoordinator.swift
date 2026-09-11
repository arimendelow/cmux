import CmuxWorkspaces
import Foundation
import Observation

/// Owns restored-agent continuation state and the process generation completed by a terminal.
@MainActor
@Observable
final class RestoredAgentLifecycleCoordinator {
    @ObservationIgnored
    private let dateProvider: @MainActor () -> TimeInterval

    @ObservationIgnored
    private let eventBus: CmuxEventBus?

    init(
        dateProvider: @escaping @MainActor () -> TimeInterval = { Date.now.timeIntervalSince1970 },
        eventBus: CmuxEventBus? = OuroWorkbenchProduct.isCurrentBundle ? .shared : nil
    ) {
        self.dateProvider = dateProvider
        self.eventBus = eventBus
    }

    var snapshotsByPanelId: [UUID: SessionRestorableAgentSnapshot] = [:] {
        didSet {
            completedGenerationsByPanelId = completedGenerationsByPanelId.filter { panelId, _ in
                snapshotsByPanelId[panelId] != nil ||
                    resumeStatesByPanelId[panelId] == .completedAgentExit
            }
        }
    }
    var resumeStatesByPanelId: [UUID: Workspace.RestoredAgentResumeState] = [:] {
        didSet {
            completedGenerationsByPanelId = completedGenerationsByPanelId.filter { panelId, _ in
                resumeStatesByPanelId[panelId] == .completedAgentExit
            }
            for (panelId, state) in resumeStatesByPanelId where state == .completedAgentExit {
                guard completedGenerationsByPanelId[panelId] == nil,
                      snapshotsByPanelId[panelId] != nil else {
                    continue
                }
                completedGenerationsByPanelId[panelId] = RestoredAgentCompletedGeneration(
                    completedAt: dateProvider(),
                    processIdentities: []
                )
            }
            // Shell integration can settle a restore without an agent hook; wake the native-facts reader.
            for panelId in Set(oldValue.keys).union(resumeStatesByPanelId.keys)
                where oldValue[panelId] != resumeStatesByPanelId[panelId] {
                eventBus?.publish(
                    name: "agent.restore.changed",
                    category: "agent",
                    source: "workbench",
                    surfaceId: panelId.uuidString
                )
            }
        }
    }
    var invalidatedFingerprintsByPanelId: [UUID: Int] = [:]

    private var completedGenerationsByPanelId: [UUID: RestoredAgentCompletedGeneration] = [:]
    private var pendingStartupInputsByPanelId: [UUID: String] = [:]
    private var armedStartupInputResendPanelIds: Set<UUID> = []

    func markCompleted(
        panelId: UUID,
        observation: RestorableAgentSessionIndex.Entry?,
        runtimeProcessIdentities: Set<AgentPIDProcessIdentity>
    ) {
        clearStartupInput(panelId: panelId)
        let observedProcessIdentities = Set(
            observation.map { Array($0.agentProcessIdentities.values) } ?? []
        )
        completedGenerationsByPanelId[panelId] = RestoredAgentCompletedGeneration(
            completedAt: dateProvider(),
            processIdentities: runtimeProcessIdentities.union(observedProcessIdentities)
        )
        resumeStatesByPanelId[panelId] = .completedAgentExit
    }

    func continuationSnapshot(
        panelId: UUID,
        observation: RestorableAgentSessionIndex.Entry?,
        currentProcessIdentity: (pid_t) -> AgentPIDProcessIdentity?
    ) -> SessionRestorableAgentSnapshot? {
        guard resumeStatesByPanelId[panelId] == .completedAgentExit else {
            return snapshotsByPanelId[panelId]
        }
        guard let observation,
              observationSupersedesCompletion(
                  panelId: panelId,
                  observation: observation,
                  currentProcessIdentity: currentProcessIdentity
              ) else {
            return nil
        }
        return observation.snapshot
    }

    @discardableResult
    func reconcileCompletedAgent(
        panelId: UUID,
        observation: RestorableAgentSessionIndex.Entry,
        currentProcessIdentity: (pid_t) -> AgentPIDProcessIdentity?
    ) -> Bool {
        guard resumeStatesByPanelId[panelId] == .completedAgentExit,
              observationSupersedesCompletion(
                  panelId: panelId,
                  observation: observation,
                  currentProcessIdentity: currentProcessIdentity
              ) else {
            return false
        }
        snapshotsByPanelId[panelId] = observation.snapshot
        resumeStatesByPanelId[panelId] = .observedAgentCommandRunning
        invalidatedFingerprintsByPanelId.removeValue(forKey: panelId)
        completedGenerationsByPanelId.removeValue(forKey: panelId)
        clearStartupInput(panelId: panelId)
        return true
    }

    func completedGeneration(panelId: UUID) -> RestoredAgentCompletedGeneration? {
        completedGenerationsByPanelId[panelId]
    }

    /// Shell integration has observed the restored launch enter its command
    /// phase and has not subsequently reported the prompt returning.
    func confirmsRunningRestoredCommand(panelId: UUID) -> Bool {
        switch resumeStatesByPanelId[panelId] {
        case .autoResumeCommandRunning, .observedAgentCommandRunning:
            true
        case .manualResumeAvailable, .awaitingAutoResumeCommand, .completedAgentExit, nil:
            false
        }
    }

    /// The restored launch still owns its binding while startup input is
    /// queued, even though only a later shell callback can prove it is running.
    func ownsInFlightRestoredCommand(panelId: UUID) -> Bool {
        switch resumeStatesByPanelId[panelId] {
        case .awaitingAutoResumeCommand, .autoResumeCommandRunning, .observedAgentCommandRunning:
            true
        case .manualResumeAvailable, .completedAgentExit, nil:
            false
        }
    }

    func registerStartupInput(_ input: String?, panelId: UUID) {
        armedStartupInputResendPanelIds.remove(panelId)
        guard let input, !input.isEmpty else {
            pendingStartupInputsByPanelId.removeValue(forKey: panelId)
            return
        }
        pendingStartupInputsByPanelId[panelId] = input
    }

    func clearStartupInput(panelId: UUID) {
        pendingStartupInputsByPanelId.removeValue(forKey: panelId)
        armedStartupInputResendPanelIds.remove(panelId)
    }

    func clearAllStartupInputs() {
        pendingStartupInputsByPanelId.removeAll(keepingCapacity: false)
        armedStartupInputResendPanelIds.removeAll(keepingCapacity: false)
    }

    func startupInput(panelId: UUID) -> String? {
        pendingStartupInputsByPanelId[panelId]
    }

    func awaitsStartupInput(panelId: UUID) -> Bool {
        resumeStatesByPanelId[panelId] == .awaitingAutoResumeCommand &&
            pendingStartupInputsByPanelId[panelId] != nil
    }

    func armStartupInputResend(panelId: UUID) -> Bool {
        guard awaitsStartupInput(panelId: panelId),
              !armedStartupInputResendPanelIds.contains(panelId) else {
            return false
        }
        armedStartupInputResendPanelIds.insert(panelId)
        return true
    }

    func takeStartupInputForResend(
        panelId: UUID,
        shellState: PanelShellActivityState
    ) -> String? {
        armedStartupInputResendPanelIds.remove(panelId)
        guard shellState == .promptIdle, awaitsStartupInput(panelId: panelId) else {
            return nil
        }
        return pendingStartupInputsByPanelId.removeValue(forKey: panelId)
    }

    func seedTransferredState(
        panelId: UUID,
        snapshot: SessionRestorableAgentSnapshot?,
        resumeState: Workspace.RestoredAgentResumeState?,
        completedGeneration: RestoredAgentCompletedGeneration?,
        startupInput: String? = nil
    ) {
        registerStartupInput(
            resumeState == .awaitingAutoResumeCommand ? startupInput : nil,
            panelId: panelId
        )
        if let snapshot {
            snapshotsByPanelId[panelId] = snapshot
        } else {
            snapshotsByPanelId.removeValue(forKey: panelId)
        }

        if resumeState == .completedAgentExit, let completedGeneration {
            completedGenerationsByPanelId[panelId] = completedGeneration
        } else {
            completedGenerationsByPanelId.removeValue(forKey: panelId)
        }

        if let resumeState {
            resumeStatesByPanelId[panelId] = resumeState
        } else {
            resumeStatesByPanelId.removeValue(forKey: panelId)
        }
    }

    private func observationSupersedesCompletion(
        panelId: UUID,
        observation: RestorableAgentSessionIndex.Entry,
        currentProcessIdentity: (pid_t) -> AgentPIDProcessIdentity?
    ) -> Bool {
        guard let completed = completedGenerationsByPanelId[panelId] else {
            return false
        }

        let observedIdentities = Set(observation.agentProcessIdentities.values)
        let currentCandidateIdentities = Set(observedIdentities.filter { identity in
            currentProcessIdentity(identity.pid) == identity
        })
        if !observedIdentities.isEmpty {
            let newerIdentities = currentCandidateIdentities.subtracting(completed.processIdentities)
            return newerIdentities.contains { identity in
                let startedAt = TimeInterval(identity.startSeconds) +
                    TimeInterval(identity.startMicroseconds) / 1_000_000
                return startedAt > completed.completedAt
            }
        }
        return false
    }
}
