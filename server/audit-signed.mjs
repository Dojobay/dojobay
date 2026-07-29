#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — audit stored signed pairing blocks.
//
// READ-ONLY. Walks every record in the submission store and re-checks its
// stored `signed` block with exactly the gate the submit endpoint uses
// (verifySignedPayload over canonicalPairing(payload), against the notification
// address of the record's own payment code). Nothing is written, no network is
// touched, and the store is only ever read.
//
// Why this exists: records approved before the signed-message parser was fixed
// were checked by a parser that excised the BIP47 tail before verifying, so the
// verdict they received then is not the verdict they would receive now. This
// tells you whether anything was left behind.
//
// Run on the box as the deploy user:
//     cd /var/www/dojobay/server && node audit-signed.mjs
// SERVER_DATA_DIR defaults to ./data, the same path the server uses; set it
// only if your store lives elsewhere.
//
// Buckets:
//   VERIFIED  the stored signature is valid for one of the record's codes
//   FAILED    a signature is present but verifies for none of them
//   UNSIGNED  no signature stored (pre-gate migration, or a code-less record)
//   ERROR     the record could not be evaluated at all
// Exits non-zero if anything is FAILED or ERROR, so it can back a cron check.
// UNSIGNED alone does not fail the run: those are for a per-record decision.
// =============================================================================
import { store } from "./store.mjs";
import { verifySignedPayload, notificationAddress } from "./crypto.mjs";

const networkOf = (rec) => (rec.network === "testnet" ? "testnet" : "bitcoin");
const canonicalPairing = (payload) =>
  JSON.stringify({ pairing: payload?.pairing, explorer: payload?.explorer });

function audit(rec) {
  const codes = Array.isArray(rec.paymentCodes) ? rec.paymentCodes : [];
  if (!rec.signed) {
    return { bucket: "UNSIGNED", detail: codes.length ? "record has a payment code but no signed block" : "no signed block and no payment code" };
  }
  const net = networkOf(rec);
  const expectedMessage = canonicalPairing(rec.payload);
  const tried = [];
  // A PayNym may have signed with either BIP47 variant, so every code on the
  // record is a legitimate candidate; the first that verifies wins.
  for (const code of codes) {
    let addr;
    try { addr = notificationAddress(code, net); }
    catch (e) { tried.push(`${code.slice(0, 12)}…: undecodable code (${e.message})`); continue; }
    const r = verifySignedPayload({ signedText: rec.signed, expectedMessage, expectedAddress: addr, network: net });
    if (r.ok) return { bucket: "VERIFIED", detail: `${code.slice(0, 12)}… → ${addr}` };
    tried.push(`${code.slice(0, 12)}… (${addr}): ${r.error}`);
  }
  if (!codes.length) {
    const r = verifySignedPayload({ signedText: rec.signed, expectedMessage, network: net });
    return r.ok
      ? { bucket: "FAILED", detail: "signature is internally valid but the record carries no payment code to bind it to" }
      : { bucket: "FAILED", detail: r.error };
  }
  return { bucket: "FAILED", detail: tried.join("\n           ") };
}

const recs = (await store.listSubmissions())
  .sort((a, b) => (a.network + a.name).localeCompare(b.network + b.name));

const buckets = { VERIFIED: [], FAILED: [], UNSIGNED: [], ERROR: [] };
for (const rec of recs) {
  let res;
  try { res = audit(rec); } catch (e) { res = { bucket: "ERROR", detail: e.message }; }
  buckets[res.bucket].push({ rec, detail: res.detail });
}

console.log(`Audited ${recs.length} record(s) in the store.\n`);
for (const b of ["FAILED", "ERROR", "UNSIGNED", "VERIFIED"]) {
  if (!buckets[b].length) continue;
  console.log(`${b}: ${buckets[b].length}`);
  for (const { rec, detail } of buckets[b]) {
    console.log(`  [${b}] ${rec.id}  (${rec.status})${detail ? "\n           " + detail : ""}`);
  }
  console.log("");
}

const bad = buckets.FAILED.length + buckets.ERROR.length;
console.log(
  `Summary: ${buckets.VERIFIED.length} verified, ${buckets.FAILED.length} failed, ` +
  `${buckets.UNSIGNED.length} unsigned, ${buckets.ERROR.length} error.` +
  (buckets.UNSIGNED.length ? "\nUNSIGNED records are listed for a per-record decision and are not counted as failures." : "") +
  (bad ? `\nNON-ZERO EXIT: ${bad} record(s) need attention.` : "\nEvery signed record verifies under the current gate."));
process.exit(bad ? 1 : 0);
