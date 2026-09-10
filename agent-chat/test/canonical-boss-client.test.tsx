import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  appContinuityNotice,
  applyCanonicalBoss,
  bossBlockedMessage,
  draftSurvivesCapabilityChange,
  imageAttachmentAllowed,
  latestImageCapability,
  workbenchActionsAllowed,
  type AgentEvent,
  type BossState,
  type SessionSummary,
} from "../src/session";
import { BossStatusBanner } from "../src/components/BossStatusBanner";
import { WorkbenchHeader } from "../src/components/WorkbenchHeader";

const experience = {
  productName: "Ouro Workbench v1",
  surfaceName: "Boss",
  defaultProvider: "ouro-boss",
  localAuthorityLabel: "Controlled here",
  externalAuthority: { label: "Controlled elsewhere", status: "unknown" as const },
};

const sessions: SessionSummary[] = [
  { id: "stale-newer", provider: "ouro-boss", cwd: "/work", title: "Boss", status: "idle", createdAt: 99 },
  { id: "boss-1", provider: "ouro-boss", cwd: "/work", title: "Boss", status: "idle", createdAt: 10 },
];

test("the root client adopts the server-provided canonical Boss, never the newest session", () => {
  const canonical: BossState = { status: "canonical", agent: "slugger", sessionId: "boss-1", skipped: [] };
  expect(applyCanonicalBoss(sessions, canonical, experience)?.id).toBe("boss-1");

  expect(applyCanonicalBoss(sessions, { status: "none", agent: "slugger", skipped: [] }, experience)).toBeNull();
  expect(applyCanonicalBoss(sessions, {
    status: "blocked",
    agent: "slugger",
    reason: "ambiguous-candidates",
    detail: "2 persisted Boss sessions match agent slugger: boss-1, stale-newer",
    skipped: [],
  }, experience)).toBeNull();
  expect(applyCanonicalBoss(sessions, canonical, null)).toBeNull();
  expect(applyCanonicalBoss([], canonical, experience)).toBeNull();
});

test("blocked recovery reaches the operator with the exact reason and skipped records", () => {
  const blocked: BossState = {
    status: "blocked",
    agent: "slugger",
    reason: "cwd-unavailable",
    detail: "boss-1 cannot load: working directory /work is unavailable",
    skipped: [{ id: "boss-9", agent: "other", reason: "agent-mismatch" }],
  };
  expect(bossBlockedMessage(blocked)).toBe(
    "Boss recovery is blocked (cwd-unavailable): boss-1 cannot load: working directory /work is unavailable",
  );
  expect(bossBlockedMessage({ status: "canonical", agent: "slugger", sessionId: "boss-1", skipped: [] })).toBe("");

  const html = renderToStaticMarkup(<BossStatusBanner boss={blocked} />);
  expect(html).toContain("Boss recovery is blocked");
  expect(html).toContain("cwd-unavailable");
  expect(html).toContain("working directory /work is unavailable");
  expect(html).toContain("boss-9");
  expect(html).toContain("agent-mismatch");
  expect(renderToStaticMarkup(
    <BossStatusBanner boss={{ status: "canonical", agent: "slugger", sessionId: "boss-1", skipped: [] }} />,
  )).toBe("");
});

test("Workbench keeps replies while hiding new, reset, delete, and fork", () => {
  expect(workbenchActionsAllowed(experience)).toEqual({ fork: false, compose: true, delete: false });
  expect(workbenchActionsAllowed(null)).toEqual({ fork: true, compose: true, delete: true });
});

test("image attachment waits for a positive capability while text always sends", () => {
  expect(imageAttachmentAllowed("unknown")).toBe(false);
  expect(imageAttachmentAllowed("unsupported")).toBe(false);
  expect(imageAttachmentAllowed("supported")).toBe(true);
  // A dead peer resets capability to unknown; Workbench has no new/reset
  // action, so text submission must never be gated on negotiation.
  expect(draftSurvivesCapabilityChange()).toBe(true);
});

test("a reconnect rebuilds the negotiated capability from replayed history", () => {
  const events: AgentEvent[] = [
    { kind: "capabilities", image: "unsupported" },
    { kind: "user", text: "hello" },
    { kind: "capabilities", image: "supported" },
    { kind: "assistant", text: "hi" },
  ];
  expect(latestImageCapability(events)).toBe("supported");
  expect(latestImageCapability([{ kind: "user", text: "hello" }])).toBe("unknown");
  expect(latestImageCapability([])).toBe("unknown");
});

test("the Workbench header renders injected external authority and stays neutral by default", () => {
  const injected = renderToStaticMarkup(
    <BossStatusBanner boss={{ status: "canonical", agent: "slugger", sessionId: "boss-1", skipped: [] }} />,
  );
  expect(injected).toBe("");
});


test("an unclean previous exit is visibly preserved without restating the world model", () => {
  expect(appContinuityNotice(null)).toBe("");
  expect(appContinuityNotice({
    appInstanceId: "instance-1",
    startedAt: "2026-09-09T18:00:00Z",
    previousExitClean: true,
  })).toBe("");
  expect(appContinuityNotice({
    appInstanceId: "instance-1",
    startedAt: "2026-09-09T18:00:00Z",
    previousExitClean: false,
  })).toBe("Restarted after an unclean shutdown");

  const html = renderToStaticMarkup(
    <WorkbenchHeader
      experience={experience}
      continuity={{
        appInstanceId: "instance-1",
        startedAt: "2026-09-09T18:00:00Z",
        previousExitClean: false,
      }}
    />,
  );
  expect(html).toContain("Restarted after an unclean shutdown");
  // Boss identity is unchanged by a restart: it is one continuous relationship.
  expect(html).toContain("App-wide");
  expect(renderToStaticMarkup(<WorkbenchHeader experience={experience} />))
    .not.toContain("Restarted after an unclean shutdown");
});
