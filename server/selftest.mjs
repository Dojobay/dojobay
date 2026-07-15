#!/usr/bin/env node
// Offline end-to-end test of the backend. Spins a mock SOCKS proxy (so the
// connection gate passes without real Tor), simulates a wallet signing the
// Auth47 challenge and the pairing payload, and drives the HTTP API.
import net from "node:net";
import assert from "node:assert";
import { BIP47Factory } from "@samouraiwallet/bip47";
import { bitcoinMessageFactory } from "@samouraiwallet/bitcoinjs-message";
import * as bip47utils from "@samouraiwallet/bip47/utils";
import ecc from "@bitcoinerlab/secp256k1";
import { mnemonicToSeedSync } from "bip39";

// point the backend at a temp store + mock proxy BEFORE importing it
process.env.SERVER_DATA_DIR = "/tmp/dojobay-selftest";
process.env.BASE_URL = "http://exampledojobayonion.onion";
process.env.PORT = "0";
process.env.TOR_SOCKS_PORT = "19077";
// isolate the public data dir so admin approve's rebuild() never writes live data
process.env.PUBLIC_DATA_DIR = "/tmp/dojobay-selftest-data";
// make the simulated wallet's payment code an admin so /admin routes are testable
process.env.ADMIN_PAYMENT_CODES = BIP47Factory(ecc)
  .fromSeed(mnemonicToSeedSync("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"))
  .toPaymentCodePublic().toBase58();
await import("node:fs/promises").then(async (m) => {
  await m.rm(process.env.SERVER_DATA_DIR, { recursive: true, force: true });
  await m.rm(process.env.PUBLIC_DATA_DIR, { recursive: true, force: true });
  await m.mkdir(process.env.PUBLIC_DATA_DIR, { recursive: true });
  try { await m.copyFile(new URL("../data/seed.json", import.meta.url), process.env.PUBLIC_DATA_DIR + "/seed.json"); }
  catch { await m.writeFile(process.env.PUBLIC_DATA_DIR + "/seed.json", JSON.stringify({ nodes: [] })); }
});

// always-up mock SOCKS5 proxy that plays the Dojo API (login + wallet tip),
// so the authenticated connection gate passes without real Tor.
const proxy = net.createServer((s) => {
  let st = "g";
  s.on("data", (d) => {
    if (st === "g") { s.write(Buffer.from([5, 0])); st = "c"; return; }
    if (st === "c") { s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); st = "t"; return; }
    const req = d.toString("latin1");
    let body;
    if (req.includes("/auth/login")) body = JSON.stringify({ authorizations: { access_token: "tok" } });
    else if (req.includes("/wallet")) body = JSON.stringify({ info: { latest_block: { height: 900000, time: 1 } } });
    else { s.write("HTTP/1.0 404 x\r\n\r\n"); s.end(); return; }
    s.write(`HTTP/1.0 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    s.end();
  });
  s.on("error", () => {});
});
await new Promise((r) => proxy.listen(19077, "127.0.0.1", r));

const { server } = await import("./index.mjs");
await new Promise((r) => (server.listening ? r() : server.on("listening", r)));
const base = "http://127.0.0.1:" + server.address().port;

// --- simulated wallet ---
const bip47 = BIP47Factory(ecc), msg = bitcoinMessageFactory(ecc), net47 = bip47utils.networks.bitcoin;
const acct = bip47.fromSeed(mnemonicToSeedSync("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"));
const paymentCode = acct.toPaymentCodePublic().toBase58();
const priv = acct.getNotificationPrivateKey();
const notifAddr = acct.toPaymentCodePublic().getNotificationAddress();

let cookie = "";
async function api(path, method = "GET", body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const txt = await res.text();
  return { status: res.status, body: txt ? JSON.parse(txt) : null };
}

let passed = 0;
const ok = (c, label) => { assert.ok(c, label); passed++; console.log("  ok -", label); };

console.log("backend self-test");

// 1) login: challenge -> sign -> callback -> poll -> cookie
const ch = await api("/api/auth47/challenge", "POST", {});
ok(ch.status === 200 && ch.body.uri.startsWith("auth47://"), "challenge issued");
const signedChallenge = (() => { const u = new URL(ch.body.uri); u.searchParams.delete("c"); return decodeURIComponent(u.toString()); })();
const proofSig = Buffer.from(msg.sign(signedChallenge, priv, true, net47.messagePrefix)).toString("base64");
const cb = await api("/api/auth47/callback", "POST", { auth47_response: "1.0", challenge: signedChallenge, signature: proofSig, nym: paymentCode });
ok(cb.status === 200, "wallet proof accepted");
const poll = await api("/api/auth47/poll?nonce=" + ch.body.nonce);
ok(poll.status === 200 && poll.body.authenticated, "poll sets session");
const me = await api("/api/me");
ok(me.body.authenticated && me.body.paymentCode === paymentCode, "session bound to payment code");

// 2) wrong-signer proof is rejected
{
  const ch2 = await api("/api/auth47/challenge", "POST", {});
  const sc2 = (() => { const u = new URL(ch2.body.uri); u.searchParams.delete("c"); return decodeURIComponent(u.toString()); })();
  const bad = bip47.fromSeed(mnemonicToSeedSync("legal winner thank year wave sausage worth useful legal winner thank yellow"));
  const badSig = Buffer.from(msg.sign(sc2, bad.getNotificationPrivateKey(), true, net47.messagePrefix)).toString("base64");
  const r = await api("/api/auth47/callback", "POST", { auth47_response: "1.0", challenge: sc2, signature: badSig, nym: paymentCode });
  ok(r.status === 401, "mismatched signature rejected at login");
}

// 3) submit a Dojo with a valid signed payload -> passes both gates -> pending
const payload = {
  pairing: { type: "dojo.api", version: "1.28.0", apikey: "deadbeef", url: "http://ebtnuwk5qayotlk7brszskn2zbtzu54y24s6lmojt6j4cv7uaiwlsyad.onion/v2" },
  explorer: { type: "explorer.btc_rpc_explorer", url: "http://eaa3qxan44q2rksr23nferh5ntxsqcdcdkjmotlyo7h56widf4y3yiqd.onion" },
};
const canonical = JSON.stringify({ pairing: payload.pairing, explorer: payload.explorer });
const sigLine = Buffer.from(msg.sign(canonical, priv, true, net47.messagePrefix)).toString("base64");
const signedBlock =
  `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${canonical}\nBIP47:\n${paymentCode}\n-----BEGIN BITCOIN SIGNATURE-----\nAddress: ${notifAddr}\n${sigLine}\n-----END BITCOIN SIGNATURE-----`;
const create = await api("/api/dojo", "POST", { network: "mainnet", name: "selftest-node", jurisdiction: "Europe", hardware: "N100 16GB", payload, signed: signedBlock });
ok(create.status === 200 && create.body.submission.status === "pending", "valid submission accepted, pending review");

// 4) tampered signed payload is rejected by the signature gate
{
  const badSigned = signedBlock.replace(notifAddr, "1BitcoinEaterAddressDontSendf59kuE");
  const r = await api("/api/dojo", "POST", { network: "mainnet", name: "selftest-node", payload, signed: badSigned });
  ok(r.status === 400 && /signature gate/.test(r.body.error), "wrong-address signed payload rejected");
}

// 5) connection gate: point the probe at a proxy that reports the onion down.
{
  const down = net.createServer((s) => {
    let st = "g";
    s.on("data", () => {
      if (st === "g") { s.write(Buffer.from([5, 0])); st = "c"; return; }
      s.write(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); s.end();  // 0x04 host unreachable
    });
    s.on("error", () => {});
  });
  await new Promise((r) => down.listen(19078, "127.0.0.1", r));
  const { PROBE_CFG } = await import("./probe.mjs");
  PROBE_CFG.proxyPort = 19078;                 // live object, mutated in place
  const r = await api("/api/dojo", "POST", { network: "testnet", name: "selftest-node", payload, signed: null });
  ok(r.status === 422 && /connection gate/.test(r.body.error), "unreachable node rejected by connection gate");
  PROBE_CFG.proxyPort = 19077;                 // restore the up proxy
  down.close();
}

// 6) admin moderation via the /admin API + publish
const anon = await fetch(base + "/api/admin/submissions");    // no cookie
ok(anon.status === 401, "admin route rejects anonymous");
const alist = await api("/api/admin/submissions");
ok(alist.status === 200 && alist.body.admin === true && alist.body.submissions.some((s) => s.status === "pending"),
   "admin can list pending submissions");
const pendId = alist.body.submissions.find((s) => s.status === "pending").id;
const appr = await api("/api/admin/approve", "POST", { id: pendId, paynym: "+testoperator" });
ok(appr.status === 200 && appr.body.ok && appr.body.rebuild.nodes >= 1, "admin approve publishes");
const fsp = await import("node:fs/promises");
const pub = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"));
ok(pub.nodes.some((n) => n.paynym === "+testoperator"), "approved submission appears in public dojos.json");
// ---- new-schema checks (paymentCodes[], operator names, migration) ---------

// 7) multi-code ownership: a PayNym commonly has two BIP47 code variants and
//    the wallet may sign Auth47 with either, so a record must match on
//    membership of its paymentCodes array, not equality with one code.
{
  const { store } = await import("./store.mjs");   // same instance the server uses
  const rec = await store.getSubmission("mainnet-selftest-node");
  const legacyVariant = "PMlegacyVariantOfTheSameNym";
  rec.paymentCodes.push(legacyVariant);
  await store.putSubmission(rec);
  const viaPrimary = await store.submissionsFor(paymentCode);
  const viaLegacy = await store.submissionsFor(legacyVariant);
  ok(viaPrimary.some((r) => r.id === "mainnet-selftest-node")
     && viaLegacy.some((r) => r.id === "mainnet-selftest-node"),
     "both payment-code variants match the same record");
  const meAgain = await api("/api/me");
  ok(meAgain.body.submissions.some((r) => r.id === "mainnet-selftest-node"),
     "/api/me still lists the record after the second code is added");
}

// 8) name uniqueness: another operator may not take a name that is in use.
{
  const jarB = { cookie: "" };
  const apiB = async (path, method = "GET", body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(jarB.cookie ? { Cookie: jarB.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) jarB.cookie = sc.split(";")[0];
    const txt = await res.text();
    return { status: res.status, body: txt ? JSON.parse(txt) : null };
  };
  const acctB = bip47.fromSeed(mnemonicToSeedSync("legal winner thank year wave sausage worth useful legal winner thank yellow"));
  const chB = await apiB("/api/auth47/challenge", "POST", {});
  const scB = (() => { const u = new URL(chB.body.uri); u.searchParams.delete("c"); return decodeURIComponent(u.toString()); })();
  const sigB = Buffer.from(msg.sign(scB, acctB.getNotificationPrivateKey(), true, net47.messagePrefix)).toString("base64");
  await apiB("/api/auth47/callback", "POST", { auth47_response: "1.0", challenge: scB, signature: sigB, nym: acctB.toPaymentCodePublic().toBase58() });
  await apiB("/api/auth47/poll?nonce=" + chB.body.nonce);
  const ncB = await apiB("/api/dojo/name-check?network=mainnet&name=Selftest%20Node");
  ok(ncB.status === 200 && ncB.body.available === false, "name-check reports a taken name (case/punctuation-insensitive)");
  const dup = await apiB("/api/dojo", "POST", { network: "mainnet", name: "selftest-node", payload, signed: null });
  ok(dup.status === 409, "duplicate name from another operator rejected with 409");
  const ncOwner = await api("/api/dojo/name-check?network=mainnet&name=selftest-node");
  ok(ncOwner.status === 200 && ncOwner.body.available === true && ncOwner.body.update === true,
     "owner's own name reads as available (an update, keeping the record id)");
}

// 9) manage-panel ordering: /api/me returns mainnet before testnet, then
//    alphabetical by name.
{
  const { store } = await import("./store.mjs");
  const stub = (network, name) => ({
    id: `${network}-${name}`, network, name, paymentCodes: [paymentCode],
    paynym: null, payload: { pairing: { type: "dojo.api", url: "http://" + "a".repeat(56) + ".onion/v2" } },
    status: "pending", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  });
  await store.putSubmission(stub("testnet", "alpha"));
  await store.putSubmission(stub("mainnet", "zulu"));
  const meOrd = await api("/api/me");
  const order = meOrd.body.submissions.map((r) => r.name);
  ok(JSON.stringify(order) === JSON.stringify(["selftest-node", "zulu", "alpha"]),
     "submissions ordered mainnet-then-testnet, then by name (" + order.join(", ") + ")");
}

// 10) migration script: dry-run prints its plan (including the code-less
//     adoption warning) and writes nothing; a real run creates owned records
//     and adopts code-less ones as admin-managed exceptions; seed.json is
//     never rewritten; a second run skips everything (byte-identical store).
{
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const MIG_DATA = "/tmp/dojobay-selftest-mig-data";
  const MIG_STORE = "/tmp/dojobay-selftest-mig-store";
  await fsp.rm(MIG_DATA, { recursive: true, force: true });
  await fsp.rm(MIG_STORE, { recursive: true, force: true });
  await fsp.mkdir(MIG_DATA, { recursive: true });
  const fixturePayload = { pairing: { type: "dojo.api", url: "http://" + "b".repeat(56) + ".onion/v2" } };
  await fsp.writeFile(MIG_DATA + "/seed.json", JSON.stringify({ nodes: [
    { id: "mainnet-fam-one", network: "mainnet", name: "Fam One", paynym: "+fam", payload: fixturePayload },
    { id: "mainnet-fam-two", network: "mainnet", name: "Fam Two", paynym: "+fam", payload: fixturePayload },
    { id: "testnet-keeper", network: "testnet", name: "wanderinKeeper", paynym: null, payload: fixturePayload },
  ] }, null, 2));
  await fsp.writeFile(MIG_DATA + "/paynym-codes.json", JSON.stringify({ mapping: {
    "+fam": { nymName: "+fam", codes: [{ code: "PMfamSegwit", segwit: true }, { code: "PMfamLegacy", segwit: false }] },
  } }, null, 2));
  const env = { ...process.env, PUBLIC_DATA_DIR: MIG_DATA, SERVER_DATA_DIR: MIG_STORE };
  const script = new URL("../scripts/migrate-seed-to-store.mjs", import.meta.url).pathname;
  const seedBefore = await fsp.readFile(MIG_DATA + "/seed.json", "utf8");

  const dry = await run(process.execPath, [script, "--dry-run"], { env });
  const storeAbsent = await fsp.access(MIG_STORE + "/store.json").then(() => false, () => true);
  ok(/create\s+mainnet-fam-one\s+name=one/.test(dry.stdout)
     && /adopt\s+testnet-keeper\s+name=wanderinKeeper/.test(dry.stdout)
     && /WARNING: testnet-keeper has no BIP47/.test(dry.stdout)
     && storeAbsent,
     "migration --dry-run: family prefix stripped, code-less adoption warned, nothing written");

  await run(process.execPath, [script], { env });
  const store1 = await fsp.readFile(MIG_STORE + "/store.json", "utf8");
  const migrated = JSON.parse(store1).submissions;
  const seedAfter = await fsp.readFile(MIG_DATA + "/seed.json", "utf8");
  ok(migrated["mainnet-fam-one"].status === "approved"
     && migrated["mainnet-fam-one"].paymentCodes.length === 2
     && migrated["testnet-keeper"].status === "approved"
     && migrated["testnet-keeper"].paymentCodes.length === 0
     && migrated["testnet-keeper"].source === "seed-adoption"
     && migrated["testnet-keeper"].name === "wanderinKeeper"
     && seedAfter === seedBefore,
     "migration creates owned records, adopts code-less exceptions, never rewrites seed.json");

  const second = await run(process.execPath, [script], { env });
  const store2 = await fsp.readFile(MIG_STORE + "/store.json", "utf8");
  ok(/nothing to do/.test(second.stdout) && /skip\s+mainnet-fam-one/.test(second.stdout) && store2 === store1,
     "second migration run skips existing ids (store byte-identical)");
  await fsp.rm(MIG_DATA, { recursive: true, force: true });
  await fsp.rm(MIG_STORE, { recursive: true, force: true });
}

// 11) a moderation change whose publish (rebuild) fails must report the
//     failure to the admin, not swallow it: this is how an approved node
//     silently never reached the public dojos.json.
{
  const goodDir = process.env.PUBLIC_DATA_DIR;
  process.env.PUBLIC_DATA_DIR = "/dev/null/not-a-directory";     // rebuild will throw
  const rej = await api("/api/admin/reject", "POST", { id: "mainnet-selftest-node" });
  ok(rej.status === 200 && rej.body.ok && rej.body.rebuild && rej.body.rebuild.error,
     "moderation succeeds but a failed publish is reported (rebuild.error)");
  process.env.PUBLIC_DATA_DIR = goodDir;
  const reAppr = await api("/api/admin/approve", "POST", { id: "mainnet-selftest-node", paynym: "+testoperator" });
  ok(reAppr.status === 200 && reAppr.body.rebuild && !reAppr.body.rebuild.error, "publish succeeds again once writable");
}

// 12) updater reconciliation: an approved node deleted from dojos.json (the
//     approve-mid-probe-cycle clobber) is restored by reconcilePublicList(),
//     which the updater now runs at the start of every cycle.
{
  const dojosPath = process.env.PUBLIC_DATA_DIR + "/dojos.json";
  const doc = JSON.parse(await fsp.readFile(dojosPath, "utf8"));
  doc.nodes = doc.nodes.filter((n) => n.id !== "mainnet-selftest-node");
  await fsp.writeFile(dojosPath, JSON.stringify(doc, null, 2) + "\n");
  const { reconcilePublicList } = await import("../scripts/update.mjs");
  await reconcilePublicList();
  const healed = JSON.parse(await fsp.readFile(dojosPath, "utf8"));
  ok(healed.nodes.some((n) => n.id === "mainnet-selftest-node"),
     "reconcile restores an approved node clobbered out of dojos.json");
}

// 13) history grace period: delisting a node stamps its history `retired`
//     instead of deleting it; relisting within the window clears the stamp
//     with the data intact; only a long-expired retiree is deleted.
{
  const histPath = process.env.PUBLIC_DATA_DIR + "/history.json";
  const marker = [{ t: "2026-07-14 00:00", up: true }];
  const doc = JSON.parse(await fsp.readFile(histPath, "utf8"));
  doc.nodes["mainnet-selftest-node"] = { checks: marker.slice() };
  doc.nodes["mainnet-long-gone"] = { checks: marker.slice(), retired: "2026-06-01T00:00:00Z" };
  await fsp.writeFile(histPath, JSON.stringify(doc, null, 2) + "\n");

  const rej = await api("/api/admin/reject", "POST", { id: "mainnet-selftest-node" });   // delists + rebuilds
  const afterRej = JSON.parse(await fsp.readFile(histPath, "utf8")).nodes;
  ok(rej.status === 200 && afterRej["mainnet-selftest-node"]
     && afterRej["mainnet-selftest-node"].retired
     && JSON.stringify(afterRej["mainnet-selftest-node"].checks) === JSON.stringify(marker),
     "delisted node's history is retired (stamped), not deleted");
  ok(!afterRej["mainnet-long-gone"], "history retired beyond the grace window is deleted");

  await api("/api/admin/approve", "POST", { id: "mainnet-selftest-node", paynym: "+testoperator" });   // relists + rebuilds
  const afterAppr = JSON.parse(await fsp.readFile(histPath, "utf8")).nodes["mainnet-selftest-node"];
  ok(afterAppr && !afterAppr.retired
     && JSON.stringify(afterAppr.checks) === JSON.stringify(marker),
     "relisting within the grace window resurrects the history untouched");
}

// 14) display-field edits: owner can amend name, hardware and Dojo version;
//     the id, status and history are untouched; renames respect per-network
//     uniqueness including the owner's own other records and the seed.
{
  const ed = await api("/api/dojo/edit", "POST", { id: "mainnet-selftest-node", name: "selftest-node", hardware: "RPi5 8GB", version: "9.9.9-test" });
  const rec = await api("/api/me").then((r) => r.body.submissions.find((x) => x.id === "mainnet-selftest-node"));
  ok(ed.status === 200 && rec.hardware === "RPi5 8GB" && rec.version === "9.9.9-test" && rec.status === "approved",
     "owner edit updates hardware and version, keeps id and approved status");
  const pub = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"));
  const pubNode = pub.nodes.find((n) => n.id === "mainnet-selftest-node");
  ok(pubNode && pubNode.version === "9.9.9-test" && pubNode.paymentCode === rec.paymentCodes[0],
     "approved edit publishes immediately; card carries version override and a payment code");

  const clashOwn = await api("/api/dojo/edit", "POST", { id: "mainnet-selftest-node", name: "zulu" });
  const clashSeed = await api("/api/dojo/edit", "POST", { id: "mainnet-selftest-node", name: "Maxtannahill" });
  ok(clashOwn.status === 409 && clashSeed.status === 409,
     "renames rejected when colliding with own other record or the anchor seed node");

  const anon = await fetch(base + "/api/dojo/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "mainnet-selftest-node", name: "x" }) });
  const admEd = await api("/api/admin/edit", "POST", { id: "testnet-alpha", name: "alpha", hardware: "edited-by-admin" });
  const stub = await api("/api/me").then((r) => r.body.submissions.find((x) => x.id === "testnet-alpha"));
  ok(anon.status === 401 && admEd.status === 200 && stub.hardware === "edited-by-admin",
     "anonymous edit rejected; admin can edit any record via /api/admin/edit");
}

// 15) the card shows the PayNym's canonical (non-segwit) code variant when the
//     mapping identifies it, falling back to the record's first code.
{
  const { displayPaymentCode } = await import("./build-public.mjs");
  const sub = { paynym: "+max", paymentCodes: ["PMsegwitVariant", "PMlegacyVariant"] };
  const mapping = { "+max": { codes: [{ code: "PMsegwitVariant", segwit: true }, { code: "PMlegacyVariant", segwit: false }] } };
  ok(displayPaymentCode(sub, mapping) === "PMlegacyVariant"
     && displayPaymentCode(sub, {}) === "PMsegwitVariant"
     && displayPaymentCode({ paymentCodes: [] }, mapping) === null,
     "display code prefers the non-segwit variant, falls back to the first, null when none");
}

// 16) intake hygiene and card link: pasted CRLF/zero-width bytes are stripped
//     from signed blocks before verification; name_url is operator-settable
//     via edit (blank clears), rejected unless http(s); export endpoint merges
//     both history windows.
{
  // signed cleaning: resubmit the check-3 record with a clipboard-mangled
  // signed block (CRLF + zero-width space); it must still pass the signature
  // gate and be STORED byte-clean.
  const mangled = signedBlock.replace(/\n/g, "\r\n") + "\u200b";
  const resub = await api("/api/dojo", "POST", { network: "mainnet", name: "selftest-node", jurisdiction: "Europe", hardware: "N100 16GB", payload, signed: mangled });
  const rec = await api("/api/me").then((r) => r.body.submissions.find((x) => x.id === "mainnet-selftest-node"));
  ok(resub.status === 200 && rec.signed === signedBlock && !rec.signed.includes("\r"),
     "CRLF/zero-width paste artefacts stripped before verification; stored block byte-clean");

  // restore approved status (resubmission re-enters moderation)
  await api("/api/admin/approve", "POST", { id: "mainnet-selftest-node", paynym: "+testoperator" });

  // name_url: set via edit, published, blank clears, invalid rejected
  const setUrl = await api("/api/dojo/edit", "POST", { id: "mainnet-selftest-node", name: "selftest-node", name_url: "https://example.org/mynode" });
  const pubbed = JSON.parse(await fsp.readFile(process.env.PUBLIC_DATA_DIR + "/dojos.json", "utf8"))
    .nodes.find((n) => n.id === "mainnet-selftest-node");
  const badUrl = await api("/api/dojo/edit", "POST", { id: "mainnet-selftest-node", name: "selftest-node", name_url: "javascript:alert(1)" });
  const clearUrl = await api("/api/dojo/edit", "POST", { id: "mainnet-selftest-node", name: "selftest-node", name_url: "" });
  const cleared = await api("/api/me").then((r) => r.body.submissions.find((x) => x.id === "mainnet-selftest-node"));
  ok(setUrl.status === 200 && pubbed.name_url === "https://example.org/mynode"
     && badUrl.status === 400 && clearUrl.status === 200 && cleared.name_url === null,
     "name_url settable by the operator, published on the card, blank clears, non-http(s) rejected");

  // export endpoint: both windows merged, per-node filter, 404 on unknown
  const all = await api("/api/history/export");
  const one = await api("/api/history/export?id=mainnet-selftest-node");
  const none = await api("/api/history/export?id=no-such-node");
  ok(all.status === 200 && all.body.nodes["mainnet-selftest-node"]
     && Array.isArray(one.body.nodes["mainnet-selftest-node"].checks)
     && Array.isArray(one.body.nodes["mainnet-selftest-node"].days)
     && Object.keys(one.body.nodes).length === 1 && none.status === 404,
     "history export merges 24h checks and daily rollups, filters by id, 404s unknown ids");
}

// 17) update check: counts commits behind main and releases published since
//     this build (fake transport), and the admin route gates access while
//     reporting an unreachable GitHub in-band rather than erroring the panel.
{
  await fsp.writeFile(process.env.PUBLIC_DATA_DIR + "/version.json",
    JSON.stringify({ commit: "abc1234", built: "2026-01-01T00:00:00Z" }));
  const { checkUpdates } = await import("./updates.mjs");
  const transport = async (apiPath) => {
    if (apiPath.startsWith("/repos/Dojobay/dojobay/compare/"))
      return { status: 200, body: JSON.stringify({ status: "behind", ahead_by: 4, behind_by: 0 }) };
    if (apiPath.startsWith("/repos/Dojobay/dojobay/releases"))
      return { status: 200, body: JSON.stringify([
        { tag_name: "v0.2", published_at: "2026-06-01T00:00:00Z" },
        { tag_name: "v0.1", published_at: "2025-12-01T00:00:00Z" },
      ]) };
    return { status: 404, body: "{}" };
  };
  const u = await checkUpdates({ transport });
  ok(u.commits_behind === 4 && u.releases_behind === 1 && u.latest_release === "v0.2" && u.commit === "abc1234",
     "update check: 4 commits behind, 1 release since build, latest v0.2");

  const anon = await fetch(base + "/api/admin/updates");
  const admin = await api("/api/admin/updates");
  ok(anon.status === 401 && admin.status === 200 && admin.body.available === false && admin.body.error,
     "updates route: anonymous 401; unreachable GitHub reported in-band to the admin");
}

await fsp.rm(process.env.PUBLIC_DATA_DIR, { recursive: true, force: true });

console.log(`\nall ${passed} checks passed`);
proxy.close();
process.exit(0);
