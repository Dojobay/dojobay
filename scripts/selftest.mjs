#!/usr/bin/env node
// Offline self-test for the reachability logic in update.mjs.
// Spins up a fake SOCKS5 proxy (no Tor needed) that can simulate:
//   - a reachable hidden service that returns an HTTP response  -> UP
//   - Tor reporting the onion as unreachable (reply 0x04)        -> DOWN
//   - no proxy listening at all                                  -> DOWN
//
// Run: node scripts/selftest.mjs   (exit 0 = all assertions passed)

import net from "node:net";
import assert from "node:assert";
import { probe, fetchAvatar } from "./update.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Minimal SOCKS5 server. `mode` decides how it answers the CONNECT request.
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
          stage = "tunnel";
          return;
        }
        if (stage === "tunnel") {
          // we just received the request; answer like a Dojo HTTP server
          if (mode === "http") sock.write("HTTP/1.0 401 Unauthorized\r\n\r\n");
          if (mode === "avatar") {
            const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fakepixels")]);
            sock.write(Buffer.concat([Buffer.from("HTTP/1.0 200 OK\r\nContent-Type: image/png\r\n\r\n", "latin1"), png]));
          }
          if (mode === "avatar-notpng") sock.write("HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n<html>not found</html>");
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

await check("no proxy listening -> down", async () => {
  const r = await probe("http://whatever1234567.onion/v2", cfg(1)); // nothing on :1
  assert.equal(r.up, false, JSON.stringify(r));
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

console.log(`\nall ${passed} checks passed`);
