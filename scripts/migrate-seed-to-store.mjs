#!/usr/bin/env node
// One-off (but idempotent) migration: move every operator-owned node out of the
// curated data/seed.json into server/data/store.json as an APPROVED submission,
// so operators can manage their own listings via Auth47.
//
//   node scripts/migrate-seed-to-store.mjs --dry-run   print the plan, write nothing
//   node scripts/migrate-seed-to-store.mjs             apply it
//
// What it does:
//   - reads data/paynym-codes.json (paynym.rs snapshot: every PayNym with BOTH
//     of its BIP47 code variants, segwit and legacy, because the wallet may
//     sign Auth47 with either) and data/seed.json
//   - writes one approved store record per seed node whose PayNym appears in
//     the mapping, with paymentCodes = all code variants for that PayNym
//   - keeps the original seed id as the record id, so reliability history in
//     data/history*.json (keyed by id) carries over untouched
//   - auto-populates the operator-facing node name from the seed id: strip the
//     network prefix, and where one owner's nodes share a family prefix (the
//     91xtx93 fleet) strip that too, so mainnet-91xtx93-yellow becomes "yellow"
//     and mainnet-syndicate-systems becomes "syndicate-systems"
//   - slims seed.json to only the nodes with no PayNym (Kilombino mainnet,
//     wanderinKing072 testnet)
//   - a second run finds nothing to change and is a no-op
//
// Afterwards run `node server/build-public.mjs` (or approve anything in /admin)
// to regenerate data/dojos.json; because ids are unchanged, the public list and
// histories come out identical apart from the new name/name_url fields.
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { store } from "../server/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data");
const SEED_PATH = path.join(DATA_DIR, "seed.json");
const CODES_PATH = path.join(DATA_DIR, "paynym-codes.json");
const DRY = process.argv.includes("--dry-run");

async function readJSON(p) { return JSON.parse(await readFile(p, "utf8")); }
async function writeAtomic(p, obj) {
  const tmp = p + ".tmp";
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, p);
}

// Name derivation. Remainder = seed id minus its `${network}-` prefix. When an
// owner has several nodes that all share the same first hyphen-token AND every
// node has something left after stripping it, drop the shared token (the
// 91xtx93 fleet -> yellow/red/tanto-e/green/blue); otherwise keep the whole
// remainder (bottomshelfbtc keeps its name on both networks).
function deriveNames(nodes) {
  const rem = nodes.map((n) => n.id.replace(new RegExp(`^${n.network}-`), ""));
  if (nodes.length > 1) {
    const first = rem.map((r) => r.split("-")[0]);
    const shared = first.every((t) => t === first[0]);
    const strippable = rem.every((r) => r.includes("-"));
    if (shared && strippable) return rem.map((r) => r.split("-").slice(1).join("-"));
  }
  return rem;
}

// Compare the record we would write against what the store already holds,
// ignoring timestamps, so re-running the migration is a clean no-op.
const comparable = ({ created_at, updated_at, ...rest }) => JSON.stringify(rest);

async function main() {
  const seed = await readJSON(SEED_PATH);
  const codesDoc = await readJSON(CODES_PATH);
  const mapping = codesDoc.mapping || {};

  const owned = (seed.nodes || []).filter((n) => n.paynym);
  const kept = (seed.nodes || []).filter((n) => !n.paynym);

  // The deploy pipeline ships the SLIM seed, so on a box where the migration
  // has not run yet, this script's input no longer exists locally: seed.json
  // has no operator-owned nodes and the store has nothing migrated. Reporting
  // "nothing to do" in that state is actively misleading, so detect it and
  // say what to do instead.
  if (owned.length === 0) {
    const migrated = (await store.listSubmissions()).filter((r) => r.source === "seed-migration");
    if (migrated.length === 0) {
      console.error(`no operator-owned nodes in ${path.relative(ROOT, SEED_PATH)} and no migrated records in the store.`);
      console.error("If this seed was already slimmed by a deploy, supply the PRE-migration seed:");
      console.error("  mkdir -p /tmp/mig && cp <full-seed>.json /tmp/mig/seed.json && cp data/paynym-codes.json /tmp/mig/");
      console.error("  PUBLIC_DATA_DIR=/tmp/mig node scripts/migrate-seed-to-store.mjs --dry-run");
      console.error("(records are written to the normal server/data store; only the seed is read from /tmp/mig)");
      process.exit(1);
    }
  }

  // Refuse to run at all if any owned node lacks a code mapping: a partial
  // migration would strand that operator without a manageable record.
  const missing = owned.filter((n) => !mapping[n.paynym]);
  if (missing.length) {
    console.error("aborting: no payment codes in", path.relative(ROOT, CODES_PATH), "for:");
    for (const n of missing) console.error("  ", n.id, n.paynym);
    process.exit(1);
  }

  // Derive names per owner, then check per-network uniqueness across the
  // migrated set plus the nodes staying in the seed.
  const byOwner = new Map();
  for (const n of owned) {
    if (!byOwner.has(n.paynym)) byOwner.set(n.paynym, []);
    byOwner.get(n.paynym).push(n);
  }
  const slugOf = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const nameOf = new Map();
  for (const group of byOwner.values()) {
    const names = deriveNames(group);
    // Prefer the seed's display name when it slugs to the derived value, so
    // capitalisation like "wanderinKing072" survives the migration.
    group.forEach((n, i) => nameOf.set(n.id, (n.name && slugOf(n.name) === names[i]) ? n.name : names[i]));
  }
  const seen = new Set();
  for (const n of owned.concat(kept)) {
    const key = `${n.network}:${(nameOf.get(n.id) || n.name || n.id).toLowerCase()}`;
    if (seen.has(key)) { console.error("aborting: duplicate node name per network:", key); process.exit(1); }
    seen.add(key);
  }

  const now = new Date().toISOString();
  const plan = [];
  for (const n of owned) {
    const codes = mapping[n.paynym].codes.map((c) => c.code);
    const desired = {
      id: n.id,                                  // unchanged, preserving reliability history
      network: n.network,
      name: nameOf.get(n.id),
      paymentCodes: codes,                       // every variant (segwit + legacy)
      paynym: n.paynym,
      jurisdiction: n.jurisdiction || null,
      country: n.country || null,
      hardware: n.hardware || null,
      payload: n.payload,
      signed: n.signed || null,
      name_url: n.name_url || null,
      status: "approved",
      source: "seed-migration",
      created_at: now,
      updated_at: now,
    };
    const existing = await store.getSubmission(n.id);
    if (existing && comparable(existing) === comparable(desired)) {
      plan.push({ action: "skip", node: desired });
    } else if (existing) {
      desired.created_at = existing.created_at || now;
      plan.push({ action: "update", node: desired });
    } else {
      plan.push({ action: "create", node: desired });
    }
  }

  const slimSeed = { nodes: kept };
  const seedChanged = JSON.stringify(seed) !== JSON.stringify(slimSeed);

  console.log(`${DRY ? "DRY RUN — " : ""}migration plan (${owned.length} operator-owned seed nodes):`);
  for (const { action, node } of plan) {
    console.log(`  ${action.padEnd(6)} ${node.id.padEnd(26)} name=${node.name.padEnd(18)} ${node.paynym} (${node.paymentCodes.length} codes)`);
  }
  console.log(`  ${seedChanged ? "slim  " : "skip  "} ${path.relative(ROOT, SEED_PATH).padEnd(26)} keeps: ${kept.map((n) => n.id).join(", ") || "(none)"}`);

  const changes = plan.filter((p) => p.action !== "skip").length + (seedChanged ? 1 : 0);
  if (DRY) { console.log(`\ndry run: ${changes} change(s) would be made, nothing written.`); return; }
  if (!changes) { console.log("\nnothing to do: migration already applied."); return; }

  for (const { action, node } of plan) if (action !== "skip") await store.putSubmission(node);
  if (seedChanged) await writeAtomic(SEED_PATH, slimSeed);
  console.log(`\napplied ${changes} change(s). Now run: node server/build-public.mjs`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error("fatal:", e.message); process.exit(1); });
}
