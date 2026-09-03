Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { pathname: "/" },
});

const { composerDraftKey, consumeOptimisticUserEcho, foldEvent, pickInitialBossSession, providerSessionTitle, providerStartTimeoutMs, resolveProviderSelection, restoreComposerDraft } = await import("../src/session");

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
  { id: "agency-worker", label: "Agency worker", role: "boss" as const },
];
if (resolveProviderSelection(providers, "", "agency-worker") !== "agency-worker") {
  throw new Error("a clean Workbench composer should select the configured boss");
}
if (resolveProviderSelection(providers, "copilot", "agency-worker") !== "copilot") {
  throw new Error("an installed user-selected provider should be preserved");
}
const recoveredBoss = pickInitialBossSession([
  { id: "copilot-newer", provider: "copilot", cwd: "/tmp", title: "GitHub Copilot", status: "idle", createdAt: 20 },
  { id: "boss-older", provider: "agency-worker", cwd: "/tmp", title: "Boss", status: "idle", createdAt: 10 },
], {
  productName: "Ouro Workbench v1",
  surfaceName: "Boss",
  defaultProvider: "agency-worker",
  localAuthorityLabel: "Controlled here",
  hubAuthorityLabel: "Controlled in Agency Hub",
});
if (recoveredBoss?.id !== "boss-older") {
  throw new Error(`Workbench root should resume its newest Boss, got ${JSON.stringify(recoveredBoss)}`);
}
if (pickInitialBossSession([], null) !== null) {
  throw new Error("generic Agent Chat should not auto-resume a Workbench Boss");
}
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

const plan = foldEvent([], {
  kind: "plan",
  entries: [
    { content: "Inspect the greeting", status: "completed" },
    { content: "Update the message", status: "in_progress" },
  ],
});
if (plan[0]?.kind !== "plan" || plan[0].entries[1]?.content !== "Update the message") {
  throw new Error(`structured plan should survive event folding: ${JSON.stringify(plan)}`);
}

const elicitationRequested = foldEvent([], {
  kind: "elicitation-request",
  requestId: "100",
  message: "How should I update the greeting?",
  fields: [
    {
      name: "strategy",
      type: "string",
      title: "Strategy",
      required: true,
      options: ["conservative", "balanced"],
      defaultValue: "balanced",
    },
  ],
});
const pendingElicitation = elicitationRequested[0];
if (pendingElicitation?.kind !== "elicitation" || pendingElicitation.status !== "pending") {
  throw new Error(`elicitation request should create a pending block: ${JSON.stringify(elicitationRequested)}`);
}
const elicitationResolved = foldEvent(elicitationRequested, {
  kind: "elicitation-resolved",
  requestId: "100",
  action: "accept",
});
const resolvedElicitation = elicitationResolved[0];
if (resolvedElicitation?.kind !== "elicitation" || resolvedElicitation.status !== "resolved" || resolvedElicitation.action !== "accept") {
  throw new Error(`elicitation response should resolve the matching block: ${JSON.stringify(elicitationResolved)}`);
}

console.log("session store assertions passed");

export {};
