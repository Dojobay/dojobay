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
import { checkUpdates } from "./updates.mjs";
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

// Ownership: a record is owned by whoever holds ANY of its payment codes,
// because a PayNym commonly has two BIP47 codes (segwit + legacy) and the
// wallet may sign Auth47 with either variant.
const owns = (rec, pc) => !!rec && Array.isArray(rec.paymentCodes) && rec.paymentCodes.includes(pc);

// Node names: operator-chosen, unique per network. The slug both keys the
// record (`${network}-${slug}`) and enforces case/punctuation-insensitive
// uniqueness of the display name.
// Signed pairing blocks arrive by clipboard, which is where stray bytes creep
// in: CRLF line endings, zero-width characters, non-breaking spaces. Wallets
// emit LF-only ASCII, so stripping these BEFORE signature verification keeps a
// mangled paste verifiable while never altering what the wallet actually
// signed. Applied at intake only; stored and emitted bytes are then clean.
const cleanSigned = (v) => {
  const t = String(v || "").replace(/\r/g, "").replace(/[\u200b\u200c\u200d\ufeff]/g, "").replace(/\u00a0/g, " ").trim();
  return t || null;
};

// Operator-set card link (name_url). http(s) only, so no javascript: or data:
// schemes can reach an href. Returns null for empty, undefined for invalid.
const cleanUrl = (v) => {
  const t = String(v || "").trim();
  if (!t) return null;
  if (t.length > 200 || !/^https?:\/\/[^\s"'<>]+$/i.test(t)) return undefined;
  return t;
};

const slugify = (name) => String(name || "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// Curated seed nodes are not in the store but still occupy the same public
// namespace, so a submission may not take a seed node's name or id.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function seedNodes() {
  const p = path.join(process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data"), "seed.json");
  try { return JSON.parse(await readFile(p, "utf8")).nodes || []; } catch { return []; }
}

// Is `slug` free on `network` for the holder of `pc`? Returns null when free
// or when it names a record the caller already owns (an update), otherwise a
// human-readable reason. Checks every store record regardless of status plus
// the curated seed, so a rejected or pending record cannot be hijacked either.
async function nameConflict(network, slug, pc) {
  for (const r of await store.listSubmissions()) {
    if (r.network !== network) continue;
    if (slugify(r.name) !== slug && r.id !== `${network}-${slug}`) continue;
    if (!owns(r, pc)) return `the name is already used by another operator's ${r.status} record`;
  }
  for (const n of await seedNodes()) {
    if (n.network !== network) continue;
    if (slugify(n.name) === slug || n.id === `${network}-${slug}`) return "the name is reserved by a curated seed node";
  }
  return null;
}

// The record an owner's (network, slug) submission should update, if any.
async function ownedRecordFor(network, slug, pc) {
  for (const r of await store.listSubmissions()) {
    if (r.network === network && owns(r, pc)
        && (slugify(r.name) === slug || r.id === `${network}-${slug}`)) return r;
  }
  return null;
}

// Manage-panel ordering: mainnet before testnet, then alphabetical by name.
const submissionOrder = (a, b) =>
  a.network !== b.network
    ? (a.network === "mainnet" ? -1 : 1)
    : String(a.name || a.id).localeCompare(String(b.name || b.id), "en", { sensitivity: "base" });
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
  const mine = (await store.submissionsFor(s.paymentCode)).sort(submissionOrder);
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
    id: s.id, network: s.network, status: s.status, name: s.name || null,
    paynym: s.paynym || null, paymentCodes: s.paymentCodes,
    jurisdiction: s.jurisdiction || null, country: s.country || null,
    hardware: s.hardware || null, signed: !!s.signed,
    version: (probes[s.id] && probes[s.id].detected_version) || s.payload?.pairing?.version || null,
    pairingUrl: s.payload?.pairing?.url || null,
    created_at: s.created_at || null, updated_at: s.updated_at || null,
    probe: probes[s.id] || null,      // { status, checked_at, block_height, checks:[] }
  }));
  json(res, 200, { admin: true, submissions: subs });
});

// The store change (approve/reject/remove) is committed before the public list
// is rebuilt, so a rebuild failure must be REPORTED, not thrown as a 500 that
// hides which half happened: the moderation applied but publication did not.
// The updater re-runs the rebuild at the start of every 10-minute cycle, so a
// failed publish heals itself; the error here tells the admin why it deferred.
async function tryRebuild() {
  try { return await rebuild(); }
  catch (e) { return { error: e.message, msg: "rebuild failed: " + e.message + " (the updater retries every 10 minutes)" }; }
}

route("POST", /^\/api\/admin\/approve$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec) return json(res, 404, { error: "not found" });
  rec.status = "approved";
  rec.updated_at = new Date().toISOString();
  if (body.paynym) rec.paynym = body.paynym.startsWith("+") ? body.paynym : "+" + body.paynym;
  else if (!rec.paynym) { const r = await resolvePayNym(rec.paymentCodes[0]).catch(() => null); if (r) rec.paynym = r; }
  // Mirror the operator's PayNym avatar now rather than waiting a cycle; the
  // updater retries missing ones every ten minutes, so failure here is fine.
  import("../scripts/update.mjs").then(({ fetchAvatar }) => Promise.all(
    rec.paymentCodes.map((c) => fetchAvatar(c, {
      proxyHost: PROBE_CFG.proxyHost, proxyPort: PROBE_CFG.proxyPort,
      destDir: path.join(process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data"), "avatars"),
    }).catch(() => {}))
  )).catch(() => {});
  await store.putSubmission(rec);
  const out = await tryRebuild();
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
  const out = await tryRebuild();   // drops it from the public list if it was approved
  json(res, 200, { ok: true, rebuild: out });
});

route("POST", /^\/api\/admin\/remove$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  await store.deleteSubmission(body.id);
  const out = await tryRebuild();
  json(res, 200, { ok: true, rebuild: out });
});

// 5) logout
route("POST", /^\/api\/logout$/, async (req, res) => {
  const sid = parseCookies(req).dojobay_sid;
  if (sid) await store.dropSession(sid);
  res.setHeader("Set-Cookie", "dojobay_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  json(res, 200, { ok: true });
});

// 6) is a node name free on a network? (pre-flight for the submission form;
//    the POST below re-checks and is the authority)
route("GET", /^\/api\/dojo\/name-check$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  const u = new URL(req.url, "http://x");
  const network = u.searchParams.get("network") === "testnet" ? "testnet" : "mainnet";
  const slug = slugify(u.searchParams.get("name"));
  if (!slug) return json(res, 400, { error: "name must contain at least one letter or digit" });
  const conflict = await nameConflict(network, slug, s.paymentCode);
  const mine = conflict ? null : await ownedRecordFor(network, slug, s.paymentCode);
  json(res, 200, { available: !conflict, reason: conflict, slug, update: !!mine, id: mine ? mine.id : `${network}-${slug}` });
});

// 7) create or replace one of my Dojo records (keyed by network + node name)
route("POST", /^\/api\/dojo$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }

  const network = body.network === "testnet" ? "testnet" : (body.network === "mainnet" ? "mainnet" : null);
  if (!network) return json(res, 400, { error: "network must be mainnet or testnet" });

  const name = String(body.name || "").trim().slice(0, 40);
  const slug = slugify(name);
  if (!slug) return json(res, 400, { error: "name is required (letters, digits and hyphens)" });
  const conflict = await nameConflict(network, slug, s.paymentCode);
  if (conflict) return json(res, 409, { error: `name "${name}" is taken on ${network}: ${conflict}` });

  const payloadErr = validatePayload(body.payload);
  if (payloadErr) return json(res, 400, { error: payloadErr });

  body.signed = cleanSigned(body.signed);
  const nameUrl = cleanUrl(body.name_url);
  if (nameUrl === undefined) return json(res, 400, { error: "link must be an http(s) URL under 200 characters" });

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

  // An owned record with this name (or this id, for records that predate
  // operator naming) is updated in place, keeping its id and therefore its
  // reliability history; otherwise a new record is created at network-slug.
  const existing = await ownedRecordFor(network, slug, s.paymentCode);
  const id = existing ? existing.id : `${network}-${slug}`;
  const now = new Date().toISOString();
  // Resolve the registered PayNym from paynym.rs (best-effort, over Tor). Keep a
  // previously resolved value if the lookup is momentarily unavailable.
  const resolvedNym = await resolvePayNym(s.paymentCode).catch(() => null);
  const rec = {
    id, network, name,
    // Union with any codes already on the record, so a record migrated with
    // both PayNym variants keeps them when the operator edits via either.
    paymentCodes: [...new Set([...(existing?.paymentCodes || []), s.paymentCode])],
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
    // A link supplied here is set; left blank, any existing link is kept (the
    // Edit panel, where the field is prefilled, is the place to clear it).
    name_url: nameUrl !== null ? nameUrl : ((existing && existing.name_url) || null),
    status: "pending",                         // moderation state: pending | approved | rejected
    last_probe: check,
    created_at: existing ? existing.created_at : now,
    updated_at: now,
  };
  await store.putSubmission(rec);
  json(res, 200, { ok: true, submission: rec, note: "Submitted for review. It will appear once a maintainer approves it." });
});

// Editable metadata: name and hardware. The Dojo version is NOT editable it is
// read live from the node's X-Dojo-Version response header by the updater (see
// scripts/update.mjs), so it always reflects what the node is actually running.
// These are display fields, so an edit keeps the record's moderation status and
// its id (and therefore its history); only a full resubmission re-enters
// moderation. A rename must not collide with ANY other record's name on that
// network, including the editor's own other records, hence the excludeId scan.
async function slugTakenByOther(network, slug, excludeId) {
  for (const r of await store.listSubmissions()) {
    if (r.id === excludeId || r.network !== network) continue;
    if (slugify(r.name) === slug || r.id === `${network}-${slug}`) {
      return `the name is already used by ${r.paynym || "another"}'s ${r.status} record`;
    }
  }
  for (const n of await seedNodes()) {
    if (n.network !== network || n.id === excludeId) continue;
    if (slugify(n.name) === slug || n.id === `${network}-${slug}`) return "the name is reserved by a curated seed node";
  }
  return null;
}

async function applyEdit(rec, body, res) {
  const name = String(body.name || "").trim().slice(0, 40);
  const slug = slugify(name);
  if (!slug) return json(res, 400, { error: "name is required (letters, digits and hyphens)" });
  const taken = await slugTakenByOther(rec.network, slug, rec.id);
  if (taken) return json(res, 409, { error: `name "${name}" is taken on ${rec.network}: ${taken}` });
  const nameUrl = cleanUrl(body.name_url);
  if (nameUrl === undefined) return json(res, 400, { error: "link must be an http(s) URL under 200 characters" });
  rec.name = name;
  rec.name_url = nameUrl;                           // prefilled in the form, so blank is a deliberate clear
  rec.hardware = String(body.hardware || "").trim().slice(0, 120) || null;
  rec.updated_at = new Date().toISOString();
  await store.putSubmission(rec);
  const out = rec.status === "approved" ? await tryRebuild() : null;   // approved edits publish immediately
  json(res, 200, { ok: true, submission: rec, rebuild: out });
}

// 9) edit display fields on one of my records
route("POST", /^\/api\/dojo\/edit$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec || !owns(rec, s.paymentCode)) return json(res, 404, { error: "not found" });
  await applyEdit(rec, body, res);
});

// 10) admin: edit display fields on any record
route("POST", /^\/api\/admin\/edit$/, async (req, res) => {
  const s = await adminFrom(req, res);
  if (!s) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec) return json(res, 404, { error: "not found" });
  await applyEdit(rec, body, res);
});

// 12) admin: how far behind is this instance? Cached for six hours; failure
//     (GitHub unreachable over Tor, or an undeployed dev build) is reported
//     in-band so the admin panel can show "unavailable" without erroring.
// A self-update runs as a single background job with polled progress. Only one
// at a time; the job object is the source of truth the poll route returns.
let UPDATE_JOB = null;   // { id, phase, log[], done, ok, error, source, version, needsRefresh }
route("POST", /^\/api\/admin\/update$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  if (UPDATE_JOB && !UPDATE_JOB.done) return json(res, 409, { error: "an update is already in progress" });
  let body; try { body = JSON.parse(await readBody(req)); } catch { body = {}; }

  const id = Date.now().toString(36);
  const job = UPDATE_JOB = { id, phase: "starting", log: [], done: false, ok: false, error: null,
    source: body.source === "peer" ? "peer" : "github", version: null, needsRefresh: false };
  const log = (line) => { job.log.push(line); if (job.log.length > 200) job.log.shift(); };

  // Run detached from the request: reply immediately with the job id.
  (async () => {
    try {
      const cfg = { proxyHost: PROBE_CFG.proxyHost, proxyPort: PROBE_CFG.proxyPort };
      const { fetchFromGitHub, fetchFromPeer, applyUpdate } = await import("./self-update.mjs");
      let fetched;
      job.phase = "fetching";
      if (job.source === "peer") {
        const onionHost = String(body.onion || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        if (!/^[a-z2-7]{56}\.onion$/.test(onionHost)) throw new Error("a valid peer .onion is required");
        fetched = await fetchFromPeer({ onionHost, trustedCode: body.code || null, cfg, log });
      } else {
        fetched = await fetchFromGitHub({ cfg, log });
      }
      job.version = fetched.version;
      job.phase = "applying";
      const r = await applyUpdate({ ...fetched, webRoot: ROOT, log });
      job.needsRefresh = true;                 // front end should hard-reload once the service is back
      job.phase = "restarting";
      job.ok = true; job.done = true;
      log("update staged from " + fetched.sourceLabel + "; service is restarting.");
    } catch (e) {
      job.error = e.message; job.ok = false; job.done = true; job.phase = "failed";
      log("✗ " + e.message);
    }
  })();

  json(res, 202, { started: true, id });
});

route("GET", /^\/api\/admin\/update\/status$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  // After a successful apply the service restarts; on the way back up the
  // helper leaves data/updates/last-result.json, which we surface so the panel
  // can confirm completion across the restart.
  let lastResult = null;
  try { lastResult = JSON.parse(await readFile(path.join(process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data"), "updates", "last-result.json"), "utf8")); } catch {}
  json(res, 200, { job: UPDATE_JOB, lastResult });
});

let UPDATES_CACHE = null;
route("GET", /^\/api\/admin\/updates$/, async (req, res) => {
  if (!(await adminFrom(req, res))) return;
  if (UPDATES_CACHE && Date.now() - UPDATES_CACHE.at < 6 * 3600 * 1000) {
    return json(res, 200, UPDATES_CACHE.result);
  }
  try {
    const result = { available: true, ...(await checkUpdates({ cfg: { proxyHost: PROBE_CFG.proxyHost, proxyPort: PROBE_CFG.proxyPort } })) };
    UPDATES_CACHE = { at: Date.now(), result };
    json(res, 200, result);
  } catch (e) {
    json(res, 200, { available: false, error: e.message });
  }
});

// 11) reliability export: the full 24h check series and 90-day rollups in one
//     document, optionally filtered to a single node. Not linked anywhere on
//     the front end; the raw files also remain at /data/history.json and
//     /data/history-daily.json.
route("GET", /^\/api\/history\/export$/, async (req, res) => {
  const u = new URL(req.url, "http://x");
  const id = u.searchParams.get("id");
  const dataDir = process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data");
  const read = async (f, fb) => { try { return JSON.parse(await readFile(path.join(dataDir, f), "utf8")); } catch { return fb; } };
  const hist = await read("history.json", { nodes: {} });
  const daily = await read("history-daily.json", { nodes: {} });
  const ids = id ? [id] : [...new Set([...Object.keys(hist.nodes || {}), ...Object.keys(daily.nodes || {})])].sort();
  const nodes = {};
  for (const k of ids) {
    const h = (hist.nodes || {})[k], d = (daily.nodes || {})[k];
    if (!h && !d) continue;
    nodes[k] = { checks: (h && h.checks) || [], days: (d && d.days) || [] };
    const retired = (h && h.retired) || (d && d.retired);
    if (retired) nodes[k].retired = retired;
  }
  if (id && !nodes[id]) return json(res, 404, { error: "no history for that id" });
  json(res, 200, {
    generated_at: new Date().toISOString(),
    interval_minutes: hist.interval_minutes || 10,
    window_checks: hist.window_checks || 144,
    nodes,
  });
});

// 8) delete one of my records
route("POST", /^\/api\/dojo\/delete$/, async (req, res) => {
  const s = await sessionFrom(req);
  if (!s) return json(res, 401, { error: "not authenticated" });
  let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
  const rec = await store.getSubmission(body.id);
  if (!rec || !owns(rec, s.paymentCode)) return json(res, 404, { error: "not found" });
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
