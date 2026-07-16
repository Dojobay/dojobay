#!/usr/bin/env node
// Merge the curated seed list with APPROVED self-service submissions into the
// public data/dojos.json that the front-end and the 10-minute updater consume.
// The seed list (data/seed.json) stays under maintainer control; only approved
// submissions are added. A newly-approved node inherits the status, block
// height and reliability history the updater already recorded for it while it
// was pending (see scripts/update.mjs and server/data/pending-probe.json), so
// it appears active with its uptime intact the moment it is published.
//
// Exposes rebuild() for in-process use by the admin API; runs it when invoked
// directly from the CLI.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { store } from "./store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJSON(p, fallback) {
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
}
async function writeAtomic(p, obj) {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, p);
}

// The payment code shown on a card. A PayNym commonly has two BIP47 variants
// and records store every variant; the canonical one people share (and the one
// shown on paynym.rs profiles) is the NON-segwit code, so prefer that when the
// paynym-codes mapping can identify it, falling back to the record's first.
// Exported for the self-test.
export function displayPaymentCode(sub, mapping) {
  const codes = Array.isArray(sub.paymentCodes) ? sub.paymentCodes : [];
  if (!codes.length) return null;
  const entry = sub.paynym && mapping && mapping[sub.paynym];
  const legacy = entry && (entry.codes || []).find((c) => !c.segwit && codes.includes(c.code));
  return (legacy && legacy.code) || codes[0];
}

function toPublicNode(sub, paymentCode) {
  return {
    id: sub.id,
    network: sub.network,
    name: sub.name || sub.paynym || sub.id,
    name_url: sub.name_url || null,
    status: "inactive",
    paynym: sub.paynym || null,
    paymentCode: paymentCode || null,
    jurisdiction: sub.jurisdiction || null,
    country: sub.country || null,
    hardware: sub.hardware || null,
    // `version` is an operator-editable override; the wallet pairing payload's
    // version remains the default and is untouched by edits.
    version: sub.version || sub.payload?.pairing?.version || null,
    checked_at: null,
    payload: sub.payload,
    signed: sub.signed || null,
  };
}

// Grace-period retirement for history entries. Deleting history the instant an
// id leaves the node list turned a transient list mistake into permanent data
// loss (the seed-migration deploy wiped every migrated node's history seconds
// after rsync, via the post-deploy rebuild, before the migration could run on
// the box). Instead: an unlisted id is STAMPED `retired` and kept; it is only
// deleted after HISTORY_GRACE_DAYS (default 14); if the id is listed again
// within the window, the stamp is cleared and its history resumes untouched.
// Exported because scripts/update.mjs rewrites the same two files every cycle
// and must apply identical rules.
export function retireUnlisted(nodesMap, isListed, nowIso, graceDays = Number(process.env.HISTORY_GRACE_DAYS || 14)) {
  let touched = false;
  const cutoffMs = Date.parse(nowIso) - graceDays * 86400000;
  for (const id of Object.keys(nodesMap)) {
    const entry = nodesMap[id];
    if (isListed(id)) {
      if (entry.retired) { delete entry.retired; touched = true; }
    } else if (!entry.retired) {
      entry.retired = nowIso; touched = true;
    } else if (Date.parse(entry.retired) < cutoffMs) {
      delete nodesMap[id]; touched = true;
    }
  }
  return touched;
}

export async function rebuild() {
  const DATA_DIR = process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data");
  const SERVER_DATA = process.env.SERVER_DATA_DIR || path.join(ROOT, "server", "data");
  const SEED = path.join(DATA_DIR, "seed.json");
  const OUT = path.join(DATA_DIR, "dojos.json");
  const HIST = path.join(DATA_DIR, "history.json");
  const DAILY = path.join(DATA_DIR, "history-daily.json");
  const PENDING_PROBE = path.join(SERVER_DATA, "pending-probe.json");

  const seed = await readJSON(SEED, { nodes: [] });
  // Optional: identifies each PayNym's non-segwit code variant for display.
  const codesDoc = await readJSON(path.join(DATA_DIR, "paynym-codes.json"), { mapping: {} });
  // The operator binding is REQUIRED: an instance must prove who runs it.
  // Warn (unmissably) rather than fail, so a malformed signature nags the
  // operator without taking the directory down for its visitors. The crypto
  // import is lazy so the dependency-free scripts/ chain can still import
  // this module on a box where server/node_modules is not installed yet.
  try {
    const opDoc = await readJSON(path.join(DATA_DIR, "operator.json"), null);
    if (!opDoc) {
      console.error("[rebuild] REQUIRED: data/operator.json is missing. Sign your onion URL with your wallet and install the binding (the installer does this); see README.");
    } else {
      try {
        const { verifyOperatorDoc } = await import("./crypto.mjs");
        const v = verifyOperatorDoc(opDoc);
        if (!v.ok) console.error(`[rebuild] REQUIRED: data/operator.json does not verify: ${v.error}`);
      } catch { console.error("[rebuild] note: cannot verify operator.json (server dependencies not installed)."); }
    }
  } catch (e) { console.error(`[rebuild] operator.json check skipped: ${e.message}`); }

  // Anchor-model checks (warnings, never fatal: a fresh instance mid-setup or
  // mid-transition should build, just noisily). The seed should hold exactly
  // one node -- the instance operator's own, carrying their payment code --
  // and every listed node should carry a BIP47 code; code-less records are
  // grandfathered exceptions managed from /admin.
  if ((seed.nodes || []).length !== 1) {
    console.error(`[rebuild] note: seed carries ${(seed.nodes || []).length} node(s); the anchor model expects exactly one (the instance operator's own node).`);
  } else if (!seed.nodes[0].paymentCode) {
    console.error(`[rebuild] warning: the anchor seed node ${seed.nodes[0].id} has no BIP47 payment code.`);
  }
  const approvedSubs = (await store.listSubmissions()).filter((s) => s.status === "approved");
  const codeless = approvedSubs.filter((s) => !(s.paymentCodes || []).length);
  if (codeless.length) {
    console.error(`[rebuild] warning: ${codeless.length} listed node(s) without a BIP47 payment code (legacy exceptions, /admin-managed): ${codeless.map((s) => s.id).join(", ")}`);
  }
  const approved = approvedSubs.map((s) => toPublicNode(s, displayPaymentCode(s, codesDoc.mapping)));
  const approvedIds = new Set(approved.map((n) => n.id));

  const byId = new Map();
  for (const n of (seed.nodes || [])) byId.set(n.id, n);
  for (const n of approved) byId.set(n.id, n);
  const nodes = [...byId.values()];

  // Carry over the live status the updater last wrote, so a rebuild does not
  // blank a node for a probe cycle.
  const prior = await readJSON(OUT, { nodes: [] });
  const priorById = new Map((prior.nodes || []).map((n) => [n.id, n]));
  // Pending-probe results (updater-owned): seed a just-approved node's status
  // and height from what was observed while it was pending.
  const pending = await readJSON(PENDING_PROBE, { nodes: {} });
  for (const n of nodes) {
    const p = priorById.get(n.id);
    if (p) {
      n.status = p.status ?? n.status;
      n.checked_at = p.checked_at ?? n.checked_at;
      if (p.block_height != null) n.block_height = p.block_height;
    } else if (approvedIds.has(n.id) && pending.nodes?.[n.id]) {
      const pr = pending.nodes[n.id];
      n.status = pr.status ?? n.status;
      n.checked_at = pr.checked_at ?? n.checked_at;
      if (pr.block_height != null) n.block_height = pr.block_height;
    }
  }

  await writeAtomic(OUT, {
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    interval_minutes: 10,
    nodes,
  });

  // Reliability history: ensure a bucket per node, seed a newly-approved node's
  // history from its pending history, and retire (grace period) unlisted ids.
  const hist = await readJSON(HIST, { interval_minutes: 10, window_checks: 144, nodes: {} });
  let touched = false;
  for (const n of nodes) {
    if (!hist.nodes[n.id]) {
      const seedChecks = (approvedIds.has(n.id) && pending.nodes?.[n.id]?.checks) || [];
      hist.nodes[n.id] = { checks: seedChecks.slice() };
      touched = true;
    }
  }
  const nowIso = new Date().toISOString();
  touched = retireUnlisted(hist.nodes, (id) => byId.has(id), nowIso) || touched;
  if (touched) { hist.generated_at = hist.generated_at || null; await writeAtomic(HIST, hist); }

  // 90-day daily rollup membership.
  const dailyDoc = await readJSON(DAILY, { retention_days: 90, nodes: {} });
  let dailyTouched = false;
  for (const n of nodes) if (!dailyDoc.nodes[n.id]) {
    dailyDoc.nodes[n.id] = { days: (approvedIds.has(n.id) && pending.nodes?.[n.id]?.days) ? pending.nodes[n.id].days.slice() : [] };
    dailyTouched = true;
  }
  dailyTouched = retireUnlisted(dailyDoc.nodes, (id) => byId.has(id), nowIso) || dailyTouched;
  if (dailyTouched) await writeAtomic(DAILY, dailyDoc);

  const msg = `public list rebuilt: ${nodes.length} nodes (${approved.length} approved submissions).`;
  return { nodes: nodes.length, approved: approved.length, msg };
}

// Run when invoked directly.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const r = await rebuild();
  console.log(r.msg);
}
