import Foundation

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

    /// Creates transport-owned caller evidence.
    ///
    /// - Parameters:
    ///   - processID: The accepted peer process identifier.
    ///   - hasSameUserID: Whether the peer has the same user ID as the host.
    ///   - hasVerifiedSocketCapability: Whether the inherited capability was valid.
    public init(
        processID: Int32?,
        hasSameUserID: Bool,
        hasVerifiedSocketCapability: Bool
    ) {
        self.processID = processID
        self.hasSameUserID = hasSameUserID
        self.hasVerifiedSocketCapability = hasVerifiedSocketCapability
    }
}
