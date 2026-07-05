// Auth47 login and BIP47 signed-payload verification for The Dojo Bay backend.
// Thin wrappers over the audited Samourai libraries; the exact call shapes here
// were verified against the libraries end to end (see selftest.mjs).
import { Auth47Verifier } from "@samouraiwallet/auth47";
import { BIP47Factory } from "@samouraiwallet/bip47";
import { bitcoinMessageFactory } from "@samouraiwallet/bitcoinjs-message";
import * as bip47utils from "@samouraiwallet/bip47/utils";
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

// ---- lab-style signed pairing payload verification -------------------------
// The submitted `signed` blob is a BIP-signed message. We require it to be
// signed by the notification address of the operator's authenticated payment
// code, over the exact pairing JSON they are submitting. This is the same
// verify() the paymentcode.io lab uses.
//
// The signed message format Samourai/Ashigaru export wraps the payload between
// BEGIN/END markers with a BIP47 payment code and a signature block. We accept
// either a raw {message, address, signature} triple or that wrapped text and
// pull the fields out of it.
export function parseSignedBlock(text) {
  if (!text || typeof text !== "string") return null;
  const t = text.replace(/\r\n/g, "\n");
  // wrapped "-----BEGIN BITCOIN SIGNED MESSAGE-----" form
  const msgM = t.match(/BEGIN BITCOIN SIGNED MESSAGE-----\n([\s\S]*?)\n(?:BIP47:|-----BEGIN BITCOIN SIGNATURE)/);
  const addrM = t.match(/Address:\s*(\S+)/);
  const sigM = t.match(/\n([A-Za-z0-9+/=]{80,})\n-----END BITCOIN SIGNATURE/);
  if (msgM && addrM && sigM) {
    return { message: msgM[1].trim(), address: addrM[1].trim(), signature: sigM[1].trim() };
  }
  return null;
}

// Verify that `signedText` is a valid signature, by the expected notification
// address, over `expectedMessage` (the canonical pairing JSON string).
export function verifySignedPayload({ signedText, expectedMessage, expectedAddress, network = "bitcoin" }) {
  const parsed = parseSignedBlock(signedText);
  if (!parsed) return { ok: false, error: "unrecognised signed message format" };
  if (expectedAddress && parsed.address !== expectedAddress) {
    return { ok: false, error: "signed by a different address than the authenticated payment code" };
  }
  if (expectedMessage != null && parsed.message.trim() !== String(expectedMessage).trim()) {
    return { ok: false, error: "signed message does not match the submitted pairing code" };
  }
  const net = bip47utils.networks[network];
  let verified = false;
  try {
    verified = message.verify(parsed.message, parsed.address, parsed.signature, net.messagePrefix);
  } catch (e) {
    return { ok: false, error: "signature could not be verified (" + e.message + ")" };
  }
  return verified ? { ok: true, address: parsed.address } : { ok: false, error: "invalid signature" };
}
