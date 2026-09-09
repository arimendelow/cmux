import Foundation

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

    func allowsLocalAutoResume(globalEnabled: Bool, wasRunning: Bool) -> Bool {
        globalEnabled && wasRunning && self == .controlledHere
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
