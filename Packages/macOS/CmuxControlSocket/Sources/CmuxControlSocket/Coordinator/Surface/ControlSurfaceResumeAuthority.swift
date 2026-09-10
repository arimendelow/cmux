import Foundation

/// A caller's generic control-location attestation for an agent session.
public enum ControlSurfaceResumeAuthority: String, Sendable, Equatable {
    /// A verified launcher on this machine owns the session.
    case local

    /// Another host or control plane owns the session.
    case external

    /// No controller can currently be verified.
    case unknown
}
