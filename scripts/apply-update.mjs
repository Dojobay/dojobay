#!/usr/bin/env node
// Detached helper that finishes a self-update AFTER the backend has replied to
// the browser. Spawned by server/self-update.mjs; not meant to be run by hand.
// It overlays the staged code onto the web root, reinstalls server
// dependencies, rebuilds the public list and source archive, records the
// result where the (about-to-restart) backend's status endpoint can read it,
// then restarts the service. Because restarting kills this helper's parent but
// not this detached process, the restart is the last thing it does.
import { cp, writeFile, rm, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const staging = arg("--staging");
const webRoot = arg("--webroot");
const version = arg("--version", "");

const resultPath = path.join(webRoot, "data", "updates", "last-result.json");
async function writeResult(obj) {
  try { await mkdir(path.dirname(resultPath), { recursive: true }); await writeFile(resultPath, JSON.stringify({ ...obj, at: new Date().toISOString(), version }, null, 2)); } catch {}
}

async function main() {
  if (!staging || !webRoot) { await writeResult({ ok: false, error: "missing --staging/--webroot" }); process.exit(1); }
  // Give the backend a moment to flush its "restarting" response.
  await new Promise((r) => setTimeout(r, 1500));
  try {
    // Overlay staged code onto the web root (data/ is not in staging, so
    // instance state is untouched).
    await cp(staging, webRoot, { recursive: true, force: true });
    // Reinstall backend deps in case package-lock changed; tolerate offline.
    try { await run("npm", ["ci", "--omit=dev"], { cwd: path.join(webRoot, "server") }); } catch (e) { /* keep going: existing node_modules */ }
    // Rebuild public list + source archive from the new code.
    await run(process.execPath, ["build-public.mjs"], { cwd: path.join(webRoot, "server") }).catch(() => {});
    await run(process.execPath, [path.join(webRoot, "scripts", "pack-source.mjs")]).catch(() => {});
    // Clean this staging tree (keep backups and the result file).
    await rm(path.dirname(staging), { recursive: true, force: true }).catch(() => {});
    await writeResult({ ok: true, restarting: true });
    // Restart the service last: this replaces the running (old-code) backend
    // with the new one. If we lack privilege, record it so /admin can show how
    // to finish by hand.
    try { await run("systemctl", ["restart", "dojobay-server.service"]); }
    catch (e) { await writeResult({ ok: true, restarting: false, note: "code updated; restart dojobay-server manually: " + e.message }); }
  } catch (e) {
    await writeResult({ ok: false, error: e.message });
    process.exit(1);
  }
}
main();
