#!/usr/bin/env node
// The Dojo Bay — self-service submission backend (step 2 feature).
//
// Auth47 login, then a gated "manage my Dojo" API. Two hard gates on any create
// or pairing-changing edit:
//   1. connection gate: the pairing code's .onion must currently answer over Tor
//   2. signature gate:  any supplied signed payload must verify against the
//      notification address of the authenticated payment code (lab logic)
// Passing both puts the record in a moderation queue; a maintainer approves it
// (see admin.mjs) before build-public.mjs merges it into the public dojos.json.
//
// Runs behind nginx on 127.0.0.1. No passwords, no external database.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { store } from "./store.mjs";
import { makeAuth47, notificationAddress, verifySignedPayload } from "./crypto.mjs";
import { probe, PROBE_CFG } from "./probe.mjs";
import { resolvePayNym } from "./paynym.mjs";
import { rebuild } from "./build-public.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = +(process.env.PORT || 8787);
// The public origin of the site (its .onion), needed for the Auth47 callback + resource.
const BASE_URL = process.env.BASE_URL || "http://localhost";
const NONCE_TTL = 5 * 60 * 1000;      // Auth47 nonces valid 5 minutes
const SESSION_TTL = 12 * 60 * 60 * 1000;

// BIP47 payment codes permitted to moderate at /admin. Per-operator config, set
// in the systemd unit (Environment=ADMIN_PAYMENT_CODES=...); never hard-coded,
// so a fork's operator sets their own.
const ADMIN_CODES = (process.env.ADMIN_PAYMENT_CODES || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const isAdmin = (pc) => !!pc && ADMIN_CODES.includes(pc);

const SERVER_DATA = process.env.SERVER_DATA_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");
async function pendingProbe() {
  try { return JSON.parse(await readFile(path.join(SERVER_DATA, "pending-probe.json"), "utf8")); }
  catch { return { nodes: {} }; }
}

const auth47 = makeAuth47(BASE_URL);

// ---- helpers ---------------------------------------------------------------
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
};
const readBody = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
  let data = ""; let size = 0;
  req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); } else data += c; });
  req.on("end", () => resolve(data));
  req.on("error", reject);
});
function parseCookies(req) {
  const out = {}; const h = req.headers.cookie || "";
  h.split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
async function sessionFrom(req) {
  const sid = parseCookies(req).dojobay_sid;
  return sid ? await store.getSession(sid) : null;
}
function networkOf(rec) { return rec === "testnet" ? "testnet" : "bitcoin"; }
const isPlainOnionUrl = (u) => { try { const x = new URL(u); return x.protocol === "http:" && /\.onion$/.test(x.hostname); } catch { return false; } };
// Electrum/indexer endpoints are a bare TCP (or SSL) onion socket, e.g.
// tcp://<56-char>.onion:50001 , not an HTTP URL, so they need their own check.
const isIndexerUrl = (u) => typeof u === "string" && /^(tcp|ssl):\/\/[a-z2-7]{56}\.onion:\d{2,5}(\/.*)?$/i.test(u);

// Best-effort: pull an Electrum/indexer endpoint from an explicit payload.indexer
// field or from a modern services[] array. Display-only metadata: it is never
// probed by the connection gate nor part of the signed pairing, so a malformed
// or absent indexer simply yields null and never blocks a submission.
function extractIndexer(payload) {
  let cand = payload && payload.indexer;
  if ((!cand || !cand.url) && Array.isArray(payload && payload.services)) {
    cand = payload.services.find((s) => s && s.type === "indexer");
  }
  if (!cand || !isIndexerUrl(cand.url)) return null;
  return { type: "indexer", kind: cand.kind || null, url: cand.url };
}

// Canonical pairing JSON string the operator must have signed.
function canonicalPairing(payload) {
  return JSON.stringify({ pairing: payload.pairing, explorer: payload.explorer });
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return "missing pairing payload";
  const p = payload.pairing;
  if (!p || p.type !== "dojo.api" || !p.url) return "pairing.type must be dojo.api with a url";
  if (!isPlainOnionUrl(p.url)) return "pairing.url must be an http .onion address";
  if (payload.explorer && !isPlainOnionUrl(payload.explorer.url)) return "explorer.url must be an http .onion address";
  return null;
}

// ---- routes ----------------------------------------------------------------
const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

// 1) begin login: mint nonce + challenge URI (QR-encoded client-side)
route("POST", /^\/api\/auth47\/challenge$/, async (req, res) => {
  await store.gcNonces();
  const nonce = randomBytes(16).toString("hex");            // 32 alphanumeric chars
  const expires = Date.now() + NONCE_TTL;
  const uri = auth47.challengeURI(nonce, Math.floor(expires / 1000), BASE_URL);
  await store.putNonce(nonce, { expires, used: false, sid: null });
  json(res, 200, { nonce, uri, expires });
});

// 2) wallet callback: verify proof, bind nonce -> payment code
route("POST", /^\/api\/auth47\/callback$/, async (req, res) => {
  let proof;
  try { proof = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const v = auth47.verify(proof);
  if (!v.ok) return json(res, 401, { error: v.error });
  // tie proof back to a live nonce (prevents replay to a different session)
  let nonce = null;
  try { nonce = new URL(proof.challenge).hostname; } catch {}
  const rec = nonce ? await store.takeNonce(nonce) : null;
  if (!rec) return json(res, 401, { error: "unknown or expired nonce" });
  if (rec.expires < Date.now()) return json(res, 401, { error: "challenge expired" });
  const sid = await store.putSession({ paymentCode: v.paymentCode, expires: Date.now() + SESSION_TTL });
  // stash the sid against the nonce value so the browser poll can pick it up
  await store.putNonce("claimed:" + nonce, { expires: Date.now() + NONCE_TTL, sid });
  json(res, 200, { ok: true });
});

// 3) browser poll: has my nonce been claimed? if so, set the session cookie
route("GET", /^\/api\/auth47\/poll$/, async (req, res) => {
  const u = new URL(req.url, "http://x");
  const nonce = u.searchParams.get("nonce") || "";
  const claim = await store.takeNonce("claimed:" + nonce);
  if (!claim) return json(res, 200, { authenticated: false });
  res.setHeader("Set-Cookie",
    `dojobay_sid=${claim.sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
  json(res, 200, { authenticated: true });
});

// 4) who am I
route("GET", /^\/api\/me$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 200, { authenticated: false });
  const mine = await store.submissionsFor(s.paymentCode);
  json(res, 200, { authenticated: true, paymentCode: s.paymentCode, admin: isAdmin(s.paymentCode), submissions: mine });
});

// ---- admin (moderation) ----------------------------------------------------
// All require an authenticated session whose payment code is in ADMIN_CODES.
async function adminFrom(req, res) {
  const s = await sessionFrom(req);
  if (!s) { json(res, 401, { error: "not authenticated" }); return null; }
  if (!isAdmin(s.paymentCode)) { json(res, 403, { error: "not authorised" }); return null; }
  return s;
}

// list submissions with their pending-probe status + reliability history
route("GET", /^\/api\/admin\/submissions$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  const probes = (await pendingProbe()).nodes || {};
  const subs = (await store.listSubmissions()).map((s) => ({
    id: s.id, network: s.network, status: s.status,
    paynym: s.paynym || null, paymentCode: s.paymentCode,
    jurisdiction: s.jurisdiction || null, country: s.country || null,
    hardware: s.hardware || null, signed: !!s.signed,
    version: s.payload?.pairing?.version || null,
    pairingUrl: s.payload?.pairing?.url || null,
    created_at: s.created_at || null, updated_at: s.updated_at || null,
    probe: probes[s.id] || null,      // { status, checked_at, block_height, checks:[] }
  }));
  json(res, 200, { admin: true, submissions: subs });
});

route("POST", /^\/api\/admin\/approve$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec) return json(res, 404, { error: "not found" });
  rec.status = "approved";
  rec.updated_at = new Date().toISOString();
  if (body.paynym) rec.paynym = body.paynym.startsWith("+") ? body.paynym : "+" + body.paynym;
  else if (!rec.paynym) { const r = await resolvePayNym(rec.paymentCode).catch(() => null); if (r) rec.paynym = r; }
  await store.putSubmission(rec);
  const out = await rebuild();
  json(res, 200, { ok: true, submission: rec, rebuild: out });
});

route("POST", /^\/api\/admin\/reject$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec) return json(res, 404, { error: "not found" });
  rec.status = "rejected";
  rec.updated_at = new Date().toISOString();
  await store.putSubmission(rec);
  const out = await rebuild();   // drops it from the public list if it was approved
  json(res, 200, { ok: true, rebuild: out });
});

route("POST", /^\/api\/admin\/remove$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  await store.deleteSubmission(body.id);
  const out = await rebuild();
  json(res, 200, { ok: true, rebuild: out });
});

// 5) logout
route("POST", /^\/api\/logout$/, async (req, res) => {
  const sid = parseCookies(req).dojobay_sid;
  if (sid) await store.dropSession(sid);
  res.setHeader("Set-Cookie", "dojobay_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  json(res, 200, { ok: true });
});

// 6) create or replace one of my Dojo records (per network)
route("POST", /^\/api\/dojo$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }

  const network = body.network === "testnet" ? "testnet" : (body.network === "mainnet" ? "mainnet" : null);
  if (!network) return json(res, 400, { error: "network must be mainnet or testnet" });

  const payloadErr = validatePayload(body.payload);
  if (payloadErr) return json(res, 400, { error: payloadErr });

  // signature gate (optional field, but if present it must verify)
  if (body.signed) {
    const sig = verifySignedPayload({
      signedText: body.signed,
      expectedMessage: canonicalPairing(body.payload),
      expectedAddress: notificationAddress(s.paymentCode, networkOf(network)),
      network: networkOf(network),
    });
    if (!sig.ok) return json(res, 400, { error: "signature gate: " + sig.error });
  }

  // connection gate: the node must answer right now over Tor. When the pairing
  // payload carries an apikey (it should), this performs the same authenticated
  // chain-tip read the health checker uses, so a submission must prove its
  // apikey works and the Dojo is serving block data, not merely that the onion
  // is reachable. Without an apikey it falls back to a plain reachability probe.
  const check = await probe(body.payload.pairing.url, { ...PROBE_CFG, apikey: body.payload.pairing.apikey, network });
  if (!check.up) return json(res, 422, { error: "connection gate: node unreachable or not serving block data over Tor (" + (check.reason || "no response") + ")", probe: check });

  const id = `${network}-${s.paymentCode.slice(0, 12)}`;
  const now = new Date().toISOString();
  const existing = await store.getSubmission(id);
  // Resolve the registered PayNym from paynym.rs (best-effort, over Tor). Keep a
  // previously resolved value if the lookup is momentarily unavailable.
  const resolvedNym = await resolvePayNym(s.paymentCode).catch(() => null);
  const rec = {
    id, network, paymentCode: s.paymentCode,
    paynym: resolvedNym || (existing && existing.paynym) || null,
    jurisdiction: (body.jurisdiction || "").toString().slice(0, 64) || null,
    country: (body.country || "").toString().slice(0, 2).toUpperCase() || null,
    hardware: (body.hardware || "").toString().slice(0, 120) || null,
    payload: (() => {
      const base = { pairing: body.payload.pairing, explorer: body.payload.explorer };
      const indexer = extractIndexer(body.payload);
      return indexer ? { ...base, indexer } : base;
    })(),
    signed: body.signed || null,
    status: "pending",                         // moderation state: pending | approved | rejected
    last_probe: check,
    created_at: existing ? existing.created_at : now,
    updated_at: now,
  };
  await store.putSubmission(rec);
  json(res, 200, { ok: true, submission: rec, note: "Submitted for review. It will appear once a maintainer approves it." });
});

// 7) delete one of my records
route("POST", /^\/api\/dojo\/delete$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec || rec.paymentCode !== s.paymentCode) return json(res, 404, { error: "not found" });
  await store.deleteSubmission(body.id);
  json(res, 200, { ok: true });
});

// ---- server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://x").pathname;
    for (const r of routes) {
      if (r.method === req.method && r.re.test(path)) return await r.fn(req, res);
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: "server error", detail: e.message });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`dojobay backend on 127.0.0.1:${PORT} (base ${BASE_URL})`));

export { server, routes };
