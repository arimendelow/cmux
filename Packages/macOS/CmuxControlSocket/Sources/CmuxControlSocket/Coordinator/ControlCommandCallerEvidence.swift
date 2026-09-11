public import Foundation

/// A fresh, process-correlated observation of one agent session.
public struct ControlAgentSessionCallerEvidence: Sendable, Equatable {
    /// The surface whose process tree owns the observed session.
    public let surfaceID: UUID

    /// The generic agent kind.
    public let kind: String

    /// The exact runtime session identifier.
    public let sessionID: String

    /// Current-generation agent processes correlated with this session.
    public let agentProcessIDs: Set<Int32>

    /// The observed working directory, if available.
    public let workingDirectory: String?

    /// Creates immutable exact-session process evidence.
    public init(
        surfaceID: UUID,
        kind: String,
        sessionID: String,
        agentProcessIDs: Set<Int32>,
        workingDirectory: String?
    ) {
        self.surfaceID = surfaceID
        self.kind = kind
        self.sessionID = sessionID
        self.agentProcessIDs = agentProcessIDs
        self.workingDirectory = workingDirectory
    }
}

/// Transport-owned evidence about the process that issued a control command.
///
/// Callers cannot populate this through request parameters. The socket host
/// captures it from the accepted peer and passes it to the coordinator.
public struct ControlCommandCallerEvidence: Sendable, Equatable {
    /// The peer process identifier captured from the accepted socket.
    public let processID: Int32?

    /// Whether the peer runs under the same user ID as the socket host.
    public let hasSameUserID: Bool

    /// Whether the peer presented a valid inherited socket capability.
    public let hasVerifiedSocketCapability: Bool

    /// Fresh exact-session process evidence collected off the main actor.
    public let agentSession: ControlAgentSessionCallerEvidence?

    /// Creates transport-owned caller evidence.
    ///
    /// - Parameters:
    ///   - processID: The accepted peer process identifier.
    ///   - hasSameUserID: Whether the peer has the same user ID as the host.
    ///   - hasVerifiedSocketCapability: Whether the inherited capability was valid.
    ///   - agentSession: Fresh exact-session process evidence, when requested.
    public init(
        processID: Int32?,
        hasSameUserID: Bool,
        hasVerifiedSocketCapability: Bool,
        agentSession: ControlAgentSessionCallerEvidence? = nil
    ) {
        self.processID = processID
        self.hasSameUserID = hasSameUserID
        self.hasVerifiedSocketCapability = hasVerifiedSocketCapability
        self.agentSession = agentSession
    }
}
