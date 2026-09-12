import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Invoked by a separate driver against an owned actual server, never by importing server.ts.
async function runServerFilesScenario(
  address: string,
  fixtureRoot: string,
  traceFile: string,
  completePrompt: (text: string) => Promise<void>,
  evidence: unknown[],
) {
  const allowed = join(fixtureRoot, "allowed");
  const repo = join(allowed, "repository");
  const plain = join(allowed, "plain");
  const outside = join(fixtureRoot, "outside");
  assert.deepEqual(readdirSync(allowed), [], "the scenario needs a fresh owned directory");
  assert.notEqual(process.getuid?.(), 0, "permission-denied walking needs an unprivileged process");
  for (const dir of [repo, plain, outside]) mkdirSync(dir);
  const git = (cwd: string, args: string[], expectedExit = 0) => {
    const within = relative(fixtureRoot, cwd);
    assert.ok(within && !within.startsWith(".."));
    const argv = ["-C", resolve(import.meta.dir, "../.."), "-C", cwd, ...args];
    const result = spawnSync("/usr/bin/git", argv, {
      encoding: "utf8", timeout: 10_000,
      env: {
        ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_CEILING_DIRECTORIES: fixtureRoot,
        GIT_AUTHOR_NAME: "Ari Mendelow", GIT_AUTHOR_EMAIL: "ari@mendelow.me",
        GIT_COMMITTER_NAME: "Ari Mendelow", GIT_COMMITTER_EMAIL: "ari@mendelow.me",
      },
    });
    evidence.push({ git: ["/usr/bin/git", ...argv], pid: result.pid, exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedExit, result.stderr);
    return result.stdout;
  };
  const indexSnapshot = (phase: "before" | "after") => {
    const bytes = readFileSync(join(repo, ".git/index"));
    const binaryFile = join(fixtureRoot, `index-${phase}.bin`);
    writeFileSync(binaryFile, bytes, { flag: "wx" });
    const entries = git(repo, ["ls-files", "--stage", "-v", "-z"]).split("\0");
    assert.equal(entries.pop(), "", "Git's complete staged listing must be NUL-terminated");
    const debug = git(repo, ["ls-files", "--debug", "-z"]);
    const flags = Array.from(debug.matchAll(/^  size: \d+\tflags: ([\da-f]+)$/gm), (match) => match[1]);
    assert.equal(flags.length, entries.length, "retain a Git-reported flag word for every staged entry");
    const logical = {
      entries: entries.map((entry, index) => ({ entry, flags: flags[index] })),
      resolveUndo: git(repo, ["ls-files", "--resolve-undo", "-z"]),
      headRef: git(repo, ["symbolic-ref", "--quiet", "HEAD"]),
      headObjects: git(repo, ["rev-parse", "HEAD", "HEAD^{tree}"]),
    };
    const receipt = {
      phase, binaryFile, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), logical,
    };
    evidence.push({ indexSnapshot: receipt });
    writeFileSync(join(fixtureRoot, `index-${phase}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    return { bytes, logical };
  };
  const write = (base: string, path: string, text: string) => {
    const full = join(base, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, text);
  };
  const seed = {
    ".gitignore": "ignored.txt\nignored-dir/\n",
    "tracked.txt": "before\n",
    "deleted.txt": "remove me\n",
    "long.txt": "old\n",
    "bytes.txt": "old\n",
    "nested/anchor.txt": "anchor\n",
    "unreported.txt": "quiet\n",
  };
  for (const [path, text] of Object.entries(seed)) write(repo, path, text);
  git(repo, ["init", "--initial-branch=file-fixture", "--object-format=sha1"]);
  git(repo, ["config", "core.abbrev", "7"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["config", "core.filemode", "false"]);
  git(repo, ["config", "color.ui", "false"]);
  git(repo, ["add", "--", ...Object.keys(seed)]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "Seed owned file response fixture"]);
  assert.equal(git(repo, ["status", "--porcelain=v1"]), "");
  const originalHead = git(repo, ["rev-parse", "HEAD"]).trim();
  const outsideText = "outside sentinel must remain unchanged\n";
  write(outside, "sentinel.txt", outsideText);
  write(repo, "ignored.txt", "ignored by git\n");
  write(repo, "ignored-dir/hidden.txt", "ignored directory\n");

  const plainFiles = {
    "alpha.txt": "alpha\n",
    "sub/beta.txt": "beta: \u03b2\n",
    "zeta.txt": "zeta\n",
    "d1/d2/d3/d4/d5/at-limit.txt": "depth five\n",
    "d1/d2/d3/d4/d5/d6/too-deep.txt": "depth six\n",
    ".hidden.txt": "hidden\n",
    ".secret/file.txt": "hidden directory\n",
    "node_modules/pkg/index.js": "not a listed dependency\n",
    "dist/output.txt": "not a listed build output\n",
    "build/output.txt": "not a listed build output\n",
    "unreadable/file.txt": "not readable during the walk\n",
  };
  for (const [path, text] of Object.entries(plainFiles)) write(plain, path, text);
  symlinkSync("alpha.txt", join(plain, "file-link.txt"));
  symlinkSync("sub", join(plain, "directory-link"));
  symlinkSync(outside, join(plain, "outside-directory-link"));
  symlinkSync("absent-target", join(plain, "broken-link"));
  symlinkSync(outside, join(allowed, "outside-cwd-link"));
  mkdirSync(join(allowed, "empty"));
  // The ceiling prevents these directories from accidentally using the enclosing checkout.
  git(plain, ["rev-parse", "--is-inside-work-tree"], 128);
  git(join(allowed, "empty"), ["rev-parse", "--is-inside-work-tree"], 128);

  const messages: any[] = [];
  const sockets: WebSocket[] = [];
  let socketError: unknown;
  const wait = async <T>(read: () => T | undefined, description: string): Promise<T> => {
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      if (socketError) throw socketError;
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(20);
    }
    throw new Error(`timed out: ${description}`);
  };
  const socket = new WebSocket(`${address.replace("http:", "ws:")}/ws`);
  sockets.push(socket);
  socket.onmessage = (event) => {
    try {
      const raw = String(event.data);
      evidence.push({ receivedRaw: raw });
      const message = JSON.parse(raw);
      messages.push(message);
      evidence.push({ received: message });
    } catch (error) { socketError = error; }
  };
  socket.onerror = () => { socketError = new Error("file scenario websocket failed"); };
  const exchange = async (request: unknown, kind: string) => {
    const cursor = messages.length;
    evidence.push({ sent: request });
    socket.send(JSON.stringify(request));
    return wait(() => messages.slice(cursor).find((message) => message.kind === kind || message.kind === "error"), kind);
  };
  const error = (op: string, reason: string, details = {}) => ({
    kind: "error", op, message: `${op === "get-file-diff" ? "Failed to load diff" : "Request failed"}: ${reason}`, ...details,
  });
  const denied = join(plain, "unreadable");
  const deniedMode = statSync(denied).mode & 0o777;
  let permissionChanged = false;
  let gitMoved = false;
  let headMoved = false;
  try {
    await wait(() => messages.find((message) => message.kind === "hello"), "hello");
    const prompt = "Edit the owned file response fixture";
    const traceStart = existsSync(traceFile) ? readFileSync(traceFile).length : 0;
    const createResponse = await fetch(`${address}/api/sessions`, {
      method: "POST", signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ provider: "copilot", cwd: repo, prompt }),
    });
    const createdText = await createResponse.text();
    evidence.push({ createStatus: createResponse.status, createBody: createdText });
    const created = JSON.parse(createdText);
    assert.equal(createResponse.status, 200);
    assert.deepEqual(Object.keys(created).sort(), ["id", "url"]);
    assert.equal(typeof created.id, "string");
    assert.ok(created.id);
    assert.equal(created.url, `${address}/s/${created.id}`);
    const sessionId = created.id;
    const history = await exchange({ op: "subscribe", sessionId }, "history");
    assert.equal(history.kind, "history");
    assert.equal(history.sessionId, sessionId);

    // Admission does not await the baseline. For this clean repository, the completed real status read fixes its empty result before edits; no internal baseline or allowlist is seeded.
    const baseline = await wait(() => {
      if (!existsSync(traceFile)) return undefined;
      const text = readFileSync(traceFile).subarray(traceStart).toString("utf8");
      const rows = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const start = rows.find((row) => row.event === "start"
        && JSON.stringify(row.argv?.slice(1)) === JSON.stringify(["-C", repo, "status", "--porcelain=v1"]));
      if (!start) return undefined;
      const end = rows.find((row) => row.event === "atexit" && row.sid === start.sid);
      return end ? { start, end } : undefined;
    }, "the server's real Git baseline status completion");
    assert.equal(baseline.end.code, 0);
    evidence.push({ baseline });

    const newLines = Array.from({ length: 450 }, (_, index) => `line-${String(index + 1).padStart(3, "0")}`);
    const largeLine = "b".repeat(90_000);
    write(repo, "tracked.txt", "after\n");
    write(repo, "added.txt", "new file\n");
    write(repo, "long.txt", `${newLines.join("\n")}\n`);
    write(repo, "bytes.txt", `${largeLine}\n`);
    unlinkSync(join(repo, "deleted.txt"));
    await completePrompt(prompt);
    await wait(() => messages.find((message) => message.kind === "event" && message.sessionId === sessionId && message.evt?.kind === "done"), "done after file attribution");
    const changed = messages.filter((message) => message.kind === "event" && message.sessionId === sessionId && message.evt?.kind === "files-changed");
    assert.deepEqual(changed, [{
      kind: "event", sessionId, evt: { kind: "files-changed", files: [
        { path: "added.txt", adds: 0, dels: 0, status: "added" },
        { path: "bytes.txt", adds: 1, dels: 1, status: "modified" },
        { path: "deleted.txt", adds: 0, dels: 1, status: "deleted" },
        { path: "long.txt", adds: 450, dels: 1, status: "modified" },
        { path: "tracked.txt", adds: 1, dels: 1, status: "modified" },
      ] },
    }]);
    const beforeIndex = indexSnapshot("before");
    const originalIndex = beforeIndex.bytes;

    const blob = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex").slice(0, 7);
    const header = (path: string, before: string, after: string, hunk: string) =>
      `diff --git a/${path} b/${path}\nindex ${blob(before)}..${blob(after)} 100644\n--- a/${path}\n+++ b/${path}\n${hunk}\n`;
    const expectedTracked = `${header("tracked.txt", "before\n", "after\n", "@@ -1 +1 @@")}-before\n+after\n`;
    const expectDiff = async (path: string, expectedPath: string, diff: string) => {
      const actual = await exchange({ op: "get-file-diff", sessionId, path }, "file-diff");
      assert.deepEqual(actual, { kind: "file-diff", sessionId, path: expectedPath, diff });
    };
    await expectDiff("tracked.txt", "tracked.txt", expectedTracked);
    await expectDiff(join(repo, "tracked.txt"), "tracked.txt", expectedTracked);
    await expectDiff("./nested/../tracked.txt", "tracked.txt", expectedTracked);
    await expectDiff("added.txt", "added.txt",
      `diff --git a/added.txt b/added.txt\nnew file mode 100644\nindex 0000000..${blob("new file\n")}\n--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+new file\n`);
    await expectDiff("deleted.txt", "deleted.txt",
      `diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\nindex ${blob("remove me\n")}..0000000\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-remove me\n`);
    await expectDiff("long.txt", "long.txt",
      `${header("long.txt", "old\n", `${newLines.join("\n")}\n`, "@@ -1 +1,450 @@")}-old\n${newLines.slice(0, 394).map((line) => `+${line}`).join("\n")}`);
    const fullLargeDiff = `${header("bytes.txt", "old\n", `${largeLine}\n`, "@@ -1 +1 @@")}-old\n+${largeLine}\n`;
    await expectDiff("bytes.txt", "bytes.txt", `${fullLargeDiff.slice(0, 80_000)}\n[truncated]\n`);
    for (const path of ["", "../outside/sentinel.txt", join(outside, "sentinel.txt"), ".", "tracked.txt\0other"]) {
      assert.deepEqual(await exchange({ op: "get-file-diff", sessionId, path }, "error"),
        error("get-file-diff", "invalid path", { sessionId, path }));
    }
    assert.deepEqual(await exchange({ op: "get-file-diff", sessionId, path: "unreported.txt" }, "error"),
      error("get-file-diff", "file was not reported by this session", { sessionId, path: "unreported.txt" }));
    assert.deepEqual(await exchange({ op: "get-file-diff", sessionId: "absent", path: "tracked.txt" }, "error"),
      error("get-file-diff", "no session is available", { sessionId: "absent", path: "tracked.txt" }));

    const observerMessages: any[] = [];
    const observer = new WebSocket(`${address.replace("http:", "ws:")}/ws`);
    sockets.push(observer);
    observer.onmessage = (event) => {
      try {
        const raw = String(event.data);
        evidence.push({ observerReceivedRaw: raw });
        const message = JSON.parse(raw);
        observerMessages.push(message);
        evidence.push({ observerReceived: message });
      } catch (failure) { socketError = failure; }
    };
    observer.onerror = () => { socketError = new Error("unsubscribed observer websocket failed"); };
    await wait(() => observerMessages.find((message) => message.kind === "hello"), "observer hello");
    observer.send(JSON.stringify({ op: "get-file-diff", sessionId, path: "tracked.txt" }));
    assert.deepEqual(await wait(() => observerMessages.find((message) => message.kind === "error"), "unsubscribed diff refusal"),
      error("get-file-diff", "no session is available", { sessionId, path: "tracked.txt" }));

    const listed = await exchange({ op: "list-files", cwd: repo }, "files-list");
    assert.deepEqual(listed, {
      kind: "files-list", cwd: repo,
      files: [".gitignore", "added.txt", "bytes.txt", "deleted.txt", "long.txt", "nested/anchor.txt", "tracked.txt", "unreported.txt"],
    });
    assert.deepEqual(await exchange({ op: "list-files", cwd: repo }, "files-list"), listed);
    assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "after\n");
    assert.equal(readFileSync(join(repo, "added.txt"), "utf8"), "new file\n");
    assert.equal(readFileSync(join(repo, "long.txt"), "utf8"), `${newLines.join("\n")}\n`);
    assert.equal(readFileSync(join(repo, "bytes.txt"), "utf8"), `${largeLine}\n`);
    assert.equal(existsSync(join(repo, "deleted.txt")), false);
    assert.equal(readFileSync(join(repo, "unreported.txt"), "utf8"), "quiet\n");
    assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), originalHead);
    assert.deepEqual(readFileSync(join(repo, ".git/index")), originalIndex);
    evidence.push({ diffFiles: {
      tracked: readFileSync(join(repo, "tracked.txt"), "utf8"), added: readFileSync(join(repo, "added.txt"), "utf8"),
      long: readFileSync(join(repo, "long.txt"), "utf8"), bytes: readFileSync(join(repo, "bytes.txt"), "utf8"),
      deletedExists: existsSync(join(repo, "deleted.txt")),
    } });

    write(repo, "tracked.txt", "before\n");
    await expectDiff("tracked.txt", "tracked.txt", "empty diff for tracked.txt\n");
    unlinkSync(join(repo, "added.txt"));
    // Git's no-index missing-path error exits 1, which this endpoint accepts as a diff exit.
    await expectDiff("added.txt", "added.txt", "empty diff for added.txt\n");
    write(repo, "added.txt", "new file\n");
    const addedMode = statSync(join(repo, "added.txt")).mode & 0o777;
    chmodSync(join(repo, "added.txt"), 0);
    try {
      await expectDiff("added.txt", "added.txt", "diff unavailable for added.txt\n");
    } finally {
      chmodSync(join(repo, "added.txt"), addedMode);
    }
    git(repo, ["symbolic-ref", "HEAD", "refs/heads/no-commits"]);
    headMoved = true;
    await expectDiff("bytes.txt", "bytes.txt", "empty diff for bytes.txt\n");
    git(repo, ["symbolic-ref", "HEAD", "refs/heads/file-fixture"]);
    headMoved = false;
    renameSync(join(repo, ".git"), join(repo, ".git-held"));
    gitMoved = true;
    assert.deepEqual(await exchange({ op: "get-file-diff", sessionId, path: "tracked.txt" }, "error"),
      error("get-file-diff", "not a git repository", { sessionId, path: "tracked.txt" }));
    renameSync(join(repo, ".git-held"), join(repo, ".git"));
    gitMoved = false;

    chmodSync(denied, 0);
    permissionChanged = true;
    const expectedPlain = {
      kind: "files-list", cwd: plain,
      files: ["alpha.txt", "d1/d2/d3/d4/d5/at-limit.txt", "file-link.txt", "sub/beta.txt", "zeta.txt"],
    };
    const concurrentCursor = messages.length;
    for (let index = 0; index < 2; index++) socket.send(JSON.stringify({ op: "list-files", cwd: plain }));
    const concurrent = await wait(() => {
      const replies = messages.slice(concurrentCursor).filter((message) => message.kind === "files-list" || message.kind === "error");
      return replies.length >= 2 ? replies : undefined;
    }, "both cold non-Git listing requests");
    assert.deepEqual(concurrent, [expectedPlain, expectedPlain]);
    assert.deepEqual(await exchange({ op: "list-files", cwd: plain }, "files-list"), expectedPlain);
    assert.deepEqual(await exchange({ op: "list-files", cwd: join(allowed, "empty") }, "files-list"),
      { kind: "files-list", cwd: join(allowed, "empty"), files: [] });
    for (const cwd of [join(allowed, "missing"), join(plain, "alpha.txt")]) {
      assert.deepEqual(await exchange({ op: "list-files", cwd }, "error"),
        error("list-files", "working directory is unavailable"));
    }
    for (const cwd of [outside, join(allowed, "outside-cwd-link")]) {
      assert.deepEqual(await exchange({ op: "list-files", cwd }, "error"),
        error("list-files", "working directory is outside the configured roots"));
    }
    chmodSync(denied, deniedMode);
    permissionChanged = false;
    const finalRepoFiles = Object.entries({
      ...seed, "added.txt": "new file\n", "long.txt": `${newLines.join("\n")}\n`, "bytes.txt": `${largeLine}\n`,
      "ignored.txt": "ignored by git\n", "ignored-dir/hidden.txt": "ignored directory\n",
    }).filter(([path]) => path !== "deleted.txt");
    for (const [path, text] of finalRepoFiles) assert.equal(readFileSync(join(repo, path), "utf8"), text);
    assert.equal(existsSync(join(repo, "deleted.txt")), false);
    assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), originalHead);
    // Git may refresh stat-cache data after content is restored; staging and HEAD must not change.
    const afterIndex = indexSnapshot("after");
    assert.deepEqual(afterIndex.logical, beforeIndex.logical);
    for (const [path, text] of Object.entries(plainFiles)) assert.equal(readFileSync(join(plain, path), "utf8"), text);
    assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), outsideText);
    assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);
    evidence.push({ finalRepoFiles: Object.fromEntries(finalRepoFiles.map(([path]) => [path, readFileSync(join(repo, path), "utf8")])), plainFiles: Object.fromEntries(Object.keys(plainFiles).map((path) => [path, readFileSync(join(plain, path), "utf8")])), outside: readFileSync(join(outside, "sentinel.txt"), "utf8") });
    return { sessionId, result: "file response and walking assertions passed" };
  } finally {
    if (permissionChanged) chmodSync(denied, deniedMode);
    if (gitMoved) renameSync(join(repo, ".git-held"), join(repo, ".git"));
    if (headMoved) git(repo, ["symbolic-ref", "HEAD", "refs/heads/file-fixture"]);
    for (const open of sockets) open.close();
  }
}

// One finite actual-server scenario, adapted from the qualified root driver. The JSON input supplies local tooling paths; importing this file has no process/listener effects.
if (import.meta.main) {
  const [inputPath, mode, ...extra] = Bun.argv.slice(2);
  assert.ok(inputPath && (mode === "baseline" || mode === "root-only") && extra.length === 0,
    "Usage: bun server-files-scenario.ts INPUTS_JSON baseline|root-only");
  assert.equal(inputPath, resolve(inputPath), "input declaration must be absolute");
  const inputs = JSON.parse(readFileSync(inputPath, "utf8"));
  const prefix = dirname(resolve(inputPath));
  const worktree = resolve(import.meta.dir, "../..");
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.equal(inputs.worktree, worktree);
  assert.equal(inputs.outputPrefix, prefix);
  assert.deepEqual({ ...process.env }, inputs.outerEnvironment, "use the declared outer env -i command");
  assert.equal(process.env.HOME, prefix);
  assert.equal(process.env.TMPDIR, prefix);
  assert.equal(process.execPath, inputs.bun.path);
  assert.equal(hash(process.execPath), inputs.bun.sha256);
  assert.equal(hash(join(inputs.tooling, "durable-run.ts")), inputs.runnerSha256);
  assert.equal(hash(join(inputs.tooling, "durable-report.ts")), inputs.reporterSha256);
  const relativePrefix = relative(inputs.tooling, prefix);
  assert.ok(relativePrefix && !relativePrefix.startsWith(".."), "output must remain below the declared collector directory");
  assert.deepEqual(Object.keys(process.env).filter((key) => /^(CMUX_|BUN_ISTANBUL_|RECOVERY_TEST_|FAKE_ACP_|GIT_TRACE)/.test(key)), []);
  for (const [path, expected] of Object.entries(inputs.authoredInputs) as Array<[string, { sha256: string; mode: number }]>) {
    assert.equal(hash(path), expected.sha256, `prepared input changed: ${path}`);
    assert.equal(statSync(path).mode & 0o7777, expected.mode, `prepared mode changed: ${path}`);
  }
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", worktree, ...args], { encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), inputs.baseHead);
  assert.equal(git("rev-parse", "HEAD^{tree}"), inputs.baseTree);
  assert.equal(git("branch", "--show-current"), inputs.branch);
  assert.equal(git("status", "--porcelain=v1"), inputs.expectedGitStatus);
  const output = join(prefix, `${mode}-01`);
  const bundleReceiptFile = join(output, "bundle-owner.json");
  assert.equal(bundleReceiptFile, inputs.bundleReceiptFiles[mode]);
  assert.equal(existsSync(output), false, "never overwrite a prior invocation");
  const sourceList = join(prefix, "sources.json");
  const configurationFiles = JSON.parse(readFileSync(join(prefix, "configurations.json"), "utf8")) as string[];
  assert.equal(JSON.parse(readFileSync(sourceList, "utf8")).length, 18);
  assert.ok(configurationFiles.includes(import.meta.path));
  const bundleGuard = join(import.meta.dir, "server-files-bundle-guard.ts");
  const serverArgs = ["--no-env-file", "--no-install", "--preload", bundleGuard, "server.ts"];
  assert.ok(configurationFiles.includes(bundleGuard));
  assert.deepEqual(inputs.serverArgv, [process.execPath, ...serverArgs]);
  const { runDurable } = await import(join(inputs.tooling, "durable-run.ts"));
  const { reportDurable } = await import(join(inputs.tooling, "durable-report.ts"));
  const json = (name: string, value: unknown) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  mkdirSync(output, { mode: 0o700 });
  const home = join(output, "home");
  const bin = join(home, ".ouro-cli/bin");
  const fixtureRoot = join(output, "fixture");
  for (const dir of [bin, join(output, "tmp"), join(fixtureRoot, "allowed")]) mkdirSync(dir, { recursive: true });
  const peer = join(import.meta.dir, "fake-recovery-peer.ts");
  symlinkSync(process.execPath, join(bin, "bun"));
  symlinkSync("/usr/bin/git", join(bin, "git"));
  writeFileSync(join(bin, "ghostty"), "#!/bin/sh\ntest \"$#\" -eq 1 && test \"$1\" = \"+show-config\" || exit 64\nprintf 'background = 101014\\nforeground = e8e8ec\\n'\n", { mode: 0o755 });
  writeFileSync(join(bin, "defaults"), "#!/bin/sh\ntest \"$#\" -eq 3 && test \"$1\" = \"read\" && test \"$2\" = \"-g\" && test \"$3\" = \"AppleInterfaceStyle\" || exit 64\nprintf 'Dark\\n'\n", { mode: 0o755 });
  writeFileSync(join(bin, "unavailable"), "#!/bin/sh\nexit 64\n", { mode: 0o755 });
  for (const name of ["copilot", "ouro", "opencode", "gemini"]) symlinkSync(peer, join(bin, name));
  for (const name of ["claude", "codex", "pi", "npx", "npm", "cmux"]) symlinkSync(join(bin, "unavailable"), join(bin, name));
  const configs = [...new Set([...configurationFiles, inputPath, ...readdirSync(bin).map((name) => join(bin, name))])];
  const configHashes = Object.fromEntries(configs.map((path) => [path, hash(path)]));
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  const until = async <T>(read: () => T | undefined, label: string): Promise<T> => {
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(20);
    }
    throw new Error(`timed out: ${label}`);
  };
  const traffic: any[] = [];
  const unexpected: unknown[] = [];
  let pending: { message: any; finish: (response: Response) => void } | undefined;
  const controller = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/models") {
        traffic.push({ path });
        return Response.json({ schemaVersion: 1, updatedAt: "2026-09-11T00:00:00Z", providers: {} });
      }
      const message = await request.json().catch(() => null);
      traffic.push({ path, message });
      if (path !== "/acp" || !message || typeof message !== "object") {
        unexpected.push({ path, message });
        return new Response("unhandled fixture request", { status: 400 });
      }
      const reply = (result: unknown) => Response.json([{ jsonrpc: "2.0", id: message.id, result }]);
      if (message.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } });
      if (message.method === "session/new") return reply({ sessionId: message.params?.sessionId ?? "file-peer" });
      if (message.method === "session/prompt") {
        if (pending) {
          unexpected.push({ duplicatePrompt: message });
          return new Response("duplicate prompt", { status: 409 });
        }
        return new Promise<Response>((finish) => { pending = { message, finish }; });
      }
      if (message.method === "session/cancel") {
        pending?.finish(Response.json([{ jsonrpc: "2.0", id: pending.message.id, result: { stopReason: "cancelled" } }]));
        pending = undefined;
        return Response.json([]);
      }
      return reply({});
    },
  });
  const controllerPort = controller.port; // Save before stop(), which resets this value.
  const token = `files-${crypto.randomUUID()}`;
  const stateFile = join(output, "server.json");
  const processLog = join(output, "processes.jsonl");
  const traceFile = join(output, "git-trace.jsonl");
  const environment = {
    HOME: home, CFFIXED_USER_HOME: home, TMPDIR: join(output, "tmp"),
    // Do not pre-insert HOME/.ouro-cli/bin; server.ts must prepend it ahead of Homebrew.
    PATH: "/usr/bin:/bin", BUN_OPTIONS: "--no-env-file", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
    CMUX_GHOSTTY_BIN: join(bin, "ghostty"),
    CMUX_AGENT_CHAT_PORT: "0", CMUX_AGENT_CHAT_TOKEN: token, CMUX_AGENT_CHAT_STATE_FILE: stateFile,
    CMUX_AGENT_CHAT_PRODUCT: "", CMUX_AGENT_CHAT_DEFAULT_PROVIDER: "copilot",
    CMUX_AGENT_CHAT_SESSION_DIR: join(output, "sessions"),
    CMUX_AGENT_CHAT_ALLOWED_ROOTS: join(fixtureRoot, "allowed"), CMUX_AGENT_UI_CWD: join(fixtureRoot, "allowed"),
    CMUX_AGENT_CHAT_OURO_COMMAND: peer, CMUX_BUNDLED_CLI_PATH: peer, CMUX_SOCKET_PATH: join(output, "native.sock"),
    CMUX_AGENT_MODELS_URL: `http://127.0.0.1:${controllerPort}/models`,
    RECOVERY_TEST_URL: `http://127.0.0.1:${controllerPort}`, RECOVERY_TEST_PROCESS_LOG: processLog,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_CEILING_DIRECTORIES: fixtureRoot, GIT_TRACE2_EVENT: traceFile,
    GIT_AUTHOR_NAME: "Ari Mendelow", GIT_AUTHOR_EMAIL: "ari@mendelow.me",
    GIT_COMMITTER_NAME: "Ari Mendelow", GIT_COMMITTER_EMAIL: "ari@mendelow.me",
    SERVER_FILES_BUNDLE_RECEIPT: bundleReceiptFile, SERVER_FILES_DRIVER_PID: String(process.pid),
    LANG: "C", LC_ALL: "C",
  };
  const evidence: unknown[] = [];
  let terminal: any;
  let launchError: unknown;
  const runOutput = join(output, "server-run");
  let running: Promise<unknown> | undefined;
  let state: any;
  let address = "";
  let scenarioResult: unknown;
  let failure: unknown;
  try {
    json("launch.json", { baseHead: inputs.baseHead, baseTree: inputs.baseTree, worktree, mode, environment, controllerPid: process.pid, controllerPort, driverArgv: Bun.argv, driverEnvironment: { ...process.env }, argv: [process.execPath, ...serverArgs], authoredSha256: hash(import.meta.path), gitStatus: git("status", "--porcelain=v1"), configurationFiles: configHashes });
    running = runDurable({
      output: runOutput, sourceList, cwd: resolve(import.meta.dir, ".."),
      args: serverArgs, env: environment, baseline: mode === "baseline",
      ...(mode === "root-only" ? { measurementMode: "root-only", configurationFiles: configs } : {}),
    }).then((result: unknown) => { terminal = result; return result; }, (error: unknown) => { launchError = error; });
    state = await until(() => {
      if (launchError) throw launchError;
      if (terminal) throw new Error(`server exited before state discovery: ${terminal.exitCode}`);
      try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return undefined; }
    }, "server state file");
    assert.equal(state.pid, JSON.parse(readFileSync(join(runOutput, "invocation.json"), "utf8")).pid);
    assert.ok(Number.isSafeInteger(state.port) && state.port > 0);
    address = `http://127.0.0.1:${state.port}/${token}`;
    scenarioResult = await runServerFilesScenario(address, fixtureRoot, traceFile, async (text) => {
      const held = await until(() => pending, "owned ACP prompt");
      assert.deepEqual(held.message.params.prompt, [{ type: "text", text }]);
      held.finish(Response.json([{ jsonrpc: "2.0", id: held.message.id, result: { stopReason: "end_turn" } }]));
      pending = undefined;
    }, evidence);
    assert.deepEqual(unexpected, []);
  } catch (error) {
    failure = error;
  } finally {
    pending?.finish(Response.json([{ jsonrpc: "2.0", id: pending.message.id, result: { stopReason: "cancelled" } }]));
    pending = undefined;
    let shutdown: { status?: number; error?: string } = {};
    const signals: unknown[] = [];
    const invocation = existsSync(join(runOutput, "invocation.json"))
      ? JSON.parse(readFileSync(join(runOutput, "invocation.json"), "utf8")) : undefined;
    try {
      if (!terminal && address) {
        try { shutdown.status = (await fetch(`${address}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(15_000) })).status; }
        catch (error) { shutdown.error = String(error); }
      }
      if (running && !terminal && !launchError) {
        try { await until(() => terminal || launchError, "normal server shutdown"); }
        catch (error) {
          failure ??= error;
          assert.ok(Number.isSafeInteger(invocation?.pid) && invocation.pid > 1);
          for (const signal of ["SIGTERM", "SIGKILL"] as const) {
            if (terminal || launchError) break;
            if (alive(invocation.pid)) {
              const identity = spawnSync("/bin/ps", ["-p", String(invocation.pid), "-o", "ppid=,command="], { encoding: "utf8" });
              const [ppid, ...command] = identity.stdout.trim().split(/\s+/);
              assert.equal(Number(ppid), process.pid, "do not signal a reused/unowned PID");
              assert.equal(command[0], process.execPath);
              assert.equal(command.at(-1), "server.ts");
              signals.push({ pid: invocation.pid, signal, identity: identity.stdout });
              process.kill(invocation.pid, signal);
            }
            await Promise.race([running, Bun.sleep(2_000)]);
          }
        }
      }
    } catch (error) {
      failure ??= error;
      signals.push({ cleanupError: String(error) });
    } finally {
      controller.stop(true);
    }
    const peers = existsSync(processLog) ? readFileSync(processLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    json("transcript.json", { evidence, traffic, unexpected, state, peers });
    let report: any;
    try {
      if (terminal && mode === "root-only") report = reportDurable(terminal.output);
      assert.deepEqual(unexpected, []);
      assert.equal(shutdown.status, 200);
      assert.equal(terminal?.exitCode, 0);
      assert.equal(terminal?.signalCode, null);
      for (const peer of peers) assert.equal(peer.ppid, terminal.pid);
      if (report) assert.equal(report.expectedCaptureComplete, true);
    } catch (error) { failure ??= error; }
    const pids = [...new Set<number>([
      ...(invocation ? [invocation.pid] : []), ...peers.map((peer) => peer.pid),
      ...evidence.flatMap((entry: any) => entry.git && entry.pid > 1 ? [entry.pid] : []),
      ...(report?.unmeasured?.observedProcesses ?? []).map((entry: any) => entry.pid),
    ])];
    const deadline = performance.now() + 2_000;
    while (pids.some(alive) && performance.now() < deadline) await Bun.sleep(20);
    const remaining = pids.filter(alive);
    const ports = [controllerPort, state?.port].filter((port) => Number.isSafeInteger(port) && port > 0);
    const listenerArgv = ["-nP", "-a", `-iTCP:${ports.join(",")}`, "-sTCP:LISTEN", "-Fpcn"];
    const listenerResult = spawnSync("/usr/sbin/lsof", listenerArgv, { encoding: "utf8", timeout: 10_000 });
    const bundleCleanup: any = { state: "preserved", receiptFile: bundleReceiptFile };
    try {
      assert.deepEqual(remaining, [], "recorded owned processes remain");
      assert.ifError(listenerResult.error);
      assert.equal(listenerResult.status, 1);
      assert.equal(listenerResult.stdout, "");
      assert.equal(listenerResult.stderr, "");
      const receiptInfo = lstatSync(bundleReceiptFile);
      assert.ok(receiptInfo.isFile() && !receiptInfo.isSymbolicLink());
      assert.equal(receiptInfo.uid, process.getuid!());
      assert.equal(receiptInfo.mode & 0o777, 0o600);
      const receipt = JSON.parse(readFileSync(bundleReceiptFile, "utf8"));
      bundleCleanup.receipt = receipt;
      assert.equal(receipt.state, "owned", "no proven new bundle-directory ownership; preserve it");
      assert.equal(receipt.created, true);
      assert.ok(Number.isSafeInteger(invocation?.pid) && invocation.pid > 1);
      assert.equal(receipt.pid, invocation?.pid);
      assert.equal(receipt.parentPid, process.pid);
      assert.equal(receipt.token, token);
      assert.equal(receipt.requestedPath, `/tmp/cmux-agent-ui-${invocation.pid}`);
      assert.equal(receipt.canonicalPath, join(realpathSync("/tmp"), `cmux-agent-ui-${invocation.pid}`));
      const checkDirectory = () => {
        const directory = lstatSync(receipt.requestedPath, { bigint: true });
        assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
        assert.equal(realpathSync(receipt.requestedPath), receipt.canonicalPath);
        assert.equal(directory.uid, BigInt(process.getuid!()));
        assert.equal(directory.mode & 0o777n, 0o700n);
        for (const key of ["dev", "ino", "birthtimeNs", "uid"] as const) {
          assert.equal(directory[key].toString(), receipt.identity[key], `bundle directory ${key} changed; preserve it`);
        }
      };
      checkDirectory();
      // Keep one owned scanner rather than lsof's forked blocking-operation helpers.
      const consumerArgv = ["/usr/sbin/lsof", "-nP", "+w", "-O", "+D", receipt.canonicalPath];
      const consumers = spawnSync(consumerArgv[0], consumerArgv.slice(1), { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
      bundleCleanup.consumers = { argv: consumerArgv, pid: consumers.pid, exitCode: consumers.status, signal: consumers.signal, error: consumers.error ? String(consumers.error) : undefined, stdout: consumers.stdout, stderr: consumers.stderr };
      assert.ifError(consumers.error);
      assert.equal(consumers.signal, null);
      assert.equal(consumers.status, 1, "bundle directory has open consumers or an uncertain scan; preserve it");
      assert.equal(consumers.stdout, "", "bundle directory has open consumers; preserve it");
      assert.equal(consumers.stderr, "", "bundle-directory scan was incomplete; preserve it");
      checkDirectory();
      bundleCleanup.state = "removal-attempted";
      rmSync(receipt.canonicalPath, { recursive: true });
      assert.equal(lstatSync(receipt.canonicalPath, { throwIfNoEntry: false }), undefined);
      assert.equal(lstatSync(receipt.requestedPath, { throwIfNoEntry: false }), undefined);
      bundleCleanup.state = "removed";
    } catch (error) {
      failure ??= error;
      bundleCleanup.error = String(error instanceof Error ? error.stack : error);
    }
    json("result.json", {
      scenarioResult, failure: failure ? String(failure instanceof Error ? failure.stack : failure) : undefined,
      launchError: launchError ? String(launchError) : undefined, terminal, shutdown, signals,
      controllerPort, serverPort: state?.port, pids, remaining,
      listeners: { argv: ["/usr/sbin/lsof", ...listenerArgv], exitCode: listenerResult.status, stdout: listenerResult.stdout, stderr: listenerResult.stderr },
      bundleCleanup,
      expectedCaptureComplete: report?.expectedCaptureComplete, reportExitCode: report?.exitCode,
      eligibleForCoverage: !failure && !launchError && terminal?.exitCode === 0 && !terminal?.signalCode && remaining.length === 0 && report?.expectedCaptureComplete === true,
      scope: "Only the actual server root is measured. Driver, ACP/Git children, browser, and native realms receive no credit.",
    });
    assert.deepEqual(remaining, [], "recorded owned processes remain; preserve fixtures for inspection");
    if (launchError) throw launchError;
    if (failure) throw failure;
    console.log(JSON.stringify({ output, scenarioResult, commandExitCode: terminal.exitCode, expectedCaptureComplete: report?.expectedCaptureComplete, numericGateExitCode: report?.exitCode }));
  }
}
