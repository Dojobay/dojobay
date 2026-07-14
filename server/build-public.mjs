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

function toPublicNode(sub) {
  return {
    id: sub.id,
    network: sub.network,
    name: sub.name || sub.paynym || sub.id,
    name_url: sub.name_url || null,
    status: "inactive",
    paynym: sub.paynym || null,
    jurisdiction: sub.jurisdiction || null,
    country: sub.country || null,
    hardware: sub.hardware || null,
    version: sub.payload?.pairing?.version || null,
    checked_at: null,
    payload: sub.payload,
    signed: sub.signed || null,
  };
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
  const approvedSubs = (await store.listSubmissions()).filter((s) => s.status === "approved");
  const approved = approvedSubs.map(toPublicNode);
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
  // history from its pending history, and prune ids no longer listed.
  const hist = await readJSON(HIST, { interval_minutes: 10, window_checks: 144, nodes: {} });
  let touched = false;
  for (const n of nodes) {
    if (!hist.nodes[n.id]) {
      const seedChecks = (approvedIds.has(n.id) && pending.nodes?.[n.id]?.checks) || [];
      hist.nodes[n.id] = { checks: seedChecks.slice() };
      touched = true;
    }
  }
  for (const id of Object.keys(hist.nodes)) if (!byId.has(id)) { delete hist.nodes[id]; touched = true; }
  if (touched) { hist.generated_at = hist.generated_at || null; await writeAtomic(HIST, hist); }

  // 90-day daily rollup membership.
  const dailyDoc = await readJSON(DAILY, { retention_days: 90, nodes: {} });
  let dailyTouched = false;
  for (const n of nodes) if (!dailyDoc.nodes[n.id]) {
    dailyDoc.nodes[n.id] = { days: (approvedIds.has(n.id) && pending.nodes?.[n.id]?.days) ? pending.nodes[n.id].days.slice() : [] };
    dailyTouched = true;
  }
  for (const id of Object.keys(dailyDoc.nodes)) if (!byId.has(id)) { delete dailyDoc.nodes[id]; dailyTouched = true; }
  if (dailyTouched) await writeAtomic(DAILY, dailyDoc);

  const msg = `public list rebuilt: ${nodes.length} nodes (${approved.length} approved submissions).`;
  return { nodes: nodes.length, approved: approved.length, msg };
}

// Run when invoked directly.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const r = await rebuild();
  console.log(r.msg);
}
