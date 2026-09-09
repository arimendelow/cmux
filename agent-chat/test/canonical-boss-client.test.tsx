import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyCanonicalBoss,
  bossBlockedMessage,
  canSendWhileNegotiating,
  workbenchActionsAllowed,
  type BossState,
  type SessionSummary,
} from "../src/session";
import { BossStatusBanner } from "../src/components/BossStatusBanner";

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

test("Workbench hides new, reset, delete, and fork while stock Agent Chat keeps them", () => {
  expect(workbenchActionsAllowed(experience)).toEqual({ fork: false, compose: false, delete: false });
  expect(workbenchActionsAllowed(null)).toEqual({ fork: true, compose: true, delete: true });
});

test("send is withheld while image capability is unknown and the draft survives", () => {
  expect(canSendWhileNegotiating("unknown")).toBe(false);
  expect(canSendWhileNegotiating("supported")).toBe(true);
  expect(canSendWhileNegotiating("unsupported")).toBe(true);
});

test("the Workbench header renders injected external authority and stays neutral by default", () => {
  const injected = renderToStaticMarkup(
    <BossStatusBanner boss={{ status: "canonical", agent: "slugger", sessionId: "boss-1", skipped: [] }} />,
  );
  expect(injected).toBe("");
});
