#!/usr/bin/env node
// Bootstrap a new Dojo Bay from a TRUSTED existing instance, so a fresh
// directory is mature the moment it starts: its nodes become approved store
// records here and their reliability histories carry over.
//
//   node scripts/bootstrap-import.mjs --onion <56-char>.onion \
//        --code PM8T... [--dry-run]
//
// Trust is verified before anything is imported: the remote instance's
// data/operator.json must bind that onion to exactly the payment code YOU
// typed in, under a valid wallet signature (server/crypto.mjs). If the
// signature does not verify, or binds a different onion or code, nothing is
// fetched further. After that: dojos.json supplies the nodes, both history
// files supply the record, and each PayNym is resolved against paynym.rs
// (over Tor) for its full BIP47 code-variant set so imported operators can
// sign in here with either variant. Existing ids are never touched; history
// is only written for ids that have none.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { httpOverTor } from "./update.mjs";
import { store } from "../server/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data");

const defaultCfg = () => ({
  proxyHost: process.env.TOR_SOCKS_HOST || "127.0.0.1",
  proxyPort: +(process.env.TOR_SOCKS_PORT || 9050),
});

// GET a JSON document from the remote instance over Tor.
async function torFetchJSON(onionHost, urlPath, cfg, timeoutMs = 30000) {
  const req = `GET ${urlPath} HTTP/1.0\r\nHost: ${onionHost}\r\nUser-Agent: dojobay-bootstrap\r\nConnection: close\r\n\r\n`;
  const res = await httpOverTor(cfg, onionHost, 80, req, timeoutMs);
  if (res.status !== 200) throw new Error(`${urlPath}: HTTP ${res.status || "no response"}`);
  return JSON.parse(res.body);
}

async function writeJSONAtomic(p, obj) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p + ".tmp", JSON.stringify(obj, null, 2) + "\n");
  await rename(p + ".tmp", p);
}

// fetchers are injectable for the self-test: fetchDoc(urlPath) -> object,
// fetchCodes(paynymOrCode) -> [{code, segwit}, ...]
export async function bootstrapImport({
  onionHost, trustedCode, dryRun = false, dataDir = DATA_DIR, log = console.error,
  fetchDoc, fetchCodes,
} = {}) {
  const cfg = defaultCfg();
  fetchDoc = fetchDoc || ((p) => torFetchJSON(onionHost, p, cfg));
  if (!fetchCodes) {
    const { fetchNymCodes } = await import("../server/paynym.mjs");
    fetchCodes = (nym) => fetchNymCodes(nym);
  }

  // 1) trust gate: the remote operator binding must verify for THIS onion and
  //    exactly the payment code the operator typed in.
  const { verifyOperatorDoc } = await import("../server/crypto.mjs");
  const opDoc = await fetchDoc("/data/operator.json");
  const v = verifyOperatorDoc(opDoc, { expectedOnion: `http://${onionHost}` });
  if (!v.ok) throw new Error(`refusing to import: remote operator binding does not verify (${v.error})`);
  if (opDoc.paymentCode !== trustedCode) {
    throw new Error("refusing to import: the remote instance is operated by a DIFFERENT payment code than the one you trusted");
  }
  log(`trusted: ${onionHost} is signed by ${trustedCode.slice(0, 12)}… ✓`);

  // 2) data
  const dojos = await fetchDoc("/data/dojos.json");
  const hist = await fetchDoc("/data/history.json").catch(() => ({ nodes: {} }));
  const daily = await fetchDoc("/data/history-daily.json").catch(() => ({ nodes: {} }));
  const nodes = (dojos.nodes || []).filter((n) => n.payload?.pairing?.url);

  // 3) plan records: skip existing ids; resolve full code sets per PayNym
  const existingIds = new Set((await store.listSubmissions()).map((r) => r.id));
  const plan = [];
  const codeCache = new Map();
  for (const n of nodes) {
    if (existingIds.has(n.id)) { plan.push({ action: "skip", n }); continue; }
    let codes = n.paymentCode ? [n.paymentCode] : [];
    if (n.paynym) {
      if (!codeCache.has(n.paynym)) codeCache.set(n.paynym, await fetchCodes(n.paynym).catch(() => []));
      const all = codeCache.get(n.paynym).map((c) => c.code);
      if (all.length) codes = [...new Set([...all, ...codes])];
    }
    plan.push({ action: "import", n, codes });
  }

  const now = new Date().toISOString();
  for (const { action, n, codes } of plan) {
    log(`  ${action.padEnd(6)} ${n.id.padEnd(28)} ${n.paynym || "(no PayNym)"} (${(codes || []).length} codes)`);
  }
  const imports = plan.filter((p) => p.action === "import");
  if (dryRun) { log(`dry run: ${imports.length} node(s) would be imported, nothing written.`); return { imported: 0, planned: imports.length }; }

  for (const { n, codes } of imports) {
    await store.putSubmission({
      id: n.id, network: n.network, name: n.name || n.id,
      paymentCodes: codes, paynym: n.paynym || null,
      jurisdiction: n.jurisdiction || null, country: n.country || null,
      hardware: n.hardware || null, payload: n.payload,
      signed: n.signed || null, name_url: n.name_url || null,
      status: "approved", source: `bootstrap-import:${onionHost}`,
      created_at: now, updated_at: now,
    });
  }

  // 4) histories: only for ids we have no history for
  for (const [file, remote] of [["history.json", hist], ["history-daily.json", daily]]) {
    const p = path.join(dataDir, file);
    let local; try { local = JSON.parse(await readFile(p, "utf8")); } catch { local = { nodes: {} } }
    local.nodes = local.nodes || {};
    let added = 0;
    for (const [id, entry] of Object.entries(remote.nodes || {})) {
      if (!local.nodes[id] && imports.some((x) => x.n.id === id)) { local.nodes[id] = entry; added++; }
    }
    if (added) {
      if (remote.interval_minutes && !local.interval_minutes) local.interval_minutes = remote.interval_minutes;
      if (remote.window_checks && !local.window_checks) local.window_checks = remote.window_checks;
      await writeJSONAtomic(p, local);
      log(`  history: ${added} node(s) carried into ${file}`);
    }
  }
  log(`imported ${imports.length} node(s) from ${onionHost}. Now run: node server/build-public.mjs`);
  return { imported: imports.length, planned: imports.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const onionHost = String(arg("--onion") || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const trustedCode = arg("--code");
  if (!/^[a-z2-7]{56}\.onion$/.test(onionHost) || !trustedCode) {
    console.error("usage: node scripts/bootstrap-import.mjs --onion <56-char>.onion --code PM8T... [--dry-run]");
    process.exit(1);
  }
  bootstrapImport({ onionHost, trustedCode, dryRun: process.argv.includes("--dry-run") })
    .catch((e) => { console.error("fatal:", e.message); process.exit(1); });
}
