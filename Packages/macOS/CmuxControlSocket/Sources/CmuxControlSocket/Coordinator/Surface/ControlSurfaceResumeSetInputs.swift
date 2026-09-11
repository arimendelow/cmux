public import Foundation

/// The pre-parsed inputs for `surface.resume.set`, lifted from the legacy
/// `v2SurfaceResumeSet` body's param parsing.
///
/// The coordinator parses these (the `source` already mapped through the legacy
/// `v2PublicSurfaceResumeSource` `process-detected` → `manual` rule, and
/// `autoResume` already gated to the `agent-hook` source); the app constructs the
/// app-typed `SurfaceResumeBindingSnapshot`, runs the approval flow, and stores it.
public struct ControlSurfaceResumeSetInputs: Sendable, Equatable {
    /// The binding's display name (trimmed non-empty), if any.
    public let name: String?
    /// The binding's kind (trimmed non-empty), if any.
    public let kind: String?
    /// The resume command, absent only for a non-local authority attestation.
    public let command: String?
    /// The working directory (trimmed non-empty), if any.
    public let cwd: String?
    /// The checkpoint identifier (trimmed non-empty), if any.
    public let checkpointID: String?
    /// The authoritative agent session identifier reported by its runtime hook.
    public let agentSessionID: String?
    /// The generic control-location attestation paired with ``agentSessionID``.
    public let authority: ControlSurfaceResumeAuthority?
    /// The binding source (already mapped: `process-detected` → `manual`), if any.
    public let source: String?
    /// The environment overrides (the legacy `v2StringMap`, or `nil`).
    public let environment: [String: String]?
    /// Structured launch data supplied alongside the compatibility command.
    public let launchCommand: ControlAgentLaunchCommand?
    /// Last provider permission mode captured by an agent hook.
    public let permissionMode: String?
    /// Whether automatic resume is requested (already gated: `true` only for the
    /// `agent-hook` source with `auto_resume == true`).
    public let autoResume: Bool
    /// The relay-claimed remote workspace, authenticated by the app context.
    public let remoteWorkspaceID: UUID?
    /// Raw relay parameters retained to authenticate their provenance.
    public let remoteRelayParameters: [String: JSONValue]?
    /// Transport-owned evidence about the process that issued the request.
    public let callerEvidence: ControlCommandCallerEvidence?

    /// Creates resume-set inputs.
    ///
    /// - Parameters:
    ///   - name: The binding's display name.
    ///   - kind: The binding's kind.
    ///   - command: The resume command.
    ///   - cwd: The working directory.
    ///   - checkpointID: The checkpoint identifier.
    ///   - source: The (already-mapped) binding source.
    ///   - environment: The environment overrides.
    ///   - autoResume: Whether automatic resume is requested.
    ///   - remoteWorkspaceID: The authenticated relay's owning workspace.
    ///   - remoteRelayParameters: Raw parameters carrying relay authentication.
    public init(
        name: String?,
        kind: String?,
        command: String?,
        cwd: String?,
        checkpointID: String?,
        agentSessionID: String?,
        authority: ControlSurfaceResumeAuthority?,
        source: String?,
        environment: [String: String]?,
        launchCommand: ControlAgentLaunchCommand?,
        permissionMode: String?,
        autoResume: Bool,
        remoteWorkspaceID: UUID?,
        remoteRelayParameters: [String: JSONValue]?,
        callerEvidence: ControlCommandCallerEvidence?
    ) {
        self.name = name
        self.kind = kind
        self.command = command
        self.cwd = cwd
        self.checkpointID = checkpointID
        self.agentSessionID = agentSessionID
        self.authority = authority
        self.source = source
        self.environment = environment
        self.launchCommand = launchCommand
        self.permissionMode = permissionMode
        self.autoResume = autoResume
        self.remoteWorkspaceID = remoteWorkspaceID
        self.remoteRelayParameters = remoteRelayParameters
        self.callerEvidence = callerEvidence
    }
}
