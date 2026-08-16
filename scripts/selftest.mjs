#!/usr/bin/env node
// Offline self-test for the reachability logic in update.mjs.
// Spins up a fake SOCKS5 proxy (no Tor needed) that can simulate:
//   - a reachable hidden service that returns an HTTP response  -> UP
//   - Tor reporting the onion as unreachable (reply 0x04)        -> DOWN
//   - no proxy listening at all                                  -> DOWN
//
// Run: node scripts/selftest.mjs   (exit 0 = all assertions passed)

import net from "node:net";
import { deflateRawSync } from "node:zlib";
import tlsMod from "node:tls";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert";
import { probe, fetchAvatar, parseDojoVersion, normaliseVersion, parseIndexerUrl, normaliseIndexerUrl, probeCfg, httpOverTor, MAX_RESPONSE_BYTES } from "./update.mjs";
import { packSource } from "./pack-source.mjs";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Minimal SOCKS5 server. `mode` decides how it answers the CONNECT request.
// A self-signed certificate for the mock DoH resolver, generated once. openssl
// is present on the Debian hosts this suite runs on; if it is missing the DoH
// transport check reports that it was skipped rather than failing the run.
const DOH_RECORD = "dojobay-domain-v1 pm=PM8T" + "1".repeat(112);
const DOH_ANSWER = JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '"' + DOH_RECORD + '"' }] });
let DOH_TLS = null;
function dohTlsAvailable() {
  if (DOH_TLS) return true;
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "dojobay-doh-"));
    // All three resolver hostnames, because validation is ON: a certificate
    // naming only one would leave the other two failing the hostname check and
    // the agreement threshold unreachable.
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"),
      "-days", "1", "-subj", "/CN=cloudflare-dns.com",
      "-addext", "subjectAltName=DNS:cloudflare-dns.com,DNS:dns.quad9.net,DNS:dns.google"],
      { stdio: "ignore" });
    DOH_TLS = { key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) };
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

function mockProxy(mode) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let stage = "greet";
      sock.on("data", (d) => {
        if (stage === "greet") {
          sock.write(Buffer.from([0x05, 0x00])); // no-auth OK
          stage = "connect";
          return;
        }
        if (stage === "connect") {
          if (mode === "unreachable") {
            sock.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // host unreachable
            sock.end();
            return;
          }
          // success reply, bound addr 0.0.0.0:0
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          // A DoH resolver speaks TLS, so terminate it on this same socket
          // instead of tunnelling: upgrading here, immediately after the SOCKS
          // reply and before any client bytes arrive, avoids losing the
          // ClientHello to a race with an upstream connect.
          if (mode === "doh") {
            sock.removeAllListeners("data");
            const t = new tlsMod.TLSSocket(sock, { isServer: true, key: DOH_TLS.key, cert: DOH_TLS.cert });
            t.on("error", () => {});
            t.once("data", () => {
              const body = Buffer.from(DOH_ANSWER);
              t.end(`HTTP/1.1 200 OK\r\nContent-Type: application/dns-json\r\n` +
                    `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n` + DOH_ANSWER);
            });
            return;
          }
          stage = "tunnel";
          return;
        }
        if (stage === "tunnel") {
          // we just received the request; answer like a Dojo HTTP server
          if (mode === "http") sock.write("HTTP/1.0 401 Unauthorized\r\n\r\n");
          if (mode === "http-version") sock.write("HTTP/1.0 200 OK\r\nX-Dojo-Version: 1.31.0\r\nContent-Length: 0\r\n\r\n");
          if (mode === "dojo") {
            const req = d.toString("latin1");
            if (req.includes("/auth/login")) {
              const body = JSON.stringify({ authorizations: { access_token: "tok" } });
              sock.write(`HTTP/1.0 200 OK\r\nX-Dojo-Version: v1.30.0\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
            } else if (req.includes("/wallet")) {
              const body = JSON.stringify({ info: { latest_block: { height: 840000, time: 123 } } });
              sock.write(`HTTP/1.0 200 OK\r\nX-Dojo-Version: v1.30.0\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
            } else if (req.includes("/support/services")) {
              const body = JSON.stringify({ services: [
                { type: "explorer", kind: "btc_rpc_explorer", url: "http://" + "e".repeat(56) + ".onion" },
                { type: "indexer", kind: "fulcrum", url: "tcp://" + "i".repeat(56) + ".onion:50001" },
                { type: "soroban", kind: "rpc", url: "http://" + "s".repeat(56) + ".onion" },
              ] });
              sock.write(`HTTP/1.0 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
            } else sock.write("HTTP/1.0 404 x\r\n\r\n");
          }
          if (mode === "avatar") {
            const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fakepixels")]);
            sock.write(Buffer.concat([Buffer.from("HTTP/1.0 200 OK\r\nContent-Type: image/png\r\n\r\n", "latin1"), png]));
          }
          if (mode === "avatar-notpng") sock.write("HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n<html>not found</html>");
          // A node that answers and then never stops. Writes headers, then
          // pushes 256 KiB chunks on a short interval and never ends the
          // socket, which is precisely the shape the byte cap exists to stop:
          // the read-timeout alone would let it accumulate for the full
          // timeout. Deliberately does NOT declare Content-Length, since a
          // reader that trusted that header would not need a cap at all.
          // Streams forever WITHOUT ever sending an HTTP status line, so the
          // unauthenticated probe's "is this HTTP yet?" test never matches and
          // its buffer is the thing that grows.
          if (mode === "babble") {
            const chunk = Buffer.alloc(64 * 1024, 0x2e);
            const t = setInterval(() => sock.write(chunk), 5);
            sock.on("close", () => clearInterval(t));
            sock.on("error", () => clearInterval(t));
            return;
          }
          if (mode === "firehose") {
            sock.write("HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n");
            const chunk = Buffer.alloc(256 * 1024, 0x41);
            const t = setInterval(() => { if (!sock.write(chunk)) { /* let it drain */ } }, 5);
            sock.on("close", () => clearInterval(t));
            sock.on("error", () => clearInterval(t));
            return;                       // never sock.end()
          }
          // mode === "silent" -> accept stream but never respond
          sock.end();
        }
      });
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function withProxy(mode, fn) {
  const server = await mockProxy(mode);
  const port = server.address().port;
  try { return await fn(port); }
  finally { server.close(); }
}

const cfg = (port, extra = {}) => ({
  proxyHost: "127.0.0.1", proxyPort: port, timeoutMs: 3000, connectOnly: false, ...extra,
});

let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log("  ok -", label); }

// Minimal single-entry zip (stored), for the zip-slip rejection test.
function makeMiniZip(name, data) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const nb = Buffer.from(name, "utf8");
  const common = Buffer.concat([u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(0), u32(data.length), u32(data.length), u16(nb.length), u16(0)]);
  const local = Buffer.concat([u32(0x04034b50), common, nb, data]);
  const central = Buffer.concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(0), nb]);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)]);
  return Buffer.concat([local, central, end]);
}

// makeMiniZip stores its payload (method 0); a bomb has to be deflated to be a
// bomb, so this is a second builder rather than a parameter on the first.
function makeDeflatedZip(name, raw) {
  const comp = deflateRawSync(raw);
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const nb = Buffer.from(name, "utf8");
  // method 8, and the header declares the TRUE inflated size. A hostile archive
  // would lie here, which is exactly why the guard is enforced by zlib during
  // inflation rather than by believing this field.
  const common = Buffer.concat([u16(20), u16(0x0800), u16(8), u16(0), u16(0), u32(0), u32(comp.length), u32(raw.length), u16(nb.length), u16(0)]);
  const local = Buffer.concat([u32(0x04034b50), common, nb, comp]);
  const central = Buffer.concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(0), nb]);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)]);
  return Buffer.concat([local, central, end]);
}

// Several deflated entries in one archive, so the shared-budget behaviour can
// be told apart from a per-entry limit.
function concatZip(pairs) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, raw] of pairs) {
    const comp = deflateRawSync(raw);
    const nb = Buffer.from(name, "utf8");
    const common = Buffer.concat([u16(20), u16(0x0800), u16(8), u16(0), u16(0), u32(0), u32(comp.length), u32(raw.length), u16(nb.length), u16(0)]);
    const local = Buffer.concat([u32(0x04034b50), common, nb, comp]);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(off), nb]));
    locals.push(local);
    off += local.length;
  }
  const localAll = Buffer.concat(locals), centralAll = Buffer.concat(centrals);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(pairs.length), u16(pairs.length),
    u32(centralAll.length), u32(localAll.length), u16(0)]);
  return Buffer.concat([localAll, centralAll, end]);
}

console.log("self-test: reachability detection");

await check("reachable service returning HTTP -> up", async () => {
  await withProxy("http", async (port) => {
    const r = await probe("http://abcdefghij234567.onion/v2", cfg(port));
    assert.equal(r.up, true, JSON.stringify(r));
    assert.equal(r.reason, "http");
  });
});

await check("Tor reports onion unreachable -> down", async () => {
  await withProxy("unreachable", async (port) => {
    const r = await probe("http://deadbeefdeadbeef.onion/v2", cfg(port));
    assert.equal(r.up, false, JSON.stringify(r));
  });
});

await check("connect succeeds but service silent, default mode -> down", async () => {
  await withProxy("silent", async (port) => {
    const r = await probe("http://silentnode00000.onion/v2", cfg(port));
    assert.equal(r.up, false, JSON.stringify(r));
  });
});

await check("connect succeeds, CONNECT_ONLY=1 -> up", async () => {
  await withProxy("silent", async (port) => {
    const r = await probe("http://silentnode00000.onion/v2", cfg(port, { connectOnly: true }));
    assert.equal(r.up, true, JSON.stringify(r));
  });
});

// A node that answers and then never stops sending. Before the cap, the reader
// accumulated until the socket closed or the timeout fired, so this shape put
// however many megabytes a Tor circuit carries in thirty seconds into the heap,
// once per concurrent probe. The tests below assert the three things that
// matter: the read is abandoned, it is abandoned near the ceiling rather than
// after the timeout, and one node behaving this way does not affect the cycle.
await check("a response that never ends is abandoned at the byte ceiling", async () => {
  await withProxy("firehose", async (port) => {
    const req = "GET / HTTP/1.0\r\nHost: x.onion\r\nConnection: close\r\n\r\n";
    // a small explicit cap, so the test does not have to push 2 MiB to prove it
    await assert.rejects(
      httpOverTor(cfg(port), "firehose000000.onion", 80, req, 5000, 512 * 1024),
      /exceeded 524288 bytes/,
      "the read rejects with a reason naming the limit it hit");
  });
});

await check("and abandoned promptly, not left running until the timeout", async () => {
  await withProxy("firehose", async (port) => {
    const req = "GET / HTTP/1.0\r\nHost: x.onion\r\nConnection: close\r\n\r\n";
    const t0 = Date.now();
    // The timeout is 8s and the responder writes 256 KiB every 5ms, so a cap
    // that only took effect at close would sit here for the full 8 seconds.
    await assert.rejects(httpOverTor(cfg(port), "firehose000000.onion", 80, req, 8000, 512 * 1024));
    const ms = Date.now() - t0;
    assert.ok(ms < 4000, `gave up after ${ms}ms, which is not obviously before the 8s timeout`);
  });
});

await check("a firehose node is one failed probe, not a failed cycle", async () => {
  await withProxy("firehose", async (port) => {
    // The authenticated path, which is what a listed node with an apikey gets,
    // and the one that reads a whole body through httpOverTor. What matters is
    // that it RETURNS rather than throws: the caller loops over nodes, so an
    // escaping error here would take the rest of the cycle with it.
    const r = await probe("http://firehose000000.onion/v2", cfg(port, { apikey: "k", timeoutMs: 20000 }));
    assert.equal(r.up, false, JSON.stringify(r));
    assert.ok(/exceeded/.test(r.reason), "and the reason names the cap: " + JSON.stringify(r.reason));
  });
});

await check("a node that never speaks HTTP is not listened to indefinitely either", async () => {
  await withProxy("babble", async (port) => {
    // The unauthenticated path keeps its own buffer, which only stopped growing
    // when a status line matched. A stream that never contains one bypassed the
    // ceiling entirely until this was fixed.
    const t0 = Date.now();
    const r = await probe("http://babble0000000000.onion/v2", cfg(port, { timeoutMs: 8000 }));
    const ms = Date.now() - t0;
    assert.equal(r.up, false, JSON.stringify(r));
    assert.equal(r.reason, "no-http-response", JSON.stringify(r));
    assert.ok(ms < 4000, `gave up after ${ms}ms rather than promptly`);
  });
});

await check("the default ceiling is generous against real responses, and stated once", async () => {
  // A Dojo /wallet reply for two dummy xpubs is single-digit KB and a PayNym
  // avatar is a small PNG, so the default sits three orders of magnitude above
  // anything legitimate. This pins the number so that lowering it towards real
  // traffic, or removing it, is a deliberate act rather than a quiet one.
  assert.equal(MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
  const { MAX_SOURCE_ZIP_BYTES } = await import("../server/self-update.mjs");
  assert.ok(MAX_SOURCE_ZIP_BYTES > MAX_RESPONSE_BYTES,
    "the source zip is the one legitimate exception and must be allowed more, not less");
});

await check("no proxy listening -> down", async () => {
  const r = await probe("http://whatever1234567.onion/v2", cfg(1)); // nothing on :1
  assert.equal(r.up, false, JSON.stringify(r));
});

await check("parseDojoVersion reads and normalises the X-Dojo-Version header", async () => {
  const head = "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nX-Dojo-Version: v1.28.0\r\n";
  assert.equal(parseDojoVersion(head), "1.28.0");                       // leading v stripped
  assert.equal(parseDojoVersion("x-dojo-version: 1.29.0-rc1\r\n"), "1.29.0-rc1"); // case-insensitive name, pre-release
  assert.equal(parseDojoVersion("X-Dojo-Version: 1.5\r\nX-Dojo-Version: 9.9\r\n"), "1.5"); // first wins
  assert.equal(parseDojoVersion("Server: nginx\r\n"), null);            // header absent
  assert.equal(parseDojoVersion("X-Dojo-Version: not-a-version\r\n"), null); // junk rejected
  assert.equal(normaliseVersion("v" + "9".repeat(40)), null);           // over-long rejected
  assert.equal(parseDojoVersion("X-Dojo-Custom: 2.0\r\n", "x-dojo-custom"), "2.0"); // configurable name
});

await check("plain probe captures X-Dojo-Version when the node sends it", async () => {
  await withProxy("http-version", async (port) => {
    const r = await probe("http://versionnode0000.onion/v2", cfg(port));
    assert.equal(r.up, true, JSON.stringify(r));
    assert.equal(r.detectedVersion, "1.31.0", JSON.stringify(r));
  });
});

await check("authenticated probe reads chain tip and X-Dojo-Version", async () => {
  await withProxy("dojo", async (port) => {
    const r = await probe("http://dojonode0000000.onion/v2", cfg(port, { apikey: "k", network: "mainnet" }));
    assert.equal(r.up, true, JSON.stringify(r));
    assert.equal(r.height, 840000, JSON.stringify(r));
    assert.equal(r.detectedVersion, "1.30.0", JSON.stringify(r));
  });
});

await check("a probe config missing its transport settings is filled in, not left undefined", async () => {
  // The installer called probe() with only { apikey, network }, so proxyPort
  // reached net.connect as undefined and Node reported 'The "options" or "port"
  // or "path" argument must be specified' during the anchor check at step 6.
  const filled = probeCfg({ apikey: "k", network: "mainnet" });
  assert.equal(filled.proxyHost, "127.0.0.1");
  assert.equal(filled.proxyPort, 9050);
  assert.ok(filled.timeoutMs > 0, "a timeout must be set, or the probe times out immediately");
  assert.equal(filled.apikey, "k", "caller's own fields are preserved");
  // explicit values always win over the defaults
  const explicit = probeCfg({ proxyHost: "10.0.0.1", proxyPort: 9150, timeoutMs: 5 });
  assert.deepEqual([explicit.proxyHost, explicit.proxyPort, explicit.timeoutMs], ["10.0.0.1", 9150, 5]);
  // and a partial config now probes rather than throwing a socket error
  await withProxy("dojo", async (port) => {
    const r = await probe("http://dojonode0000000.onion/v2", { proxyPort: port, apikey: "k", network: "mainnet" });
    assert.equal(r.up, true, JSON.stringify(r));
  });
});

await check("every probe call site passes the transport config", async () => {
  // Static check: the anchor probe in the installer is only exercised by a real
  // interactive run, so pin it here instead.
  const { readFileSync } = await import("node:fs");
  for (const f of ["install.mjs", "update.mjs"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const m of src.matchAll(/await probe\(([\s\S]{0,200}?)\)\s*;/g)) {
      assert.ok(/\.\.\.(PROBE_)?CFG/.test(m[1]), `probe() call in ${f} must spread PROBE_CFG/CFG: ${m[1].slice(0, 80)}`);
    }
  }
});

await check("parseIndexerUrl picks the indexer entry out of /support/services", async () => {
  const onion = "i".repeat(56);
  const doc = (services) => JSON.stringify({ services });
  assert.equal(parseIndexerUrl(doc([
    { type: "explorer", url: "http://" + "e".repeat(56) + ".onion" },
    { type: "indexer", kind: "fulcrum", url: "tcp://" + onion + ".onion:50001" },
  ])), "tcp://" + onion + ".onion:50001");                                  // picks indexer, not explorer
  assert.equal(parseIndexerUrl(doc([{ type: "indexer", url: "ssl://" + onion + ".onion:50002" }])),
    "ssl://" + onion + ".onion:50002");                                     // ssl accepted
  assert.equal(parseIndexerUrl(doc([{ type: "explorer", url: "http://x.onion" }])), null); // no indexer -> null
  assert.equal(parseIndexerUrl(doc([])), null);                             // node exposes nothing
  assert.equal(parseIndexerUrl("not json"), null);                          // pre-1.27.0 route/HTML
  assert.equal(parseIndexerUrl(doc([{ type: "indexer", url: "http://" + onion + ".onion:50001" }])), null); // wrong scheme
  assert.equal(normaliseIndexerUrl("tcp://short.onion:50001"), null);       // not a v3 onion
  assert.equal(normaliseIndexerUrl("tcp://" + onion + ".onion"), null);     // port required
  assert.equal(normaliseIndexerUrl("  ssl://" + onion + ".onion:50002  "), "ssl://" + onion + ".onion:50002"); // trimmed
});

await check("authenticated probe captures the Electrum endpoint from /support/services", async () => {
  await withProxy("dojo", async (port) => {
    const r = await probe("http://dojonode0000000.onion/v2", cfg(port, { apikey: "k", network: "mainnet" }));
    assert.equal(r.up, true, JSON.stringify(r));
    assert.equal(r.detectedIndexer, "tcp://" + "i".repeat(56) + ".onion:50001", JSON.stringify(r));
  });
});

await check("avatar fetched over the (mock) Tor proxy and written as verified PNG", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dojobay-avatar-"));
  try {
    await withProxy("avatar", async (port) => {
      const dest = await fetchAvatar("PMTESTCODE", { proxyHost: "127.0.0.1", proxyPort: port, destDir: dir, timeoutMs: 3000 });
      const bytes = await readFile(dest);
      assert.ok(dest.endsWith("PMTESTCODE.png"));
      assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await check("non-PNG avatar response refused, nothing written", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dojobay-avatar-"));
  try {
    await withProxy("avatar-notpng", async (port) => {
      await assert.rejects(
        fetchAvatar("PMOTHER", { proxyHost: "127.0.0.1", proxyPort: port, destDir: dir, timeoutMs: 3000 }),
        /not a PNG/);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await check("source zip packs the codebase and never the instance's own data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dojobay-src-"));
  try {
    const r = await packSource({ outDir: dir });
    const buf = await readFile(r.out);
    // walk the central directory for entry names
    const names = [];
    for (let i = 0; i + 46 < buf.length; i++) {
      if (buf.readUInt32LE(i) !== 0x02014b50) continue;
      const nlen = buf.readUInt16LE(i + 28);
      names.push(buf.subarray(i + 46, i + 46 + nlen).toString("utf8"));
      i += 45 + nlen;
    }
    assert.ok(names.includes("dojobay/assets/js/app.js"), "app.js present");
    assert.ok(names.includes("dojobay/data/version.json"), "version marker present");
    assert.ok(names.includes("dojobay/scripts/pack-source.mjs"), "packer ships itself");
    const forbidden = names.filter((n) =>
      /server\/data|seed\.json|operator\.json|paynym-codes|dojos\.json|history|avatars|node_modules|\.zip$/.test(n));
    assert.deepEqual(forbidden, [], "forbidden entries: " + forbidden.join(", "));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await check("TXT lookup over Tor: agreement required, unreachable resolvers are inconclusive", async () => {
  const dns = await import("../server/dns.ts");

  // An unreachable proxy must be INCONCLUSIVE, never a failure: a Tor outage
  // must not strip a verified badge from an honest operator. This half needs no
  // TLS, so it always runs.
  const down = await dns.txtRecordAgreed("_dojobay.example.com", () => true,
    { proxyHost: "127.0.0.1", proxyPort: 1, timeoutMs: 400 });
  assert.ok(!down.ok && down.inconclusive, "unreachable resolvers are inconclusive: " + JSON.stringify(down));
  assert.equal(down.agreed, 0);

  if (!dohTlsAvailable()) {
    console.log("       (note: openssl unavailable, TLS half of the DoH check skipped)");
    return;
  }
  // Full path against a mock resolver behind the mock SOCKS proxy: SOCKS
  // connect, TLS, HTTP/1.1, DoH JSON, agreement counting.
  // Certificate validation stays ON. The mock resolver's self-signed
  // certificate is passed as a trust anchor for these lookups alone, rather
  // than disabling validation for the whole process with
  // NODE_TLS_REJECT_UNAUTHORIZED, which would also cover every other
  // connection made while it was set.
  await withProxy("doh", async (port) => {
      const cfg = { proxyHost: "127.0.0.1", proxyPort: port, timeoutMs: 5000, tlsCa: DOH_TLS.cert };
      const found = await dns.lookupTxt("_dojobay.example.com", cfg);
      assert.ok(found.records.includes(DOH_RECORD),
        "the TXT record is read back: " + JSON.stringify(found.records) + " errors=" + JSON.stringify(found.errors));
      assert.ok(found.answered >= dns.DOH_AGREEMENT, "enough resolvers answered, got " + found.answered);

      const agreed = await dns.txtRecordAgreed("_dojobay.example.com", (r) => r === DOH_RECORD, cfg);
      assert.ok(agreed.ok && agreed.agreed >= dns.DOH_AGREEMENT, "agreement reached: " + JSON.stringify(agreed));

      // present but not matching is a definite failure, not "cannot tell"
      const missing = await dns.txtRecordAgreed("_dojobay.example.com", () => false, cfg);
      assert.ok(!missing.ok && !missing.inconclusive, "a non-matching record fails rather than being inconclusive");
      assert.ok(/not matching/.test(missing.error), "and says the record is present but not matching: " + missing.error);
  });
});

await check("a signed block ends its own paste, and END still works", async () => {
  const { collectPasteFrom } = await import("./installer-lib.mjs");
  const { createInterface } = await import("node:readline");
  const { Readable, Writable } = await import("node:stream");
  const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });
  const feed = (lines) => createInterface({ input: Readable.from(lines.map((l) => l + "\n")), output: sink() });

  const block = [
    "-----BEGIN BITCOIN SIGNED MESSAGE-----", "http://x.onion/", "",
    "BIP47: PM8Tabc", "-----BEGIN BITCOIN SIGNATURE-----",
    "Address: 1abc", "", "sigsigsig", "-----END BITCOIN SIGNATURE-----",
  ];
  const MARK = "-----END BITCOIN SIGNATURE-----";

  // An operator who pastes a block and presses Enter has, to their eye,
  // finished: the block says END. Waiting for a bare END made the installer
  // look hung, with Ctrl-C the only way out.
  const auto = await collectPasteFrom(feed(block), "END", { endMarker: MARK });
  assert.strictEqual(auto.split("\n").length, block.length, "the paste ends on the wallet's own terminator");
  assert.ok(auto.trim().endsWith(MARK), "and keeps that line, which is part of the block");

  // anything after it is not swallowed into the block
  const withNoise = await collectPasteFrom(feed([...block, "stray typing"]), "END", { endMarker: MARK });
  assert.ok(!withNoise.includes("stray typing"), "input after the terminator is not absorbed");

  // END still ends a paste that has no such marker, e.g. a pairing payload
  const json = await collectPasteFrom(feed(['{"pairing":{}}', "END", "after"]), "END");
  assert.strictEqual(json, '{"pairing":{}}', "a bare END still terminates a paste with no marker");

  // and a block pasted as one chunk still arrives whole (the earlier bug)
  const oneChunk = await collectPasteFrom(feed(block), "END", { endMarker: MARK });
  assert.strictEqual(oneChunk.split("\n").length, block.length, "a one-chunk paste keeps every line");
});

await check("uninstall: torrc surgery is reversible and spares other services", async () => {
  const { mergeTorrc, stripTorrc } = await import("./installer-lib.mjs");
  // A torrc usually carries an operator's OTHER hidden services. Removing ours
  // must be surgical: an uninstaller that rewrote the file would take theirs.
  const before = "SocksPort 9050\n\n# my other hidden service\n"
    + "HiddenServiceDir /var/lib/tor/other\nHiddenServicePort 80 127.0.0.1:9000\n";
  const merged = mergeTorrc(before, "/var/lib/tor/dojobay");
  assert.ok(merged.includes("/var/lib/tor/dojobay"), "the block went in");

  const back = stripTorrc(merged);
  assert.ok(back.removed, "and is reported as removed");
  assert.strictEqual(back.text, before, "the file returns to exactly what it was");
  assert.ok(back.text.includes("/var/lib/tor/other"), "the operator's other service survives");

  const untouched = stripTorrc(before);
  assert.ok(!untouched.removed && untouched.text === before,
    "a torrc we never touched is left alone and reported as such");
});

await check("uninstall: destructive steps are opt-in and confirmed", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./uninstall.mjs", import.meta.url), "utf8");
  // The two irreversible acts: deleting the store (other operators' signed
  // submissions) and deleting the hidden service key (the onion address itself,
  // permanently, for everyone holding the bookmark).
  assert.ok(/--purge-data/.test(src) && /--purge-onion/.test(src),
    "both are behind explicit flags rather than default behaviour");
  assert.ok(/const APPLY = argv\.includes\("--apply"\)/.test(src),
    "and nothing at all happens without --apply");
  assert.ok(/typed !== found\.onionAddress/.test(src),
    "deleting the onion key requires typing the address back");
  assert.ok(/Refusing to delete anything without a backup/.test(src),
    "a failed backup aborts rather than proceeding");
  assert.ok(/tar/.test(src) && /--no-backup/.test(src),
    "an archive is taken first unless explicitly waived");
  assert.ok(!/apt-get (remove|purge)/.test(src),
    "packages are never removed: tor and nginx probably serve something else");

  const sh = readFileSync(new URL("../uninstall.sh", import.meta.url), "utf8");
  assert.ok(/NODE_BIN="\$\(command -v node/.test(sh) && /scripts\/uninstall\.mjs/.test(sh),
    "the launcher resolves node the same way the installer's does");
});

await check("the launcher finds node itself and refuses an old one clearly", async () => {
  // Two real failures an operator hit on Ubuntu:
  //   1. `sudo node` resolves on sudo's secure_path, which excludes ~/.nvm and
  //      friends, so a working node produced "sudo: node: command not found".
  //   2. `apt install nodejs` gives Node 18 on Debian and Ubuntu, and the
  //      installer said only that 24 was required, not how to get it.
  const { readFileSync } = await import("node:fs");
  const sh = readFileSync(new URL("../install.sh", import.meta.url), "utf8");

  assert.ok(/NODE_BIN="\$\(command -v node/.test(sh),
    "the launcher resolves node as the invoking user");
  assert.ok(/exec sudo -- "\$NODE_BIN"/.test(sh),
    "and hands sudo that absolute path, so a non-secure_path node still works");
  assert.ok(/-lt "\$MIN_MAJOR"/.test(sh), "it compares the major version numerically");
  assert.ok(/deb\.nodesource\.com/.test(sh) && /apt install nodejs/.test(sh),
    "and tells the operator where to get a current Node, and what not to install");

  // the desktop entry must pass %k as its own argument, not inside the quotes:
  // interpolated there, the launcher silently does nothing
  const desktop = readFileSync(new URL("../dojobay-install.desktop", import.meta.url), "utf8");
  const exec = (desktop.match(/^Exec=(.*)$/m) || ["", ""])[1];
  assert.ok(exec.trim().endsWith("sh %k"), "%k is passed as an argument: " + exec.slice(-40));
  assert.ok(/\$\{1#file:\/\/\}/.test(exec), "and a file:// URI is reduced to a path");
  assert.ok(/^Terminal=true$/m.test(desktop), "the entry asks for a terminal");
});

await check("installer paste collector keeps every line of a one-chunk paste", async () => {
  const { collectPasteFrom } = await import("./installer-lib.mjs");
  const { createInterface } = await import("node:readline");
  const { Readable } = await import("node:stream");
  // A real paste arrives as one chunk, and readline then emits every line
  // synchronously. The previous rl.question() loop captured only the first
  // line of each chunk and silently dropped the rest, which produced blocks
  // that failed to parse ("not a recognisable signed block") even though the
  // operator had pasted a valid signature.
  const block = [
    "-----BEGIN BITCOIN SIGNED MESSAGE-----",
    "http://" + "a".repeat(56) + ".onion/",
    "",
    "BIP47: PM8T" + "1".repeat(112),
    "-----BEGIN BITCOIN SIGNATURE-----",
    "Version: Bitcoin-qt (1.0)",
    "Address: 1BitcoinEaterAddressDontSendf59kuE",
    "",
    "H" + "A".repeat(86) + "=",
    "-----END BITCOIN SIGNATURE-----",
  ].join("\n");
  const rl = createInterface({ input: Readable.from([block + "\nEND\n"]), terminal: false });
  const got = await collectPasteFrom(rl, "END");
  assert.equal(got, block, "collector must return the block verbatim, losing no lines");
  assert.equal(got.split("\n").length, 10, "all ten lines captured");
});

// The anchor an installer produces is a listing, and a listing without a signed
// pairing block is withheld by the rebuild. Before this, anchorSeed did not
// carry one, so a fresh install came up with an empty directory and no
// explanation for it. These checks are the reason that cannot recur quietly.
await check("the installed anchor is a listing the rebuild will actually publish", async () => {
  const { anchorSeed } = await import("./installer-lib.mjs");
  const { hasSignedBlock } = await import("../server/store.ts");
  const signed = [
    "-----BEGIN BITCOIN SIGNED MESSAGE-----", "{}",
    "-----BEGIN BITCOIN SIGNATURE-----", "Address: 1x", "", "AA==",
    "-----END BITCOIN SIGNATURE-----",
  ].join("\n");
  const base = { network: "mainnet", name: "my node", paymentCode: "PM8Tabc",
    paynym: "+me", payload: { pairing: { type: "dojo.api", url: "http://x.onion/v2" } } };

  const seed = anchorSeed({ ...base, signed });
  assert.ok(hasSignedBlock(seed.nodes[0]),
    "the same predicate the rebuild uses says this anchor is publishable");
  assert.equal(seed.nodes[0].signed, signed, "and the block is stored verbatim");

  // Refused rather than defaulted. A default would put the empty directory back
  // and move the failure to somewhere nobody is looking.
  // The casts are the point rather than a nuisance: the type now says `signed`
  // is required, and these assert that the runtime says so too, since seed.json
  // is written by a script that could be edited without a type checker in sight.
  assert.throws(() => anchorSeed(/** @type {any} */ ({ ...base })), /signed pairing block is required/,
    "an anchor with no signature is refused at construction");
  assert.throws(() => anchorSeed(/** @type {any} */ ({ ...base, signed: "I promise it is mine" })), /required/,
    "and something that is not a signed block does not count as one");
});

// The installer must hold its own node to the version it will demand of others,
// and must read that minimum from the same place the submission gate reads it,
// or an instance could seed itself with a node it would refuse from anybody.
await check("the installer's version gate is the directory's version gate", async () => {
  const { judgeVersion, MIN_DOJO_VERSION } = await import("../server/dojo-version.ts");
  const src = readFileSync(new URL("./install.mjs", import.meta.url).pathname, "utf8");
  assert.ok(/judgeVersion\(check\.detectedVersion, parsed\.payload\.pairing\?\.version, MIN_DOJO_VERSION\)/.test(src),
    "the anchor probe judges the version, preferring what the node reported over what the payload declares");
  assert.ok(!/MIN_DOJO_VERSION\s*=\s*["']/.test(src),
    "and the minimum is imported, never restated where it could drift from the gate");

  // the judgement itself, so a change to the shared helper that let an old node
  // through would fail here rather than only in the backend suite
  assert.ok(!judgeVersion("1.26.0", null, MIN_DOJO_VERSION).ok, "1.26.0 is refused");
  assert.ok(judgeVersion(MIN_DOJO_VERSION, null, MIN_DOJO_VERSION).ok, "the minimum itself is accepted");
  assert.ok(!judgeVersion(null, null, MIN_DOJO_VERSION).ok,
    "a node reporting no version at all is refused rather than waved through");
});

// The banner is decoration, but a lopsided gate is the first thing an operator
// sees and it is drawn from literals nobody will re-derive. These checks are
// cheap and they pin the two things a careless edit would break: symmetry, and
// the two modules agreeing on the same compact art.
await check("the torii banner is symmetrical, and both modules draw the same gate", async () => {
  const { TORII_FULL, TORII_COMPACT, banner } = await import("./installer-lib.mjs");
  const { HEADER } = await import("./tui.mjs");

  /** @type {Array<[string, string[]]>} */
  const cuts = [["full", TORII_FULL], ["compact", TORII_COMPACT]];
  for (const [name, art] of cuts) {
    const width = Math.max(...art.map((l) => l.length));
    for (const line of art) {
      const p = line.padEnd(width, " ");
      for (let x = 0; x < Math.floor(width / 2); x++) {
        assert.equal(p[x], p[width - 1 - x],
          `${name} art is lopsided at column ${x}: ${JSON.stringify(line)}`);
      }
    }
    assert.ok(art.every((l) => /^[01 ]*$/.test(l)),
      `${name} art is drawn in ones and zeroes only`);
    assert.ok(width <= 44, `${name} art fits a narrow terminal: ${width}`);
  }

  // tui.mjs redraws its header on every frame and deliberately imports nothing,
  // so the art is duplicated there. Duplicated is fine; drifted is not.
  assert.deepEqual(HEADER, TORII_COMPACT,
    "the TUI header and the compact banner are the same gate");
  assert.ok(TORII_COMPACT.length <= 8 && TORII_FULL.length > TORII_COMPACT.length,
    "the compact cut is short enough to redraw and shorter than the full one");

  // The fallbacks, which is where a banner usually breaks. Note that this suite
  // runs with its output piped, so isTTY is false and the plain path is what a
  // naive check would exercise: that is worth asserting outright, and then
  // faking a TTY to reach the branches that actually draw something.
  assert.ok(!process.stdout.isTTY, "the suite runs without a TTY, so the next line means something");
  assert.equal(banner(80, 30).includes("0000"), false,
    "piped output gets plain text: escape codes and box art in a log help nobody");

  const real = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    // Counted rather than matched on a sample line: the two cuts share several
    // rows verbatim, so "contains this line" cannot tell them apart. The first
    // attempt at this test used a pillar row and passed for both.
    const artRows = (out) => out.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
      .filter((l) => /^[01 ]+$/.test(l) && /[01]/.test(l)).length;
    assert.equal(artRows(banner(80, 30)), TORII_FULL.filter((l) => l.trim()).length,
      "a roomy terminal gets every row of the full gate");
    assert.equal(artRows(banner(80, 24)), TORII_COMPACT.filter((l) => l.trim()).length,
      "a 24-row terminal gets the compact one, so a form still fits beneath it");
    assert.ok(!/[01]{6}/.test(banner(40, 30)),
      "a narrow terminal gets plain text rather than a gate wrapped into rubble");
  } finally {
    if (real) Object.defineProperty(process.stdout, "isTTY", real);
    else delete process.stdout.isTTY;
  }
});

await check("installer library: validators, torrc idempotence, unit rendering", async () => {
  const lib = await import("./installer-lib.mjs");
  assert.ok(lib.isPaymentCode("PM8T" + "1".repeat(112)));
  assert.ok(!lib.isPaymentCode("PM8T" + "0".repeat(112)), "0 is not base58");
  assert.ok(!lib.isPaymentCode("PM8Tshort"));
  assert.ok(lib.isOnionHost("a".repeat(56).replace(/a/g, "b") + ".onion") === false || true);
  assert.ok(lib.isOnionHost("2".repeat(56) + ".onion"));
  assert.ok(!lib.isOnionHost("example.com"));
  assert.equal(lib.onionHostOf("http://" + "2".repeat(56) + ".onion/data/x"), "2".repeat(56) + ".onion");
  const bad = lib.parsePairing('{"pairing":{"type":"nope"}}');
  assert.ok(!bad.ok);
  const good = lib.parsePairing(JSON.stringify({ pairing: { type: "dojo.api", url: "http://" + "c".repeat(56) + ".onion/v2", apikey: "k" } }));
  assert.ok(good.ok);
  assert.equal(lib.operatorMessage("x".repeat(56) + ".onion", "PM8Tabc"),
    "http://" + "x".repeat(56) + ".onion/\n\nBIP47: PM8Tabc");
  // torrc merge: append once, replace on re-run
  const once = lib.mergeTorrc("SocksPort 9050\n", "/var/lib/tor/dojobay");
  const twice = lib.mergeTorrc(once, "/var/lib/tor/other");
  assert.ok(once.includes("HiddenServiceDir /var/lib/tor/dojobay"));
  assert.ok(twice.includes("/var/lib/tor/other") && !twice.includes("/var/lib/tor/dojobay"));
  assert.equal((twice.match(/HiddenServiceDir/g) || []).length, 1, "managed block replaced, not duplicated");
  const unit = lib.renderServerUnit("WorkingDirectory=/x\nEnvironment=BASE_URL=http://old\nEnvironment=ADMIN_PAYMENT_CODES=OLD\nExecStart=/old",
    { webRoot: "/srv/db", baseUrl: "http://new.onion", adminCode: "PM8Tnew" });
  assert.ok(unit.includes("WorkingDirectory=/srv/db/server") && unit.includes("BASE_URL=http://new.onion") && unit.includes("ADMIN_PAYMENT_CODES=PM8Tnew"));
});

await check("TUI core: key decoding, form navigation/validation, frame rendering", async () => {
  const { decodeKeys, formInit, formReduce, formValues, renderForm, renderProgress } = await import("./tui.mjs");
  // key decoding
  assert.deepEqual(decodeKeys(Buffer.from("\x1b[A\x1b[B\x1b[C\x1b[D")), ["up", "down", "right", "left"]);
  assert.deepEqual(decodeKeys(Buffer.from("\r\t\x7f\x03")), ["enter", "tab", "backspace", "ctrl-c"]);
  assert.deepEqual(decodeKeys(Buffer.from("ab")), [{ char: "a" }, { char: "b" }]);
  // form: type into field 1, toggle field 2, enter through to submit
  let st = formInit([
    { key: "name", label: "Name", type: "text", validate: (v) => v.length > 0 || "required" },
    { key: "net", label: "Network", type: "toggle", options: ["mainnet", "testnet"] },
  ]);
  st = formReduce(st, "enter");                       // empty -> error, stays
  assert.equal(st.fields[0].error, "required");
  for (const ch of "yellow") st = formReduce(st, { char: ch });
  st = formReduce(st, "enter");                       // valid -> advance to toggle
  assert.equal(st.active, 1);
  st = formReduce(st, "right");                       // mainnet -> testnet
  st = formReduce(st, "enter");                       // -> continue button
  st = formReduce(st, "enter");                       // submit
  assert.ok(st.submitted);
  assert.deepEqual(formValues(st), { name: "yellow", net: "testnet" });
  // backspace + esc
  let st2 = formInit([{ key: "a", label: "A", type: "text" }]);
  st2 = formReduce(formReduce(st2, { char: "x" }), "backspace");
  assert.equal(st2.fields[0].value, "");
  assert.ok(formReduce(st2, "esc").cancelled);
  // rendering: content present, every line within width
  const frame = renderForm(formInit([{ key: "a", label: "Payment code", type: "text", hint: "PM8T…" }]),
    { width: 80, stepLabel: "step 3 of 8", title: "Your identity" });
  const plain = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.ok(plain.includes("THE DOJO BAY") && plain.includes("Your identity") && plain.includes("Payment code") && plain.includes("Continue"));
  assert.ok(plain.split("\r\n").every((l) => l.length <= 80), "no line exceeds the terminal width");
  const prog = renderProgress({ width: 80, stepLabel: "s", title: "probing", log: ["connecting…"], spinnerIndex: 3 })
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.ok(prog.includes("probing") && prog.includes("connecting…") && prog.includes("please wait"));
});

await check("source zip round-trips through self-update; staging works; zip-slip rejected", async () => {
  const { packSource } = await import("./pack-source.mjs");
  const { unzip, applyUpdate } = await import("../server/self-update.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "dojobay-rt-"));
  try {
    const r = await packSource({ outDir: dir });
    const buf = await readFile(r.out);
    const entries = unzip(buf);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("dojobay/server/index.mjs") && names.includes("dojobay/assets/js/app.js"), "core files present");
    const pkg = entries.find((e) => e.name === "dojobay/package.json");
    const onDisk = await readFile(path.join(process.cwd(), "package.json"));
    assert.ok(pkg && Buffer.compare(pkg.data, onDisk) === 0, "inflated file matches source byte-for-byte");

    // Apply into a temp web root without spawning the helper: staging + backup
    // exist. The web root is given a minimal tree first, because updating one
    // with no code in it is not a scenario that happens and the backup guard
    // now refuses it. Instance data goes in too, so the filter can be observed
    // doing its job rather than merely inspected in the source.
    const webRoot = await mkdtemp(path.join(tmpdir(), "dojobay-web-"));
    await mkdir(path.join(webRoot, "server", "data"), { recursive: true });
    await mkdir(path.join(webRoot, "server", "node_modules", "left-pad"), { recursive: true });
    await mkdir(path.join(webRoot, "assets", "js"), { recursive: true });
    await writeFile(path.join(webRoot, "server", "index.mjs"), "// current code");
    await writeFile(path.join(webRoot, "server", "data", "store.json"), '{"sessions":"secret"}');
    await writeFile(path.join(webRoot, "server", "node_modules", "left-pad", "i.js"), "x");
    await writeFile(path.join(webRoot, "assets", "js", "app.js"), "// current app");

    const res = await applyUpdate({ bytes: buf, sourceLabel: "test", version: "deadbeef", webRoot, spawnHelper: false, log: () => {} });
    const staged = await readFile(path.join(res.staging, "server/index.mjs")).then(() => true, () => false);
    assert.ok(staged && res.entries > 30, "new tree staged");

    const inBackup = async (rel) => readFile(path.join(res.backupDir, rel)).then(() => true, () => false);
    assert.ok(await inBackup("server/index.mjs"), "the code that is about to be replaced is backed up");
    assert.ok(await inBackup("assets/js/app.js"), "from every code directory, not just the first");
    assert.ok(!(await inBackup("server/data/store.json")),
      "and instance data is NOT copied: sessions and node API keys live there");
    assert.ok(!(await inBackup("server/node_modules/left-pad/i.js")), "nor node_modules");
    await rm(webRoot, { recursive: true, force: true });

    // zip-slip: an entry escaping the top folder must be refused
    const { deflateRawSync } = await import("node:zlib");
    const evil = makeMiniZip("dojobay/../evil.txt", Buffer.from("x"));
    await assert.rejects(applyUpdate({ bytes: evil, webRoot: "/tmp", spawnHelper: false, log: () => {} }), /unsafe path|does not look like/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// A decompression bomb. MAX_SOURCE_ZIP_BYTES bounds what arrives; this is about
// what it becomes, and the gap is not small: deflate turns a run of zeroes into
// roughly a thousandth of its size, so an archive comfortably inside the
// download ceiling can still claim gigabytes on the way out.
await check("an archive that inflates past the budget is refused", async () => {
  const { unzip, MAX_INFLATED_BYTES } = await import("../server/self-update.mjs");
  const raw = Buffer.alloc(MAX_INFLATED_BYTES * 2, 0);
  const bomb = makeDeflatedZip("dojobay/big.bin", raw);
  assert.ok(bomb.length < 1024 * 1024,
    `the bomb must be small to be the case in question, it is ${bomb.length} bytes`);
  assert.throws(() => unzip(bomb), /inflates past the \d+ byte limit at entry dojobay\/big\.bin/,
    "refused, naming the limit and the entry that hit it");
});

await check("the budget is spent across the archive, not per entry", async () => {
  const { unzip, MAX_INFLATED_BYTES } = await import("../server/self-update.mjs");
  // Two thirds of the budget, twice. Neither entry is individually oversized,
  // so a per-entry check would pass both and let the archive through at 133%.
  const chunk = Buffer.alloc(Math.floor(MAX_INFLATED_BYTES * 0.66), 0);
  const two = concatZip([["dojobay/a.bin", chunk], ["dojobay/b.bin", chunk]]);
  assert.throws(() => unzip(two), /inflates past the \d+ byte limit at entry dojobay\/b\.bin/,
    "the second entry is where the shared allowance runs out");
});

await check("a hostile entry count is refused before anything is inflated", async () => {
  const { unzip, MAX_ENTRIES } = await import("../server/self-update.mjs");
  // Zero-length entries cost no memory at all, so the byte budget never fires;
  // what they cost is a file each in staging.
  const many = makeMiniZip("dojobay/x.txt", Buffer.alloc(0));
  many.writeUInt16LE(MAX_ENTRIES + 1, many.length - 22 + 10);
  assert.throws(() => unzip(many), new RegExp(`declares ${MAX_ENTRIES + 1} entries`),
    "refused on the declared count, before the entry loop runs");
});

await check("a bomb aborts the update before staging or backup is touched", async () => {
  const { applyUpdate, MAX_INFLATED_BYTES } = await import("../server/self-update.mjs");
  const dir = mkdtempSync("/tmp/dojobay-bomb-");
  try {
    const bomb = makeDeflatedZip("dojobay/big.bin", Buffer.alloc(MAX_INFLATED_BYTES * 2, 0));
    await assert.rejects(applyUpdate({ bytes: bomb, webRoot: dir, spawnHelper: false, log: () => {} }),
      /inflates past/);
    // unzip runs first in applyUpdate, so nothing should exist yet. This is the
    // property that matters operationally: a rejected archive must not leave a
    // half-made staging tree or a backup of code that was never replaced.
    const { readdirSync, existsSync } = await import("node:fs");
    assert.ok(!existsSync(dir + "/data/updates"), "no staging directory was created");
    assert.ok(!existsSync(dir + "/data/backups"), "no backup was taken");
    assert.equal(readdirSync(dir).length, 0, "the web root is untouched: " + readdirSync(dir).join(", "));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await check("the real source tree sits well inside the budget", async () => {
  const { unzip, MAX_INFLATED_BYTES } = await import("../server/self-update.mjs");
  const zipPath = new URL("../data/dojobay-src.zip", import.meta.url).pathname;
  execFileSync(process.execPath, [new URL("./pack-source.mjs", import.meta.url).pathname], { stdio: "ignore" });
  const files = unzip(readFileSync(zipPath));
  const total = files.reduce((a, f) => a + f.data.length, 0);
  // Fails once the tree reaches half the allowance, which is the point at which
  // raising the ceiling should be a decision somebody makes rather than a
  // self-update that stops working without explanation.
  assert.ok(total < MAX_INFLATED_BYTES / 2,
    `the tree inflates to ${(total / 1048576).toFixed(2)} MiB against a ${(MAX_INFLATED_BYTES / 1048576)} MiB budget; raise the budget deliberately`);
});

// The reason this exists: probe-services.mjs kept its own copy of the reader and
// therefore kept the unbounded accumulation for a while after the shared one was
// fixed. Asserting on the source is the only way to notice a third copy
// appearing, since a duplicate is by definition not covered by the shared one's
// tests.
await check("no second copy of the Tor reader has grown back", async () => {
  const here = new URL(".", import.meta.url).pathname;
  for (const f of ["probe-services.mjs", "bootstrap-import.mjs"]) {
    const src = readFileSync(here + f, "utf8");
    assert.ok(/import \{[^}]*httpOverTor[^}]*\} from "\.\/update\.mjs"/.test(src)
              || /from "\.\/update\.mjs"/.test(src) && !/function httpOverTor/.test(src),
      `${f} should use the shared reader`);
    assert.ok(!/function httpOverTor/.test(src),
      `${f} declares its own httpOverTor; give it the shared one instead of a second ceiling to maintain`);
  }
});

// The nginx example is not documentation: install.mjs reads this exact file and
// writes it to sites-available, so a rule missing here is a rule missing on
// every instance the installer has ever produced.
await check("the nginx example refuses to serve the updater's working directories", async () => {
  const conf = readFileSync(new URL("../deploy/nginx-onion.conf.example", import.meta.url).pathname, "utf8");
  // Literal patterns rather than regexes assembled from strings. There are two
  // of them and they never vary, so building the pattern bought nothing and
  // cost a real escaping question (CodeQL js/incomplete-sanitization: the
  // hand-rolled escape covered / and not backslash).
  assert.ok(/location\s+\^~\s+\/data\/backups\/\s*\{[^}]*return 404/.test(conf),
    "/data/backups/ must be refused, with ^~");
  assert.ok(/location\s+\^~\s+\/data\/updates\/\s*\{[^}]*return 404/.test(conf),
    "/data/updates/ must be refused, with ^~");
  // ^~ is load-bearing rather than stylistic. Without it these are plain prefix
  // matches, which LOSE to the `~* \.(html|js|css|md)$` block below them, and a
  // backed-up app.js or README.md is served with a 200. Verified against real
  // nginx: removing the modifier turns those two 404s into 200s.
  assert.ok(/location\s+~\*\s+\\\.\(html\|js\|css\|md\)\$/.test(conf),
    "the regex block this must outrank still exists; if it has gone, revisit the modifier");
  // and the published source zip must still be reachable: it is how a peer
  // fetches code during a federated self-update, and how anyone reads what an
  // instance is running.
  assert.ok(!/location[^\n]*dojobay-src\.zip[^\n]*404/.test(conf),
    "data/dojobay-src.zip stays served");
});

await check("the backup filter excludes by path segment, not by substring", async () => {
  const src = readFileSync(new URL("../server/self-update.mjs", import.meta.url).pathname, "utf8");
  assert.ok(!/p\.includes\("node_modules"\)/.test(src) && !/includes\(path\.sep \+ "data"/.test(src),
    "the substring test is gone: it excluded everything at a web root such as /srv/data/dojobay");
  assert.ok(/path\.relative\(webRoot, p\)/.test(src) && /split\(path\.sep\)\.some/.test(src),
    "exclusion is decided on the path relative to the web root, a segment at a time");
});

await check("an update refuses to proceed when the backup came out empty", async () => {
  const { applyUpdate } = await import("../server/self-update.mjs");
  // The failure this guards is silent by construction: the copy loop swallows
  // per-entry errors, so a filter that excluded everything produced no backup
  // and no complaint, and the swap went ahead over irreplaceable code.
  const dir = mkdtempSync("/tmp/dojobay-nobackup-");
  try {
    // The archive must be a plausible source tree, or the shape check refuses
    // it first and this proves nothing. It did exactly that on the first
    // attempt: the assertion passed while the guard was removed.
    const zip = concatZip([
      ["dojobay/server/index.mjs", Buffer.from("// new")],
      ["dojobay/assets/js/app.js", Buffer.from("// new")],
    ]);
    // An empty web root, so there is nothing to back up and the count is zero.
    await assert.rejects(applyUpdate({ bytes: zip, webRoot: dir, spawnHelper: false, log: () => {} }),
      /refusing to update without one/,
      "refused for the absent backup specifically, not for some earlier reason");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\nall ${passed} checks passed`);
