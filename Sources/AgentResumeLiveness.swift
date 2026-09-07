import Foundation

/// Answers "is there already a live process for this agent session?" using
/// the process-liveness facts `SharedLiveAgentIndex` / `RestorableAgentSessionIndex`
/// already maintain. Centralizing the check here means both the launch-time
/// resume gate (`Workspace.createPanel`) and the persist-time stale-binding
/// reconciliation (`Workspace.reconcileSurfaceResumeBindings`) agree on the
/// same definition of "live" (#8446).
enum AgentResumeLiveness {
    /// True when `entry` reports a live process for the same agent session
    /// (matched by kind + session id), i.e. resuming it again would spawn a
    /// duplicate process against the same on-disk session data.
    static func hasLiveProcess(
        for entry: RestorableAgentSessionIndex.Entry?,
        kind: String,
        sessionId: String
    ) -> Bool {
        guard let entry, !entry.processIDs.isEmpty else { return false }
        return entry.snapshot.kind.rawValue == kind &&
            ManagedAgentSessionIdentity.sessionIDsMatch(
                kind: kind,
                lhs: entry.snapshot.sessionId,
                rhs: sessionId
            )
    }

    static func exactProcessGeneration(
        for entry: RestorableAgentSessionIndex.Entry?,
        kind: String,
        sessionId: String,
        currentProcessIdentity: (Int) -> AgentPIDProcessIdentity?
    ) -> Set<AgentPIDProcessIdentity>? {
        guard let entry,
              hasLiveProcess(for: entry, kind: kind, sessionId: sessionId) else {
            return nil
        }
        let processIDs = entry.agentProcessIDs.isEmpty ? entry.processIDs : entry.agentProcessIDs
        let identities = entry.agentProcessIdentities.isEmpty
            ? entry.processIdentities
            : entry.agentProcessIdentities
        guard !processIDs.isEmpty,
              Set(identities.keys) == processIDs,
              identities.allSatisfy({ processID, identity in
                  Int(identity.pid) == processID &&
                      currentProcessIdentity(processID) == identity
              }) else {
            return nil
        }
        return Set(identities.values)
    }
}
