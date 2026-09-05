import AppKit
import Foundation
import Testing

#if canImport(cmux_DEV)
@testable import cmux_DEV
#elseif canImport(cmux)
@testable import cmux
#endif

@Suite(.serialized)
struct CmuxAgentChatConfigTests {

    @Test func ouroWorkbenchOwnsTheBossEntrypoint() {
        let bundleIdentifier = "com.ourostack.workbench.v1.debug"
        #expect(OuroWorkbenchProduct.isWorkbenchBundleIdentifier(bundleIdentifier))
        #expect(!OuroWorkbenchProduct.isWorkbenchBundleIdentifier("com.manaflow.cmux"))
        #expect(OuroWorkbenchProduct.agentChatUIEnabled(bundleIdentifier: bundleIdentifier, upstreamValue: false))
        #expect(!OuroWorkbenchProduct.agentChatUIEnabled(bundleIdentifier: "com.manaflow.cmux", upstreamValue: false))
        #expect(OuroWorkbenchProduct.agentChatActionTitle(bundleIdentifier: bundleIdentifier) == "Open Boss")
        #expect(OuroWorkbenchProduct.agentChatSurfaceTitle(bundleIdentifier: bundleIdentifier) == "Boss")
        #expect(OuroWorkbenchProduct.agentChatSubtitle(bundleIdentifier: bundleIdentifier) == "Workbench boss")
        #expect(!OuroWorkbenchProduct.shouldStartMainThreadHangWatchdog(bundleIdentifier: bundleIdentifier))
        #expect(OuroWorkbenchProduct.shouldStartMainThreadHangWatchdog(bundleIdentifier: "com.manaflow.cmux"))
        let command = OuroWorkbenchProduct.agentChatStartCommand(
            bundleIdentifier: bundleIdentifier,
            sourceFilePath: #filePath
        )
        #expect(command?.contains("/agent-chat/cmux-chat") == true)
    }

    @Test func ouroWorkbenchPrefersThePackagedAgentChatRuntime() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("workbench-packaged-agent-chat-\(UUID().uuidString)")
        defer { try? fileManager.removeItem(at: root) }
        let bundle = root.appendingPathComponent("Ouro Workbench.app")
        let packaged = bundle.appendingPathComponent("Contents/Resources/agent-chat/cmux-chat")
        try fileManager.createDirectory(
            at: packaged.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        #expect(fileManager.createFile(atPath: packaged.path, contents: Data("#!/bin/sh\n".utf8)))
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: packaged.path)

        let command = OuroWorkbenchProduct.agentChatStartCommand(
            bundleIdentifier: "com.ourostack.workbench.v1",
            bundleURL: bundle,
            sourceFilePath: "/missing/Sources/FeatureFlags.swift",
            fileManager: fileManager
        )

        #expect(command?.contains(packaged.path) == true)
        #expect(command?.contains("/missing/agent-chat") == false)
    }

    @Test func ouroWorkbenchInstallsCopilotHooksBesideAgencyHooks() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("workbench-copilot-hooks-\(UUID().uuidString)")
        defer { try? fileManager.removeItem(at: root) }
        let home = root.appendingPathComponent("home")
        let bundle = root.appendingPathComponent("Ouro Workbench.app")
        let cli = bundle.appendingPathComponent("Contents/Resources/bin/cmux")
        let copilot = home.appendingPathComponent(".copilot-cli/1.0.82/copilot")
        let hooks = home.appendingPathComponent(".copilot/hooks")
        let agencyHook = hooks.appendingPathComponent("agency.json")
        let cmuxHook = hooks.appendingPathComponent("cmux.json")
        try fileManager.createDirectory(at: cli.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: copilot.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: hooks, withIntermediateDirectories: true)
        #expect(fileManager.createFile(atPath: cli.path, contents: Data()))
        #expect(fileManager.createFile(atPath: copilot.path, contents: Data()))
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cli.path)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: copilot.path)
        try "agency-hook".write(to: agencyHook, atomically: true, encoding: .utf8)
        var calls = 0

        let installed = OuroWorkbenchProduct.installCopilotHooksIfNeeded(
            bundleIdentifier: "com.ourostack.workbench.v1",
            homeURL: home,
            bundleURL: bundle,
            environment: ["PATH": "/usr/bin:/bin"],
            fileManager: fileManager
        ) { executable, arguments, environment in
            calls += 1
            #expect(executable == cli)
            #expect(arguments == ["hooks", "setup", "--agent", "copilot", "--yes"])
            #expect(
                environment["PATH"]?.split(separator: ":").first.map {
                    URL(fileURLWithPath: String($0)).resolvingSymlinksInPath().path
                } == copilot.deletingLastPathComponent().resolvingSymlinksInPath().path
            )
            try? #"{"hooks":{"sessionStart":[{"command":"\"$cmux_cli\" hooks copilot session-start"}]}}"#
                .write(to: cmuxHook, atomically: true, encoding: .utf8)
            return true
        }

        #expect(installed)
        #expect(calls == 1)
        #expect(try String(contentsOf: agencyHook, encoding: .utf8) == "agency-hook")
        #expect(OuroWorkbenchProduct.installCopilotHooksIfNeeded(
            bundleIdentifier: "com.ourostack.workbench.v1",
            homeURL: home,
            bundleURL: bundle,
            environment: [:],
            fileManager: fileManager
        ) { _, _, _ in
            calls += 1
            return false
        })
        #expect(calls == 1)

        try fileManager.removeItem(at: cmuxHook)
        try """
        #!/bin/sh
        mkdir -p "$HOME/.copilot/hooks"
        printf '%s\n' '{"command":"cmux hooks copilot session-start"}' > "$HOME/.copilot/hooks/cmux.json"
        """.write(to: cli, atomically: true, encoding: .utf8)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cli.path)
        #expect(OuroWorkbenchProduct.installCopilotHooksIfNeeded(
            bundleIdentifier: "com.ourostack.workbench.v1",
            homeURL: home,
            bundleURL: bundle,
            environment: ["HOME": home.path, "PATH": "/usr/bin:/bin"],
            fileManager: fileManager
        ))
    }

    @Test func ouroWorkbenchBossSelectionPreservesValidLegacyThenFallsBackOnlyWhenUnique() {
        #expect(OuroWorkbenchProduct.resolveBossSelection(
            selectedBossName: "ouroboros",
            legacyBossName: "slugger",
            usableAgentNames: ["ouroboros", "slugger"]
        ) == .selected("ouroboros"))
        #expect(OuroWorkbenchProduct.resolveBossSelection(
            selectedBossName: "missing",
            legacyBossName: "slugger",
            usableAgentNames: ["ouroboros", "slugger"]
        ) == .selected("slugger"))
        #expect(OuroWorkbenchProduct.resolveBossSelection(
            legacyBossName: "missing",
            usableAgentNames: ["ouroboros"]
        ) == .selected("ouroboros"))
        #expect(OuroWorkbenchProduct.resolveBossSelection(
            legacyBossName: nil,
            usableAgentNames: []
        ) == .unavailable("No enabled Ouro agents are installed."))
        #expect(OuroWorkbenchProduct.resolveBossSelection(
            legacyBossName: nil,
            usableAgentNames: ["ouroboros", "slugger"]
        ) == .unavailable("Choose one Ouro agent as Boss: ouroboros, slugger."))
    }

    @Test func ouroWorkbenchBossSelectionRejectsUnsafeOrDisabledNames() {
        #expect(OuroWorkbenchProduct.resolveBossSelection(
            legacyBossName: "../slugger",
            usableAgentNames: ["../slugger"]
        ) == .unavailable("No enabled Ouro agents are installed."))
        #expect(OuroWorkbenchProduct.resolveBossSelection(
            legacyBossName: "disabled",
            usableAgentNames: ["ouroboros"]
        ) == .selected("ouroboros"))
    }

    @Test func ouroWorkbenchPersistsExplicitBossSelectionAndScopesItsSessions() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("workbench-boss-selection-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let appSupport = root.appendingPathComponent("Application Support", isDirectory: true)
        let bundles = home.appendingPathComponent("AgentBundles", isDirectory: true)
        for name in ["ouroboros", "slugger"] {
            let bundle = bundles.appendingPathComponent("\(name).ouro", isDirectory: true)
            try fileManager.createDirectory(at: bundle, withIntermediateDirectories: true)
            try #"{"enabled":true,"humanFacing":{"provider":"github-copilot"},"agentFacing":{"provider":"github-copilot"}}"#.write(
                to: bundle.appendingPathComponent("agent.json"),
                atomically: true,
                encoding: .utf8
            )
        }
        let defaultsName = "CmuxAgentChatConfigTests.bossSelection.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer {
            defaults.removePersistentDomain(forName: defaultsName)
            try? fileManager.removeItem(at: root)
        }

        #expect(OuroWorkbenchProduct.selectBossAgent(
            "slugger",
            homeURL: home,
            defaults: defaults,
            fileManager: fileManager
        ))
        #expect(defaults.string(forKey: OuroWorkbenchProduct.selectedBossDefaultsKey) == "slugger")
        #expect(!OuroWorkbenchProduct.selectBossAgent(
            "missing",
            homeURL: home,
            defaults: defaults,
            fileManager: fileManager
        ))
        let environment = OuroWorkbenchProduct.agentChatEnvironment(
            bundleIdentifier: "com.ourostack.workbench.v1.debug",
            homeURL: home,
            applicationSupportURL: appSupport,
            defaults: defaults,
            environment: [:],
            fileManager: fileManager
        )

        #expect(environment["CMUX_AGENT_CHAT_BOSS_AGENT"] == "slugger")
        #expect(environment["CMUX_AGENT_CHAT_BOSS_ERROR"] == nil)
        #expect(
            environment["CMUX_AGENT_CHAT_SESSION_DIR"]
                == appSupport.appendingPathComponent("Ouro Workbench v1/Agent Chat/Sessions/slugger").path
        )
    }

    @Test func ouroWorkbenchEnvironmentCarriesTheResolvedBossOrExactSetupError() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("workbench-boss-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let appSupport = root.appendingPathComponent("Application Support", isDirectory: true)
        let bundles = home.appendingPathComponent("AgentBundles", isDirectory: true)
        let slugger = bundles.appendingPathComponent("slugger.ouro", isDirectory: true)
        let legacyDirectory = appSupport.appendingPathComponent("OuroWorkbench", isDirectory: true)
        let bundle = root.appendingPathComponent("Ouro Workbench v1 DEV.app", isDirectory: true)
        let workbenchMCP = bundle.appendingPathComponent(
            "Contents/Resources/agent-chat/OuroWorkbenchMCP"
        )
        let bundledCLI = bundle.appendingPathComponent("Contents/Resources/bin/cmux")
        let ouro = home.appendingPathComponent(".ouro-cli/bin/ouro")
        let bun = home.appendingPathComponent(".nvm/versions/node/v20.19.5/bin/bun")
        let node20 = home.appendingPathComponent(".nvm/versions/node/v20.19.5/bin/node")
        let node22 = home.appendingPathComponent(".nvm/versions/node/v22.14.0/bin/node")
        let olderBun = home.appendingPathComponent(".nvm/versions/node/v9.9.9/bin/bun")
        let defaultsName = "CmuxAgentChatConfigTests.environmentBoss.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        try fileManager.createDirectory(at: slugger, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: legacyDirectory, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: workbenchMCP.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: bundledCLI.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: ouro.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: bun.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: node22.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: olderBun.deletingLastPathComponent(), withIntermediateDirectories: true)
        #expect(fileManager.createFile(atPath: workbenchMCP.path, contents: Data("#!/bin/sh\n".utf8)))
        #expect(fileManager.createFile(atPath: bundledCLI.path, contents: Data("#!/bin/sh\n".utf8)))
        #expect(fileManager.createFile(atPath: ouro.path, contents: Data("#!/bin/sh\n".utf8)))
        #expect(fileManager.createFile(atPath: bun.path, contents: Data("#!/bin/sh\n".utf8)))
        #expect(fileManager.createFile(atPath: node20.path, contents: Data("#!/bin/sh\n".utf8)))
        #expect(fileManager.createFile(atPath: node22.path, contents: Data("#!/bin/sh\n".utf8)))
        #expect(fileManager.createFile(atPath: olderBun.path, contents: Data("#!/bin/sh\n".utf8)))
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: workbenchMCP.path)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bundledCLI.path)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: ouro.path)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bun.path)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node20.path)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node22.path)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: olderBun.path)
        try #"{"enabled":true,"humanFacing":{"provider":"github-copilot"},"agentFacing":{"provider":"github-copilot"}}"#.write(
            to: slugger.appendingPathComponent("agent.json"),
            atomically: true,
            encoding: .utf8
        )
        try #"{"boss":{"agentName":"slugger"}}"#.write(
            to: legacyDirectory.appendingPathComponent("workspace-state.json"),
            atomically: true,
            encoding: .utf8
        )
        defer {
            defaults.removePersistentDomain(forName: defaultsName)
            try? fileManager.removeItem(at: root)
        }
        let sourceFilePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/FeatureFlags.swift")
            .path

        let selected = OuroWorkbenchProduct.agentChatEnvironment(
            bundleIdentifier: "com.ourostack.workbench.v1.debug",
            homeURL: home,
            applicationSupportURL: appSupport,
            bundleURL: bundle,
            controlSocketPath: "/tmp/workbench-control.sock",
            controlSocketCapability: "capability-token",
            controlSocketReady: true,
            sourceFilePath: sourceFilePath,
            defaults: defaults,
            environment: ["PATH": "/usr/bin"],
            fileManager: fileManager
        )
        #expect(selected["CMUX_AGENT_CHAT_DEFAULT_PROVIDER"] == "ouro-boss")
        #expect(selected["CMUX_AGENT_CHAT_BOSS_AGENT"] == "slugger")
        #expect(selected["CMUX_AGENT_CHAT_BOSS_ERROR"] == nil)
        #expect(selected["CMUX_AGENT_CHAT_OURO_COMMAND"] == ouro.path)
        #expect(selected["CMUX_AGENT_CHAT_WORKBENCH_MCP"] == workbenchMCP.path)
        #expect(selected["CMUX_AGENT_UI_CWD"] == home.appendingPathComponent("ms-desk").path)
        #expect(selected["CMUX_BUNDLED_CLI_PATH"] == bundledCLI.path)
        #expect(selected["CMUX_SOCKET_PATH"] == "/tmp/workbench-control.sock")
        #expect(selected["CMUX_SOCKET_CAPABILITY"] == "capability-token")
        let selectedPath = try #require(selected["PATH"]?.split(separator: ":"))
        #expect(
            URL(fileURLWithPath: String(selectedPath[0])).resolvingSymlinksInPath().path
                == node22.deletingLastPathComponent().resolvingSymlinksInPath().path
        )
        #expect(selectedPath.dropFirst().map(String.init) == ["/usr/bin"])
        #expect(
            selected["BUN_BIN"].map {
                URL(fileURLWithPath: $0).resolvingSymlinksInPath().path
            } == bun.resolvingSymlinksInPath().path
        )

        let unavailableActions = OuroWorkbenchProduct.agentChatEnvironment(
            bundleIdentifier: "com.ourostack.workbench.v1.debug",
            homeURL: home,
            applicationSupportURL: appSupport,
            bundleURL: bundle,
            controlSocketPath: "/tmp/workbench-control.sock",
            controlSocketCapability: "capability-token",
            controlSocketReady: false,
            sourceFilePath: sourceFilePath,
            defaults: defaults,
            environment: [:],
            fileManager: fileManager
        )
        #expect(unavailableActions["CMUX_AGENT_CHAT_WORKBENCH_MCP"] == nil)
        #expect(unavailableActions["CMUX_SOCKET_CAPABILITY"] == nil)

        try fileManager.removeItem(at: bun)
        try fileManager.removeItem(at: olderBun)
        let missingBun = OuroWorkbenchProduct.agentChatEnvironment(
            bundleIdentifier: "com.ourostack.workbench.v1.debug",
            homeURL: home,
            applicationSupportURL: appSupport,
            bundleURL: bundle,
            controlSocketPath: "/tmp/workbench-control.sock",
            controlSocketCapability: "capability-token",
            controlSocketReady: true,
            sourceFilePath: sourceFilePath,
            defaults: defaults,
            environment: [:],
            fileManager: fileManager
        )
        #expect(missingBun["CMUX_AGENT_CHAT_WORKBENCH_MCP"] == nil)
        #expect(missingBun["CMUX_SOCKET_CAPABILITY"] == nil)

        try fileManager.removeItem(at: legacyDirectory.appendingPathComponent("workspace-state.json"))
        let ouroboros = bundles.appendingPathComponent("ouroboros.ouro", isDirectory: true)
        try fileManager.createDirectory(at: ouroboros, withIntermediateDirectories: true)
        try #"{"enabled":true,"humanFacing":{"provider":"github-copilot"},"agentFacing":{"provider":"github-copilot"}}"#.write(
            to: ouroboros.appendingPathComponent("agent.json"),
            atomically: true,
            encoding: .utf8
        )
        defaults.removeObject(forKey: OuroWorkbenchProduct.selectedBossDefaultsKey)
        let ambiguous = OuroWorkbenchProduct.agentChatEnvironment(
            bundleIdentifier: "com.ourostack.workbench.v1.debug",
            homeURL: home,
            applicationSupportURL: appSupport,
            bundleURL: bundle,
            sourceFilePath: sourceFilePath,
            defaults: defaults,
            fileManager: fileManager
        )
        #expect(ambiguous["CMUX_AGENT_CHAT_BOSS_AGENT"] == nil)
        #expect(ambiguous["CMUX_AGENT_CHAT_BOSS_ERROR"] == "Choose one Ouro agent as Boss: ouroboros, slugger.")
    }

    @Test func ouroWorkbenchDefaultUsesItsSourceOwnedAgentChatHelper() {
        let command = "'/repo/agent-chat/cmux-chat' --no-open"
        let resolved = CmuxAgentChatConfiguration.resolved(
            local: nil,
            global: nil,
            localSourcePath: nil,
            globalSourcePath: nil,
            productDefaultStartCommand: command
        )

        #expect(resolved.startCommand == command)
        #expect(resolved.serverMode == .appOwned)

        let emptyGlobal = CmuxAgentChatConfiguration.resolved(
            local: nil,
            global: CmuxAgentChatConfigDefinition(),
            localSourcePath: nil,
            globalSourcePath: "/Users/me/.config/cmux/cmux.json",
            productDefaultStartCommand: command
        )
        #expect(emptyGlobal.startCommand == command)
        #expect(emptyGlobal.serverMode == .appOwned)

        let productExplicit = CmuxAgentChatConfiguration.resolved(
            local: CmuxAgentChatConfigDefinition(url: "http://127.0.0.1:9000"),
            global: nil,
            localSourcePath: "/repo/cmux.json",
            globalSourcePath: nil,
            productDefaultStartCommand: command,
            productDefaultIsAuthoritative: true
        )
        #expect(productExplicit.startCommand == command)
        #expect(productExplicit.serverMode == .appOwned)

        let stockExplicit = CmuxAgentChatConfiguration.resolved(
            local: CmuxAgentChatConfigDefinition(url: "http://127.0.0.1:9000"),
            global: nil,
            localSourcePath: "/repo/cmux.json",
            globalSourcePath: nil,
            productDefaultStartCommand: command,
            productDefaultIsAuthoritative: false
        )
        #expect(stockExplicit.startCommand == nil)
        #expect(stockExplicit.serverMode == .explicitURL)

        let stockLocalWithoutPath = CmuxAgentChatConfiguration.resolved(
            local: CmuxAgentChatConfigDefinition(startCommand: "cmux-chat"),
            global: nil,
            localSourcePath: nil,
            globalSourcePath: nil,
            productDefaultStartCommand: command,
            productDefaultIsAuthoritative: false
        )
        #expect(stockLocalWithoutPath.source == .defaults)

        let stockGlobalWithoutPath = CmuxAgentChatConfiguration.resolved(
            local: nil,
            global: CmuxAgentChatConfigDefinition(startCommand: "cmux-chat"),
            localSourcePath: nil,
            globalSourcePath: nil,
            productDefaultStartCommand: command,
            productDefaultIsAuthoritative: false
        )
        #expect(stockGlobalWithoutPath.source == .defaults)

        let stockInvalidDirectURL = CmuxAgentChatConfiguration.resolved(
            local: CmuxAgentChatConfigDefinition(url: "http://["),
            global: nil,
            localSourcePath: nil,
            globalSourcePath: nil,
            productDefaultStartCommand: command,
            productDefaultIsAuthoritative: false
        )
        #expect(stockInvalidDirectURL.url == CmuxAgentChatConfiguration.default.url)
    }

    @MainActor
    private func withAgentChatUIFlag<T>(_ enabled: Bool, _ body: () throws -> T) throws -> T {
        let flags = CmuxFeatureFlags.shared
        let definition = try #require(CmuxFeatureFlags.allFlags.first { $0.key == "agent-chat-ui-enabled-release" })
        let previous = flags.overrideValue(for: definition)
        flags.setOverride(enabled, for: definition)
        defer { flags.setOverride(previous, for: definition) }
        return try body()
    }

    @MainActor
    private func withBrowserDisabled(_ body: () throws -> Void) rethrows {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: BrowserAvailabilitySettings.disabledKey) as? Bool
        let hadPrevious = defaults.object(forKey: BrowserAvailabilitySettings.disabledKey) != nil
        BrowserAvailabilitySettings.setDisabled(true)
        defer {
            if hadPrevious, let previous {
                BrowserAvailabilitySettings.setDisabled(previous)
            } else {
                defaults.removeObject(forKey: BrowserAvailabilitySettings.disabledKey)
                NotificationCenter.default.post(name: BrowserAvailabilitySettings.didChangeNotification, object: nil)
            }
        }
        try body()
    }

    private func decode(_ json: String) throws -> CmuxConfigFile {
        let data = json.data(using: .utf8)!
        return try JSONDecoder().decode(CmuxConfigFile.self, from: data)
    }

    @Test func decodeAgentChatConfigTrimsURLAndStartCommand() throws {
        let json = """
        {
          "agentChat": {
            "url": "  http://127.0.0.1:8777/chat  ",
            "startCommand": "  cmux-chat --port 8777  "
          }
        }
        """
        let config = try decode(json)
        #expect(config.agentChat?.url == "http://127.0.0.1:8777/chat")
        #expect(config.agentChat?.startCommand == "cmux-chat --port 8777")
        let resolved = CmuxAgentChatConfiguration.resolved(local: config.agentChat, global: nil)
        #expect(resolved.hasExplicitURL)
        #expect(resolved.healthURL.absoluteString == "http://127.0.0.1:8777/healthz")
    }

    @Test func decodeAgentChatRejectsBlankAndNonHTTPURL() {
        #expect(throws: (any Error).self) {
            try decode("""
        {
          "agentChat": {
            "url": "   "
          }
        }
        """)
        }
        #expect(throws: (any Error).self) {
            try decode("""
        {
          "agentChat": {
            "url": "file:///tmp/chat"
          }
        }
        """)
        }
        #expect(throws: (any Error).self) {
            try decode("""
        {
          "agentChat": {
            "startCommand": "   "
          }
        }
        """)
        }
    }

    @Test func resolveLocalURLOnlyDoesNotInheritGlobalStartCommand() {
        let localPath = "/repo/cmux.json"
        let globalPath = "/Users/me/.config/cmux/cmux.json"
        let resolved = CmuxAgentChatConfiguration.resolved(
            local: CmuxAgentChatConfigDefinition(url: "http://127.0.0.1:9010"),
            global: CmuxAgentChatConfigDefinition(
                url: "http://127.0.0.1:9000",
                startCommand: "cmux-chat --port 9000"
            ),
            localSourcePath: localPath,
            globalSourcePath: globalPath
        )

        #expect(resolved.url.absoluteString == "http://127.0.0.1:9010")
        #expect(resolved.startCommand == nil)
        #expect(resolved.source == .local(path: localPath))
        #expect(resolved.source.sourcePath == localPath)
        #expect(resolved.hasExplicitURL)
        #expect(resolved.serverMode == .explicitURL)
        #expect(!resolved.startCommandRequiresTrust)
    }

    @Test func resolveLocalSidecarOnlyFieldsUseGlobalServerConfig() throws {
        let localPath = "/repo/cmux.json"
        let globalPath = "/Users/me/.config/cmux/cmux.json"
        let localConfig = try decode("""
        {
          "agentChat": {
            "fontSize": 14,
            "keymap": "vim"
          }
        }
        """)
        let resolved = CmuxAgentChatConfiguration.resolved(
            local: localConfig.agentChat,
            global: CmuxAgentChatConfigDefinition(
                url: "http://127.0.0.1:9000",
                startCommand: "cmux-chat --port 9000"
            ),
            localSourcePath: localPath,
            globalSourcePath: globalPath
        )

        #expect(resolved.url.absoluteString == "http://127.0.0.1:9000")
        #expect(resolved.startCommand == "cmux-chat --port 9000")
        #expect(resolved.source == .global(path: globalPath))
        #expect(resolved.hasExplicitURL)
        #expect(resolved.serverMode == .explicitURL)
        #expect(!resolved.startCommandRequiresTrust)
    }

    @Test func resolveLocalStartCommandOnlyUsesDefaultURL() {
        let localPath = "/repo/cmux.json"
        let resolved = CmuxAgentChatConfiguration.resolved(
            local: CmuxAgentChatConfigDefinition(startCommand: "cmux-chat --port 9010"),
            global: CmuxAgentChatConfigDefinition(
                url: "http://127.0.0.1:9000",
                startCommand: "cmux-chat --port 9000"
            ),
            localSourcePath: localPath,
            globalSourcePath: "/Users/me/.config/cmux/cmux.json"
        )

        #expect(resolved.url.absoluteString == CmuxAgentChatConfiguration.defaultURLString)
        #expect(resolved.startCommand == "cmux-chat --port 9010")
        #expect(resolved.source == .local(path: localPath))
        #expect(!resolved.hasExplicitURL)
        #expect(resolved.serverMode == .appOwned)
        #expect(resolved.startCommandRequiresTrust)
    }

    @Test func resolveNoLocalUsesGlobalBlock() {
        let globalPath = "/Users/me/.config/cmux/cmux.json"
        let resolved = CmuxAgentChatConfiguration.resolved(
            local: nil,
            global: CmuxAgentChatConfigDefinition(
                url: "http://127.0.0.1:9000",
                startCommand: "cmux-chat --port 9000"
            ),
            localSourcePath: nil,
            globalSourcePath: globalPath
        )

        #expect(resolved.url.absoluteString == "http://127.0.0.1:9000")
        #expect(resolved.startCommand == "cmux-chat --port 9000")
        #expect(resolved.source == .global(path: globalPath))
        #expect(resolved.hasExplicitURL)
        #expect(resolved.serverMode == .explicitURL)
        #expect(!resolved.startCommandRequiresTrust)
    }

    @Test func resolveNeitherUsesDefaultBlock() {
        let resolved = CmuxAgentChatConfiguration.resolved(local: nil, global: nil)

        #expect(resolved.url.absoluteString == CmuxAgentChatConfiguration.defaultURLString)
        #expect(resolved.startCommand == nil)
        #expect(resolved.source == .defaults)
        #expect(resolved.source.sourcePath == nil)
        #expect(!resolved.hasExplicitURL)
        #expect(resolved.serverMode == .legacyDefaultURL)
        #expect(!resolved.startCommandRequiresTrust)
    }

    @Test func agentChatServerModeSelectsTheThreeURLStrategies() {
        let explicit = CmuxAgentChatConfiguration.resolved(
            local: CmuxAgentChatConfigDefinition(url: "http://127.0.0.1:9000/chat"),
            global: nil
        )
        let owned = CmuxAgentChatConfiguration.resolved(
            local: CmuxAgentChatConfigDefinition(startCommand: "cmux-chat"),
            global: nil
        )
        let legacy = CmuxAgentChatConfiguration.resolved(local: nil, global: nil)

        #expect(explicit.serverMode == .explicitURL)
        #expect(explicit.url.absoluteString == "http://127.0.0.1:9000/chat")
        #expect(owned.serverMode == .appOwned)
        #expect(owned.url.absoluteString == CmuxAgentChatConfiguration.defaultURLString)
        #expect(legacy.serverMode == .legacyDefaultURL)
        #expect(legacy.url.absoluteString == CmuxAgentChatConfiguration.defaultURLString)
    }

    @Test func agentChatStateFileParsesValidPortAndPID() throws {
        let data = try #require("""
        {"port":43123,"pid":9876,"launchId":"launch-1"}
        """.data(using: .utf8))

        let session = try #require(try AgentChatSidecarStateFile.parse(
            data,
            token: "token_123",
            launchId: "launch-1"
        ))

        #expect(session.port == 43123)
        #expect(session.pid == 9876)
        #expect(session.token == "token_123")
        #expect(session.healthURL.absoluteString == "http://127.0.0.1:43123/healthz")
    }

    @Test func agentChatStateFileRejectsInvalidPortOrPID() throws {
        let badPort = try #require("""
        {"port":0,"pid":9876,"launchId":"launch-1"}
        """.data(using: .utf8))
        let badPID = try #require("""
        {"port":43123,"pid":0,"launchId":"launch-1"}
        """.data(using: .utf8))

        #expect(try AgentChatSidecarStateFile.parse(badPort, token: "token", launchId: "launch-1") == nil)
        #expect(try AgentChatSidecarStateFile.parse(badPID, token: "token", launchId: "launch-1") == nil)
    }

    @Test func agentChatStateFileRequiresMatchingLaunchID() throws {
        let missing = try #require("""
        {"port":43123,"pid":9876}
        """.data(using: .utf8))
        let mismatched = try #require("""
        {"port":43123,"pid":9876,"launchId":"old-launch"}
        """.data(using: .utf8))

        #expect(try AgentChatSidecarStateFile.parse(missing, token: "token", launchId: "new-launch") == nil)
        #expect(try AgentChatSidecarStateFile.parse(mismatched, token: "token", launchId: "new-launch") == nil)
    }

    @Test func agentChatOwnedServerBuildsTokenedURLs() {
        let session = AgentChatOwnedServerSession(port: 43123, pid: 9876, token: "abc-DEF_123")

        #expect(session.browserURL.absoluteString == "http://127.0.0.1:43123/abc-DEF_123/")
        #expect(session.themeURL.absoluteString == "http://127.0.0.1:43123/abc-DEF_123/api/theme")
        #expect(AgentChatOwnedServerSession.browserURL(port: 43123, token: "abc").absoluteString == "http://127.0.0.1:43123/abc/")
    }

    @Test func agentChatStateFileStoreBuildsPerLaunchPaths() {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "cmux-agent-chat-state-\(UUID().uuidString)",
            isDirectory: true
        )
        let store = AgentChatSidecarStateFileStore(
            directoryURL: root,
            fileSystem: AgentChatSidecarFileSystem()
        )

        #expect(store.stateFileURL(launchId: "launch-a").lastPathComponent == "state-launch-a.json")
        #expect(store.stateFileURL(launchId: "launch-b").lastPathComponent == "state-launch-b.json")
    }

    @Test func agentChatStateFileWaitPropagatesCancellation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "cmux-agent-chat-cancel-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AgentChatSidecarStateFileStore(
            directoryURL: root,
            fileSystem: AgentChatSidecarFileSystem()
        )
        let waiting = Task {
            await store.waitForSession(
                token: "token",
                launchId: "launch",
                launchDate: Date()
            )
        }
        try await Task.sleep(for: .milliseconds(50))
        waiting.cancel()
        let clock = ContinuousClock()
        let started = clock.now
        #expect(await waiting.value == nil)
        #expect(started.duration(to: clock.now) < .seconds(1))
    }

    @Test func agentChatPendingServerProcessIsTerminatedAndCleared() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        try process.run()
        #expect(AgentChatActionInFlightGate.registerPendingServerProcess(process))
        #expect(AgentChatActionInFlightGate.hasOwnedServerWork())

        await AgentChatActionInFlightGate.stopPendingServerProcess(matching: process)

        #expect(!process.isRunning)
        #expect(!AgentChatActionInFlightGate.hasOwnedServerWork())
    }

    @Test func agentChatStateFileStoreSweepsPatternedStaleFiles() async throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "cmux-agent-chat-state-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        let stale = root.appendingPathComponent("state-old.json")
        let unrelated = root.appendingPathComponent("other.json")
        try Data("old".utf8).write(to: stale)
        try Data("keep".utf8).write(to: unrelated)
        let oldDate = Date(timeIntervalSinceNow: -120)
        try fileManager.setAttributes([.modificationDate: oldDate], ofItemAtPath: stale.path)
        try fileManager.setAttributes([.modificationDate: oldDate], ofItemAtPath: unrelated.path)
        let store = AgentChatSidecarStateFileStore(
            directoryURL: root,
            fileSystem: AgentChatSidecarFileSystem(fileManager: fileManager)
        )

        let prepared = try #require(await store.prepareStateFileURL(
            launchId: "new",
            launchDate: Date()
        ))

        #expect(prepared.lastPathComponent == "state-new.json")
        #expect(fileManager.fileExists(atPath: prepared.path))
        #expect(!fileManager.fileExists(atPath: stale.path))
        #expect(fileManager.fileExists(atPath: unrelated.path))
    }

    @Test func newAgentChatInFlightGateRejectsDuplicatesUntilCleared() {
        let firstBegin = AgentChatActionInFlightGate.begin()
        #expect(firstBegin)
        guard firstBegin else { return }

        #expect(!AgentChatActionInFlightGate.begin())
        AgentChatActionInFlightGate.end()

        let secondBegin = AgentChatActionInFlightGate.begin()
        #expect(secondBegin)
        if secondBegin {
            AgentChatActionInFlightGate.end()
        }
    }

    @Test func agentChatThemePayloadUsesResolvedGhosttyConfigFields() throws {
        var config = GhosttyConfig()
        config.backgroundColor = try #require(NSColor(hex: "#102030"))
        config.foregroundColor = try #require(NSColor(hex: "#D0E0F0"))
        config.cursorColor = try #require(NSColor(hex: "#AA5500"))
        config.selectionBackground = try #require(NSColor(hex: "#334455"))
        config.fontFamily = " JetBrains Mono "
        config.fontSize = 13.5
        config.backgroundOpacity = 0.72
        config.backgroundBlur = .radius(18)
        let palette = [
            "#000001", "#000002", "#000003", "#000004",
            "#000005", "#000006", "#000007", "#000008",
            "#000009", "#00000A", "#00000B", "#00000C",
            "#00000D", "#00000E", "#00000F", "#000010",
        ]
        config.palette = Dictionary(uniqueKeysWithValues: try palette.enumerated().map { index, hex in
            (index, try #require(NSColor(hex: hex)))
        })

        let payload = AgentChatThemePayload(config: config)

        #expect(payload.background == "#102030")
        #expect(payload.foreground == "#D0E0F0")
        #expect(payload.palette == palette)
        #expect(payload.selectionBackground == "#334455")
        #expect(payload.cursorColor == "#AA5500")
        #expect(payload.fontFamily == "JetBrains Mono")
        #expect(payload.fontSize == 13.5)
        #expect(payload.opacity == 0.72)
        #expect(payload.blur == 18)
        #expect(payload.isLight == false)
        #expect(payload.source == "cmux")
    }

    @Test func agentChatThemeEndpointIsRootAnchoredLikeHealthURL() throws {
        let url = try #require(URL(string: "http://127.0.0.1:7739/chat?ignored=1"))
        #expect(AgentChatThemeSync.themeURL(for: url).absoluteString == "http://127.0.0.1:7739/api/theme")
    }

    @MainActor
    @Test func agentChatThemeURLUsesTokenedOwnedServerWhenAvailable() {
        let session = AgentChatOwnedServerSession(port: 43123, pid: 9876, token: "theme-token")
        AgentChatActionInFlightGate.updateOwnedServerSession(session)
        defer { AgentChatActionInFlightGate.clearOwnedServerSession() }
        let agentChat = CmuxAgentChatConfiguration.resolved(
            local: CmuxAgentChatConfigDefinition(startCommand: "cmux-chat"),
            global: nil
        )

        #expect(AgentChatThemeSync.themeURL(for: agentChat).absoluteString == "http://127.0.0.1:43123/theme-token/api/theme")
        #expect(session.shutdownURL.absoluteString == "http://127.0.0.1:43123/theme-token/api/shutdown")
    }

    @MainActor
    @Test func explicitAgentChatThemeURLIgnoresOwnedServer() {
        let session = AgentChatOwnedServerSession(port: 43123, pid: 9876, token: "theme-token")
        AgentChatActionInFlightGate.updateOwnedServerSession(session)
        defer { AgentChatActionInFlightGate.clearOwnedServerSession() }
        let agentChat = CmuxAgentChatConfiguration.resolved(
            local: CmuxAgentChatConfigDefinition(
                url: "http://127.0.0.1:9000/chat",
                startCommand: "cmux-chat"
            ),
            global: nil
        )

        #expect(AgentChatThemeSync.themeURL(for: agentChat).absoluteString == "http://127.0.0.1:9000/api/theme")
    }

    @MainActor
    @Test func agentChatThemeConnectionFailureClearsMatchingOwnedSession() async {
        let session = AgentChatOwnedServerSession(port: 43123, pid: 9876, token: "theme-token")
        AgentChatActionInFlightGate.updateOwnedServerSession(session)
        defer { AgentChatActionInFlightGate.clearOwnedServerSession() }

        await AgentChatThemeSync.handleThemePostFailure(
            URLError(.cannotConnectToHost),
            url: session.themeURL
        )

        #expect(AgentChatActionInFlightGate.ownedServerSession() == nil)
    }

    @MainActor
    @Test func agentChatThemeNonConnectionFailureKeepsOwnedSession() async {
        let session = AgentChatOwnedServerSession(port: 43123, pid: 9876, token: "theme-token")
        AgentChatActionInFlightGate.updateOwnedServerSession(session)
        defer { AgentChatActionInFlightGate.clearOwnedServerSession() }

        await AgentChatThemeSync.handleThemePostFailure(
            URLError(.badURL),
            url: session.themeURL
        )

        #expect(AgentChatActionInFlightGate.ownedServerSession() == session)
    }

    @Test func agentChatThemePayloadEncodesNullNullableFields() throws {
        var config = GhosttyConfig()
        config.fontFamily = " "
        config.fontSize = 0

        let data = try JSONEncoder().encode(AgentChatThemePayload(config: config))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])

        #expect(object["fontFamily"] is NSNull)
        #expect(object["fontSize"] is NSNull)
        #expect(object.keys.contains("selectionBackground"))
        #expect(object.keys.contains("cursorColor"))
    }

    @MainActor
    @Test func agentChatUIFeatureFlagDefaultsOff() throws {
        let defaultsName = "cmux-agent-chat-flag-defaults-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        let flags = CmuxFeatureFlags(defaults: defaults, remoteFlagValueProvider: { _ in nil })

        #expect(!flags.isAgentChatUIEnabled)
    }

    @MainActor
    @Test func commandPaletteNewAgentChatContributionFollowsFeatureFlag() throws {
        try withAgentChatUIFlag(false) {
            #expect(ContentView.commandPaletteNewAgentChatContributions(
                bundleIdentifier: "com.cmuxterm.app"
            ).isEmpty)
        }

        try withAgentChatUIFlag(true) {
            #expect(ContentView.commandPaletteNewAgentChatContributions(
                bundleIdentifier: "com.cmuxterm.app"
            ).map(\.commandId) == ["palette.newAgentChat"])
            #expect(ContentView.commandPaletteNewAgentChatContributions(
                bundleIdentifier: "com.ourostack.workbench.v1.debug"
            ).map(\.commandId) == [
                "palette.newAgentChat",
                "palette.chooseWorkbenchBoss",
            ])
        }
    }

    @MainActor
    @Test func agentChatThemeSyncGateFollowsFeatureFlag() throws {
        try withAgentChatUIFlag(false) {
            #expect(!AgentChatThemeSync.isEnabled)
        }

        try withAgentChatUIFlag(true) {
            #expect(AgentChatThemeSync.isEnabled)
        }
    }

    @MainActor
    @Test func performNewAgentChatActionRejectsWhenFeatureFlagOff() throws {
        try withAgentChatUIFlag(false) {
            let didStart = AppDelegate().performNewAgentChatAction(
                tabManager: TabManager(),
                agentChat: .default,
                globalConfigPath: nil,
                preferredWindow: nil
            )

            #expect(!didStart)
        }
    }

    @MainActor
    @Test func performNewAgentChatActionRejectsWhenBrowserSurfacesAreDisabled() throws {
        try withAgentChatUIFlag(true) {
            try withBrowserDisabled {
                let didStart = AppDelegate().performNewAgentChatAction(
                    tabManager: TabManager(),
                    agentChat: .default,
                    globalConfigPath: nil,
                    preferredWindow: nil
                )

                #expect(!didStart)
            }
        }
    }

    @MainActor
    @Test func workbenchBossWaitsForPendingSessionRestoreBeforeReplacingPersistedPanel() throws {
        let defaults = UserDefaults.standard
        let persistedKey = AgentChatActionInFlightGate.bossStableSurfaceDefaultsKey
        let previousPersistedPanel = defaults.object(forKey: persistedKey)
        let previousDock = defaults.object(forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
        let previousAppDelegate = AppDelegate.shared
        defaults.set(true, forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
        let app = AppDelegate()
        AppDelegate.shared = app
        let manager = TabManager()
        let sidebar = FileExplorerState()
        let windowID = app.registerMainWindowContextForTesting(
            tabManager: manager,
            fileExplorerState: sidebar
        )
        defer {
            app.didAttemptStartupSessionRestore = true
            app.isApplyingSessionRestore = false
            app.clearWorkbenchBossPaneForTesting()
            app.unregisterMainWindowContextForTesting(windowId: windowID)
            AppDelegate.shared = previousAppDelegate
            if let previousPersistedPanel {
                defaults.set(previousPersistedPanel, forKey: persistedKey)
            } else {
                defaults.removeObject(forKey: persistedKey)
            }
            if let previousDock {
                defaults.set(previousDock, forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
            } else {
                defaults.removeObject(forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
            }
        }
        app.clearWorkbenchBossPaneForTesting()
        let persistedStableSurfaceID = UUID()
        AgentChatActionInFlightGate.persistBossStableSurfaceID(
            persistedStableSurfaceID,
            defaults: defaults
        )
        app.didAttemptStartupSessionRestore = false
        app.isApplyingSessionRestore = true

        let panelID = app.openWorkbenchBossPanelForTesting(
            tabManager: manager,
            url: try #require(URL(string: "http://127.0.0.1:7739/token/"))
        )

        #expect(panelID == nil)
        #expect(
            AgentChatActionInFlightGate.persistedBossStableSurfaceID(defaults: defaults)
                == persistedStableSurfaceID
        )
        #expect(app.existingWindowDock(forWindowId: windowID) == nil)
    }

    @MainActor
    @Test func workbenchBossRebindsPersistedDockPanelAfterRestart() throws {
        let defaults = UserDefaults.standard
        let persistedKey = AgentChatActionInFlightGate.bossStableSurfaceDefaultsKey
        let previousPersistedPanel = defaults.object(forKey: persistedKey)
        let previousDock = defaults.object(forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
        let previousAppDelegate = AppDelegate.shared
        defaults.set(true, forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
        let app = AppDelegate()
        AppDelegate.shared = app
        let manager = TabManager()
        let sidebar = FileExplorerState()
        let windowID = app.registerMainWindowContextForTesting(
            tabManager: manager,
            fileExplorerState: sidebar
        )
        defer {
            app.clearWorkbenchBossPaneForTesting()
            app.unregisterMainWindowContextForTesting(windowId: windowID)
            AppDelegate.shared = previousAppDelegate
            if let previousPersistedPanel {
                defaults.set(previousPersistedPanel, forKey: persistedKey)
            } else {
                defaults.removeObject(forKey: persistedKey)
            }
            if let previousDock {
                defaults.set(previousDock, forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
            } else {
                defaults.removeObject(forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
            }
        }
        app.clearWorkbenchBossPaneForTesting()
        let dock = app.windowDock(forWindowId: windowID)
        let pane = try #require(dock.resolvePane(requestedPaneID: nil))
        let restoredURL = try #require(URL(string: "http://127.0.0.1:7739/old-token/"))
        let restoredPanelID = try #require(dock.newSurface(
            kind: .browser,
            inPane: pane,
            url: restoredURL,
            focus: false
        ))
        let restoredStableSurfaceID = try #require(
            dock.browserPanel(for: restoredPanelID)?.stableSurfaceId
        )
        AgentChatActionInFlightGate.persistBossStableSurfaceID(
            restoredStableSurfaceID,
            defaults: defaults
        )
        let panelCountBeforeRebind = dock.panels.count
        let currentURL = try #require(URL(string: "http://127.0.0.1:7740/new-token/"))

        let reboundPanelID = try #require(app.openWorkbenchBossPanelForTesting(
            tabManager: manager,
            url: currentURL
        ))

        #expect(reboundPanelID == restoredPanelID)
        #expect(dock.panels.count == panelCountBeforeRebind)
        #expect(dock.browserPanel(for: restoredPanelID)?.currentURL == currentURL)
        #expect(sidebar.isVisible)
        #expect(sidebar.mode == .dock)
    }

    @Test func workbenchBossPersistenceRejectsMalformedPanelID() throws {
        let defaultsName = "CmuxAgentChatConfigTests.bossPanel.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        defaults.set("not-a-uuid", forKey: AgentChatActionInFlightGate.bossStableSurfaceDefaultsKey)

        #expect(AgentChatActionInFlightGate.persistedBossStableSurfaceID(defaults: defaults) == nil)
        #expect(defaults.object(forKey: AgentChatActionInFlightGate.bossStableSurfaceDefaultsKey) == nil)
    }

    @MainActor
    @Test func workbenchBossUsesOneWindowDockPanelAndRehomesIt() throws {
        let defaults = UserDefaults.standard
        let previousDock = defaults.object(forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
        let previousAppDelegate = AppDelegate.shared
        defaults.set(true, forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
        let app = AppDelegate()
        AppDelegate.shared = app
        let firstManager = TabManager()
        let secondManager = TabManager()
        let firstSidebar = FileExplorerState()
        let secondSidebar = FileExplorerState()
        let firstWindowID = app.registerMainWindowContextForTesting(
            tabManager: firstManager,
            fileExplorerState: firstSidebar
        )
        let secondWindowID = app.registerMainWindowContextForTesting(
            tabManager: secondManager,
            fileExplorerState: secondSidebar
        )
        defer {
            app.clearWorkbenchBossPaneForTesting()
            app.unregisterMainWindowContextForTesting(windowId: firstWindowID)
            app.unregisterMainWindowContextForTesting(windowId: secondWindowID)
            AppDelegate.shared = previousAppDelegate
            if let previousDock {
                defaults.set(previousDock, forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
            } else {
                defaults.removeObject(forKey: RightSidebarBetaFeatureSettings.dockEnabledKey)
            }
        }
        let firstWorkspaceCount = firstManager.tabs.count
        let secondWorkspaceCount = secondManager.tabs.count
        let firstURL = try #require(URL(string: "http://127.0.0.1:7739/token/"))
        let secondURL = try #require(URL(string: "http://127.0.0.1:7740/token/"))

        let panelID = try #require(app.openWorkbenchBossPanelForTesting(
            tabManager: firstManager,
            url: firstURL
        ))
        #expect(firstManager.tabs.count == firstWorkspaceCount)
        #expect(firstSidebar.isVisible)
        #expect(firstSidebar.mode == .dock)
        #expect(app.windowDock(forWindowId: firstWindowID).containsPanel(panelID))

        let reusedID = try #require(app.openWorkbenchBossPanelForTesting(
            tabManager: secondManager,
            url: secondURL
        ))
        #expect(reusedID == panelID)
        #expect(secondManager.tabs.count == secondWorkspaceCount)
        #expect(app.existingWindowDock(forWindowId: secondWindowID) == nil)

        #expect(app.rehomeWorkbenchBossPanelForTesting(closingWindowId: firstWindowID))
        #expect(!app.windowDock(forWindowId: firstWindowID).containsPanel(panelID))
        #expect(app.windowDock(forWindowId: secondWindowID).containsPanel(panelID))
        #expect(secondSidebar.isVisible)
        #expect(secondSidebar.mode == .dock)
    }
}
