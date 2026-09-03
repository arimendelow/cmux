Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { pathname: "/" },
});

const { composerDraftKey, consumeOptimisticUserEcho, foldEvent, providerSessionTitle, providerStartTimeoutMs, restoreComposerDraft } = await import("../src/session");

const writes: Record<string, string> = {};
restoreComposerDraft({ setItem: (key: string, value: string) => { writes[key] = value; } }, "retry this exact prompt");

if (writes[composerDraftKey] !== "retry this exact prompt") {
  throw new Error(`pre-session start failure did not preserve composer draft: ${JSON.stringify(writes)}`);
}

const repeated = [
  { kind: "user" as const, text: "same" },
  { kind: "user" as const, text: "same" },
].reduce(foldEvent, []);
if (repeated.length !== 2) {
  throw new Error(`legitimate repeated user messages should be preserved, got ${JSON.stringify(repeated)}`);
}

const optimistic: string[] = ["same", "same"];
const queueLength = () => optimistic.length as number;
if (!consumeOptimisticUserEcho(optimistic, "same") || queueLength() !== 1) {
  throw new Error("first optimistic user echo was not consumed");
}
if (!consumeOptimisticUserEcho(optimistic, "same") || queueLength() !== 0) {
  throw new Error("second optimistic user echo was not consumed independently");
}
if (consumeOptimisticUserEcho(optimistic, "same")) {
  throw new Error("non-optimistic repeated user message should not be suppressed");
}

const providers = [
  { id: "copilot", label: "GitHub Copilot" },
  { id: "agency-worker", label: "Agency worker" },
];
if (providerSessionTitle(providers, "agency-worker") !== "Agency worker") {
  throw new Error("session title should use the provider label");
}
if (providerSessionTitle(providers, "missing") !== "Agent") {
  throw new Error("unknown provider title should be neutral");
}
if (providerStartTimeoutMs([{ id: "agency-worker", label: "Agency worker", startupTimeoutMs: 90_000 }], "agency-worker") !== 90_000) {
  throw new Error("provider startup timeout should reach the browser client");
}
if (providerStartTimeoutMs(providers, "missing") !== 30_000) {
  throw new Error("unknown providers should keep the default startup timeout");
}

const permissionRequested = foldEvent([], {
  kind: "permission-request",
  requestId: "99",
  title: "Read greeting.mjs",
  options: [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ],
});
const pendingPermission = permissionRequested[0];
if (pendingPermission?.kind !== "permission" || pendingPermission.status !== "pending") {
  throw new Error(`permission request should create a pending block: ${JSON.stringify(permissionRequested)}`);
}
const permissionResolved = foldEvent(permissionRequested, {
  kind: "permission-resolved",
  requestId: "99",
  optionId: "allow-once",
});
const resolvedPermission = permissionResolved[0];
if (resolvedPermission?.kind !== "permission" || resolvedPermission.status !== "resolved" || resolvedPermission.optionId !== "allow-once") {
  throw new Error(`permission response should resolve the matching block: ${JSON.stringify(permissionResolved)}`);
}

console.log("session store assertions passed");

export {};
