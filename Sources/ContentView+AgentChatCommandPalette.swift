import AppKit
import CmuxCommandPalette

extension ContentView {
    func commandPaletteConfigActionID(for commandId: String) -> String? {
        switch commandId {
        case "palette.newTerminalTab":
            return CmuxSurfaceTabBarBuiltInAction.newTerminal.configID
        case "palette.newBrowserTab":
            return CmuxSurfaceTabBarBuiltInAction.newBrowser.configID
        case "palette.newSimulatorPane":
            return CmuxSurfaceTabBarBuiltInAction.newSimulator.configID
        case "palette.newAgentChat":
            return CmuxSurfaceTabBarBuiltInAction.newAgentChat.configID
        case "palette.terminalSplitRight":
            return CmuxSurfaceTabBarBuiltInAction.splitRight.configID
        case "palette.terminalSplitDown":
            return CmuxSurfaceTabBarBuiltInAction.splitDown.configID
        default:
            return nil
        }
    }

    static func commandPaletteNewAgentChatContributions(
        bundleIdentifier: String? = Bundle.main.bundleIdentifier
    ) -> [CommandPaletteCommandContribution] {
        guard CmuxFeatureFlags.shared.isAgentChatUIEnabled else { return [] }
        var contributions = [CommandPaletteCommandContribution(
            commandId: "palette.newAgentChat",
            title: { _ in OuroWorkbenchProduct.agentChatActionTitle() },
            subtitle: { _ in OuroWorkbenchProduct.agentChatSubtitle() },
            keywords: ["create", "new", "agent", "chat", "boss", "copilot", "agency"],
            when: { !$0.bool(CommandPaletteContextKeys.browserDisabled) }
        )]
        if OuroWorkbenchProduct.isWorkbenchBundleIdentifier(bundleIdentifier) {
            contributions.append(CommandPaletteCommandContribution(
                commandId: "palette.chooseWorkbenchBoss",
                title: { _ in "Choose Workbench Boss..." },
                subtitle: { _ in "Select the Ouro agent that supervises Workbench" },
                keywords: ["choose", "change", "select", "ouro", "boss"],
                when: { _ in true }
            ))
        }
        return contributions
    }

    func registerAgentChatCommandPaletteHandler(_ registry: inout CommandPaletteHandlerRegistry) {
        registry.register(commandId: "palette.newAgentChat") {
            guard CmuxFeatureFlags.shared.isAgentChatUIEnabled else {
                NSSound.beep()
                return
            }
            guard let appDelegate = AppDelegate.shared else {
                NSSound.beep()
                return
            }
            if !appDelegate.executeConfiguredCmuxAction(
                id: CmuxSurfaceTabBarBuiltInAction.newAgentChat.configID,
                tabManager: tabManager,
                preferredWindow: appDelegate.mainWindow(for: windowId)
            ) {
                NSSound.beep()
            }
        }
        registry.register(commandId: "palette.chooseWorkbenchBoss") {
            guard OuroWorkbenchProduct.isCurrentBundle,
                  let appDelegate = AppDelegate.shared else {
                NSSound.beep()
                return
            }
            appDelegate.chooseWorkbenchBoss(
                tabManager: tabManager,
                preferredWindow: appDelegate.mainWindow(for: windowId)
            )
        }
    }
}
