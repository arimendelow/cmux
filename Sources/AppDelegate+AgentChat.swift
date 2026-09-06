import AppKit
import CMUXAgentLaunch
import CmuxSettings
import Darwin
import Foundation
import os
import Security

struct AgentChatActionInFlightGate {
    static let bossStableSurfaceDefaultsKey = "ouroWorkbench.bossStableSurfaceID"
    private static let legacyBossPanelDefaultsKey = "ouroWorkbench.bossPanelID"

    private struct State {
        var isRunning = false
        var ownedServerSession: AgentChatOwnedServerSession?
        var pendingServerProcess: Process?
        var sidecarStateFileStore = AgentChatSidecarStateFileStore.live()
        var bossPanelOwnerWindowId: UUID?
        var bossPanelId: UUID?
    }

    private nonisolated static let lock = OSAllocatedUnfairLock(initialState: State())

    static func begin() -> Bool {
        lock.withLock { state in
            guard !state.isRunning else { return false }
            state.isRunning = true
            return true
        }
    }

    static func end() {
        lock.withLock { state in
            state.isRunning = false
        }
    }

    static func beginWhenAvailable() async throws {
        while true {
            try Task.checkCancellation()
            if begin() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    @MainActor
    static func runReservedAction(
        _ action: @MainActor () async -> Bool
    ) async -> Bool? {
        guard begin() else { return nil }
        defer { end() }
        return await action()
    }

    static func ownedServerSession() -> AgentChatOwnedServerSession? {
        lock.withLock { state in
            state.ownedServerSession
        }
    }

    static func updateOwnedServerSession(_ session: AgentChatOwnedServerSession) {
        lock.withLock { state in
            state.ownedServerSession = session
        }
    }

    static func clearOwnedServerSession(matching candidate: AgentChatOwnedServerSession? = nil) {
        lock.withLock { state in
            if let candidate, state.ownedServerSession != candidate { return }
            state.ownedServerSession = nil
        }
    }

    static func registerPendingServerProcess(_ process: Process) -> Bool {
        lock.withLock { state in
            guard state.pendingServerProcess?.isRunning != true else { return false }
            state.pendingServerProcess = process
            return true
        }
    }

    static func clearPendingServerProcess(matching candidate: Process? = nil) {
        lock.withLock { state in
            if let candidate, state.pendingServerProcess !== candidate { return }
            state.pendingServerProcess = nil
        }
    }

    static func hasOwnedServerWork() -> Bool {
        lock.withLock {
            $0.ownedServerSession != nil || $0.pendingServerProcess?.isRunning == true
        }
    }

    static func stopPendingServerProcess(matching candidate: Process? = nil) async {
        let pending = lock.withLock { state -> Process? in
            guard let pending = state.pendingServerProcess else { return nil }
            if let candidate, pending !== candidate { return nil }
            state.pendingServerProcess = nil
            return pending
        }
        guard let pending else { return }
        if pending.isRunning {
            pending.terminate()
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: .seconds(1))
            while pending.isRunning, clock.now < deadline {
                try? await clock.sleep(for: .milliseconds(50))
            }
            if pending.isRunning {
                kill(pending.processIdentifier, SIGKILL)
                let killDeadline = clock.now.advanced(by: .seconds(1))
                while pending.isRunning, clock.now < killDeadline {
                    try? await clock.sleep(for: .milliseconds(50))
                }
            }
        }
    }

    static func sidecarStateFileStore() -> AgentChatSidecarStateFileStore? {
        lock.withLock { state in
            state.sidecarStateFileStore
        }
    }

    static func bossPanelLocation() -> (ownerWindowId: UUID, panelId: UUID)? {
        lock.withLock { state in
            guard let ownerWindowId = state.bossPanelOwnerWindowId,
                  let panelId = state.bossPanelId else {
                return nil
            }
            return (ownerWindowId, panelId)
        }
    }

    static func updateBossPanel(ownerWindowId: UUID, panelId: UUID, stableSurfaceId: UUID) {
        lock.withLock { state in
            state.bossPanelOwnerWindowId = ownerWindowId
            state.bossPanelId = panelId
        }
        persistBossStableSurfaceID(stableSurfaceId)
    }

    static func clearBossPanel() {
        lock.withLock { state in
            state.bossPanelOwnerWindowId = nil
            state.bossPanelId = nil
        }
        UserDefaults.standard.removeObject(forKey: bossStableSurfaceDefaultsKey)
        UserDefaults.standard.removeObject(forKey: legacyBossPanelDefaultsKey)
    }

    static func persistedBossStableSurfaceID(defaults: UserDefaults = .standard) -> UUID? {
        guard let rawValue = defaults.string(forKey: bossStableSurfaceDefaultsKey) else { return nil }
        guard let stableSurfaceID = UUID(uuidString: rawValue) else {
            defaults.removeObject(forKey: bossStableSurfaceDefaultsKey)
            return nil
        }
        return stableSurfaceID
    }

    static func persistBossStableSurfaceID(_ stableSurfaceID: UUID, defaults: UserDefaults = .standard) {
        defaults.set(stableSurfaceID.uuidString, forKey: bossStableSurfaceDefaultsKey)
    }

    static func stopOwnedServer() async -> Bool {
        await stopPendingServerProcess()
        guard let session = ownedServerSession() else { return true }
        var request = URLRequest(url: session.shutdownURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 1.5
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 1.5
        configuration.timeoutIntervalForResource = 2
        let urlSession = URLSession(configuration: configuration)
        defer { urlSession.invalidateAndCancel() }

        do {
            let (_, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                return false
            }
        } catch {
            let isReachable = await serverIsReachable(session.healthURL, session: urlSession)
            guard !isReachable else {
                return false
            }
        }

        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(1))
        while clock.now < deadline {
            let isReachable = await serverIsReachable(session.healthURL, session: urlSession)
            if !isReachable {
                clearOwnedServerSession(matching: session)
                await sidecarStateFileStore()?.removeStateFile()
                return true
            }
            try? await clock.sleep(for: .milliseconds(50))
        }
        return false
    }

    private static func serverIsReachable(_ url: URL, session: URLSession) async -> Bool {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 0.25
        do {
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return false }
            return (200..<300).contains(http.statusCode)
        } catch {
            return false
        }
    }
}

struct AgentChatServerAvailability: Sendable {
    var isReachable: Bool
    /// nil means the owned launch failed and nothing safe exists to open;
    /// the action must fail instead of falling back to the legacy URL.
    var browserURL: URL?
}

extension AppDelegate {
    private struct WorkbenchBossChoice {
        var agentName: String
        var previousAgentName: String?

        var changed: Bool {
            agentName != previousAgentName
        }
    }

    func startWorkbenchLocalSupervisionIfNeeded() {
        guard OuroWorkbenchProduct.isCurrentBundle,
              workbenchLocalSupervisionCoordinator == nil else {
            return
        }
        let coordinator = WorkbenchLocalSupervisionCoordinator(
            evidenceProvider: Self.workbenchSupervisionEvidence(for:),
            recoveryProvider: Self.workbenchSupervisionRecoveryEvents,
            dispositionHandler: { receiptId, envelope, result, policy in
                switch result.disposition {
                case .ariAttention:
                    guard policy.notificationMode != .off, let summary = result.summary else { return true }
                    return await MainActor.run {
                        switch WorkbenchLocalActionRouter.flagForReview(
                            params: [
                                "request_id": "workbench-supervision:\(receiptId.uuidString)",
                                "workspace_id": envelope.workspaceId,
                                "surface_id": envelope.surfaceId as Any? ?? NSNull(),
                                "summary": summary,
                            ]
                        ) {
                        case .ok:
                            return true
                        case .err:
                            return false
                        }
                    }
                case .draftGuidance:
                    guard let guidance = result.guidance,
                          envelope.evidence?.supportsGuidance == true,
                          let sourceRevision = envelope.sourceRevision,
                          let inputEpoch = envelope.inputEpoch,
                          let workspaceId = UUID(uuidString: envelope.workspaceId),
                          let surface = envelope.surfaceId,
                          let surfaceId = UUID(uuidString: surface) else {
                        return false
                    }
                    let requestId = "workbench-supervision:\(receiptId.uuidString)"
                    let draft = WorkbenchGuidanceDraft(
                        requestId: requestId,
                        sourceRevision: sourceRevision,
                        inputEpoch: inputEpoch,
                        text: guidance
                    )
                    guard WorkbenchLocalSessionStateStore.shared.storeGuidance(
                        draft,
                        workspaceId: workspaceId,
                        surfaceId: surfaceId,
                        sessionId: envelope.sessionId
                    ) else {
                        return false
                    }
                    let mutationAllowed = await MainActor.run {
                        policy.allowsAutomatedLocalMutation(appIsActive: NSApp.isActive)
                    }
                    guard mutationAllowed else {
                        return true
                    }
                    return await MainActor.run {
                        switch WorkbenchLocalActionRouter.sendGuidance(
                            params: [
                                "request_id": requestId,
                                "workspace_id": envelope.workspaceId,
                                "surface_id": surface,
                                "session_id": envelope.sessionId,
                                "expected_source_revision": sourceRevision,
                                "expected_input_epoch": inputEpoch,
                                "text": guidance,
                            ]
                        ) {
                        case .ok:
                            return true
                        case .err:
                            return false
                        }
                    }
                case .noAction, .hold:
                    return true
                }
            },
            runTurn: { [weak self] requestId, prompt, cwd in
                guard let self else { throw CancellationError() }
                return try await self.runWorkbenchHeadlessBossTurn(
                    requestId: requestId,
                    prompt: prompt,
                    cwd: cwd
                )
            }
        )
        workbenchLocalSupervisionCoordinator = coordinator
        coordinator.start()
    }

    func stopWorkbenchLocalSupervision() {
        workbenchSupervisionShutdownTask = workbenchLocalSupervisionCoordinator?.stop()
        workbenchLocalSupervisionCoordinator = nil
    }

    private func runWorkbenchHeadlessBossTurn(
        requestId: String,
        prompt: String,
        cwd: String
    ) async throws -> String {
        guard OuroWorkbenchProduct.isCurrentBundle,
              !isTerminatingApp,
              let context = mainWindowContexts.values.first(where: {
                  $0.cmuxConfigStore?.agentChat.startCommand != nil
              }) else {
            throw WorkbenchLocalSupervisionCoordinator.AgentChatHeadlessTurnError.provider(
                "Workbench Boss runtime is unavailable"
            )
        }
        try await AgentChatActionInFlightGate.beginWhenAvailable()
        defer { AgentChatActionInFlightGate.end() }
        try Task.checkCancellation()
        guard !isTerminatingApp else { throw CancellationError() }
        let agentChat = context.cmuxConfigStore?.agentChat ?? .default
        let availability = await ensureAgentChatServerAvailable(
            agentChat,
            globalConfigPath: context.cmuxConfigStore?.globalConfigPath,
            preferredWindow: resolvedWindow(for: context)
        )
        guard availability.isReachable,
              !isTerminatingApp,
              let ownedSession = AgentChatActionInFlightGate.ownedServerSession() else {
            throw WorkbenchLocalSupervisionCoordinator.AgentChatHeadlessTurnError.provider(
                "Workbench Boss runtime is unavailable"
            )
        }
        return try await WorkbenchLocalSupervisionCoordinator.AgentChatHeadlessTurnClient(
            ownedSession: ownedSession
        ).run(
            requestId: requestId,
            prompt: prompt,
            cwd: cwd
        )
    }

    nonisolated private static func workbenchSupervisionEvidence(
        for envelope: WorkbenchSupervisionEnvelope
    ) -> WorkbenchSupervisionEvidence? {
        let item = FeedCoordinator.shared.snapshot(pendingOnly: false).reversed().first { item in
            guard item.source.rawValue == envelope.source,
                  item.workstreamId == envelope.sessionId else {
                return false
            }
            if let sourceEventId = envelope.sourceEventId,
               item.sourceEventId != sourceEventId {
                return false
            }
            if let sourceRevision = envelope.sourceRevision,
               item.sourceRevision != sourceRevision {
                return false
            }
            if let causalChainId = envelope.causalChainId,
               item.causalChainId != causalChainId {
                return false
            }
            return true
        }
        guard let context = item?.context else { return nil }
        return WorkbenchSupervisionEvidence(
            lastUserMessage: context.lastUserMessage.map { String($0.prefix(1_000)) },
            assistantMessage: context.assistantPreamble.map { String($0.prefix(1_000)) }
        )
    }

    nonisolated private static func workbenchSupervisionRecoveryEvents() -> [[String: Any]] {
        var events: [[String: Any]] = []
        for item in FeedCoordinator.shared.snapshot(pendingOnly: false).reversed() {
            let hookName: String
            switch item.kind {
            case .stop:
                hookName = "agent.hook.Stop"
            case .question:
                hookName = "agent.hook.AskUserQuestion"
            case .permissionRequest:
                hookName = "agent.hook.PermissionRequest"
            case .sessionEnd:
                hookName = "agent.hook.SessionEnd"
            case .toolResult:
                guard case .toolResult(_, _, let isError) = item.payload, isError else { continue }
                hookName = "agent.hook.Notification"
            default:
                continue
            }
            let source = item.source.rawValue
            let prefix = "\(source)-"
            guard item.workstreamId.hasPrefix(prefix) else { continue }
            let sourceSessionId = String(item.workstreamId.dropFirst(prefix.count))
            guard let target = FeedJumpResolver.lookup(agent: source, sessionId: sourceSessionId) else {
                continue
            }
            let eventId = "recovery:\(item.id.uuidString)"
            events.append(
                [
                    "name": hookName,
                    "id": eventId,
                    "seq": Int64(0),
                    "boot_id": "recovery",
                    "source": source,
                    "occurred_at": ISO8601DateFormatter().string(from: item.updatedAt),
                    "workspace_id": target.workspaceId,
                    "surface_id": target.surfaceId,
                    "payload": [
                        "session_id": item.workstreamId,
                        "workspace_id": target.workspaceId,
                        "surface_id": target.surfaceId,
                        "cwd": item.cwd ?? NSNull(),
                        "tool_name": item.title ?? NSNull(),
                        "is_error": {
                            if case .toolResult(_, _, let isError) = item.payload { return isError }
                            return false
                        }(),
                        "_source_event_id": item.sourceEventId ?? NSNull(),
                        "_source_revision": item.sourceRevision ?? NSNull(),
                        "_causal_chain_id": item.causalChainId ?? NSNull(),
                        "_action_request_id": item.actionRequestId ?? NSNull(),
                        "phase": "received",
                    ] as [String: Any],
                ]
            )
            if events.count == 64 { break }
        }
        return events.reversed()
    }

    func scheduleWorkbenchBossAfterInitialBootstrap(
        tabManager: TabManager,
        windowId: UUID
    ) {
        guard OuroWorkbenchProduct.isCurrentBundle else { return }
        OuroWorkbenchProduct.scheduleCopilotHookInstallation()
        guard didAttemptStartupSessionRestore, !isApplyingSessionRestore else {
            workbenchBossBootstrapPending = true
            return
        }
        workbenchBossBootstrapPending = false
        guard let context = mainWindowContext(for: tabManager),
              context.cmuxConfigStore?.agentChat.startCommand != nil else {
            return
        }
        DispatchQueue.main.async { [weak self, weak tabManager] in
            guard let self,
                  let tabManager,
                  let context = self.mainWindowContext(for: tabManager) else {
                return
            }
            let preferredWindow = self.mainWindow(for: windowId)
            let openBoss = { [weak self, weak context] in
                guard let self,
                      let context,
                      let action = context.cmuxConfigStore?.resolvedAction(
                        id: CmuxSurfaceTabBarBuiltInAction.newAgentChat.configID
                      ) else {
                    return
                }
                _ = self.executeConfiguredCmuxAction(
                    action,
                    context: context,
                    preferredWindow: preferredWindow
                )
            }
            if !self.presentWorkbenchBossSelectionSheetIfNeeded(
                preferredWindow: preferredWindow,
                completion: openBoss
            ) {
                openBoss()
            }
        }
    }

    func resumePendingWorkbenchBossBootstrapAfterSessionRestore() {
        guard OuroWorkbenchProduct.isCurrentBundle,
              workbenchBossBootstrapPending,
              let context = mainWindowContexts.values.first(where: {
                  $0.cmuxConfigStore?.agentChat.startCommand != nil
              }) else {
            return
        }
        scheduleWorkbenchBossAfterInitialBootstrap(
            tabManager: context.tabManager,
            windowId: context.windowId
        )
    }

    func chooseWorkbenchBoss(
        tabManager: TabManager,
        preferredWindow: NSWindow?
    ) {
        guard let choice = presentWorkbenchBossSelection(
            preferredWindow: preferredWindow,
            force: true
        ) else {
            return
        }
        guard choice.changed else {
            _ = executeConfiguredCmuxAction(
                id: CmuxSurfaceTabBarBuiltInAction.newAgentChat.configID,
                tabManager: tabManager,
                preferredWindow: preferredWindow
            )
            return
        }
        guard prepareNewAgentChatAction() else { return }
        Task { @MainActor [weak self, weak tabManager] in
            guard let self, let tabManager else { return }
            let result = await AgentChatActionInFlightGate.runReservedAction {
                if AgentChatActionInFlightGate.hasOwnedServerWork(),
                   !(await AgentChatActionInFlightGate.stopOwnedServer()) {
                    self.restoreWorkbenchBossSelection(choice.previousAgentName)
                    self.presentWorkbenchBossSwitchFailure(preferredWindow: preferredWindow)
                    return false
                }
                guard let context = self.mainWindowContext(for: tabManager) else {
                    NSSound.beep()
                    return false
                }
                return await self.completeNewAgentChatAction(
                    tabManager: tabManager,
                    agentChat: context.cmuxConfigStore?.agentChat ?? .default,
                    globalConfigPath: context.cmuxConfigStore?.globalConfigPath,
                    preferredWindow: self.resolvedWindow(for: context) ?? preferredWindow
                )
            }
            if result == nil {
                restoreWorkbenchBossSelection(choice.previousAgentName)
                NSSound.beep()
            }
        }
    }

    private func presentWorkbenchBossSelection(
        preferredWindow: NSWindow?,
        force: Bool
    ) -> WorkbenchBossChoice? {
        let candidates = OuroWorkbenchProduct.usableBossAgentNames()
        let currentAgentName: String? = {
            guard case .selected(let agentName) = OuroWorkbenchProduct.currentBossSelection() else {
                return nil
            }
            return agentName
        }()
        if !force, let currentAgentName {
            return WorkbenchBossChoice(
                agentName: currentAgentName,
                previousAgentName: currentAgentName
            )
        }
        guard !candidates.isEmpty else { return nil }

        let (alert, popup) = workbenchBossSelectionAlert(
            candidates: candidates,
            currentAgentName: currentAgentName
        )
        guard alert.runCmuxModal(presentingWindow: preferredWindow) == .alertFirstButtonReturn,
              let selectedAgentName = popup.titleOfSelectedItem,
              OuroWorkbenchProduct.selectBossAgent(selectedAgentName) else {
            return nil
        }
        return WorkbenchBossChoice(
            agentName: selectedAgentName,
            previousAgentName: currentAgentName
        )
    }

    private func presentWorkbenchBossSelectionSheetIfNeeded(
        preferredWindow: NSWindow?,
        completion: @escaping @MainActor () -> Void
    ) -> Bool {
        if case .selected = OuroWorkbenchProduct.currentBossSelection() {
            return false
        }
        let candidates = OuroWorkbenchProduct.usableBossAgentNames()
        guard !candidates.isEmpty, let preferredWindow else { return false }
        let (alert, popup) = workbenchBossSelectionAlert(
            candidates: candidates,
            currentAgentName: nil
        )
        preferredWindow.makeKeyAndOrderFront(nil)
        NSRunningApplication.current.activate(
            options: [.activateAllWindows, .activateIgnoringOtherApps]
        )
        DispatchQueue.main.async {
            alert.beginSheetModal(for: preferredWindow) { response in
                if response == .alertFirstButtonReturn,
                   let selectedAgentName = popup.titleOfSelectedItem {
                    _ = OuroWorkbenchProduct.selectBossAgent(selectedAgentName)
                }
                completion()
            }
        }
        return true
    }

    private func workbenchBossSelectionAlert(
        candidates: [String],
        currentAgentName: String?
    ) -> (NSAlert, NSPopUpButton) {
        let popup = NSPopUpButton(
            frame: NSRect(x: 0, y: 0, width: 320, height: 28),
            pullsDown: false
        )
        popup.addItems(withTitles: candidates)
        if let currentAgentName {
            popup.selectItem(withTitle: currentAgentName)
        }
        popup.setAccessibilityLabel("Boss agent")

        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Choose your Boss"
        alert.informativeText = "Boss keeps the cross-workspace picture and coordinates your agents. Each Ouro agent keeps its own provider, identity, and conversation history."
        alert.accessoryView = popup
        alert.addButton(withTitle: "Use as Boss")
        alert.addButton(withTitle: "Not Now")
        return (alert, popup)
    }

    private func restoreWorkbenchBossSelection(_ agentName: String?) {
        if let agentName {
            _ = OuroWorkbenchProduct.selectBossAgent(agentName)
        } else {
            UserDefaults.standard.removeObject(forKey: OuroWorkbenchProduct.selectedBossDefaultsKey)
        }
    }

    private func presentWorkbenchBossSwitchFailure(preferredWindow: NSWindow?) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Could not switch Boss"
        alert.informativeText = "The current Boss runtime did not stop cleanly, so Workbench kept the existing selection."
        alert.addButton(withTitle: "OK")
        _ = alert.runCmuxModal(presentingWindow: preferredWindow)
    }

    /// Workstream feed title mapping extracted because `AppDelegate.swift`
    /// sits at its file-length budget.
    nonisolated static func feedWorkstreamTitle(for event: WorkstreamEvent) -> String? {
        switch event.hookEventName {
        case .preCompact, .postCompact:
            return String(localized: "feed.lifecycle.compaction.title", defaultValue: "Compaction")
        case .subagentStart, .subagentStop:
            return String(localized: "feed.lifecycle.subagent.title", defaultValue: "Subagent")
        default:
            return nil
        }
    }

    @discardableResult
    func performConfiguredNewAgentChatAction(
        context: MainWindowContext,
        preferredWindow: NSWindow?,
        onExecuted: (() -> Void)?
    ) -> Bool {
        let cmuxConfigStore = context.cmuxConfigStore
        return performNewAgentChatAction(
            tabManager: context.tabManager,
            agentChat: cmuxConfigStore?.agentChat ?? .default,
            globalConfigPath: cmuxConfigStore?.globalConfigPath,
            preferredWindow: resolvedWindow(for: context) ?? preferredWindow,
            onExecuted: onExecuted
        )
    }

    @discardableResult
    func executeConfiguredCmuxAction(
        id actionID: String,
        tabManager: TabManager,
        preferredWindow: NSWindow? = nil
    ) -> Bool {
        guard let context = mainWindowContext(for: tabManager),
                  let action = context.cmuxConfigStore?.resolvedAction(
                    id: actionID
                  ) else {
            return false
        }
        return executeConfiguredCmuxAction(
            action,
            context: context,
            preferredWindow: preferredWindow
        )
    }

    @discardableResult
    func performNewAgentChatAction(
        tabManager: TabManager,
        agentChat: CmuxAgentChatConfiguration,
        globalConfigPath: String?,
        preferredWindow: NSWindow?,
        onExecuted: (() -> Void)? = nil
    ) -> Bool {
        guard prepareNewAgentChatAction() else { return false }
        guard AgentChatActionInFlightGate.begin() else {
            NSSound.beep()
            return false
        }
        Task { @MainActor [weak self, weak tabManager] in
            defer { AgentChatActionInFlightGate.end() }
            guard let self, let tabManager else { return }
            _ = await self.completeNewAgentChatAction(
                tabManager: tabManager,
                agentChat: agentChat,
                globalConfigPath: globalConfigPath,
                preferredWindow: preferredWindow,
                onExecuted: onExecuted
            )
        }
        return true
    }

    private func prepareNewAgentChatAction() -> Bool {
        guard CmuxFeatureFlags.shared.isAgentChatUIEnabled else {
            NSSound.beep()
            return false
        }
        guard BrowserAvailabilitySettings.isEnabled() else {
            NSSound.beep()
            return false
        }
        AgentChatThemeSync.start()
        return true
    }

    private func completeNewAgentChatAction(
        tabManager: TabManager,
        agentChat: CmuxAgentChatConfiguration,
        globalConfigPath: String?,
        preferredWindow: NSWindow?,
        onExecuted: (() -> Void)? = nil
    ) async -> Bool {
        let availability = await ensureAgentChatServerAvailable(
            agentChat,
            globalConfigPath: globalConfigPath,
            preferredWindow: preferredWindow
        )
        AgentChatThemeSync.syncNow(agentChat: agentChat)
        guard let browserURL = availability.browserURL else {
            NSSound.beep()
            postAgentChatServerUnavailableNotification(
                workspace: nil,
                agentChat: agentChat
            )
            return false
        }
        let workspace: Workspace?
        let didOpen: Bool
        if OuroWorkbenchProduct.isCurrentBundle {
            didOpen = openWorkbenchBossPanel(tabManager: tabManager, url: browserURL) != nil
            workspace = tabManager.selectedWorkspace
        } else {
            workspace = openAgentChatWorkspace(tabManager: tabManager, url: browserURL)
            didOpen = workspace != nil
        }
        guard didOpen else {
            NSSound.beep()
            return false
        }
        if !availability.isReachable {
            postAgentChatServerUnavailableNotification(
                workspace: workspace,
                agentChat: agentChat
            )
        }
        onExecuted?()
        return true
    }

    @discardableResult
    private func openAgentChatWorkspace(
        tabManager: TabManager,
        url: URL
    ) -> Workspace? {
        let beforeIds = Set(tabManager.tabs.map(\.id))
        let workspaceName = OuroWorkbenchProduct.agentChatSurfaceTitle()
        if OuroWorkbenchProduct.isCurrentBundle,
           let existing = tabManager.tabs.first(where: { $0.customTitle == workspaceName }) {
            let browserPanel = existing.focusedPanelId.flatMap({ existing.panels[$0] as? BrowserPanel })
                ?? existing.panels.values.compactMap({ $0 as? BrowserPanel }).first
            if let browserPanel {
                browserPanel.setOmnibarVisible(false)
                browserPanel.navigateSmart(url.absoluteString)
            } else if let paneId = existing.bonsplitController.focusedPaneId
                ?? existing.bonsplitController.allPaneIds.first {
                _ = existing.newBrowserSurface(
                    inPane: paneId,
                    url: url,
                    focus: true,
                    creationPolicy: .automationPreload,
                    omnibarVisible: false
                )
            }
            tabManager.selectWorkspace(existing)
            return existing
        }
        let workspaceDefinition = CmuxWorkspaceDefinition(
            name: workspaceName,
            layout: .pane(CmuxPaneDefinition(surfaces: [
                CmuxSurfaceDefinition(
                    type: .browser,
                    name: workspaceName,
                    command: nil,
                    cwd: nil,
                    env: nil,
                    url: url.absoluteString,
                    focus: true
                ),
            ]))
        )
        let command = CmuxCommandDefinition(
            name: workspaceName,
            workspace: workspaceDefinition
        )
        let baseCwd = tabManager.selectedWorkspace?.currentDirectory
            ?? FileManager.default.homeDirectoryForCurrentUser.path
        guard CmuxConfigExecutor.executeWorkspaceCommand(
            command: command,
            workspace: workspaceDefinition,
            tabManager: tabManager,
            baseCwd: baseCwd
        ) else {
            return nil
        }
        let workspace = tabManager.tabs.first { !beforeIds.contains($0.id) } ?? tabManager.selectedWorkspace
        if let workspace {
            let browserPanel = workspace.focusedPanelId.flatMap({ workspace.panels[$0] as? BrowserPanel })
                ?? workspace.panels.values.compactMap({ $0 as? BrowserPanel }).first
            browserPanel?.setOmnibarVisible(false)
        }
        return workspace
    }

    @discardableResult
    func openWorkbenchBossPanelForTesting(
        tabManager: TabManager,
        url: URL
    ) -> UUID? {
        openWorkbenchBossPanel(tabManager: tabManager, url: url)
    }

    func clearWorkbenchBossPaneForTesting() {
        AgentChatActionInFlightGate.clearBossPanel()
    }

    @discardableResult
    func rehomeWorkbenchBossPanelForTesting(closingWindowId: UUID) -> Bool {
        guard let context = mainWindowContexts.values.first(where: { $0.windowId == closingWindowId }) else {
            return false
        }
        return rehomeWorkbenchBossPanelIfNeeded(from: context)
    }

    func workbenchBossPanelID(in dock: DockSplitStore) -> UUID? {
        guard OuroWorkbenchProduct.isCurrentBundle,
              let location = AgentChatActionInFlightGate.bossPanelLocation(),
              location.ownerWindowId == dock.workspaceId,
              dock.containsPanel(location.panelId) else {
            return nil
        }
        return location.panelId
    }

    func workbenchBossPanelID(for tabManager: TabManager) -> UUID? {
        guard let dock = existingWindowDock(for: tabManager) else { return nil }
        return workbenchBossPanelID(in: dock)
    }

    @discardableResult
    func rehomeWorkbenchBossPanelIfNeeded(from closingContext: MainWindowContext) -> Bool {
        guard !isTerminatingApp,
              let location = AgentChatActionInFlightGate.bossPanelLocation(),
              location.ownerWindowId == closingContext.windowId,
              let sourceDock = closingContext.existingWindowDock(),
              let sourcePane = sourceDock.paneId(forPanelId: location.panelId),
              let detached = sourceDock.detachSurface(panelId: location.panelId) else {
            return false
        }
        guard let destination = mainWindowContexts.values.first(where: {
            $0 !== closingContext && $0.fileExplorerState != nil
        }) else {
            _ = sourceDock.attachDetachedSurface(detached, inPane: sourcePane, focus: false)
            AgentChatActionInFlightGate.clearBossPanel()
            return false
        }
        let destinationDock = destination.windowDockStore()
        guard let pane = destinationDock.resolvePane(requestedPaneID: nil),
              destinationDock.attachDetachedSurface(detached, inPane: pane, focus: true) != nil,
              let panel = destinationDock.browserPanel(for: location.panelId) else {
            _ = sourceDock.attachDetachedSurface(detached, inPane: sourcePane, focus: false)
            return false
        }
        AgentChatActionInFlightGate.updateBossPanel(
            ownerWindowId: destination.windowId,
            panelId: location.panelId,
            stableSurfaceId: panel.stableSurfaceId
        )
        revealWorkbenchBossPanel(in: destination, dock: destinationDock, panelId: location.panelId)
        return true
    }

    @discardableResult
    private func openWorkbenchBossPanel(
        tabManager: TabManager,
        url: URL
    ) -> UUID? {
        if AgentChatActionInFlightGate.bossPanelLocation() == nil,
           AgentChatActionInFlightGate.persistedBossStableSurfaceID() != nil,
           !restorePersistedWorkbenchBossPanel() {
            guard didAttemptStartupSessionRestore, !isApplyingSessionRestore else {
                return nil
            }
            AgentChatActionInFlightGate.clearBossPanel()
        }
        if let location = AgentChatActionInFlightGate.bossPanelLocation() {
            if let owner = mainWindowContexts.values.first(where: { $0.windowId == location.ownerWindowId }),
               let dock = owner.existingWindowDock(),
               let panel = dock.browserPanel(for: location.panelId) {
                panel.setOmnibarVisible(false)
                panel.navigateSmart(url.absoluteString)
                revealWorkbenchBossPanel(in: owner, dock: dock, panelId: location.panelId)
                return location.panelId
            }
            AgentChatActionInFlightGate.clearBossPanel()
        }
        guard let context = mainWindowContext(for: tabManager),
              let sidebar = context.fileExplorerState else {
            return nil
        }
        let dock = context.windowDockStore()
        guard let pane = dock.resolvePane(requestedPaneID: nil),
              let panelId = dock.newSurface(
                kind: .browser,
                inPane: pane,
                url: url,
                focus: true,
                allowsExternalBrowserFallback: false
              ),
              let panel = dock.browserPanel(for: panelId) else {
            return nil
        }
        panel.setOmnibarVisible(false)
        AgentChatActionInFlightGate.updateBossPanel(
            ownerWindowId: context.windowId,
            panelId: panelId,
            stableSurfaceId: panel.stableSurfaceId
        )
        sidebar.mode = .dock
        sidebar.setVisible(true)
        revealWorkbenchBossPanel(in: context, dock: dock, panelId: panelId)
        return panelId
    }

    private func restorePersistedWorkbenchBossPanel() -> Bool {
        guard let stableSurfaceID = AgentChatActionInFlightGate.persistedBossStableSurfaceID() else {
            return false
        }
        for context in mainWindowContexts.values {
            guard let dock = context.existingWindowDock() else { continue }
            guard let match = dock.panels.first(where: {
                $0.value.stableSurfaceId == stableSurfaceID && $0.value is BrowserPanel
            }), let panel = match.value as? BrowserPanel else { continue }
            panel.setOmnibarVisible(false)
            AgentChatActionInFlightGate.updateBossPanel(
                ownerWindowId: context.windowId,
                panelId: match.key,
                stableSurfaceId: stableSurfaceID
            )
            return true
        }
        return false
    }

    private func revealWorkbenchBossPanel(
        in context: MainWindowContext,
        dock: DockSplitStore,
        panelId: UUID
    ) {
        context.fileExplorerState?.mode = .dock
        context.fileExplorerState?.setVisible(true)
        dock.focusPanel(panelId)
        context.window?.makeKeyAndOrderFront(nil)
    }


    private func ensureAgentChatServerAvailable(
        _ agentChat: CmuxAgentChatConfiguration,
        globalConfigPath: String?,
        preferredWindow: NSWindow?
    ) async -> AgentChatServerAvailability {
        switch agentChat.serverMode {
        case .explicitURL:
            return await ensureExplicitAgentChatServerAvailable(
                agentChat,
                startCommand: agentChat.startCommand,
                globalConfigPath: globalConfigPath,
                preferredWindow: preferredWindow
            )
        case .appOwned:
            guard let startCommand = agentChat.startCommand else {
                return AgentChatServerAvailability(isReachable: false, browserURL: agentChat.url)
            }
            return await ensureOwnedAgentChatServerAvailable(
                agentChat,
                startCommand: startCommand,
                globalConfigPath: globalConfigPath,
                preferredWindow: preferredWindow
            )
        case .legacyDefaultURL:
            let isHealthy = await Self.agentChatServerIsHealthy(healthURL: agentChat.healthURL, timeout: 1.5)
            return AgentChatServerAvailability(isReachable: isHealthy, browserURL: agentChat.url)
        }
    }

    private func ensureExplicitAgentChatServerAvailable(
        _ agentChat: CmuxAgentChatConfiguration,
        startCommand: String?,
        globalConfigPath: String?,
        preferredWindow: NSWindow?
    ) async -> AgentChatServerAvailability {
        if await Self.agentChatServerIsHealthy(healthURL: agentChat.healthURL, timeout: 1.5) {
            return AgentChatServerAvailability(isReachable: true, browserURL: agentChat.url)
        }
        let unavailable = AgentChatServerAvailability(isReachable: false, browserURL: agentChat.url)
        guard let startCommand else { return unavailable }
        guard await authorizeAgentChatStartCommandIfNeeded(
            agentChat,
            command: startCommand,
            globalConfigPath: globalConfigPath,
            preferredWindow: preferredWindow
        ) else {
            return unavailable
        }
        guard Self.launchDetachedAgentChatStartCommand(
            startCommand,
            currentDirectoryURL: Self.agentChatStartCommandDirectoryURL(for: agentChat),
            environmentOverrides: [:]
        ) != nil else {
            return unavailable
        }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(10))
        while !Task.isCancelled, clock.now < deadline {
            if await Self.agentChatServerIsHealthy(healthURL: agentChat.healthURL, timeout: 1.5) {
                return AgentChatServerAvailability(isReachable: true, browserURL: agentChat.url)
            }
            do {
                // Bounded, cancellable health polling after a configured server start.
                try await clock.sleep(for: .milliseconds(250))
            } catch {
                return unavailable
            }
        }
        return unavailable
    }

    private func ensureOwnedAgentChatServerAvailable(
        _ agentChat: CmuxAgentChatConfiguration,
        startCommand: String,
        globalConfigPath: String?,
        preferredWindow: NSWindow?
    ) async -> AgentChatServerAvailability {
        if let session = AgentChatActionInFlightGate.ownedServerSession() {
            if await Self.agentChatServerIsHealthy(healthURL: session.healthURL, timeout: 1.5) {
                return AgentChatServerAvailability(isReachable: true, browserURL: session.browserURL)
            }
            AgentChatActionInFlightGate.clearOwnedServerSession(matching: session)
            await AgentChatActionInFlightGate.sidecarStateFileStore()?.removeStateFile()
        }
        await AgentChatActionInFlightGate.stopPendingServerProcess()

        let launchId = UUID().uuidString
        guard let token = Self.generateAgentChatToken(),
              let stateFileStore = AgentChatActionInFlightGate.sidecarStateFileStore() else {
            return AgentChatServerAvailability(isReachable: false, browserURL: agentChat.url)
        }
        let launchDate = Date()
        guard let stateFileURL = await stateFileStore.prepareStateFileURL(
            launchId: launchId,
            launchDate: launchDate
        ) else {
            return AgentChatServerAvailability(isReachable: false, browserURL: agentChat.url)
        }

        guard await authorizeAgentChatStartCommandIfNeeded(
            agentChat,
            command: startCommand,
            globalConfigPath: globalConfigPath,
            preferredWindow: preferredWindow
        ) else {
            return AgentChatServerAvailability(isReachable: false, browserURL: agentChat.url)
        }
        let controlSocketPath = TerminalController.shared.activeSocketPath(
            preferredPath: SocketControlSettings.socketPath()
        )
        let productEnvironment = OuroWorkbenchProduct.agentChatEnvironment(
            controlSocketPath: controlSocketPath,
            controlSocketCapability: TerminalController.shared
                .socketClientCapabilityEnvironment()["CMUX_SOCKET_CAPABILITY"],
            controlSocketReady: TerminalController.shared
                .socketListenerHealth(expectedSocketPath: controlSocketPath)
                .isHealthy
        )
        guard let pendingProcess = Self.launchDetachedAgentChatStartCommand(
            startCommand,
            currentDirectoryURL: Self.agentChatStartCommandDirectoryURL(for: agentChat),
            environmentOverrides: [
                "CMUX_AGENT_CHAT_TOKEN": token,
                "CMUX_AGENT_CHAT_PORT": "0",
                "CMUX_AGENT_CHAT_STATE_FILE": stateFileURL.path,
                "CMUX_AGENT_CHAT_LAUNCH_ID": launchId,
            ].merging(productEnvironment) { owned, _ in owned }
        ) else {
            return AgentChatServerAvailability(isReachable: false, browserURL: agentChat.url)
        }
        guard AgentChatActionInFlightGate.registerPendingServerProcess(pendingProcess) else {
            pendingProcess.terminate()
            return AgentChatServerAvailability(isReachable: false, browserURL: agentChat.url)
        }

        guard let session = await stateFileStore.waitForSession(
            token: token,
            launchId: launchId,
            launchDate: launchDate
        ) else {
            await AgentChatActionInFlightGate.stopPendingServerProcess(matching: pendingProcess)
            await stateFileStore.removeStateFile(launchId: launchId)
            return AgentChatServerAvailability(isReachable: false, browserURL: agentChat.url)
        }
        AgentChatActionInFlightGate.clearPendingServerProcess(matching: pendingProcess)
        AgentChatActionInFlightGate.updateOwnedServerSession(session)
        let isHealthy = await Self.agentChatServerIsHealthy(healthURL: session.healthURL, timeout: 1.5)
        return AgentChatServerAvailability(isReachable: isHealthy, browserURL: session.browserURL)
    }

    private func authorizeAgentChatStartCommandIfNeeded(
        _ agentChat: CmuxAgentChatConfiguration,
        command: String,
        globalConfigPath: String?,
        preferredWindow: NSWindow?
    ) async -> Bool {
        guard agentChat.startCommandRequiresTrust else { return true }
        guard case .local(let sourcePath) = agentChat.source,
              let globalConfigPath else {
            return false
        }
        let descriptor = Self.agentChatStartCommandTrustDescriptor(
            command: command,
            sourcePath: sourcePath
        )
        return await withCheckedContinuation { continuation in
            _ = CmuxConfigExecutor.authorizeProjectAutomationIfNeeded(
                descriptor: descriptor,
                confirm: false,
                configSourcePath: sourcePath,
                globalConfigPath: globalConfigPath,
                displayCommand: command,
                displayTitle: OuroWorkbenchProduct.agentChatActionTitle(),
                presentingWindow: preferredWindow,
                onAuthorized: {
                    continuation.resume(returning: true)
                },
                onDenied: {
                    continuation.resume(returning: false)
                }
            )
        }
    }

    nonisolated private static func agentChatStartCommandTrustDescriptor(
        command: String,
        sourcePath: String
    ) -> CmuxActionTrustDescriptor {
        CmuxActionTrustDescriptor(
            actionID: "\(CmuxSurfaceTabBarBuiltInAction.newAgentChat.configID).startCommand",
            kind: "agentChatStartCommand",
            command: command,
            target: "agentChatServer",
            workspaceCommand: nil,
            configPath: canonicalAgentChatPath(sourcePath),
            projectRoot: canonicalAgentChatPath(CmuxButtonIcon.projectRoot(forConfigPath: sourcePath)),
            iconFingerprint: nil
        )
    }

    nonisolated private static func agentChatServerIsHealthy(
        healthURL: URL,
        timeout: TimeInterval
    ) async -> Bool {
        var request = URLRequest(
            url: healthURL,
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            timeoutInterval: timeout
        )
        request.httpMethod = "GET"
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { return false }
            return (200..<300).contains(httpResponse.statusCode)
        } catch {
            return false
        }
    }

    nonisolated private static func agentChatStartCommandDirectoryURL(
        for agentChat: CmuxAgentChatConfiguration
    ) -> URL {
        if case .local(let sourcePath) = agentChat.source {
            return URL(
                fileURLWithPath: canonicalAgentChatPath(CmuxButtonIcon.projectRoot(forConfigPath: sourcePath)),
                isDirectory: true
            )
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    nonisolated private static func launchDetachedAgentChatStartCommand(
        _ command: String,
        currentDirectoryURL: URL,
        environmentOverrides: [String: String]
    ) -> Process? {
        let trimmedCommand = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedCommand.isEmpty else { return nil }
        let environment = ProcessInfo.processInfo.environment
        guard let shellPath = environment["SHELL"]?.trimmingCharacters(in: .whitespacesAndNewlines),
              !shellPath.isEmpty else {
            NSLog("[AgentChat] SHELL is not set; cannot launch startCommand")
            return nil
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shellPath)
        process.arguments = ["-lc", trimmedCommand]
        process.currentDirectoryURL = currentDirectoryURL
        process.environment = environment.merging(environmentOverrides) { _, override in override }
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            return process
        } catch {
            NSLog("[AgentChat] failed to launch startCommand: %@", String(describing: error))
            return nil
        }
    }

    nonisolated private static func canonicalAgentChatPath(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.path
    }

    nonisolated private static func generateAgentChatToken(byteCount: Int = 32) -> String? {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            return nil
        }
        return Data(bytes)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

}
