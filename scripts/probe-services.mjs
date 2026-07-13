#!/usr/bin/env node
// READ-ONLY discovery. Writes nothing, changes nothing.
//
// For every node in data/dojos.json: log in with its apikey over Tor, then call
// the endpoints below and report what comes back. /support/services was added in
// Dojo v1.27.0 and exposes the explorer, soroban and indexer (Electrum) entries;
// it supersedes the deprecated `explorer` field in the pairing payload. Older
// Dojos will not have it, so expect partial coverage.
//
//   node scripts/probe-services.mjs            summary table
//   node scripts/probe-services.mjs --raw      dump full JSON per node
//   node scripts/probe-services.mjs --raw --only mainnet-otto
//
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { socks5Connect } from "./update.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CFG = {
  proxyHost: process.env.TOR_SOCKS_HOST || "127.0.0.1",
  proxyPort: +(process.env.TOR_SOCKS_PORT || 9050),
  timeoutMs: +(process.env.TIMEOUT_MS || 30000),
  concurrency: +(process.env.CONCURRENCY || 4),
};
const RAW = process.argv.includes("--raw");
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > -1 ? process.argv[i + 1] : null; })();

// Candidate endpoints, tried in order. We dump whatever each returns.
const ENDPOINTS = ["/support/services", "/support/info", "/status"];

function httpOverTor(host, port, rawReq) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try { sock = await socks5Connect(CFG.proxyHost, CFG.proxyPort, host, port, CFG.timeoutMs); }
    catch (e) { return reject(e); }
    let buf = "";
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(t); try { sock.destroy(); } catch {} fn(v); };
    const t = setTimeout(() => done(reject, new Error("read-timeout")), CFG.timeoutMs);
    sock.on("data", (d) => { buf += d.toString("utf8"); });
    sock.on("error", (e) => done(reject, e));
    sock.on("close", () => {
      const m = buf.match(/^HTTP\/1\.[01] (\d{3})/);
      const i = buf.indexOf("\r\n\r\n");
      done(resolve, { status: m ? +m[1] : 0, body: i >= 0 ? buf.slice(i + 4) : "" });
    });
    sock.write(rawReq);
  });
}

async function login(host, port, base, apikey) {
  const body = `apikey=${encodeURIComponent(apikey)}`;
  const req = `POST ${base}/auth/login HTTP/1.0\r\nHost: ${host}\r\n` +
    `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
    `Connection: close\r\n\r\n${body}`;
  const res = await httpOverTor(host, port, req);
  if (res.status !== 200) throw new Error(`login HTTP ${res.status || "no-response"}`);
  const tok = JSON.parse(res.body)?.authorizations?.access_token;
  if (!tok) throw new Error("login: no token");
  return tok;
}

async function get(host, port, base, endpoint, token) {
  const req = `GET ${base}${endpoint} HTTP/1.0\r\nHost: ${host}\r\n` +
    `Authorization: Bearer ${token}\r\nConnection: close\r\n\r\n`;
  const res = await httpOverTor(host, port, req);
  let json = null;
  try { json = JSON.parse(res.body); } catch {}
  return { status: res.status, json, body: res.body };
}

// Pull an indexer/Electrum endpoint out of whatever shape came back.
function findIndexer(obj) {
  if (!obj || typeof obj !== "object") return null;
  const arr = Array.isArray(obj) ? obj : (Array.isArray(obj.services) ? obj.services : null);
  if (arr) {
    const hit = arr.find((s) => s && (s.type === "indexer" || s.kind === "fulcrum" || s.kind === "electrum"));
    if (hit?.url) return hit.url;
  }
  if (obj.indexer) {
    if (typeof obj.indexer === "string") return obj.indexer;
    if (obj.indexer.url) return obj.indexer.url;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") { const r = findIndexer(v); if (r) return r; }
  }
  return null;
}
function findVersion(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of ["version", "dojo_version", "api_version"]) {
    if (typeof obj[k] === "string") return obj[k];
    if (obj[k]?.version) return obj[k].version;
  }
  if (obj.dojo?.version) return obj.dojo.version;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") { const r = findVersion(v); if (r) return r; }
  }
  return null;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

const dojos = JSON.parse(await readFile(path.join(ROOT, "data", "dojos.json"), "utf8"));
let nodes = dojos.nodes.filter((n) => n?.payload?.pairing?.url && n?.payload?.pairing?.apikey);
if (ONLY) nodes = nodes.filter((n) => n.id === ONLY);

console.log(`probing ${nodes.length} node(s) via socks5h://${CFG.proxyHost}:${CFG.proxyPort}\n`);

const results = await pool(nodes, CFG.concurrency, async (n) => {
  const u = new URL(n.payload.pairing.url);
  const host = u.hostname, port = u.port ? +u.port : 80;
  const base = (u.pathname || "/v2").replace(/\/+$/, "") || "/v2";
  try {
    const token = await login(host, port, base, n.payload.pairing.apikey);
    const found = {};
    for (const ep of ENDPOINTS) {
      try {
        const r = await get(host, port, base, ep, token);
        found[ep] = r;
        if (RAW) {
          console.log(`--- ${n.id}  GET ${base}${ep}  -> HTTP ${r.status}`);
          console.log(r.json ? JSON.stringify(r.json, null, 2) : (r.body || "(empty)").slice(0, 600));
          console.log("");
        }
      } catch (e) { found[ep] = { status: 0, error: e.message }; }
    }
    const svc = found["/support/services"];
    return {
      id: n.id,
      version: n.version || null,
      apiVersion: findVersion(svc?.json) || findVersion(found["/support/info"]?.json) || null,
      indexer: findIndexer(svc?.json),
      svcStatus: svc?.status ?? 0,
      note: null,
    };
  } catch (e) {
    return { id: n.id, version: n.version || null, apiVersion: null, indexer: null, svcStatus: 0, note: e.message };
  }
});

console.log("id".padEnd(30) + "listed".padEnd(9) + "api ver".padEnd(10) + "svc".padEnd(6) + "indexer / note");
console.log("-".repeat(110));
for (const r of results) {
  console.log(
    r.id.padEnd(30) +
    String(r.version || "-").padEnd(9) +
    String(r.apiVersion || "-").padEnd(10) +
    String(r.svcStatus || "-").padEnd(6) +
    (r.indexer || (r.note ? "! " + r.note : "(none)"))
  );
}
const withIdx = results.filter((r) => r.indexer).length;
console.log(`\n${withIdx}/${results.length} node(s) expose an indexer endpoint.`);
