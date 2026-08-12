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
// typed in, under a valid wallet signature (server/crypto.ts). If the
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
import { store, hasSignedBlock } from "../server/store.ts";

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
/**
 * @param {{ onionHost?: string, trustedCode?: string, dryRun?: boolean, dataDir?: string,
 *   log?: (...a: any[]) => void, fetchDoc?: any, fetchCodes?: any }} [opts]
 */
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
  const { verifyOperatorDoc } = await import("../server/crypto.ts");
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
    // A published node from another instance carries its signed block in
    // dojos.json, so an unsigned one either predates the rule there or was
    // published by an instance that does not enforce it. Either way it cannot
    // enter this store, and saying so in the plan is better than a throw from
    // putSubmission half way through the import.
    if (!hasSignedBlock(n)) { plan.push({ action: "refuse", n, why: "no signed pairing block" }); continue; }
    let codes = n.paymentCode ? [n.paymentCode] : [];
    if (n.paynym) {
      if (!codeCache.has(n.paynym)) codeCache.set(n.paynym, await fetchCodes(n.paynym).catch(() => []));
      const all = codeCache.get(n.paynym).map((c) => c.code);
      if (all.length) codes = [...new Set([...all, ...codes])];
    }
    if (!codes.length) { plan.push({ action: "refuse", n, why: "no BIP47 payment code" }); continue; }
    plan.push({ action: "import", n, codes });
  }

  const now = new Date().toISOString();
  for (const { action, n, codes, why } of plan) {
    log(`  ${action.padEnd(6)} ${n.id.padEnd(28)} ${n.paynym || "(no PayNym)"} (${(codes || []).length} codes)${why ? " — " + why : ""}`);
  }
  const imports = plan.filter((p) => p.action === "import");
  const refused = plan.filter((p) => p.action === "refuse");
  if (refused.length) log(`refused ${refused.length} node(s) that cannot be listed here: ${refused.map((p) => p.n.id).join(", ")}`);
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

  // 3b) verified operator domains.
  //
  // dojos.json publishes each badge's proof, and the signed statement is
  // deliberately portable: it names the domain and the payment code, never the
  // instance that verified it. So a claim travels intact — but it is NOT taken
  // on the source's word. We re-verify the signature here, locally and offline,
  // and store the claim UNVERIFIED so this instance's own sweep must see the TXT
  // record with its own eyes before any badge appears. Importing a badge because
  // another instance said so would make one compromised directory able to mint
  // verified domains across a federation.
  const claims = new Map();
  for (const n of dojos.nodes || []) {
    const pf = n.operator_domain_proof;
    if (!pf || !pf.domain || !pf.paymentCode || !pf.signed) continue;
    if (claims.has(pf.paymentCode)) continue;
    claims.set(pf.paymentCode, pf);
  }
  let domainsImported = 0, domainsRefused = 0;
  if (claims.size) {
    const { verifySignedUrlClaim } = await import("../server/crypto.ts");
    for (const [code, pf] of claims) {
      if (await store.getDomain(code)) continue;                 // never overwrite a local claim
      const v = verifySignedUrlClaim({ signed: pf.signed, expectedUrl: `https://${pf.domain}`, paymentCode: code });
      if (!v.ok) {
        log(`  domain  ${pf.domain}: refused (${v.error})`);
        domainsRefused++;
        continue;
      }
      await store.putDomain({
        paymentCode: code, domain: pf.domain, signed: pf.signed,
        verified: false,                    // this instance has not seen the DNS yet
        verified_at: null,
        last_check: null,                   // so the sweep picks it up immediately
        last_result: `imported from ${onionHost}; awaiting our own DNS check`,
        fail_since: null, created_at: now,
      });
      log(`  domain  ${pf.domain}: signature verified, awaiting our own TXT lookup`);
      domainsImported++;
    }
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
  return { imported: imports.length, planned: imports.length,
    domains_imported: domainsImported, domains_refused: domainsRefused };
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
