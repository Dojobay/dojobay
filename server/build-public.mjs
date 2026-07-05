#!/usr/bin/env node
// Merge the curated seed list with APPROVED self-service submissions into the
// public data/dojos.json that the front-end and the 10-minute updater consume.
// The seed list (data/seed.json, optional) stays under maintainer control; only
// approved submissions are added. Statuses are left for the updater to fill.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED = path.join(ROOT, "data", "seed.json");            // optional curated list
const OUT = path.join(ROOT, "data", "dojos.json");
const HIST = path.join(ROOT, "data", "history.json");

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
    name: sub.paynym || sub.id,               // display name; PayNym if set
    status: "inactive",                       // updater fills this within 10 min
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

const seed = await readJSON(SEED, { nodes: [] });
const approved = (await store.listSubmissions()).filter((s) => s.status === "approved").map(toPublicNode);

// seed first, then approved; approved wins on id collision
const byId = new Map();
for (const n of (seed.nodes || [])) byId.set(n.id, n);
for (const n of approved) byId.set(n.id, n);
const nodes = [...byId.values()];

await writeAtomic(OUT, {
  generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  interval_minutes: 10,
  nodes,
});

// ensure every node has a history bucket so the strip renders
const hist = await readJSON(HIST, { interval_minutes: 10, window_checks: 72, nodes: {} });
let touched = false;
for (const n of nodes) if (!hist.nodes[n.id]) { hist.nodes[n.id] = { checks: [] }; touched = true; }
for (const id of Object.keys(hist.nodes)) if (!byId.has(id)) { delete hist.nodes[id]; touched = true; }
if (touched) { hist.generated_at = hist.generated_at || null; await writeAtomic(HIST, hist); }

console.log(`public list rebuilt: ${nodes.length} nodes (${approved.length} approved submissions).`);
