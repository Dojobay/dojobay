#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — resource diagnostic.
//
// READ-ONLY. Measures what this instance actually uses, rather than guessing,
// so an operator can size a VPS from evidence and this project can document a
// requirement it has tested.
//
// What it looks at, and why each matters for THIS workload:
//
//   memory     the backend is a small long-running Node process; the updater is
//              a second one every ten minutes; tor and nginx sit alongside.
//              Peak matters more than current, because `npm ci` during a deploy
//              and the unzip during a self-update are the two spikes.
//   disk       node_modules, the published data, and — the one that grows
//              without limit — data/backups, a full copy of the code kept by
//              every self-update.
//   cpu        idle almost always, with a burst each probe cycle: one Tor
//              circuit per listed node, plus secp256k1 verification.
//   strain     swap in use, OOM kills and load average are the evidence that a
//              box is actually too small, as opposed to merely modest.
//
// Usage, on the box:
//     cd /var/www/dojobay/server && node check-resources.ts
// =============================================================================
import { readFile, stat, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = process.env.WEB_ROOT || path.resolve(HERE, "..");
const PUBLIC_DIR = process.env.PUBLIC_DATA_DIR || path.join(WEB_ROOT, "data");

const MB = 1024 * 1024;
const mb = (bytes: number) => {
  if (bytes < 1024) return bytes + " B";
  if (bytes < MB) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0) + " MB";
};
const gb = (bytes: number) => (bytes / (1024 * MB)).toFixed(1) + " GB";
const read = async (p: string) => { try { return await readFile(p, "utf8"); } catch { return null; } };
const sh = async (cmd: string, args: string[]) => {
  try { return (await exec(cmd, args)).stdout.trim(); } catch { return null; }
};

console.log("The Dojo Bay — what this instance actually uses\n");

// ---- the machine ------------------------------------------------------------
const meminfo = (await read("/proc/meminfo")) || "";
const kb = (key: string) => {
  const m = meminfo.match(new RegExp("^" + key + ":\\s+(\\d+) kB", "m"));
  return m ? Number(m[1]) * 1024 : null;
};
const memTotal = kb("MemTotal"), memAvail = kb("MemAvailable");
const swapTotal = kb("SwapTotal"), swapFree = kb("SwapFree");
const swapUsed = swapTotal != null && swapFree != null ? swapTotal - swapFree : null;
const cpus = os.cpus();

console.log("MACHINE");
console.log(`  cpu            ${cpus.length} × ${cpus[0]?.model?.trim() || "unknown"}`);
console.log(`  memory         ${memTotal ? gb(memTotal) : "?"} total, ${memAvail ? gb(memAvail) : "?"} available`);
console.log(`  swap           ${swapTotal ? gb(swapTotal) + " total, " + mb(swapUsed || 0) + " in use" : "none configured"}`);
const la = os.loadavg();
console.log(`  load average   ${la.map((n) => n.toFixed(2)).join("  ")}   (1, 5, 15 min; ${cpus.length} core${cpus.length === 1 ? "" : "s"})`);

const df = await sh("df", ["-B1", "--output=size,used,avail", WEB_ROOT]);
let diskFree: number | null = null;
if (df) {
  const [size, used, avail] = df.split("\n")[1].trim().split(/\s+/).map(Number);
  diskFree = avail;
  console.log(`  disk           ${gb(size)} total, ${gb(used)} used, ${gb(avail)} free`);
}

// ---- what our services use --------------------------------------------------
console.log("\nSERVICES  (current / peak since boot)");
const units = ["dojobay-server.service", "dojobay-update.service", "tor.service", "nginx.service"];
let ourPeak = 0;
for (const unit of units) {
  const base = `/sys/fs/cgroup/system.slice/${unit}`;
  const cur = Number((await read(`${base}/memory.current`)) || 0);
  const peak = Number((await read(`${base}/memory.peak`)) || 0);
  const active = await sh("systemctl", ["is-active", unit]);
  if (!cur && active !== "active") { console.log(`  ${unit.padEnd(24)} not running`); continue; }
  if (unit.startsWith("dojobay")) ourPeak += peak || cur;
  console.log(`  ${unit.padEnd(24)} ${cur ? mb(cur) : "—"}${peak ? "  /  " + mb(peak) : ""}`);
}

// ---- disk, broken down ------------------------------------------------------
console.log("\nDISK USED BY THIS INSTALLATION");
const du = async (p: string) => {
  const out = await sh("du", ["-sb", p]);
  return out ? Number(out.split(/\s+/)[0]) : null;
};
const parts: [string, string][] = [
  ["everything", WEB_ROOT],
  ["  server/node_modules", path.join(WEB_ROOT, "server", "node_modules")],
  ["  data (published)", PUBLIC_DIR],
  ["  data/avatars", path.join(PUBLIC_DIR, "avatars")],
  ["  data/backups", path.join(PUBLIC_DIR, "backups")],
  ["  data/updates", path.join(PUBLIC_DIR, "updates")],
];
let backupsBytes = 0, backupCount = 0;
for (const [label, p] of parts) {
  const bytes = await du(p);
  if (bytes == null) { console.log(`  ${label.padEnd(24)} —`); continue; }
  if (label.includes("backups")) {
    backupsBytes = bytes;
    try { backupCount = (await readdir(p)).length; } catch { /* none */ }
  }
  console.log(`  ${label.padEnd(24)} ${mb(bytes)}${label.includes("backups") && backupCount ? `  (${backupCount} kept)` : ""}`);
}

// ---- the workload -----------------------------------------------------------
console.log("\nWORKLOAD");
let nodeCount = 0, intervalMin = 10;
try {
  const dojos = JSON.parse((await read(path.join(PUBLIC_DIR, "dojos.json"))) || "{}");
  nodeCount = (dojos.nodes || []).length;
  intervalMin = Number(dojos.interval_minutes) || 10;
} catch { /* not built yet */ }
const concurrency = Number(process.env.CONCURRENCY || 4);
console.log(`  listed nodes   ${nodeCount}`);
console.log(`  probe cycle    every ${intervalMin} min, up to ${concurrency} Tor circuits at once`);
for (const f of ["dojos.json", "history.json", "history-daily.json"]) {
  const s = await stat(path.join(PUBLIC_DIR, f)).catch(() => null);
  if (s) console.log(`  ${f.padEnd(22)} ${mb(s.size)}`);
}

// ---- evidence of strain -----------------------------------------------------
console.log("\nSIGNS OF STRAIN");
const oom = await sh("sh", ["-c", "journalctl -k --no-pager 2>/dev/null | grep -ci 'out of memory' || true"]);
const oomCount = Number(oom || 0);
const findings: string[] = [];
if (oomCount > 0) findings.push(`${oomCount} out-of-memory event(s) in the kernel log — the box IS too small`);
if (swapUsed && swapUsed > 64 * MB) findings.push(`${mb(swapUsed)} of swap in use — memory pressure, though not fatal`);
if (memAvail && memTotal && memAvail < memTotal * 0.15) findings.push("under 15% of memory available right now");
if (la[2] > cpus.length) findings.push(`15-minute load ${la[2].toFixed(2)} exceeds ${cpus.length} core(s)`);
if (diskFree != null && diskFree < 2 * 1024 * MB) findings.push(`only ${gb(diskFree)} of disk free`);
if (backupCount > 3) findings.push(`${backupCount} self-update backups kept (${mb(backupsBytes)}); nothing prunes these`);
if (!findings.length) console.log("  none. Nothing here suggests this machine is short of anything.");
else for (const f of findings) console.log(`  · ${f}`);

// ---- what to tell other operators -------------------------------------------
console.log("\nWHAT THIS SUGGESTS FOR A MINIMUM SPEC");
const ourMb = ourPeak / MB;
if (ourPeak > 0) {
  console.log(`  This instance's own services peaked at about ${mb(ourPeak)}, carrying ${nodeCount} node(s).`);
  console.log("  Add tor, nginx and the operating system, and headroom for `npm ci`");
  console.log("  during a deploy, which is the largest transient by some way.");
} else {
  console.log("  The services are not running here, so nothing was measured. Run this ON");
  console.log("  the instance, with the backend up, for numbers that mean anything.");
}
console.log("");
console.log(`  Suggested minimum: 1 vCPU, ${ourPeak > 0 && ourMb < 200 ? "1 GB" : "2 GB"} RAM, 20 GB disk, plus swap.`);
console.log("  The work is almost entirely waiting on Tor, so cores buy little; memory");
console.log("  and a little disk headroom are what matter. Run this again after a");
console.log("  deploy and after a self-update to catch the peaks rather than the calm.");
