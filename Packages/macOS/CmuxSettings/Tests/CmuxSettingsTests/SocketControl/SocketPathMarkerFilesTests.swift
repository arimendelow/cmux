import Foundation
import Testing
@testable import CmuxSettings

@Test func markerFilesAreVariantAware() {
    #expect(SocketPathMarkerFiles.variant(
        bundleIdentifier: "com.cmuxterm.app",
        environment: [:]
    ) == .stable)
    #expect(SocketPathMarkerFiles.variant(
        bundleIdentifier: "com.cmuxterm.app.nightly",
        environment: [:]
    ) == .nightly(slug: nil))
    #expect(SocketPathMarkerFiles.variant(
        bundleIdentifier: "com.cmuxterm.app.debug.agent",
        environment: [:]
    ) == .dev(slug: "agent"))
    #expect(SocketPathMarkerFiles.variant(
        bundleIdentifier: "com.cmuxterm.app.debug",
        environment: ["CMUX_TAG": "Issue 3542"]
    ) == .dev(slug: "issue-3542"))
    #expect(SocketPathMarkerFiles.variant(
        bundleIdentifier: "com.cmuxterm.app.debug",
        environment: ["CMUX_TAG": "café"]
    ) == .dev(slug: "caf"))
}

@Test func defaultSocketPathsStayVariantScoped() {
    #expect(SocketPathMarkerFiles.defaultSocketPath(
        bundleIdentifier: "com.cmuxterm.app",
        environment: [:],
        isDebugBuild: false,
        stableSocketPath: "/stable/cmux.sock"
    ) == "/stable/cmux.sock")
    #expect(SocketPathMarkerFiles.defaultSocketPath(
        bundleIdentifier: "com.cmuxterm.app.nightly",
        environment: [:],
        isDebugBuild: false,
        stableSocketPath: "/stable/cmux.sock"
    ) == "/tmp/cmux-nightly.sock")
    #expect(SocketPathMarkerFiles.defaultSocketPath(
        bundleIdentifier: "com.cmuxterm.app.staging.my-feature",
        environment: [:],
        isDebugBuild: false,
        stableSocketPath: "/stable/cmux.sock"
    ) == "/tmp/cmux-staging-my-feature.sock")
    #expect(SocketPathMarkerFiles.defaultSocketPath(
        bundleIdentifier: "com.cmuxterm.app.debug",
        environment: ["CMUX_TAG": "Issue 3542"],
        isDebugBuild: false,
        stableSocketPath: "/stable/cmux.sock"
    ) == "/tmp/cmux-debug-issue-3542.sock")
}

@Test(arguments: [
    ("com.ourostack.workbench.v1.debug.acceptance-one", [:], "ouro-workbench-acceptance-one"),
    ("com.ourostack.workbench.v1.debug.acceptance-two", ["CMUX_TAG": "other"], "ouro-workbench-acceptance-two"),
    (" com.ourostack.workbench.v1.debug.acceptance-one ", [:], "ouro-workbench-acceptance-one"),
    ("com.ourostack.workbench.v1.debug", ["CMUX_TAG": "A Case"], "ouro-workbench-a-case"),
    ("com.ourostack.workbench.v1.debug", [:], "ouro-workbench"),
    ("com.ourostack.workbench.v1.debug", ["CMUX_TAG": "  "], "ouro-workbench"),
    ("com.ourostack.workbench.v1.debug", ["CMUX_TAG": "../../"], "ouro-workbench"),
    ("com.ourostack.workbench.v1.debug.!!!", [:], "ouro-workbench"),
])
func workbenchDebugDiscoveryStaysInItsOwnNamespace(
    bundleIdentifier: String,
    environment: [String: String],
    slug: String
) {
    #expect(SocketPathMarkerFiles.variant(
        bundleIdentifier: bundleIdentifier,
        environment: environment
    ) == .dev(slug: slug))
    #expect(SocketPathMarkerFiles.paths(
        bundleIdentifier: bundleIdentifier,
        environment: environment,
        directory: URL(fileURLWithPath: "/owned/fixture/state")
    ) == [
        "/owned/fixture/state/dev-\(slug)-last-socket-path",
        "/tmp/cmux-dev-\(slug)-last-socket-path",
    ])
    #expect(SocketPathMarkerFiles.paths(
        bundleIdentifier: bundleIdentifier,
        environment: environment,
        directory: nil
    ) == ["/tmp/cmux-dev-\(slug)-last-socket-path"])

    for isDebugBuild in [false, true] {
        #expect(SocketPathMarkerFiles.defaultSocketPath(
            bundleIdentifier: bundleIdentifier,
            environment: environment,
            isDebugBuild: isDebugBuild,
            stableSocketPath: "/stable/cmux.sock"
        ) == "/tmp/cmux-debug-\(slug).sock")
        #expect(SocketControlSettings.socketPath(
            environment: environment,
            bundleIdentifier: bundleIdentifier,
            isDebugBuild: isDebugBuild,
            currentUserID: 501,
            probeStableDefaultPathEntry: { _ in .missing }
        ) == "/tmp/cmux-debug-\(slug).sock")
    }
}

@Test(arguments: [
    nil,
    "",
    "com.cmuxterm.app",
    "com.ourostack.workbench",
    "com.ourostack.workbench.v1",
    "com.ourostack.workbench.v1.debugger",
    "com.ourostack.workbench.acceptance.one",
] as [String?])
func otherBundleDiscoveryPreservesItsExistingPolicy(bundleIdentifier: String?) {
    #expect(SocketPathMarkerFiles.variant(
        bundleIdentifier: bundleIdentifier,
        environment: ["CMUX_TAG": "acceptance-one"]
    ) == .stable)
    #expect(SocketPathMarkerFiles.paths(
        bundleIdentifier: bundleIdentifier,
        environment: ["CMUX_TAG": "acceptance-one"],
        directory: nil
    ) == ["/tmp/cmux-last-socket-path"])
}
