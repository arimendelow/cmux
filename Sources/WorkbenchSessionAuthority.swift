import CmuxControlSocket
import Darwin
import Foundation

enum WorkbenchAuthorityEvidence: String, Codable, Sendable {
    case inferred
    case launcherAttested
    case launcherOwned

    var isVerifiedLauncherEvidence: Bool {
        self != .inferred
    }
}

struct WorkbenchLauncherBindingTarget {
    let snapshot: SessionRestorableAgentSnapshot
    let agentProcessIDs: Set<pid_t>
}

struct WorkbenchLauncherBindingVerifier {
    let processIsDescendant: (pid_t, pid_t) -> Bool

    func verifiedSnapshot(
        agentSessionID: String,
        callerEvidence: ControlCommandCallerEvidence?,
        target: WorkbenchLauncherBindingTarget?
    ) -> SessionRestorableAgentSnapshot? {
        guard let callerEvidence,
              callerEvidence.hasSameUserID,
              callerEvidence.hasVerifiedSocketCapability,
              let callerProcessID = callerEvidence.processID,
              callerProcessID > 0,
              let target,
              ManagedAgentSessionIdentity.sessionIDsMatch(
                  kind: target.snapshot.kind.rawValue,
                  lhs: target.snapshot.sessionId,
                  rhs: agentSessionID
              ),
              target.agentProcessIDs.contains(where: {
                  $0 == callerProcessID ||
                      processIsDescendant(callerProcessID, $0)
              }) else {
            return nil
        }
        return target.snapshot
    }
}

enum WorkbenchSessionAuthority: String, Sendable {
    case controlledHere
    case controlledExternally
    case unknown

    static func resolved(
        agent: SessionRestorableAgentSnapshot?,
        binding: SurfaceResumeBindingSnapshot?,
        missingAuthority: WorkbenchSessionAuthority = OuroWorkbenchProduct.isCurrentBundle
            ? .unknown
            : .controlledHere
    ) -> WorkbenchSessionAuthority {
        if binding?.workbenchAuthorityEvidence.isVerifiedLauncherEvidence == true,
           let authority = binding?.workbenchAuthority {
            return authority
        }
        if let authority = agent?.workbenchAuthority ?? binding?.workbenchAuthority {
            return authority
        }
        guard agent != nil || binding != nil else {
            return missingAuthority
        }
        guard agent != nil || binding?.isAgentHookBinding == true else {
            return .controlledHere
        }
        return missingAuthority
    }

    static func preservingExplicitLocalAuthority(
        observed: SessionRestorableAgentSnapshot,
        current: SessionRestorableAgentSnapshot?
    ) -> SessionRestorableAgentSnapshot {
        guard let current,
              current.workbenchAuthority == .controlledHere,
              current.kind.rawValue == observed.kind.rawValue,
              ManagedAgentSessionIdentity.sessionIDsMatch(
                kind: current.kind.rawValue,
                lhs: current.sessionId,
                rhs: observed.sessionId
              ) else {
            return observed
        }
        var preserved = observed
        preserved.workbenchAuthority = .controlledHere
        preserved.launchCommand = current.launchCommand
        return preserved
    }

    static func localTakeoverSnapshot(
        agent: SessionRestorableAgentSnapshot?,
        binding: SurfaceResumeBindingSnapshot?
    ) -> SessionRestorableAgentSnapshot? {
        let compatibleAgent = Workspace.restorableAgentForSessionRestore(
            agent,
            resumeBinding: binding
        )
        guard resolved(agent: compatibleAgent, binding: binding) != .controlledHere else {
            return nil
        }
        var snapshot: SessionRestorableAgentSnapshot
        if let compatibleAgent {
            snapshot = compatibleAgent
        } else {
            guard let binding,
                  binding.isAgentHookBinding,
                  binding.kind == RestorableAgentKind.copilot.rawValue,
                  let sessionId = binding.checkpointId?.trimmingCharacters(
                    in: .whitespacesAndNewlines
                  ),
                  !sessionId.isEmpty else {
                return nil
            }
            snapshot = SessionRestorableAgentSnapshot(
                kind: .copilot,
                sessionId: sessionId,
                workingDirectory: binding.cwd ?? binding.launchCommand?.workingDirectory,
                launchCommand: binding.launchCommand,
                permissionMode: binding.permissionMode,
                workbenchAuthority: binding.workbenchAuthority
            )
        }
        guard snapshot.kind == .copilot else { return nil }
        snapshot.workbenchAuthority = .controlledHere
        snapshot.launchCommand = nil
        return snapshot.resumeCommand == nil ? nil : snapshot
    }

    static func localTakeoverBinding(
        snapshot: SessionRestorableAgentSnapshot,
        replacing binding: SurfaceResumeBindingSnapshot?
    ) -> SurfaceResumeBindingSnapshot? {
        guard let command = snapshot.resumeCommand else { return nil }
        return SurfaceResumeBindingSnapshot(
            name: binding?.name,
            kind: snapshot.kind.rawValue,
            command: command,
            cwd: snapshot.workingDirectory,
            checkpointId: snapshot.sessionId,
            source: "agent-hook",
            permissionMode: snapshot.permissionMode,
            autoResume: true,
            workbenchAuthority: .controlledHere,
            launchFlavor: .local
        )
    }

    static func preservingExplicitLocalBindingAuthority(
        observed: SurfaceResumeBindingSnapshot,
        current: SurfaceResumeBindingSnapshot?
    ) -> SurfaceResumeBindingSnapshot {
        if let current,
           current.workbenchAuthorityEvidence.isVerifiedLauncherEvidence,
           current.isSameManagedSession(as: observed) {
            let refreshedWorkingDirectory = observed.cwd ?? current.cwd
            let trustedExecution = current.retargetingWorkingDirectory(
                refreshedWorkingDirectory
            )
            var preserved = observed
            preserved.cwd = refreshedWorkingDirectory
            preserved.workbenchAuthority = current.workbenchAuthority
            preserved.workbenchAuthorityEvidence =
                current.workbenchAuthorityEvidence
            preserved.launchFlavor = current.launchFlavor
            preserved.launchCommand = trustedExecution.launchCommand
            preserved.command = trustedExecution.command
            preserved.environment = current.environment
            preserved.approvalPolicy = current.approvalPolicy
            preserved.approvalRecordId = current.approvalRecordId
            preserved.autoResume = current.autoResume
            return preserved
        }
        guard let current,
              current.workbenchAuthority == .controlledHere,
              current.isSameManagedSession(as: observed) else {
            return observed
        }
        let refreshedWorkingDirectory = observed.cwd ?? current.cwd
        let trustedExecution = current.retargetingWorkingDirectory(
            refreshedWorkingDirectory
        )
        var preserved = observed
        preserved.cwd = refreshedWorkingDirectory
        preserved.workbenchAuthority = .controlledHere
        preserved.launchFlavor = current.launchFlavor
        preserved.launchCommand = trustedExecution.launchCommand
        preserved.command = trustedExecution.command
        preserved.environment = current.environment
        preserved.approvalPolicy = current.approvalPolicy
        preserved.approvalRecordId = current.approvalRecordId
        return preserved
    }

    static func lowerTrustBindingCannotReplace(
        current: SurfaceResumeBindingSnapshot?,
        incoming: SurfaceResumeBindingSnapshot
    ) -> Bool {
        current?.workbenchAuthorityEvidence.isVerifiedLauncherEvidence == true &&
            !incoming.workbenchAuthorityEvidence.isVerifiedLauncherEvidence
    }

    func allowsLocalAutoResume(globalEnabled: Bool, wasRunning: Bool) -> Bool {
        globalEnabled && wasRunning && self == .controlledHere
    }

}

extension ControlSurfaceResumeAuthority {
    var workbenchAuthority: WorkbenchSessionAuthority {
        switch self {
        case .local:
            .controlledHere
        case .external:
            .controlledExternally
        case .unknown:
            .unknown
        }
    }
}

extension WorkbenchSessionAuthority: Codable {
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        switch value {
        case Self.controlledHere.rawValue:
            self = .controlledHere
        case Self.controlledExternally.rawValue:
            self = .controlledExternally
        case Self.unknown.rawValue, "":
            self = .unknown
        default:
            self = .controlledExternally
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

extension SessionRestorableAgentSnapshot {
    var effectiveWorkbenchAuthority: WorkbenchSessionAuthority {
        workbenchAuthority ?? (OuroWorkbenchProduct.isCurrentBundle ? .unknown : .controlledHere)
    }
}
