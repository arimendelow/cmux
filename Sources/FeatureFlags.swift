import Foundation
import Observation
import PostHog
import os

enum OuroWorkbenchProduct {
    private static let bundleIdentifierPrefix = "com.ourostack.workbench"
    private static let copilotHookInstallStarted = OSAllocatedUnfairLock(initialState: false)
    static let selectedBossDefaultsKey = "ouroWorkbench.selectedBossAgent"

    enum BossSelection: Equatable {
        case selected(String)
        case unavailable(String)
    }

    static func isWorkbenchBundleIdentifier(_ bundleIdentifier: String?) -> Bool {
        guard let bundleIdentifier else { return false }
        return bundleIdentifier == bundleIdentifierPrefix
            || bundleIdentifier.hasPrefix(bundleIdentifierPrefix + ".")
    }

    static var isCurrentBundle: Bool {
        isWorkbenchBundleIdentifier(Bundle.main.bundleIdentifier)
    }

    static func shouldStartMainThreadHangWatchdog(bundleIdentifier: String?) -> Bool {
        !isWorkbenchBundleIdentifier(bundleIdentifier)
    }

    static func agentChatUIEnabled(
        bundleIdentifier: String?,
        upstreamValue: Bool
    ) -> Bool {
        isWorkbenchBundleIdentifier(bundleIdentifier) || upstreamValue
    }

    static func agentChatActionTitle(bundleIdentifier: String? = Bundle.main.bundleIdentifier) -> String {
        if isWorkbenchBundleIdentifier(bundleIdentifier) { return "Open Boss" }
        return String(localized: "command.newAgentChat.title", defaultValue: "New agent chat")
    }

    static func agentChatSurfaceTitle(bundleIdentifier: String? = Bundle.main.bundleIdentifier) -> String {
        if isWorkbenchBundleIdentifier(bundleIdentifier) { return "Boss" }
        return String(localized: "workspace.agentChat.defaultTitle", defaultValue: "Agent Chat")
    }

    static func agentChatSubtitle(bundleIdentifier: String? = Bundle.main.bundleIdentifier) -> String {
        if isWorkbenchBundleIdentifier(bundleIdentifier) { return "Workbench boss" }
        return String(localized: "command.newAgentChat.subtitle", defaultValue: "Agent Chat")
    }

    static func repositoryRoot(sourceFilePath: String) -> URL {
        URL(fileURLWithPath: sourceFilePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    static var developerSourceRoot: URL {
        repositoryRoot(sourceFilePath: #filePath)
    }

    static func agentChatStartCommand(
        bundleIdentifier: String?,
        bundleURL: URL = Bundle.main.bundleURL,
        sourceFilePath: String,
        fileManager: FileManager = .default
    ) -> String? {
        guard isWorkbenchBundleIdentifier(bundleIdentifier) else { return nil }
        let sourceRoot = repositoryRoot(sourceFilePath: sourceFilePath)
        let scripts = [
            bundleURL.appendingPathComponent("Contents/Resources/agent-chat/cmux-chat"),
            sourceRoot.appendingPathComponent("agent-chat/cmux-chat"),
        ]
        guard let script = scripts.first(where: {
            fileManager.isExecutableFile(atPath: $0.path)
        }) else { return nil }
        return "BUN_BIN=\"$(command -v bun)\" \(TerminalStartupShellQuoting.singleQuoted(script.path)) --no-open"
    }

    static var currentAgentChatStartCommand: String? {
        agentChatStartCommand(
            bundleIdentifier: Bundle.main.bundleIdentifier,
            sourceFilePath: #filePath
        )
    }

    static func scheduleCopilotHookInstallation() {
        let shouldStart = copilotHookInstallStarted.withLock { started in
            guard !started else { return false }
            started = true
            return true
        }
        guard shouldStart else { return }
        Task.detached(priority: .utility) {
            if !installCopilotHooksIfNeeded() {
                Logger(
                    subsystem: Bundle.main.bundleIdentifier ?? "com.ourostack.workbench",
                    category: "copilot-hooks"
                ).error("Workbench could not install Copilot lifecycle hooks")
            }
        }
    }

    static func installCopilotHooksIfNeeded(
        bundleIdentifier: String? = Bundle.main.bundleIdentifier,
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser,
        bundleURL: URL = Bundle.main.bundleURL,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default,
        run: (URL, [String], [String: String]) -> Bool = runCopilotHookInstaller
    ) -> Bool {
        guard isWorkbenchBundleIdentifier(bundleIdentifier) else { return false }
        let hookURL = homeURL.appendingPathComponent(".copilot/hooks/cmux.json")
        func isInstalled() -> Bool {
            guard let data = fileManager.contents(atPath: hookURL.path),
                  let content = String(data: data, encoding: .utf8) else {
                return false
            }
            return content.contains("hooks copilot")
        }
        if isInstalled() { return true }

        let cli = bundleURL.appendingPathComponent("Contents/Resources/bin/cmux")
        guard fileManager.isExecutableFile(atPath: cli.path) else { return false }
        let versions = homeURL.appendingPathComponent(".copilot-cli", isDirectory: true)
        let versionedCopilots = (try? fileManager.contentsOfDirectory(
            at: versions,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ))?.sorted {
            $0.lastPathComponent.compare($1.lastPathComponent, options: .numeric) == .orderedDescending
        }.map {
            $0.appendingPathComponent("copilot")
        } ?? []
        let copilotCandidates = versionedCopilots + [
            homeURL.appendingPathComponent(".local/bin/copilot"),
            URL(fileURLWithPath: "/opt/homebrew/bin/copilot"),
            URL(fileURLWithPath: "/usr/local/bin/copilot"),
        ]
        guard let copilot = copilotCandidates.first(where: {
            fileManager.isExecutableFile(atPath: $0.path)
        }) else { return false }
        var installEnvironment = environment
        let existingPath = installEnvironment["PATH"]?.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        installEnvironment["PATH"] = [
            copilot.deletingLastPathComponent().path,
            cli.deletingLastPathComponent().path,
            existingPath,
        ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ":")
        guard run(
            cli,
            ["hooks", "setup", "--agent", "copilot", "--yes"],
            installEnvironment
        ) else { return false }
        return isInstalled()
    }

    private static func runCopilotHookInstaller(
        executable: URL,
        arguments: [String],
        environment: [String: String]
    ) -> Bool {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    static func resolveBossSelection(
        selectedBossName: String? = nil,
        legacyBossName: String?,
        usableAgentNames: [String]
    ) -> BossSelection {
        let usable = usableAgentNames
            .filter(isSafeAgentName)
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        if let selectedBossName = selectedBossName?.trimmingCharacters(in: .whitespacesAndNewlines),
           isSafeAgentName(selectedBossName),
           usable.contains(selectedBossName) {
            return .selected(selectedBossName)
        }
        if let legacyBossName = legacyBossName?.trimmingCharacters(in: .whitespacesAndNewlines),
           isSafeAgentName(legacyBossName),
           usable.contains(legacyBossName) {
            return .selected(legacyBossName)
        }
        if usable.count == 1 {
            return .selected(usable[0])
        }
        if usable.isEmpty {
            return .unavailable("No enabled Ouro agents are installed.")
        }
        return .unavailable("Choose one Ouro agent as Boss: \(usable.joined(separator: ", ")).")
    }

    static func usableBossAgentNames(
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser,
        fileManager: FileManager = .default
    ) -> [String] {
        let bundlesURL = homeURL.appendingPathComponent("AgentBundles", isDirectory: true)
        return ((try? fileManager.contentsOfDirectory(
            at: bundlesURL,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        ))?.compactMap { bundleURL -> String? in
            guard bundleURL.pathExtension == "ouro" else { return nil }
            let values = try? bundleURL.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values?.isDirectory == true, values?.isSymbolicLink != true else { return nil }
            let name = bundleURL.deletingPathExtension().lastPathComponent
            guard isSafeAgentName(name),
                  let data = try? Data(contentsOf: bundleURL.appendingPathComponent("agent.json")),
                  let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  config["enabled"] as? Bool == true,
                  let humanFacing = config["humanFacing"] as? [String: Any],
                  let agentFacing = config["agentFacing"] as? [String: Any],
                  humanFacing["provider"] as? String != nil,
                  agentFacing["provider"] as? String != nil else {
                return nil
            }
            return name
        } ?? []).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    @discardableResult
    static func selectBossAgent(
        _ agentName: String,
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser,
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default
    ) -> Bool {
        guard usableBossAgentNames(homeURL: homeURL, fileManager: fileManager).contains(agentName) else {
            return false
        }
        defaults.set(agentName, forKey: selectedBossDefaultsKey)
        return true
    }

    static func agentChatEnvironment(
        bundleIdentifier: String? = Bundle.main.bundleIdentifier,
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser,
        applicationSupportURL: URL? = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first,
        bundleURL: URL = Bundle.main.bundleURL,
        controlSocketPath: String? = nil,
        controlSocketCapability: String? = nil,
        controlSocketReady: Bool = false,
        sourceFilePath: String = #filePath,
        defaults: UserDefaults = .standard,
        environment baseEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> [String: String] {
        guard isWorkbenchBundleIdentifier(bundleIdentifier) else { return [:] }
        let sourceRoot = repositoryRoot(sourceFilePath: sourceFilePath)
        let deskRoot = homeURL.appendingPathComponent("ms-desk", isDirectory: true)
        let appSupport = applicationSupportURL
            ?? homeURL.appendingPathComponent("Library/Application Support")
        var environment = [
            "CMUX_AGENT_CHAT_PRODUCT": "ouro-workbench-v1",
            "CMUX_AGENT_CHAT_CONTEXT_LABEL": "Desk / v1-copilot-vertical-slice",
            "CMUX_AGENT_CHAT_DEFAULT_PROVIDER": "ouro-boss",
            "CMUX_AGENT_UI_CWD": deskRoot.path,
            "CMUX_AGENT_CHAT_ALLOWED_ROOTS": [
                homeURL.appendingPathComponent("code").path,
                deskRoot.path,
                sourceRoot.path,
            ].joined(separator: ":"),
            "CMUX_AGENT_CHAT_SESSION_DIR": appSupport
                .appendingPathComponent("Ouro Workbench v1/Agent Chat/Sessions")
                .path,
            "CMUX_AGENT_MODELS_URL": "http://127.0.0.1:1",
        ]
        switch currentBossSelection(
            homeURL: homeURL,
            applicationSupportURL: appSupport,
            defaults: defaults,
            fileManager: fileManager
        ) {
        case .selected(let agentName):
            environment["CMUX_AGENT_CHAT_BOSS_AGENT"] = agentName
            environment["CMUX_AGENT_CHAT_SESSION_DIR"] = appSupport
                .appendingPathComponent("Ouro Workbench v1/Agent Chat/Sessions")
                .appendingPathComponent(agentName, isDirectory: true)
                .path
        case .unavailable(let message):
            environment["CMUX_AGENT_CHAT_BOSS_ERROR"] = message
        }
        let ouroCandidates = [
            homeURL.appendingPathComponent(".ouro-cli/bin/ouro"),
            homeURL.appendingPathComponent(".local/bin/ouro"),
        ]
        if let ouro = ouroCandidates.first(where: { fileManager.isExecutableFile(atPath: $0.path) }) {
            environment["CMUX_AGENT_CHAT_OURO_COMMAND"] = ouro.path
        }
        let bundledCLI = bundleURL.appendingPathComponent("Contents/Resources/bin/cmux")
        let resolvedBundledCLI = fileManager.isExecutableFile(atPath: bundledCLI.path) ? bundledCLI.path : nil
        let resolvedControlSocketPath = controlSocketPath?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedControlSocketCapability = controlSocketCapability?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nvmRoot = homeURL.appendingPathComponent(".nvm/versions/node", isDirectory: true)
        let nvmVersions = (try? fileManager.contentsOfDirectory(
            at: nvmRoot,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ))?.sorted {
            $0.lastPathComponent.compare($1.lastPathComponent, options: .numeric) == .orderedDescending
        } ?? []
        let nvmBuns = nvmVersions.map {
            $0.appendingPathComponent("bin/bun")
        }
        if let node = nvmVersions.first(where: {
            guard let major = Int($0.lastPathComponent.drop(while: { $0 == "v" }).split(separator: ".").first ?? ""),
                  major >= 22 else {
                return false
            }
            return fileManager.isExecutableFile(atPath: $0.appendingPathComponent("bin/node").path)
        })?.appendingPathComponent("bin") {
            environment["PATH"] = [
                node.path,
                baseEnvironment["PATH"]?.trimmingCharacters(in: .whitespacesAndNewlines),
            ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ":")
        }
        let bunCandidates = [
            baseEnvironment["BUN_BIN"].map(URL.init(fileURLWithPath:)),
            homeURL.appendingPathComponent(".bun/bin/bun"),
            homeURL.appendingPathComponent(".local/bin/bun"),
            URL(fileURLWithPath: "/opt/homebrew/bin/bun"),
            URL(fileURLWithPath: "/usr/local/bin/bun"),
        ].compactMap { $0 } + nvmBuns
        let resolvedBun = bunCandidates.first(where: { fileManager.isExecutableFile(atPath: $0.path) })?.path
        let workbenchMCPCandidates = [
            bundleURL.appendingPathComponent(
                "Contents/Resources/agent-chat/OuroWorkbenchMCP"
            ),
            sourceRoot.appendingPathComponent("agent-chat/OuroWorkbenchMCP"),
        ]
        if controlSocketReady,
           let resolvedBundledCLI,
           let resolvedControlSocketPath, !resolvedControlSocketPath.isEmpty,
           let resolvedControlSocketCapability, !resolvedControlSocketCapability.isEmpty,
           let resolvedBun,
           let workbenchMCP = workbenchMCPCandidates.first(where: {
               fileManager.isExecutableFile(atPath: $0.path)
           }) {
            environment["CMUX_BUNDLED_CLI_PATH"] = resolvedBundledCLI
            environment["CMUX_SOCKET_PATH"] = resolvedControlSocketPath
            environment["CMUX_SOCKET_CAPABILITY"] = resolvedControlSocketCapability
            environment["BUN_BIN"] = resolvedBun
            environment["CMUX_AGENT_CHAT_WORKBENCH_MCP"] = workbenchMCP.path
        }
        return environment
    }

    static func currentBossSelection(
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser,
        applicationSupportURL: URL? = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first,
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default
    ) -> BossSelection {
        let appSupport = applicationSupportURL
            ?? homeURL.appendingPathComponent("Library/Application Support")
        let legacyURL = appSupport
            .appendingPathComponent("OuroWorkbench", isDirectory: true)
            .appendingPathComponent("workspace-state.json")
        let legacyBossName: String? = {
            guard let data = try? Data(contentsOf: legacyURL),
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let boss = root["boss"] as? [String: Any] else {
                return nil
            }
            return boss["agentName"] as? String
        }()
        let selection = resolveBossSelection(
            selectedBossName: defaults.string(forKey: selectedBossDefaultsKey),
            legacyBossName: legacyBossName,
            usableAgentNames: usableBossAgentNames(homeURL: homeURL, fileManager: fileManager)
        )
        if case .selected(let agentName) = selection {
            defaults.set(agentName, forKey: selectedBossDefaultsKey)
        }
        return selection
    }

    private static func isSafeAgentName(_ name: String) -> Bool {
        name.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]*$"#, options: .regularExpression) != nil
    }
}

struct CmuxFeatureFlagDefinition: Identifiable, Equatable, Sendable {
    var id: String { key }

    let key: String
    let title: String
    let flagDescription: String
    let defaultWhenUnavailable: Bool
}

/// PostHog-backed runtime feature flags for the macOS app (PostHog project
/// 244066, same public key analytics uses). Values are cached in memory and
/// refreshed when the SDK reports a flag payload, so gated UI can be toggled
/// from the PostHog dashboard without shipping a build.
///
/// Resolution semantics (flags must never break the app):
/// - A remote value is authoritative when present, so rollout and kill-switch
///   changes cannot be masked by a stale local override.
/// - Without a remote value, a local override applies, followed by the explicit
///   per-flag default.
/// - Until a payload arrives, the last remote value survives restarts. A flag
///   that has never loaded keeps its safe default.
/// - Request and payload failures preserve the complete cached snapshot. A
///   successfully parsed payload replaces it, so omitted flags return to their
///   local override or default.
///
/// Registry contract (enforced by scripts/lint-feature-flags.py in CI): each
/// flag declares key / owner / reviewBy / defaultWhenUnavailable in the FLAG
/// comment above its property, and its key literal appears nowhere else.
@MainActor
@Observable
final class CmuxFeatureFlags {
    static let shared = CmuxFeatureFlags(publishesOffMainSnapshot: true)

    #if DEBUG
    private static let proUpgradeUIDefault = true
    #else
    private static let proUpgradeUIDefault = false
    #endif

    private static let mobileConnectButtonDefault = false
    private static let sidebarAccountButtonDefault = true

    #if DEBUG
    private static let cloudVMUIDefault = true
    #else
    private static let cloudVMUIDefault = false
    #endif
    private static let agentChatUIDefault = false
    #if DEBUG
    private nonisolated static let mobileWorkspaceChangesDefault = true
    #else
    private nonisolated static let mobileWorkspaceChangesDefault = false
    #endif
    private static let sidebarWorkspaceAgentSpinnerDefault = false
    private static let simulatorDefault = true
    private static let workspaceTodoControlsDefault = false
    private static let appKitSidebarListDefault = true

    private static let overrideKeyPrefix = "cmux.flags.override."
    private static let remoteCacheKeyPrefix = "cmux.flags.remote."
    private static let releaseControlProductWideDistinctID = "cmux-desktop-release-control"
    private static let releaseControlDistinctIDKey = "cmux.flags.releaseControlDistinctID"
    private static let releaseControlDistinctIDPrefix =
        releaseControlProductWideDistinctID + "-"
    private nonisolated static let maximumPostHogControlPlaneResponseBytes = 1_048_576

    // FLAG(key: sidebar-appkit-list-experiment, owner: lawrencecchen,
    //      reviewBy: 2026-10-01, defaultWhenUnavailable: true)
    // Renders the workspace sidebar with the AppKit NSTableView list
    // (virtualized rows, measured-once heights) instead of the SwiftUI
    // LazyVStack. On by default after the remote rollout reached 100%.
    static let appKitSidebarListFlag = CmuxFeatureFlagDefinition(
        key: "sidebar-appkit-list-experiment",
        title: String(
            localized: "featureFlags.appKitSidebarList.title",
            defaultValue: "Lawrence Sidebar"
        ),
        flagDescription: String(
            localized: "featureFlags.appKitSidebarList.description",
            defaultValue: "Renders the workspace sidebar with a native AppKit list and divider for smoother scrolling and resizing with many workspaces."
        ),
        defaultWhenUnavailable: CmuxFeatureFlags.appKitSidebarListDefault
    )

    // FLAG(key: mobile-workspace-changes-enabled-release, owner: lawrencecchen,
    //      reviewBy: 2026-10-01, defaultWhenUnavailable: false)
    // Serves the iOS diff viewer: advertises workspace.changes.v1 to phones
    // and answers the mobile.workspace.changes.* RPCs behind it. Every iOS
    // entry point (workspace-row chip, toolbar button, one-time hint, Changes
    // sheet, summary polling) feature-detects on that capability, so this one
    // Mac-side flag turns the whole feature off end to end. Release builds
    // keep it off until the PostHog flag enables it; DEBUG keeps it on for
    // dogfood.
    nonisolated static let mobileWorkspaceChangesFlag = CmuxFeatureFlagDefinition(
        key: "mobile-workspace-changes-enabled-release",
        title: String(
            localized: "featureFlags.mobileWorkspaceChanges.title",
            defaultValue: "Mobile diff viewer"
        ),
        flagDescription: String(
            localized: "featureFlags.mobileWorkspaceChanges.description",
            defaultValue: "Serves workspace diffs to paired phones: the iOS changes chip, toolbar button, and Changes sheet."
        ),
        defaultWhenUnavailable: CmuxFeatureFlags.mobileWorkspaceChangesDefault
    )

    // Order is load-bearing for the positional typed accessors below. Flags
    // that need a stable public definition are declared independently and
    // included here without repeating their key literal.
    static let allFlags: [CmuxFeatureFlagDefinition] = {
        [
            // FLAG(key: pro-upgrade-ui-enabled-release, owner: lawrencecchen,
            //      reviewBy: 2026-10-01, defaultWhenUnavailable: false)
            // Shows the Pro upgrade entrypoints (sidebar badge, Settings Account
            // card, palette command, Help menu item). Release builds hide them until
            // the PostHog flag is enabled; DEBUG keeps them visible for dogfood.
            CmuxFeatureFlagDefinition(
                key: "pro-upgrade-ui-enabled-release",
                title: String(localized: "featureFlags.proUpgrade.title", defaultValue: "Pro upgrade UI"),
                flagDescription: String(
                    localized: "featureFlags.proUpgrade.description",
                    defaultValue: "Shows Pro upgrade entrypoints in the sidebar, Settings, command palette, and Help menu."
                ),
                defaultWhenUnavailable: CmuxFeatureFlags.proUpgradeUIDefault
            ),

            // FLAG(key: mobile-connect-button-enabled-release, owner: lawrencecchen,
            //      reviewBy: 2026-10-01, defaultWhenUnavailable: false)
            // Shows the bottom-left sidebar iPhone button that opens the Mobile
            // Connect workspace. It stays hidden until the remote flag or a
            // local debug override enables it.
            CmuxFeatureFlagDefinition(
                key: "mobile-connect-button-enabled-release",
                title: String(localized: "featureFlags.mobileConnect.title", defaultValue: "Mobile Connect button"),
                flagDescription: String(
                    localized: "featureFlags.mobileConnect.description",
                    defaultValue: "Shows Mobile Connect entrypoints that open the iPhone pairing workspace."
                ),
                defaultWhenUnavailable: CmuxFeatureFlags.mobileConnectButtonDefault
            ),

            // FLAG(key: sidebar-account-button-enabled-release, owner: lawrencecchen,
            //      reviewBy: 2026-10-01, defaultWhenUnavailable: true)
            // Shows the account control in the bottom-left sidebar footer. The
            // Settings account section remains available when this shortcut is off.
            CmuxFeatureFlagDefinition(
                key: "sidebar-account-button-enabled-release",
                title: String(localized: "featureFlags.sidebarAccount.title", defaultValue: "Sidebar account button"),
                flagDescription: String(
                    localized: "featureFlags.sidebarAccount.description",
                    defaultValue: "Shows the profile and sign-in control in the sidebar footer."
                ),
                defaultWhenUnavailable: CmuxFeatureFlags.sidebarAccountButtonDefault
            ),

            // FLAG(key: cloud-vm-ui-enabled-release, owner: lawrencecchen,
            //      reviewBy: 2026-10-01, defaultWhenUnavailable: false)
            // Shows the Cloud VM entrypoints: the new-workspace dropdown section
            // (Open/Fork/Checkpoint/Restore/Advanced), the caret's direct Cloud
            // VM menu, and the command-palette Cloud VM commands. Release builds
            // hide them until the PostHog flag is enabled; DEBUG keeps them
            // visible for dogfood.
            CmuxFeatureFlagDefinition(
                key: "cloud-vm-ui-enabled-release",
                title: String(localized: "featureFlags.cloudVM.title", defaultValue: "Cloud VM UI"),
                flagDescription: String(
                    localized: "featureFlags.cloudVM.description",
                    defaultValue: "Shows Cloud VM entrypoints in the new-workspace dropdown and command palette."
                ),
                defaultWhenUnavailable: CmuxFeatureFlags.cloudVMUIDefault
            ),

            // FLAG(key: agent-chat-ui-enabled-release, owner: lawrencecchen,
            //      reviewBy: 2026-10-01, defaultWhenUnavailable: false)
            // Shows the Agent Chat entrypoints: the new-workspace dropdown item,
            // command-palette command, surface-tab-bar button, and shared action
            // executor. Hidden by default until the sidecar UX is ready to ship.
            CmuxFeatureFlagDefinition(
                key: "agent-chat-ui-enabled-release",
                title: String(localized: "featureFlags.agentChat.title", defaultValue: "Agent Chat UI"),
                flagDescription: String(
                    localized: "featureFlags.agentChat.description",
                    defaultValue: "Shows Agent Chat entrypoints in the new-workspace dropdown, command palette, and surface tab bar."
                ),
                defaultWhenUnavailable: CmuxFeatureFlags.agentChatUIDefault
            ),

            // FLAG(key: sidebar-workspace-agent-spinner-experiment, owner: lawrencecchen,
            //      reviewBy: 2026-10-01, defaultWhenUnavailable: false)
            // Shows the coding-agent activity spinner in workspace rows. Hidden
            // by default while multi-agent lifecycle edge cases are investigated.
            CmuxFeatureFlagDefinition(
                key: "sidebar-workspace-agent-spinner-experiment",
                title: String(
                    localized: "featureFlags.sidebarWorkspaceAgentSpinner.title",
                    defaultValue: "Workspace agent spinner"
                ),
                flagDescription: String(
                    localized: "featureFlags.sidebarWorkspaceAgentSpinner.description",
                    defaultValue: "Shows a spinner in workspace rows while coding agents are running."
                ),
                defaultWhenUnavailable: CmuxFeatureFlags.sidebarWorkspaceAgentSpinnerDefault
            ),

            // FLAG(key: simulator-enabled-release, owner: lawrencecchen,
            //      reviewBy: 2026-10-01, defaultWhenUnavailable: true)
            // Controls every Simulator entrypoint and active pane. The enabled
            // fallback preserves access when PostHog is unavailable, while the
            // remote value provides a release kill switch.
            CmuxFeatureFlagDefinition(
                key: "simulator-enabled-release",
                title: String(
                    localized: "featureFlags.simulator.title",
                    defaultValue: "Simulator"
                ),
                flagDescription: String(
                    localized: "featureFlags.simulator.description",
                    defaultValue: "Enables iPhone and iPad Simulator panes, commands, and automation."
                ),
                defaultWhenUnavailable: CmuxFeatureFlags.simulatorDefault
            ),

            // FLAG(key: workspace-todo-controls-enabled-release, owner: lawrencecchen,
            //      reviewBy: 2026-10-01, defaultWhenUnavailable: false)
            // Shows user-facing workspace todo controls that create checklist
            // items or set completion/status lanes. Hidden until the local
            // beta setting opts in or the PostHog flag is enabled.
            CmuxFeatureFlagDefinition(
                key: "workspace-todo-controls-enabled-release",
                title: String(
                    localized: "featureFlags.workspaceTodoControls.title",
                    defaultValue: "Workspace todo controls"
                ),
                flagDescription: String(
                    localized: "featureFlags.workspaceTodoControls.description",
                    defaultValue: "Shows Add Checklist Item and workspace completion status controls."
                ),
                defaultWhenUnavailable: CmuxFeatureFlags.workspaceTodoControlsDefault
            ),

            CmuxFeatureFlags.appKitSidebarListFlag,

            CmuxFeatureFlags.mobileWorkspaceChangesFlag,
        ]
    }()

    var isProUpgradeUIEnabled: Bool {
        effectiveValue(for: Self.allFlags[0])
    }

    var isMobileConnectButtonEnabled: Bool {
        effectiveValue(for: Self.allFlags[1])
    }

    var isCloudVMUIEnabled: Bool {
        effectiveValue(for: Self.allFlags[3])
    }

    var isAgentChatUIEnabled: Bool {
        Self.agentChatUIEnabledForCurrentBundle(
            upstreamValue: effectiveValue(for: Self.allFlags[4])
        )
    }

    private static func agentChatUIEnabledForCurrentBundle(upstreamValue: Bool) -> Bool {
        OuroWorkbenchProduct.agentChatUIEnabled(
            bundleIdentifier: Bundle.main.bundleIdentifier,
            upstreamValue: upstreamValue
        )
    }

    var isSidebarAccountButtonEnabled: Bool {
        effectiveValue(for: Self.allFlags[2])
    }

    var isSidebarWorkspaceAgentSpinnerEnabled: Bool {
        effectiveValue(for: Self.allFlags[5])
    }

    var isSimulatorEnabled: Bool {
        effectiveValue(for: Self.allFlags[6])
    }

    var isWorkspaceTodoControlsEnabled: Bool {
        effectiveValue(for: Self.allFlags[7])
    }

    var isAppKitSidebarListEnabled: Bool {
        effectiveValue(for: Self.appKitSidebarListFlag)
    }

    var isMobileWorkspaceChangesEnabled: Bool {
        effectiveValue(for: Self.mobileWorkspaceChangesFlag)
    }

    /// Effective values mirrored for nonisolated readers: the mobile host
    /// serves status payloads (which carry the capability list) off the main
    /// actor. Written only by the shared instance so test instances cannot
    /// stomp process-wide state. Before the shared instance exists, readers
    /// get the per-flag compile-time default (fail-closed for release flags).
    private nonisolated static let offMainEffectiveValues = OSAllocatedUnfairLock(
        initialState: [String: Bool]()
    )

    nonisolated static func offMainEffectiveValue(
        for definition: CmuxFeatureFlagDefinition
    ) -> Bool {
        offMainEffectiveValues.withLock { $0[definition.key] }
            ?? definition.defaultWhenUnavailable
    }

    @ObservationIgnored
    private let publishesOffMainSnapshot: Bool
    @ObservationIgnored
    private let defaults: UserDefaults
    @ObservationIgnored
    private let remoteFlagValueProvider: (String) -> Any?
    @ObservationIgnored
    private let remoteFlagLoader: @Sendable () async -> [String: Bool]?
    @ObservationIgnored
    private var refreshTask: Task<Void, Never>?
    @ObservationIgnored
    private var refreshTimer: Timer?

    private var localOverridesByKey: [String: Bool] = [:]
    private var remoteValuesByKey: [String: Bool] = [:]
    private var resolutionsByKey: [String: CmuxFeatureFlagResolution] = [:]

    init(
        defaults: UserDefaults = .standard,
        telemetryEnabled: Bool = TelemetrySettings.enabledForCurrentLaunch,
        remoteFlagValueProvider: @escaping (String) -> Any? = { PostHogSDK.shared.getFeatureFlag($0) },
        remoteFlagLoader: (@Sendable () async -> [String: Bool]?)? = nil,
        publishesOffMainSnapshot: Bool = false
    ) {
        self.defaults = defaults
        self.publishesOffMainSnapshot = publishesOffMainSnapshot
        self.remoteFlagValueProvider = remoteFlagValueProvider
        if let remoteFlagLoader {
            self.remoteFlagLoader = remoteFlagLoader
        } else {
            let target = Self.releaseControlTarget(
                telemetryEnabled: telemetryEnabled,
                defaults: defaults
            )
            self.remoteFlagLoader = {
                await CmuxFeatureFlags.loadPostHogControlPlaneFlags(
                    distinctID: target.distinctID,
                    personProperties: target.personProperties
                )
            }
        }
        localOverridesByKey = Self.allFlags.reduce(into: [:]) { values, definition in
            if let value = Self.storedOverrideValue(for: definition.key, defaults: defaults) {
                values[definition.key] = value
            }
        }
        remoteValuesByKey = Self.allFlags.reduce(into: [:]) { values, definition in
            if let value = Self.storedBoolValue(
                forKey: Self.remoteCacheKey(for: definition.key),
                defaults: defaults
            ) {
                values[definition.key] = value
            }
        }
        recomputeEffectiveValues()
    }

    /// Loads release-control values without initializing analytics. The request
    /// uses a separate anonymous installation identity only when telemetry is
    /// enabled. Opted-out launches use one product-wide ID without targeting
    /// properties, preserving a non-identifying emergency kill switch.
    func start() {
        guard refreshTimer == nil else { return }
        refreshRemoteFlags()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshRemoteFlags() }
        }
    }

    private func refreshRemoteFlags() {
        guard refreshTask == nil else { return }
        let loader = remoteFlagLoader
        refreshTask = Task { @MainActor [weak self] in
            let values = await loader()
            guard let self else { return }
            self.refreshTask = nil
            guard let values, !Task.isCancelled else { return }
            self.applyRemoteFlagValues(values)
        }
    }

    private func applyRemoteFlagValues(_ values: [String: Bool]) {
        let previousResolutions = resolutionsByKey
        for definition in Self.allFlags {
            if let value = values[definition.key] {
                remoteValuesByKey[definition.key] = value
                defaults.set(value, forKey: Self.remoteCacheKey(for: definition.key))
            } else {
                remoteValuesByKey.removeValue(forKey: definition.key)
                defaults.removeObject(forKey: Self.remoteCacheKey(for: definition.key))
            }
        }
        recomputeEffectiveValues()
        postChangeIfNeeded(previousResolutions: previousResolutions)
    }

    static func postHogControlPlaneRequest(
        telemetryEnabled: Bool = TelemetrySettings.enabledForCurrentLaunch,
        defaults: UserDefaults = .standard,
        bundle: Bundle = .main
    ) -> URLRequest? {
        let target = releaseControlTarget(
            telemetryEnabled: telemetryEnabled,
            defaults: defaults,
            bundle: bundle
        )
        return postHogControlPlaneRequest(
            distinctID: target.distinctID,
            personProperties: target.personProperties
        )
    }

    private static func releaseControlTarget(
        telemetryEnabled: Bool,
        defaults: UserDefaults,
        bundle: Bundle = .main
    ) -> (distinctID: String, personProperties: [String: String]) {
        guard telemetryEnabled else {
            return (releaseControlProductWideDistinctID, [:])
        }
        return (
            releaseControlDistinctID(defaults: defaults),
            releaseControlPersonProperties(bundle: bundle)
        )
    }

    private static func releaseControlDistinctID(defaults: UserDefaults) -> String {
        if let existing = defaults.string(forKey: releaseControlDistinctIDKey),
           existing.hasPrefix(releaseControlDistinctIDPrefix),
           UUID(uuidString: String(existing.dropFirst(releaseControlDistinctIDPrefix.count))) != nil {
            return existing
        }
        let distinctID = releaseControlDistinctIDPrefix + UUID().uuidString.lowercased()
        defaults.set(distinctID, forKey: releaseControlDistinctIDKey)
        return distinctID
    }

    private static func releaseControlPersonProperties(
        bundle: Bundle = .main
    ) -> [String: String] {
        var properties = [
            "$os": "macOS",
            "cmux_architecture": releaseControlArchitecture,
        ]
        if let version = bundle.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String, !version.isEmpty {
            properties["$app_version"] = version
        }
        if let build = bundle.object(
            forInfoDictionaryKey: "CFBundleVersion"
        ) as? String, !build.isEmpty {
            properties["$app_build"] = build
        }
        return properties
    }

    private static var releaseControlArchitecture: String {
        #if arch(arm64)
        "arm64"
        #elseif arch(x86_64)
        "x86_64"
        #else
        "unknown"
        #endif
    }

    nonisolated private static func postHogControlPlaneRequest(
        distinctID: String,
        personProperties: [String: String]
    ) -> URLRequest? {
        guard let url = URL(string: "https://cmux.com/api/client-config") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let context: [String: Any] = personProperties.isEmpty
            ? [:]
            : ["personProperties": personProperties]
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "distinctId": distinctID,
            "context": context,
        ])
        return request
    }

    nonisolated private static func loadPostHogControlPlaneFlags(
        distinctID: String,
        personProperties: [String: String]
    ) async -> [String: Bool]? {
        guard let request = postHogControlPlaneRequest(
            distinctID: distinctID,
            personProperties: personProperties
        ) else { return nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 15
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        guard let (bytes, response) = try? await session.bytes(for: request),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              response.expectedContentLength < 0
                || response.expectedContentLength <= maximumPostHogControlPlaneResponseBytes,
              let data = try? await boundedPostHogControlPlaneData(
                  from: bytes,
                  maximumByteCount: maximumPostHogControlPlaneResponseBytes
              )
        else { return nil }
        return postHogControlPlaneFlagValues(from: data)
    }

    nonisolated static func boundedPostHogControlPlaneData<Bytes: AsyncSequence>(
        from bytes: Bytes,
        maximumByteCount: Int
    ) async throws -> Data? where Bytes.Element == UInt8 {
        guard maximumByteCount >= 0 else { return nil }
        var data = Data()
        data.reserveCapacity(min(maximumByteCount, 16 * 1_024))
        for try await byte in bytes {
            guard data.count < maximumByteCount else { return nil }
            data.append(byte)
        }
        return data
    }

    nonisolated static func postHogControlPlaneFlagValues(
        from data: Data
    ) -> [String: Bool]? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["errorsWhileComputingFlags"] as? Bool == false,
              let values = object["featureFlags"] as? [String: Any] else { return nil }
        return values.reduce(into: [String: Bool]()) { result, entry in
            if let value = entry.value as? Bool {
                result[entry.key] = value
            } else if let value = entry.value as? NSNumber {
                result[entry.key] = value.boolValue
            } else if let value = entry.value as? String {
                switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
                case "true", "1", "yes", "on": result[entry.key] = true
                case "false", "0", "no", "off": result[entry.key] = false
                default: break
                }
            }
        }
    }

    func effectiveValue(for definition: CmuxFeatureFlagDefinition) -> Bool {
        resolution(for: definition).effectiveValue
    }

    func resolution(for definition: CmuxFeatureFlagDefinition) -> CmuxFeatureFlagResolution {
        resolutionsByKey[definition.key] ?? CmuxFeatureFlagResolution(
            remoteValue: remoteValuesByKey[definition.key],
            overrideValue: localOverridesByKey[definition.key],
            defaultValue: definition.defaultWhenUnavailable
        )
    }

    func overrideValue(for definition: CmuxFeatureFlagDefinition) -> Bool? {
        localOverridesByKey[definition.key]
    }

    func remoteValue(for definition: CmuxFeatureFlagDefinition) -> Bool? {
        remoteValuesByKey[definition.key]
    }

    func setOverride(_ value: Bool?, for definition: CmuxFeatureFlagDefinition) {
        guard value == nil || remoteValuesByKey[definition.key] == nil else { return }

        let previousResolutions = resolutionsByKey
        if let value {
            localOverridesByKey[definition.key] = value
            defaults.set(value, forKey: Self.overrideDefaultsKey(for: definition.key))
        } else {
            localOverridesByKey.removeValue(forKey: definition.key)
            defaults.removeObject(forKey: Self.overrideDefaultsKey(for: definition.key))
        }
        recomputeEffectiveValues()
        postChangeIfNeeded(previousResolutions: previousResolutions)
    }

    func clearAllOverrides() {
        let previousResolutions = resolutionsByKey
        var clearedAnyOverride = false
        for definition in Self.allFlags {
            if localOverridesByKey.removeValue(forKey: definition.key) != nil {
                clearedAnyOverride = true
            }
            defaults.removeObject(forKey: Self.overrideDefaultsKey(for: definition.key))
        }
        guard clearedAnyOverride else { return }
        recomputeEffectiveValues()
        postChangeIfNeeded(previousResolutions: previousResolutions)
    }

    func applyLoadedFlags() {
        let previousResolutions = resolutionsByKey
        for definition in Self.allFlags {
            if let value = Self.coerceBoolFlagValue(remoteFlagValueProvider(definition.key)) {
                remoteValuesByKey[definition.key] = value
                defaults.set(value, forKey: Self.remoteCacheKey(for: definition.key))
            } else if remoteValuesByKey[definition.key] == true {
                remoteValuesByKey.removeValue(forKey: definition.key)
                defaults.removeObject(forKey: Self.remoteCacheKey(for: definition.key))
            }
        }
        recomputeEffectiveValues()
        postChangeIfNeeded(previousResolutions: previousResolutions)
    }

    private func recomputeEffectiveValues() {
        resolutionsByKey = Self.allFlags.reduce(into: [:]) { values, definition in
            values[definition.key] = CmuxFeatureFlagResolution(
                remoteValue: remoteValuesByKey[definition.key],
                overrideValue: localOverridesByKey[definition.key],
                defaultValue: definition.defaultWhenUnavailable
            )
        }
        if publishesOffMainSnapshot {
            let effectiveValues = resolutionsByKey.mapValues(\.effectiveValue)
            Self.offMainEffectiveValues.withLock { $0 = effectiveValues }
        }
    }

    private func postChangeIfNeeded(previousResolutions: [String: CmuxFeatureFlagResolution]) {
        if previousResolutions != resolutionsByKey {
            NotificationCenter.default.post(name: .cmuxFeatureFlagsDidChange, object: self)
        }
    }

    private static func overrideDefaultsKey(for key: String) -> String {
        overrideKeyPrefix + key
    }

    private static func remoteCacheKey(for key: String) -> String {
        remoteCacheKeyPrefix + key
    }

    private static func storedOverrideValue(for key: String, defaults: UserDefaults) -> Bool? {
        storedBoolValue(forKey: overrideDefaultsKey(for: key), defaults: defaults)
    }

    private static func storedBoolValue(forKey key: String, defaults: UserDefaults) -> Bool? {
        guard let value = defaults.object(forKey: key) else {
            return nil
        }
        if let boolValue = value as? Bool {
            return boolValue
        }
        if let numberValue = value as? NSNumber {
            return numberValue.boolValue
        }
        return nil
    }

    nonisolated static func coerceBoolFlagValue(_ value: Any?, default fallback: Bool) -> Bool {
        coerceBoolFlagValue(value) ?? fallback
    }

    nonisolated static func coerceBoolFlagValue(_ value: Any?) -> Bool? {
        guard let value else { return nil }

        if let boolValue = value as? Bool {
            return boolValue
        }

        if let numberValue = value as? NSNumber {
            return numberValue.boolValue
        }

        if let stringValue = value as? String {
            switch stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "true":
                return true
            case "false":
                return false
            default:
                return nil
            }
        }

        return nil
    }
}

extension Notification.Name {
    static let cmuxFeatureFlagsDidChange = Notification.Name("cmuxFeatureFlagsDidChange")
}
