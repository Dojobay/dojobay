// Self-update for a running Dojo Bay instance, driven from /admin. This is the
// most privileged path in the codebase -- it fetches code and restarts the
// service from a web request -- so every step is deliberate and auditable:
//
//   1. the SOURCE is verified before it is trusted:
//        - github: the archive is fetched over Tor; the commit it claims is
//          recorded, and the caller has already compared it via updates.mjs.
//        - peer:   the peer's data/operator.json signature must verify for the
//          onion it was fetched from (same trust gate as bootstrap-import),
//          and the operator must pass the peer's expected payment code.
//   2. instance data is NEVER in the archive (pack-source.mjs excludes the
//      store, seed, operator binding, histories, avatars), so an update only
//      ever replaces code.
//   3. the current code is BACKED UP to data/backups/<ts>/ before anything is
//      written, and the applier stages the new tree, then a DETACHED helper
//      swaps it in and restarts the service after this process has replied.
//
// The web layer (index.mjs) runs this as a background job and streams progress
// via a polled status object; this module just does the work and calls back
// with progress lines. Node builtins only here except the lazily-imported
// verifier (server/crypto.mjs), which the server always has installed.
import { mkdir, writeFile, rm, cp, readFile, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpOverTor } from "../scripts/update.mjs";
import { githubGet } from "./updates.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- unzip (matches scripts/pack-source.mjs's writer) ------------------------
// Reads the central directory and inflates stored/deflated entries. Guards
// against zip-slip: entries must stay under the single top-level folder.
export function unzip(buf) {
  const files = [];
  // find End Of Central Directory
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip (no EOCD)");
  let count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    // local header -> data
    const lnameLen = buf.readUInt16LE(lho + 26);
    const lextraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnameLen + lextraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(comp) : Buffer.from(comp);
    files.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function stripTopLevel(files) {
  // pack-source writes everything under "dojobay/"; strip exactly one segment.
  const out = [];
  for (const f of files) {
    const slash = f.name.indexOf("/");
    if (slash < 0) continue;                       // skip a bare top-level entry
    const rel = f.name.slice(slash + 1);
    if (!rel || rel.includes("..") || rel.startsWith("/")) throw new Error("unsafe path in archive: " + f.name);
    out.push({ rel, data: f.data });
  }
  return out;
}

// ---- source fetchers ---------------------------------------------------------
const cfgFrom = (o) => ({ proxyHost: o.proxyHost || "127.0.0.1", proxyPort: o.proxyPort || 9050 });

// A peer Dojo Bay serves its own code at /data/dojobay-src.zip. Verify who runs
// it before trusting a byte, exactly like bootstrap-import.
export async function fetchFromPeer({ onionHost, trustedCode, cfg, log = () => {}, fetchDoc, fetchZip }) {
  const c = cfgFrom(cfg || {});
  fetchDoc = fetchDoc || (async (p) => {
    const res = await httpOverTor(c, onionHost, 80, `GET ${p} HTTP/1.0\r\nHost: ${onionHost}\r\nConnection: close\r\n\r\n`, 30000);
    if (res.status !== 200) throw new Error(`${p}: HTTP ${res.status || "no response"}`);
    return res;
  });
  const { verifyOperatorDoc } = await import("./crypto.mjs");
  log("fetching peer operator binding…");
  const opDoc = JSON.parse((await fetchDoc("/data/operator.json")).body);
  const v = verifyOperatorDoc(opDoc, { expectedOnion: `http://${onionHost}` });
  if (!v.ok) throw new Error(`peer operator binding does not verify (${v.error})`);
  if (trustedCode && opDoc.paymentCode !== trustedCode) {
    throw new Error("peer is operated by a different payment code than the one you trusted");
  }
  log(`peer ${onionHost} verified ✓`);
  const zres = fetchZip ? await fetchZip() : await httpOverTor(c, onionHost, 80,
    `GET /data/dojobay-src.zip HTTP/1.0\r\nHost: ${onionHost}\r\nConnection: close\r\n\r\n`, 120000);
  if (zres.status !== 200) throw new Error(`source zip: HTTP ${zres.status || "no response"}`);
  const bytes = zres.bodyBuf || Buffer.from(zres.body, "latin1");
  let version = null;
  try { const vf = JSON.parse((await fetchDoc("/data/version.json")).body); version = vf.commit || null; } catch {}
  return { bytes, sourceLabel: `peer ${onionHost}`, version };
}

// GitHub's zipball for a ref, over Tor. The archive nests under a generated
// "<owner>-<repo>-<sha>/" folder, which stripTopLevel handles the same way.
export async function fetchFromGitHub({ repo = "Dojobay/dojobay", ref = "main", cfg, log = () => {}, transport } = {}) {
  const c = cfgFrom(cfg || {});
  transport = transport || githubGet;
  log("resolving latest commit…");
  const br = await transport(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, c);
  if ( br.status !== 200) throw new Error(`commit lookup: HTTP ${br.status}`);
  const sha = JSON.parse(br.body).sha;
  log(`downloading ${repo}@${sha.slice(0, 8)} over Tor…`);
  const zres = await transport(`/repos/${repo}/zipball/${sha}`, { ...c, binary: true, timeoutMs: 120000 });
  if (zres.status !== 200) throw new Error(`zipball: HTTP ${zres.status}`);
  const bytes = zres.bodyBuf || Buffer.from(zres.body, "latin1");
  return { bytes, sourceLabel: `github ${repo}`, version: sha };
}

// ---- apply -------------------------------------------------------------------
// Stages the new tree next to the web root, backs up the current one, then
// spawns a detached helper that swaps and restarts. Returns before the swap so
// the caller can reply "restarting" to the browser.
export async function applyUpdate({ bytes, sourceLabel, version, webRoot = ROOT, log = () => {}, spawnHelper = true } = {}) {
  log("verifying archive…");
  const entries = stripTopLevel(unzip(bytes));
  if (!entries.some((e) => e.rel === "server/index.mjs") || !entries.some((e) => e.rel === "assets/js/app.js")) {
    throw new Error("archive does not look like a Dojo Bay source tree");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const staging = path.join(webRoot, "data", "updates", stamp, "new");
  const backupDir = path.join(webRoot, "data", "backups", stamp);
  await rm(path.join(webRoot, "data", "updates", stamp), { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  log(`writing ${entries.length} files to staging…`);
  for (const { rel, data } of entries) {
    const dest = path.join(staging, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
  }

  // Preserve executable bits the archive is known to carry.
  for (const rel of ["install.sh", "dojobay-install.desktop"]) {
    try { const { chmod } = await import("node:fs/promises"); await chmod(path.join(staging, rel), 0o755); } catch {}
  }

  log(`backing up current code to data/backups/${stamp}…`);
  await mkdir(backupDir, { recursive: true });
  // back up code dirs/files only; never instance data
  for (const rel of ["assets", "content", "deploy", "scripts", "server", ".github",
    "index.html", "manifest.json", "sw.js", "package.json", "README.md", "CONTRIBUTING.md",
    "install.sh", "dojobay-install.desktop"]) {
    const src = path.join(webRoot, rel);
    try { await stat(src); await cp(src, path.join(backupDir, rel), { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes(path.sep + "data" + path.sep) }); } catch {}
  }

  const manifest = { source: sourceLabel, version, staged_at: stamp, files: entries.length };
  await writeFile(path.join(webRoot, "data", "updates", stamp, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (!spawnHelper) return { stamp, staging, backupDir, entries: entries.length, manifest };

  // Detached helper: runs after this process replies, swaps staged files into
  // the web root, reinstalls server deps, rebuilds, repacks, restarts service.
  log("handing off to the swap helper (the service will restart)…");
  const helper = path.join(webRoot, "scripts", "apply-update.mjs");
  const child = spawn(process.execPath, [helper, "--staging", staging, "--webroot", webRoot, "--version", String(version || "")], {
    detached: true, stdio: "ignore", cwd: webRoot,
  });
  child.unref();
  return { stamp, staging, backupDir, entries: entries.length, manifest, handedOff: true };
}
