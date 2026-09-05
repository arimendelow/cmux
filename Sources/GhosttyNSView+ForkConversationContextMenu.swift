import AppKit

extension GhosttyNSView {
    func appendCurrentSurfaceContextMenuItems(to menu: NSMenu) {
        if appendTakeControlOfHubSessionMenuItem(to: menu) {
            menu.addItem(.separator())
        }
        if appendForkCurrentAgentConversationMenuItems(to: menu) {
            menu.addItem(.separator())
        }
        appendMoveCurrentSurfaceMoveMenuItems(to: menu)
        menu.addItem(.separator())
    }

    @discardableResult
    private func appendTakeControlOfHubSessionMenuItem(to menu: NSMenu) -> Bool {
        guard let panelId = terminalSurface?.id,
              let appDelegate = AppDelegate.shared else {
            return false
        }
        let workspace = appDelegate.workspaceContainingPanel(panelId: panelId)?.workspace
        let dock = workspace == nil
            ? DockSplitStore.liveStores.first(where: { $0.containsPanel(panelId) })
            : nil
        guard workspace?.canTakeControlOfHubSession(panelId: panelId)
            ?? dock?.canTakeControlOfHubSession(panelId: panelId)
            ?? false else { return false }
        let item = menu.addItem(
            withTitle: String(
                localized: "terminalContextMenu.takeControlOfHubSession",
                defaultValue: "Take Control Here"
            ),
            action: #selector(takeControlOfHubSession(_:)),
            keyEquivalent: ""
        )
        item.target = self
        item.image = NSImage(systemSymbolName: "hand.raised.fill", accessibilityDescription: nil)
        return true
    }

    @objc private func takeControlOfHubSession(_ sender: Any?) {
        guard let panelId = terminalSurface?.id,
              let appDelegate = AppDelegate.shared else {
            NSSound.beep()
            return
        }
        let workspace = appDelegate.workspaceContainingPanel(panelId: panelId)?.workspace
        let dock = workspace == nil
            ? DockSplitStore.liveStores.first(where: { $0.containsPanel(panelId) })
            : nil
        let send = { (terminal: TerminalPanel, input: String) in terminal.sendText(input) }
        let didTakeControl = workspace?.takeControlOfHubSession(panelId: panelId, send: send)
            ?? dock?.takeControlOfHubSession(panelId: panelId, send: send)
            ?? false
        guard didTakeControl else { NSSound.beep(); return }
    }

    @discardableResult
    func appendForkCurrentAgentConversationMenuItems(to menu: NSMenu) -> Bool {
        let availability = currentAgentConversationForkAvailability()
        guard availability.isAvailable || availability == .agentIndexRefreshing else { return false }

        if availability == .agentIndexRefreshing {
            let item = menu.addItem(
                withTitle: String(localized: "terminalContextMenu.forkConversation", defaultValue: "Fork Conversation"),
                action: nil,
                keyEquivalent: ""
            )
            item.isEnabled = false
            item.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: nil)
            return true
        }

        let defaultDestination = AgentConversationForkDefaultSettings.current()
        let primaryItem = menu.addItem(
            withTitle: String(localized: "terminalContextMenu.forkConversation", defaultValue: "Fork Conversation"),
            action: #selector(forkCurrentAgentConversation(_:)),
            keyEquivalent: ""
        )
        primaryItem.target = self
        primaryItem.representedObject = defaultDestination.rawValue
        primaryItem.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: nil)

        let submenuItem = NSMenuItem(
            title: String(localized: "terminalContextMenu.forkConversationTo", defaultValue: "Fork Conversation To"),
            action: nil,
            keyEquivalent: ""
        )
        submenuItem.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: nil)
        let submenu = NSMenu()
        for destination in AgentConversationForkDestination.allCases {
            let item = NSMenuItem(
                title: destination.settingsTitle,
                action: #selector(forkCurrentAgentConversation(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = destination.rawValue
            item.state = destination == defaultDestination ? .on : .off
            submenu.addItem(item)
        }
        submenuItem.submenu = submenu
        menu.addItem(submenuItem)

        return true
    }

    private func currentAgentConversationForkAvailability() -> WorkspaceForkAgentConversationAvailability {
        guard let panelId = terminalSurface?.id else {
#if DEBUG
            cmuxDebugLog("fork.contextMenu.hidden reason=missing_terminal_surface")
#endif
            return .noAgentSnapshot
        }
        guard let located = AppDelegate.shared?.workspaceContainingPanel(panelId: panelId) else {
#if DEBUG
            cmuxDebugLog(
                "fork.contextMenu.hidden panel=\(panelId.uuidString.prefix(5)) " +
                "reason=missing_workspace"
            )
#endif
            return .noAgentSnapshot
        }
        let availability = located.workspace.forkAgentConversationContextMenuPresentationAvailability(
            forPanelId: panelId
        )
#if DEBUG
        if !availability.isAvailable {
            cmuxDebugLog(
                "fork.contextMenu.hidden workspace=\(located.workspace.id.uuidString.prefix(5)) " +
                "panel=\(panelId.uuidString.prefix(5)) reason=\(availability.diagnosticReason)"
            )
        }
#endif
        return availability
    }

    @objc func forkCurrentAgentConversation(_ sender: Any?) {
        guard let panelId = terminalSurface?.id,
              let located = AppDelegate.shared?.workspaceContainingPanel(panelId: panelId) else {
            NSSound.beep()
            return
        }
        let workspace = located.workspace

        let destination: AgentConversationForkDestination
        if let item = sender as? NSMenuItem,
           let rawDestination = item.representedObject as? String,
           let representedDestination = AgentConversationForkDestination(rawValue: rawDestination) {
            destination = representedDestination
        } else {
            destination = AgentConversationForkDefaultSettings.current()
        }

        Task { @MainActor in
            guard await workspace.forkAgentConversationFromContextMenu(
                fromPanelId: panelId,
                destination: destination
            ) else {
                NSSound.beep()
                return
            }
        }
    }
}
