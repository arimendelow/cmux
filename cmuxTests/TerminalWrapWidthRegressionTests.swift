import AppKit
import Testing

#if canImport(cmux_DEV)
@testable import cmux_DEV
#elseif canImport(cmux)
@testable import cmux
#endif

#if DEBUG
@MainActor
@Suite(.serialized)
struct TerminalWrapWidthRegressionTests {
    private func makeTrackedTerminalSurface(
        tabId: UUID = UUID()
    ) -> TerminalSurface {
        TerminalSurface(
            tabId: tabId,
            context: GHOSTTY_SURFACE_CONTEXT_SPLIT,
            configTemplate: nil,
            workingDirectory: nil
        )
    }

    private func makeHostedTerminalWindow(
        size: NSSize = NSSize(width: 360, height: 240)
    ) throws -> (window: NSWindow, surface: TerminalSurface, hostedView: GhosttySurfaceScrollView) {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        let surface = makeTrackedTerminalSurface()
        let hostedView = surface.hostedView
        hostedView.frame = NSRect(origin: .zero, size: size)
        hostedView.autoresizingMask = [.width, .height]
        let contentView = try #require(window.contentView, "Expected hosted terminal test window content view")
        contentView.addSubview(hostedView)
        window.makeKeyAndOrderFront(nil)
        window.displayIfNeeded()
        contentView.layoutSubtreeIfNeeded()
        hostedView.layoutSubtreeIfNeeded()
        return (window, surface, hostedView)
    }

    @Test func persistentVerticalScrollerInsetsTerminalWrapWidthAcrossSurfaceLayout() throws {
        let (window, surface, hostedView) = try makeHostedTerminalWindow()
        defer {
            GhosttySurfaceScrollView.debugSetPreferredScrollerStyleForTesting(nil)
            window.orderOut(nil)
            surface.releaseSurfaceForTesting()
        }

        GhosttySurfaceScrollView.debugSetPreferredScrollerStyleForTesting(.legacy)
        hostedView.debugSetVerticalScrollerPresentationForTesting(hidden: false, alpha: 1)
        _ = hostedView.reconcileGeometryNow()
        hostedView.debugSetVerticalScrollerPresentationForTesting(hidden: false, alpha: 1)
        #expect(hostedView.reconcileGeometryNow(), "Expected terminal geometry reconciliation")

        var sizing = hostedView.debugSurfaceSizingState()
        #expect(sizing.hasVerticalScroller, "Expected a vertical scroller in the repro setup")
        #expect(sizing.scrollerWidth > 0, "Expected a measurable legacy scroller width")
        let expectedWidth = max(0, sizing.scrollViewBounds.width - sizing.scrollerWidth)
        let pendingBeforeSurfaceLayout = try #require(sizing.pendingSurfaceSize)
        #expect(
            abs(pendingBeforeSurfaceLayout.width - expectedWidth) <= 0.5,
            "Persistent vertical scrollers should reserve a right-edge gutter in the terminal wrap width"
        )

        hostedView.debugForceSurfaceLayoutPassForTesting()

        sizing = hostedView.debugSurfaceSizingState()
        let pendingAfterSurfaceLayout = try #require(sizing.pendingSurfaceSize)
        #expect(
            abs(pendingAfterSurfaceLayout.width - expectedWidth) <= 0.5,
            "Standalone surface layout must not overwrite the host-owned terminal wrap width with full bounds"
        )
    }

    @Test func hiddenPersistentScrollerDoesNotReserveTerminalWrapGutter() throws {
        let (window, surface, hostedView) = try makeHostedTerminalWindow()
        defer {
            GhosttySurfaceScrollView.debugSetPreferredScrollerStyleForTesting(nil)
            window.orderOut(nil)
            surface.releaseSurfaceForTesting()
        }

        GhosttySurfaceScrollView.debugSetPreferredScrollerStyleForTesting(.legacy)
        hostedView.debugSetVerticalScrollerPresentationForTesting(hidden: true, alpha: 1)
        _ = hostedView.reconcileGeometryNow()
        hostedView.debugSetVerticalScrollerPresentationForTesting(hidden: true, alpha: 1)
        #expect(hostedView.reconcileGeometryNow(), "Expected terminal geometry reconciliation")

        let sizing = hostedView.debugSurfaceSizingState()
        let pending = try #require(sizing.pendingSurfaceSize)
        #expect(
            abs(pending.width - sizing.scrollViewBounds.width) <= 0.5,
            "Hidden vertical scrollers should not shrink the terminal wrap width"
        )
    }

    @Test func hostedTerminalWrapWidthHintInvalidatesWhenSurfaceBoundsChange() throws {
        let (window, surface, hostedView) = try makeHostedTerminalWindow()
        defer {
            GhosttySurfaceScrollView.debugSetPreferredScrollerStyleForTesting(nil)
            window.orderOut(nil)
            surface.releaseSurfaceForTesting()
        }

        GhosttySurfaceScrollView.debugSetPreferredScrollerStyleForTesting(.legacy)
        hostedView.debugSetVerticalScrollerPresentationForTesting(hidden: false, alpha: 1)
        _ = hostedView.reconcileGeometryNow()
        hostedView.debugSetVerticalScrollerPresentationForTesting(hidden: false, alpha: 1)
        #expect(hostedView.reconcileGeometryNow(), "Expected terminal geometry reconciliation")

        var sizing = hostedView.debugSurfaceSizingState()
        let hostedContentSize = try #require(sizing.hostedContentSurfaceSize)
        #expect(
            abs(hostedContentSize.width - sizing.surfaceViewBounds.width) <= 0.5,
            "A host-owned wrap-width hint should start valid only while it matches the hosted surface bounds"
        )

        hostedView.debugSetSurfaceViewSizeForTesting(sizing.scrollViewBounds)
        hostedView.debugForceSurfaceLayoutPassForTesting()

        sizing = hostedView.debugSurfaceSizingState()
        #expect(
            sizing.hostedContentSurfaceSize == nil,
            "A stale host-owned wrap-width hint must be cleared once live surface bounds diverge"
        )
        let pending = try #require(sizing.pendingSurfaceSize)
        #expect(
            abs(pending.width - sizing.scrollViewBounds.width) <= 0.5,
            "After invalidation, standalone surface layout should fall back to the live surface bounds"
        )
    }
}
#endif
