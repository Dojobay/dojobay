// Auth47 login and BIP47 signed-payload verification for The Dojo Bay backend.
// Thin wrappers over the audited Samourai libraries; the exact call shapes here
// were verified against the libraries end to end (see selftest.mjs).
import { Auth47Verifier } from "@dojo-tools/auth47";
import { BIP47Factory } from "@dojo-tools/bip47";
import { bitcoinMessageFactory } from "@dojo-tools/bitcoinjs-message";
import * as bip47utils from "@dojo-tools/bip47/utils";
import ecc from "@bitcoinerlab/secp256k1";

const bip47 = BIP47Factory(ecc);
const message = bitcoinMessageFactory(ecc);

// ---- Auth47 ----------------------------------------------------------------
// The verifier needs to know its own callback URL. We build it from the site's
// base URL (the .onion origin) at construction time.
export function makeAuth47(baseUrl) {
  const callback = new URL("/api/auth47/callback", baseUrl).toString();
  const verifier = new Auth47Verifier(ecc, callback);

  // Full challenge URI shown to the wallet (includes the callback `c`).
  function challengeURI(nonce, expires, resource) {
    return verifier.generateURI({ nonce, expires, resource });
  }

  // Per the spec, the wallet signs the challenge WITHOUT the callback param.
  // Given the full URI we generated, produce the value the proof must contain.
  function signedForm(fullUri) {
    const u = new URL(fullUri);
    u.searchParams.delete("c");
    return decodeURIComponent(u.toString());
  }

  // Verify a posted proof. Returns { ok, paymentCode } or { ok:false, error }.
  function verify(proof) {
    const res = verifier.verifyProof(proof);
    if (res.result !== "ok") return { ok: false, error: res.error };
    return { ok: true, paymentCode: res.data.nym };
  }

  return { challengeURI, signedForm, verify, callback };
}

// ---- payment code -> notification address ----------------------------------
export function notificationAddress(paymentCode, network = "bitcoin") {
  const net = bip47utils.networks[network];
  return bip47.fromBase58(paymentCode, net).getNotificationAddress();
}

// Every address a given payment code could legitimately have signed from.
// A PayNym is a MAINNET identity: an operator listing a testnet node still
// signs with their mainnet notification address, because that is the only key
// their wallet holds for that code. Deriving on testnet yields an "m…" address
// that can never match, which silently made every testnet listing unverifiable.
// Both derivations come from the same code, so accepting either is no weaker.
export function notificationAddresses(paymentCode) {
  const out = [];
  for (const net of ["bitcoin", "testnet"]) {
    try { const a = notificationAddress(paymentCode, net); if (!out.includes(a)) out.push(a); } catch { /* skip */ }
  }
  return out;
}

// ---- lab-style signed pairing payload verification -------------------------
// The submitted `signed` blob is a BIP-signed message. We require it to be
// signed by the notification address of the operator's authenticated payment
// code, over the exact pairing JSON they are submitting. This is the same
// verify() the paymentcode.io lab uses.
//
// The signed message format Samourai/Ashigaru export wraps the payload between
// BEGIN/END markers. CRITICAL, verified against a real wallet export: the text
// the wallet signs is EVERYTHING between the markers, i.e. the pairing JSON
// PLUS the trailing "BIP47:" line and payment code (no trailing newline). An
// earlier revision excised the BIP47 tail before verifying, which made every
// genuine wallet signature fail as "invalid signature"; the selftest did not
// catch it because it constructed its own blocks under the same assumption.
// Because the BIP47 line is inside the signed text, the payment code is
// covered by the signature and can itself be verified against the signing
// address (see verifySignedPayload).
export function parseSignedBlock(text) {
  if (!text || typeof text !== "string") return null;
  const t = text.replace(/\r\n/g, "\n");
  const msgM = t.match(/BEGIN BITCOIN SIGNED MESSAGE-----\n([\s\S]*?)\n-----BEGIN BITCOIN SIGNATURE/);
  const addrM = t.match(/Address:\s*(\S+)/);
  const sigM = t.match(/\n([A-Za-z0-9+/=]{80,})\n-----END BITCOIN SIGNATURE/);
  if (!msgM || !addrM || !sigM) return null;
  const message = msgM[1].trim();                       // the full signed text
  const tail = message.match(/^([\s\S]*?)\n\s*BIP47:\s*\n?(\S+)$/);
  return {
    message,                                            // what the signature covers
    pairingText: tail ? tail[1].trim() : message,       // the pairing JSON alone
    paymentCode: tail ? tail[2] : null,                 // code inside the signed text
    address: addrM[1].trim(),
    signature: sigM[1].trim(),
  };
}

// Verify a signed pairing block. Checks, in order, with distinct errors:
//   1. the block parses at all;
//   2. the pairing JSON inside it matches the payload being submitted;
//   3. the signature is cryptographically valid over the FULL signed text;
//   4. (signature now known valid) the BIP47 payment code inside the signed
//      text is a valid code whose notification address IS the signing address;
//   5. the signing address matches the authenticated payment code's
//      notification address (the session binding the API supplies).
// Does the signed pairing text describe the same payload being submitted?
//
// Wallets and admin panels serialise this JSON differently: pretty-printed with
// newlines and indentation, or with the object keys in another order. All of
// those are the SAME payload, and a byte-exact comparison against our own
// re-serialisation rejects them, which is what made genuine, correctly signed
// listings fail the gate. So compare the parsed structures instead: identical
// keys and identical values, order-insensitive, at every level. Anything that
// is not valid JSON, or that differs in any value or key, still fails.
export function sameSignedPayload(signedText, expected) {
  const a = String(signedText).trim(), b = String(expected).trim();
  if (a === b) return true;
  let pa, pb;
  try { pa = JSON.parse(a); pb = JSON.parse(b); } catch { return false; }
  return stableStringify(pa) === stableStringify(pb);
}

function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

export function verifySignedPayload({ signedText, expectedMessage, expectedAddress, network = "bitcoin" }) {
  const parsed = parseSignedBlock(signedText);
  if (!parsed) return { ok: false, error: "unrecognised signed message format" };
  if (expectedMessage != null && !sameSignedPayload(parsed.pairingText, expectedMessage)) {
    return { ok: false, error: "signed message does not match the submitted pairing code" };
  }
  const net = bip47utils.networks[network];
  let verified = false;
  try {
    verified = message.verify(parsed.message, parsed.address, parsed.signature, net.messagePrefix);
  } catch (e) {
    return { ok: false, error: "signature could not be verified (" + e.message + ")" };
  }
  if (!verified) return { ok: false, error: "invalid signature" };
  if (parsed.paymentCode) {
    const derived = notificationAddresses(parsed.paymentCode);
    if (!derived.length) {
      return { ok: false, error: "signature is valid, but the BIP47 line inside the signed message is not a valid payment code" };
    }
    if (!derived.includes(parsed.address)) {
      return { ok: false, error: "signature is valid, but the signing address is not the notification address of the payment code inside the message" };
    }
  }
  // expectedAddress may be a single address or every address the authenticated
  // code could have signed from (see notificationAddresses).
  const accept = expectedAddress == null ? null : (Array.isArray(expectedAddress) ? expectedAddress : [expectedAddress]);
  if (accept && !accept.includes(parsed.address)) {
    return { ok: false, error: "signed by a different address than the authenticated payment code" };
  }
  return { ok: true, address: parsed.address, paymentCode: parsed.paymentCode };
}

// ---- operator binding (data/operator.json) ----------------------------------
// A Dojo Bay instance MUST prove who runs it: operator.json binds the onion
// address to the operator's payment code via a wallet signature over the text
//
//     http://<onion>/
//
//     BIP47: <payment code>
//
// (unlike pairing blocks, the BIP47 line here is INSIDE the signed message:
// the operator pastes the whole text into the wallet's Sign tool). Verified at
// install, at bootstrap import before trusting a remote instance's data, and
// on every rebuild.
export function verifyOperatorDoc(doc, { expectedOnion } = {}) {
  if (!doc || typeof doc !== "object") return { ok: false, error: "operator.json missing or unreadable" };
  if (!doc.paymentCode) return { ok: false, error: "operator.json has no paymentCode" };
  if (!doc.verifySigned) return { ok: false, error: "operator.json has no verifySigned block" };
  const t = String(doc.verifySigned).replace(/\r\n/g, "\n");
  // The newline after the BEGIN marker is optional: some terminals swallow it
  // when a block is pasted. It is not part of the signed text either way, so
  // tolerating it recovers the correct message rather than changing it.
  const msgM = t.match(/BEGIN BITCOIN SIGNED MESSAGE-----[ \t]*\n?([\s\S]*?)\n-----BEGIN BITCOIN SIGNATURE/);
  const addrM = t.match(/Address:\s*(\S+)/);
  const sigM = t.match(/\n([A-Za-z0-9+\/=]{80,})\n*-----END BITCOIN SIGNATURE/);
  if (!msgM || !addrM || !sigM) {
    // Name what is missing: a truncated or line-dropped paste is by far the
    // most common cause, and "not recognisable" alone sends people hunting
    // for a problem with their wallet instead of re-pasting.
    const missing = [
      !msgM && "the BEGIN BITCOIN SIGNED MESSAGE section",
      !addrM && "the Address: line",
      !sigM && "the signature line before END BITCOIN SIGNATURE",
    ].filter(Boolean).join(", ");
    return { ok: false, error: `verifySigned is not a recognisable signed block (missing ${missing}) — the paste may have been truncated; paste the whole block again` };
  }
  const signedMessage = msgM[1].replace(/\n+$/, "");
  const norm = (u) => String(u || "").trim().replace(/\/+$/, "");
  const firstLine = signedMessage.split("\n")[0].trim();
  if (norm(firstLine) !== norm(doc.onion)) return { ok: false, error: "signed message does not match the declared onion" };
  if (expectedOnion && norm(doc.onion) !== norm(expectedOnion)) {
    return { ok: false, error: "declared onion does not match the address this document was fetched from" };
  }
  const bipM = signedMessage.match(/BIP47:\s*(PM8T[1-9A-HJ-NP-Za-km-z]+)/);
  if (!bipM || bipM[1] !== doc.paymentCode) {
    return { ok: false, error: "the BIP47 line inside the signed message does not match the declared payment code" };
  }
  const expectedAddr = notificationAddress(doc.paymentCode);
  if (addrM[1].trim() !== expectedAddr) {
    // Naming both addresses matters: the usual cause is signing from a
    // different account than the payment code entered, and the operator can
    // only spot that if they can see which address their wallet actually used.
    return { ok: false, error: `signed by ${addrM[1].trim()}, but the payment code's notification address is ${expectedAddr} — sign under PayNym → Sign message, which uses your PayNym's notification address` };
  }
  const net = bip47utils.networks.bitcoin;
  try {
    if (!message.verify(signedMessage, expectedAddr, sigM[1].trim(), net.messagePrefix)) {
      return { ok: false, error: "invalid signature" };
    }
  } catch (e) { return { ok: false, error: "signature could not be verified (" + e.message + ")" }; }
  return { ok: true, address: expectedAddr };
}
