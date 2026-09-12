import assert from "node:assert/strict";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// CLI-preloaded only in the scenario's actual server root, before server.ts can warm its bundle.
const receiptFile = process.env.SERVER_FILES_BUNDLE_RECEIPT;
assert.ok(receiptFile && receiptFile === resolve(receiptFile), "an absolute owned receipt path is required");
const receiptParent = lstatSync(dirname(receiptFile));
assert.ok(receiptParent.isDirectory() && !receiptParent.isSymbolicLink());
assert.equal(receiptParent.uid, process.getuid!());
assert.equal(receiptParent.mode & 0o777, 0o700, "the driver must create a private receipt directory");
const requestedPath = `/tmp/cmux-agent-ui-${process.pid}`;
const receipt: any = {
  state: "refused", created: false, pid: process.pid, parentPid: process.ppid,
  token: process.env.CMUX_AGENT_CHAT_TOKEN, requestedPath,
  canonicalPath: join(realpathSync("/tmp"), basename(requestedPath)),
};
let failure: unknown;
try {
  assert.equal(process.platform, "darwin", "this ownership guard is prepared for the declared macOS lane");
  assert.equal(resolve(Bun.main), resolve(import.meta.dir, "../server.ts"));
  assert.equal(process.env.SERVER_FILES_DRIVER_PID, String(process.ppid), "not the driver's direct server root");
  assert.ok(receipt.token, "the run token is required");
  // Native mkdir is exclusive here: any preexisting directory, file, or symlink is a refusal.
  mkdirSync(requestedPath, { mode: 0o700 });
  receipt.created = true;
  const directory = lstatSync(requestedPath, { bigint: true });
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  assert.equal(realpathSync(requestedPath), receipt.canonicalPath);
  assert.equal(directory.uid, BigInt(process.getuid!()));
  assert.equal(directory.mode & 0o777n, 0o700n);
  assert.ok(directory.ino > 0n && directory.birthtimeNs > 0n, "native directory identity is unavailable");
  receipt.identity = {
    dev: directory.dev.toString(), ino: directory.ino.toString(),
    birthtimeNs: directory.birthtimeNs.toString(), uid: directory.uid.toString(),
  };
  receipt.state = "owned";
} catch (error) {
  failure = error;
  receipt.error = String(error instanceof Error ? error.stack : error);
  receipt.errorCode = (error as NodeJS.ErrnoException).code;
}
// Never replace a receipt or remove anything on startup failure. stderr retains a receipt-write failure.
writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
if (failure) throw failure;
