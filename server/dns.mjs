// =============================================================================
// TXT record lookups over Tor, for verified operator domains.
//
// A Tor-only instance has no ordinary path to a TXT record: Tor's SOCKS
// interface resolves names but cannot fetch arbitrary record types. So we ask
// public DNS-over-HTTPS resolvers, tunnelling the HTTPS through the same SOCKS
// proxy the probes use.
//
// Two deliberate choices, because a resolver's answer decides whether a
// verified badge appears and a lying resolver could mint one:
//
//   1. Several independent resolvers are queried and a fixed number must agree
//      before a domain is treated as verified (DOH_AGREEMENT, default 2).
//   2. "Could not reach enough resolvers" is reported as INCONCLUSIVE, never as
//      a failure, so a Tor hiccup cannot strip a badge from an honest operator.
//
// The HTTPS-over-Tor fetch here duplicates a little of updates.mjs on purpose:
// that module is on the self-update path, which has never been exercised on real
// hardware, and refactoring it to share code is not a risk worth taking for a
// feature that only reads DNS.
// =============================================================================
import tls from "node:tls";
import { socks5Connect } from "../scripts/update.mjs";

// Resolvers use different JSON paths but the same response shape.
const RESOLVERS = [
  { host: "cloudflare-dns.com", path: "/dns-query" },
  { host: "dns.quad9.net", path: "/dns-query" },
  { host: "dns.google", path: "/resolve" },
];

export const DOH_AGREEMENT = Math.max(1, +(process.env.DOH_AGREEMENT || 2));
const MAX_BODY = 64 * 1024;              // a TXT answer is tiny; cap the read

function resolverList() {
  const only = (process.env.DOH_RESOLVERS || "").trim();
  if (!only) return RESOLVERS;
  const wanted = only.split(",").map((s) => s.trim()).filter(Boolean);
  return RESOLVERS.filter((r) => wanted.includes(r.host));
}

// One HTTPS GET through the Tor SOCKS proxy, returning the response body as
// text. Deliberately minimal: no redirects (a resolver that redirects is not
// one we want), and a hard body cap.
/** @param {string} host @param {string} path @param {Partial<import("../types.js").ProbeCfg>} cfg */
async function httpsGetOverTor(host, path, { proxyHost, proxyPort, timeoutMs = 20000 }) {
  const raw = await socks5Connect(proxyHost, proxyPort, host, 443, timeoutMs);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(timer); try { socket.destroy(); } catch {} fn(arg); } };
    const timer = setTimeout(() => finish(reject, new Error("timeout")), timeoutMs);
    const socket = tls.connect({ socket: raw, servername: host }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: dojobay-domain-check\r\n` +
        `Accept: application/dns-json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
    });
    const chunks = [];
    let size = 0;
    socket.on("data", (d) => {
      size += d.length;
      if (size > MAX_BODY) return finish(reject, new Error("response too large"));
      chunks.push(d);
    });
    socket.on("error", (e) => finish(reject, e));
    socket.on("close", () => {
      if (done) return;
      try {
        const all = Buffer.concat(chunks);
        const headEnd = all.indexOf("\r\n\r\n");
        if (headEnd < 0) return finish(reject, new Error("malformed reply"));
        const headText = all.subarray(0, headEnd).toString("latin1");
        const m = headText.match(/^HTTP\/1\.[01] (\d{3})/);
        if (!m) return finish(reject, new Error("malformed reply"));
        if (+m[1] !== 200) return finish(reject, new Error("HTTP " + m[1]));
        let body = all.subarray(headEnd + 4);
        if (/transfer-encoding:\s*chunked/i.test(headText)) {
          const parts = []; let p = 0;
          for (;;) {
            const nl = body.indexOf("\r\n", p);
            if (nl < 0) break;
            const n = parseInt(body.subarray(p, nl).toString("latin1"), 16);
            if (!n) break;
            parts.push(body.subarray(nl + 2, nl + 2 + n));
            p = nl + 2 + n + 2;
          }
          body = Buffer.concat(parts);
        }
        finish(resolve, body.toString("utf8"));
      } catch (e) { finish(reject, e); }
    });
  });
}

// A DoH JSON answer gives TXT data as a quoted string, and a long record as
// several quoted strings that must be concatenated. Normalise both to one line.
export function parseTxtAnswer(json) {
  let doc;
  try { doc = JSON.parse(json); } catch { return null; }
  if (typeof doc !== "object" || doc === null) return null;
  if (doc.Status === 3) return [];                      // NXDOMAIN: no records
  if (doc.Status !== 0) return null;                    // SERVFAIL etc: no answer
  const answers = Array.isArray(doc.Answer) ? doc.Answer : [];
  return answers
    .filter((a) => a && (a.type === 16 || a.type === undefined))
    .map((a) => String(a.data || ""))
    .map((d) => (d.includes('"') ? (d.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1)).join("") : d))
    .map((d) => d.trim())
    .filter(Boolean);
}

// Look up TXT records for `name` across the resolvers. Returns
// { records, answered, byResolver, errors } where `records` is the set of
// records seen and `answered` counts resolvers that gave a usable answer.
/** @param {string} name @param {Partial<import("../types.js").ProbeCfg>} [cfg] */
export async function lookupTxt(name, cfg = {}) {
  const resolvers = resolverList();
  const q = `?name=${encodeURIComponent(name)}&type=TXT`;
  const results = await Promise.allSettled(resolvers.map(async (r) => {
    const body = await httpsGetOverTor(r.host, r.path + q, cfg);
    const recs = parseTxtAnswer(body);
    if (recs === null) throw new Error("resolver returned no usable answer");
    return { host: r.host, records: recs };
  }));
  const byResolver = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];                       // a local, so the union narrows
    if (r.status === "fulfilled") byResolver.push(r.value);
    else errors.push(`${resolvers[i].host}: ${r.reason?.message || "failed"}`);
  }
  const records = [...new Set(byResolver.flatMap((r) => r.records))];
  return { records, answered: byResolver.length, byResolver, errors };
}

// Do at least DOH_AGREEMENT resolvers see a record satisfying `predicate`?
// Distinguishes "not there" from "we could not tell".
/** @param {string} name @param {(r: string) => boolean} predicate @param {Partial<import("../types.js").ProbeCfg>} [cfg] */
export async function txtRecordAgreed(name, predicate, cfg = {}) {
  const { answered, byResolver, errors, records } = await lookupTxt(name, cfg);
  if (answered < DOH_AGREEMENT) {
    return { ok: false, inconclusive: true, answered, agreed: 0,
      error: `only ${answered} of ${DOH_AGREEMENT} required resolvers answered (${errors.join("; ") || "no detail"})` };
  }
  const agreed = byResolver.filter((r) => r.records.some(predicate)).length;
  if (agreed >= DOH_AGREEMENT) return { ok: true, inconclusive: false, answered, agreed };
  return { ok: false, inconclusive: false, answered, agreed,
    error: records.length
      ? `${agreed} of ${DOH_AGREEMENT} required resolvers saw a matching record; ${records.length} TXT record(s) present but not matching`
      : `no TXT record found at ${name}` };
}
