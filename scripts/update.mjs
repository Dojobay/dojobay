#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — directory updater
//
// Probes every node's .onion pairing endpoint over Tor and rewrites the two
// JSON databases the website reads:
//
//   data/dojos.json    current snapshot  -> node.status + node.checked_at
//   data/history.json  rolling history   -> one {t, up} per node, per run
//
// dojos.json is also the source of truth for the node LIST. To add or remove a
// node, edit dojos.json (name, paynym, payload, etc.); this script only fills
// in status/checked_at and appends to the history. New nodes get a fresh
// history series automatically; removed nodes are pruned from the history.
//
// Health is checked through Tor's SOCKS5 proxy (no external npm deps). For a
// node whose pairing payload carries an apikey, the check logs in to the Dojo
// API and reads info.latest_block.height from GET /v2/wallet: the node is
// "active" only if it returns a chain tip, which proves the whole stack (Tor,
// nginx, Dojo API, bitcoind) is serving block data, and the height is recorded
// on the node. Nodes without an apikey fall back to a plain HTTP reachability
// probe (active if the onion returns an HTTP response line).
//
// Run once (intended to be driven by cron/systemd every 10 minutes):
//   node scripts/update.mjs
//
// Config via environment variables (all optional):
//   TOR_SOCKS_HOST   default 127.0.0.1
//   TOR_SOCKS_PORT   default 9050
//   DATA_DIR         default <repo>/data
//   TIMEOUT_MS       default 30000   per-node Tor timeout
//   CONCURRENCY      default 6        simultaneous Tor circuits
//   WINDOW_CHECKS    default 144      history length kept per node (24h @ 10min)
//   RETENTION_DAYS   default 90       daily-rollup days kept per node (~3 months)
//   CONNECT_ONLY     default 0        "1" = treat a successful Tor connect as up
//                                     without waiting for an HTTP response line
// =============================================================================

import net from "node:net";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CFG = {
  proxyHost: process.env.TOR_SOCKS_HOST || "127.0.0.1",
  proxyPort: +(process.env.TOR_SOCKS_PORT || 9050),
  dataDir: process.env.DATA_DIR || path.resolve(__dirname, "..", "data"),
  timeoutMs: +(process.env.TIMEOUT_MS || 30000),
  concurrency: +(process.env.CONCURRENCY || 6),
  windowChecks: +(process.env.WINDOW_CHECKS || 144),
  retentionDays: +(process.env.RETENTION_DAYS || 90),
  connectOnly: process.env.CONNECT_ONLY === "1",
};

// ---- SOCKS5 reply codes (RFC 1928 §6) ---------------------------------------
const SOCKS_ERR = {
  0x01: "general failure",
  0x02: "connection not allowed",
  0x03: "network unreachable",
  0x04: "host unreachable",   // Tor: onion descriptor not found / service down
  0x05: "connection refused",
  0x06: "TTL expired",
  0x07: "command not supported",
  0x08: "address type not supported",
};

class SocksError extends Error {
  constructor(code) {
    super("SOCKS " + (SOCKS_ERR[code] || "error 0x" + code.toString(16)));
    this.code = code;
  }
}

// -----------------------------------------------------------------------------
// Open a TCP stream to host:port THROUGH a SOCKS5 proxy (Tor), using a remote
// hostname so the .onion is resolved by Tor, not locally. Resolves with a
// connected socket on success; rejects on any handshake/connect failure.
// -----------------------------------------------------------------------------
export function socks5Connect(proxyHost, proxyPort, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, proxyHost);
    let stage = "greet";
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error("timeout")), timeoutMs);

    socket.once("connect", () => {
      // greeting: VER=5, NMETHODS=1, METHOD=0 (no auth)
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("proxy closed")));

    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);

      if (stage === "greet") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error("proxy refused no-auth handshake"));
        buf = buf.subarray(2);
        stage = "reply";
        // CONNECT request with ATYP=3 (domain name), so Tor resolves the onion
        const hb = Buffer.from(host, "utf8");
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]),
          hb,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]));
      }

      if (stage === "reply") {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) return fail(new SocksError(buf[1]));
        const atyp = buf[3];
        const addrLen =
          atyp === 0x01 ? 4 :
          atyp === 0x04 ? 16 :
          atyp === 0x03 ? (buf.length >= 5 ? 1 + buf[4] : Infinity) : 0;
        if (buf.length < 4 + addrLen + 2) return; // wait for the full bound-addr
        // success: hand the live stream back to the caller
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        resolve(socket);
      }
    });
  });
}

// Well-formed dummy extended keys, used only to elicit info.latest_block from
// the Dojo /wallet endpoint. They are passed as `new` so the node performs no
// rescan or historical import; they derive from a throwaway seed and can never
// receive funds. One per network so the Dojo never rejects them on format.
const DUMMY_XPUB = "xpub661MyMwAqRbcFhv1kNXxwyGrJUVPrmiBNTVDYAtpzF5zu9ceuhn5yV6oaSdveis14LSeBLzpWb58pDNN6hC59TTDyiN7iJR7kUQgXNMfZCL";
const DUMMY_TPUB = "tpubD6NzVbkrYhZ4XW6sCZX49tcDdbb3rADEv65WtiwyL9qteSHMyvdB7vmdpUiiBDpErEyYnvWh3guBWPryVZ3K2tuX3K7RPq5MLS16HN9awey";

// Send one HTTP/1.0 request over a fresh Tor stream and read the whole reply
// (Connection: close means the server ends the body by closing). Resolves with
// { status, body } or rejects on connect/read failure.
function httpOverTor(cfg, host, port, rawRequest, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let socket;
    try {
      socket = await socks5Connect(cfg.proxyHost, cfg.proxyPort, host, port, timeoutMs);
    } catch (e) { return reject(e); }
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.destroy(); } catch {} fn(v); };
    const timer = setTimeout(() => done(reject, new Error("read-timeout")), timeoutMs);
    socket.on("data", (d) => { buf = Buffer.concat([buf, d]); });
    socket.on("error", (e) => done(reject, e));
    socket.on("close", () => {
      const s = buf.toString("latin1");
      const m = s.match(/^HTTP\/1\.[01] (\d{3})/);
      const i = s.indexOf("\r\n\r\n");
      done(resolve, { status: m ? +m[1] : 0, body: i >= 0 ? s.slice(i + 4) : "" });
    });
    socket.write(rawRequest);
  });
}

// Authenticated health check: log in with the node's apikey, then read the
// chain tip from GET /v2/wallet. Returns { up, reason, ms, height?, blockTime? }.
async function probeHeight(url, cfg) {
  const t0 = Date.now();
  const u = new URL(url);
  const host = u.hostname;
  const port = u.port ? +u.port : 80;
  const base = (u.pathname || "/v2").replace(/\/+$/, "") || "/v2";   // e.g. /v2
  const dummy = cfg.network === "testnet" ? DUMMY_TPUB : DUMMY_XPUB;

  // 1) login -> access token
  let token;
  try {
    const body = `apikey=${encodeURIComponent(cfg.apikey)}`;
    const req =
      `POST ${base}/auth/login HTTP/1.0\r\nHost: ${host}\r\n` +
      `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
      `User-Agent: dojobay-checker\r\nConnection: close\r\n\r\n${body}`;
    const res = await httpOverTor(cfg, host, port, req, cfg.timeoutMs);
    if (res.status !== 200) return { up: false, reason: `login HTTP ${res.status || "no-response"}`, ms: Date.now() - t0 };
    token = JSON.parse(res.body)?.authorizations?.access_token;
    if (!token) return { up: false, reason: "login: no token", ms: Date.now() - t0 };
  } catch (e) {
    return { up: false, reason: "login: " + e.message, ms: Date.now() - t0 };
  }

  // 2) wallet -> info.latest_block.height
  try {
    const q = `active=${dummy}&new=${dummy}`;
    const req =
      `GET ${base}/wallet?${q} HTTP/1.0\r\nHost: ${host}\r\n` +
      `Authorization: Bearer ${token}\r\nUser-Agent: dojobay-checker\r\nConnection: close\r\n\r\n`;
    const res = await httpOverTor(cfg, host, port, req, cfg.timeoutMs);
    if (res.status !== 200) return { up: false, reason: `wallet HTTP ${res.status || "no-response"}`, ms: Date.now() - t0 };
    const info = JSON.parse(res.body)?.info?.latest_block;
    const height = info?.height;
    if (typeof height !== "number") return { up: false, reason: "wallet: no block height", ms: Date.now() - t0 };
    return { up: true, reason: "height", height, blockTime: info.time ?? null, ms: Date.now() - t0 };
  } catch (e) {
    return { up: false, reason: "wallet: " + e.message, ms: Date.now() - t0 };
  }
}

// -----------------------------------------------------------------------------
// Probe a single onion URL. Returns { up, reason, ms }.
//   up = Tor connected AND (CONNECT_ONLY, or an HTTP status line came back)
// -----------------------------------------------------------------------------
export async function probe(url, cfg = CFG) {
  // Preferred path: authenticated chain-tip check when an apikey is available.
  if (cfg.apikey) return probeHeight(url, cfg);
  const u = new URL(url);
  const host = u.hostname;
  const port = u.port ? +u.port : (u.protocol === "https:" ? 443 : 80);
  const reqPath = (u.pathname || "/") + (u.search || "");
  const t0 = Date.now();

  let socket;
  try {
    socket = await socks5Connect(cfg.proxyHost, cfg.proxyPort, host, port, cfg.timeoutMs);
  } catch (e) {
    return { up: false, reason: e.message, ms: Date.now() - t0 };
  }

  // TLS onions or connect-only mode: a successful Tor stream is the signal.
  if (cfg.connectOnly || u.protocol === "https:") {
    socket.destroy();
    return { up: true, reason: u.protocol === "https:" ? "tls-connect" : "connect", ms: Date.now() - t0 };
  }

  // Otherwise confirm the Dojo HTTP server actually answers.
  return await new Promise((resolve) => {
    let got = "";
    let settled = false;
    const finish = (up, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ up, reason, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => finish(got.length > 0, got ? "partial" : "read-timeout"), cfg.timeoutMs);

    socket.on("data", (d) => {
      got += d.toString("latin1");
      if (/^HTTP\//i.test(got)) finish(true, "http");
    });
    socket.on("error", () => finish(got.length > 0, "socket-error"));
    socket.on("close", () => finish(got.length > 0, "closed"));

    socket.write(
      `HEAD ${reqPath} HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: dojobay-checker\r\nConnection: close\r\n\r\n`
    );
  });
}

// ---- date helpers (UTC, matching the formats already in the JSON) -----------
const p2 = (n) => String(n).padStart(2, "0");
function stamps(d = new Date()) {
  const Y = d.getUTCFullYear(), M = p2(d.getUTCMonth() + 1), D = p2(d.getUTCDate());
  const h = p2(d.getUTCHours()), m = p2(d.getUTCMinutes()), s = p2(d.getUTCSeconds());
  return {
    isoSec: `${Y}-${M}-${D}T${h}:${m}:${s}Z`,   // generated_at
    isoMin: `${Y}-${M}-${D}T${h}:${m}Z`,         // history check timestamp
    dateTime: `${Y}-${M}-${D} ${h}:${m}:${s}`,   // node.checked_at
  };
}

// ---- small concurrency pool -------------------------------------------------
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT" && fallback !== undefined) return fallback; throw e; }
}

// Write atomically: a reader (the website) never sees a half-written file.
async function writeJSONAtomic(file, obj) {
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, file);
}

// -----------------------------------------------------------------------------
async function main() {
  const dojosPath = path.join(CFG.dataDir, "dojos.json");
  const historyPath = path.join(CFG.dataDir, "history.json");

  const dojos = await readJSON(dojosPath);
  if (!dojos || !Array.isArray(dojos.nodes)) throw new Error(`bad or missing ${dojosPath}`);
  const history = await readJSON(historyPath, { interval_minutes: 10, window_checks: CFG.windowChecks, nodes: {} });
  const window = history.window_checks || CFG.windowChecks;

  const now = new Date();
  const ts = stamps(now);
  console.error(`[${ts.isoSec}] probing ${dojos.nodes.length} nodes via socks5h://${CFG.proxyHost}:${CFG.proxyPort} (timeout ${CFG.timeoutMs}ms, concurrency ${CFG.concurrency})`);

  const results = await pool(dojos.nodes, CFG.concurrency, async (n) => {
    const url = n?.payload?.pairing?.url;
    if (!url) return { up: false, reason: "no pairing url", ms: 0 };
    return probe(url, { ...CFG, apikey: n?.payload?.pairing?.apikey, network: n.network });
  });

  // ---- update current snapshot ----
  let up = 0;
  dojos.nodes.forEach((n, i) => {
    const r = results[i];
    if (r.up) up++;
    n.status = r.up ? "active" : "inactive";
    n.checked_at = ts.dateTime;
    // Record the tip height when we read one; keep the last known height on a
    // down cycle so the card can still show where the node last was.
    if (typeof r.height === "number") n.block_height = r.height;
    else if (!("block_height" in n)) n.block_height = null;
  });
  dojos.generated_at = ts.isoSec;
  dojos.interval_minutes = dojos.interval_minutes || 10;

  // ---- update rolling history (append + trim, prune stale ids) ----
  const histNodes = {};
  dojos.nodes.forEach((n, i) => {
    const prev = (history.nodes?.[n.id]?.checks) || [];
    const checks = prev.concat([{ t: ts.isoMin, up: results[i].up }]);
    if (checks.length > window) checks.splice(0, checks.length - window);
    histNodes[n.id] = { checks };
  });

  await writeJSONAtomic(dojosPath, dojos);
  await writeJSONAtomic(historyPath, {
    generated_at: ts.isoSec,
    interval_minutes: history.interval_minutes || 10,
    window_checks: window,
    nodes: histNodes,
  });

  // ---- update 90-day daily rollup (per-day uptime + closing block height) ----
  // One record per node per UTC day; `close` is the last height read that day,
  // so at day's end it holds the closing height. Retained RETENTION_DAYS days.
  const dailyPath = path.join(CFG.dataDir, "history-daily.json");
  const daily = await readJSON(dailyPath, { retention_days: CFG.retentionDays, nodes: {} });
  const today = ts.dateTime.slice(0, 10); // YYYY-MM-DD (UTC)
  const dailyNodes = {};
  dojos.nodes.forEach((n, i) => {
    const r = results[i];
    const days = ((daily.nodes?.[n.id]?.days) || []).map((d) => ({ ...d }));
    let rec = days.length && days[days.length - 1].d === today ? days[days.length - 1] : null;
    if (!rec) { rec = { d: today, up: 0, total: 0, pct: 0, close: null }; days.push(rec); }
    rec.total += 1;
    if (r.up) rec.up += 1;
    rec.pct = Math.round((rec.up / rec.total) * 1000) / 10;
    if (typeof r.height === "number") rec.close = r.height;
    if (days.length > CFG.retentionDays) days.splice(0, days.length - CFG.retentionDays);
    dailyNodes[n.id] = { days }; // only current node ids are written, so removed nodes are pruned
  });
  await writeJSONAtomic(dailyPath, {
    generated_at: ts.isoSec,
    retention_days: CFG.retentionDays,
    nodes: dailyNodes,
  });

  console.error(`[${ts.isoSec}] done: ${up}/${dojos.nodes.length} active`);
  for (const [i, n] of dojos.nodes.entries()) {
    const r = results[i];
    console.error(`  ${r.up ? "UP  " : "DOWN"} ${n.id.padEnd(28)} ${String(r.ms).padStart(6)}ms  ${r.reason || ""}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error("fatal:", e.message); process.exit(1); });
}
