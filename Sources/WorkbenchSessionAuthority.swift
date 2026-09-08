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
        agent?.workbenchAuthority ?? binding?.workbenchAuthority ?? missingAuthority
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
        guard resolved(agent: agent, binding: binding) != .controlledHere else {
            return nil
        }
        var snapshot: SessionRestorableAgentSnapshot
        if let agent {
            snapshot = agent
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
