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

const PORT = +(process.env.PORT || 8787);
// The public origin of the site (its .onion), needed for the Auth47 callback + resource.
const BASE_URL = process.env.BASE_URL || "http://localhost";
const NONCE_TTL = 5 * 60 * 1000;      // Auth47 nonces valid 5 minutes
const SESSION_TTL = 12 * 60 * 60 * 1000;

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
  json(res, 200, { authenticated: true, paymentCode: s.paymentCode, submissions: mine });
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

  // connection gate: the pairing onion must answer right now over Tor
  const check = await probe(body.payload.pairing.url, PROBE_CFG);
  if (!check.up) return json(res, 422, { error: "connection gate: node unreachable over Tor (" + (check.reason || "no response") + ")", probe: check });

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
    payload: { pairing: body.payload.pairing, explorer: body.payload.explorer },
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
