import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { forbiddenPublicPattern, forbiddenPublicTerms } from "./forbidden-terms";

// Public-fork boundary: the Agent Chat surface this repository ships must not
// name a private product, tenant, plugin alias, or internal URL. External
// authority arrives through injected configuration instead.
const FORBIDDEN = forbiddenPublicPattern;

const SCANNED_ROOTS = [
  "server.ts",
  "session-persistence.ts",
  "canonical-boss.ts",
  "types.ts",
  "catalog.ts",
  "adapters",
  "src",
  "test",
  "public",
];

function walk(path: string): string[] {
  const stats = statSync(path);
  if (!stats.isDirectory()) return [path];
  return readdirSync(path)
    .filter((entry) => entry !== "node_modules" && entry !== ".scratch")
    .flatMap((entry) => walk(join(path, entry)));
}

test("no Agent Chat source, fixture, or test names a private product or internal URL", () => {
  const root = join(import.meta.dir, "..");
  const offenders: string[] = [];
  for (const relative of SCANNED_ROOTS) {
    for (const file of walk(join(root, relative))) {
      if (/\.(png|jpg|jpeg|gif|ico|woff2?)$/.test(file)) continue;
      const contents = readFileSync(file, "utf8");
      for (const [index, line] of contents.split("\n").entries()) {
        if (FORBIDDEN.test(line)) offenders.push(`${file.slice(root.length + 1)}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("native integration sources, fixtures, and downstream ledger stay free of private vocabulary", () => {
  const repo = join(import.meta.dir, "../..");
  const offenders: string[] = [];
  for (const file of [
    "Sources/ContentView+AgentChatCommandPalette.swift",
    "Sources/CmuxSurfaceTabBarBuiltInAction.swift",
    "Sources/FeatureFlags.swift",
    "Sources/AppDelegate+AgentChat.swift",
    "cmuxTests/SessionPersistenceResumeBindingTests.swift",
    "cmuxTests/CmuxAgentChatConfigTests.swift",
    "cmuxTests/WorkbenchSessionAuthorityTests.swift",
    "cmuxTests/AppDelegateIssue2907RoutingTests.swift",
    "OURO_UPSTREAM.md",
  ]) {
    const contents = readFileSync(join(repo, file), "utf8");
    for (const [index, line] of contents.split("\n").entries()) {
      if (forbiddenPublicPattern.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});
