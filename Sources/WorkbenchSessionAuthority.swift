import Foundation

enum WorkbenchSessionAuthority: String, Codable, Sendable {
    case controlledHere
    case controlledInAgencyHub

    static func inferred(from launchCommand: AgentLaunchCommandSnapshot?) -> WorkbenchSessionAuthority {
        guard let launchCommand else { return .controlledHere }
        if launchCommand.environment?["CMUX_AGENT_LAUNCH_AUTHORITY"] == "agency-hub" {
            return .controlledInAgencyHub
        }
        guard let executable = launchCommand.executablePath
            ?? launchCommand.arguments.first
            ?? launchCommand.launcher else {
            return .controlledHere
        }
        let identifiesAgency = URL(fileURLWithPath: executable).lastPathComponent == "agency"
            || launchCommand.launcher == "agency"
            || launchCommand.arguments.first.map {
                URL(fileURLWithPath: $0).lastPathComponent == "agency"
            } == true
        guard identifiesAgency else { return .controlledHere }
        let arguments = launchCommand.arguments.prefix { $0 != "--" }
        guard arguments.contains(where: { $0 == "copilot" || $0 == "cp" }),
              arguments.contains(where: { $0 == "--hub" || $0 == "--session-manager" }) else {
            return .controlledHere
        }
        return .controlledInAgencyHub
    }

    static func resolved(
        agent: SessionRestorableAgentSnapshot?,
        binding: SurfaceResumeBindingSnapshot?
    ) -> WorkbenchSessionAuthority {
        if let explicit = agent?.workbenchAuthority {
            return explicit
        }
        if inferred(from: agent?.launchCommand) == .controlledInAgencyHub ||
            inferred(from: binding?.launchCommand) == .controlledInAgencyHub {
            return .controlledInAgencyHub
        }
        return .controlledHere
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
        guard resolved(agent: agent, binding: binding) == .controlledInAgencyHub else {
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
                workbenchAuthority: .controlledInAgencyHub
            )
        }
        guard snapshot.kind == .copilot else { return nil }
        snapshot.workbenchAuthority = .controlledHere
        if inferred(from: snapshot.launchCommand) == .controlledInAgencyHub {
            snapshot.launchCommand = nil
        }
        return snapshot.resumeCommand == nil ? nil : snapshot
    }

    func allowsLocalAutoResume(globalEnabled: Bool, wasRunning: Bool) -> Bool {
        globalEnabled && wasRunning && self == .controlledHere
    }
}

extension SessionRestorableAgentSnapshot {
    var effectiveWorkbenchAuthority: WorkbenchSessionAuthority {
        workbenchAuthority ?? WorkbenchSessionAuthority.inferred(from: launchCommand)
    }
}
