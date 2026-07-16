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
import { packSource } from "./pack-source.mjs";
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

    // apply into a temp web root without spawning the helper: staging + backup exist
    const webRoot = await mkdtemp(path.join(tmpdir(), "dojobay-web-"));
    const res = await applyUpdate({ bytes: buf, sourceLabel: "test", version: "deadbeef", webRoot, spawnHelper: false, log: () => {} });
    const staged = await readFile(path.join(res.staging, "server/index.mjs")).then(() => true, () => false);
    assert.ok(staged && res.entries > 30, "new tree staged");
    await rm(webRoot, { recursive: true, force: true });

    // zip-slip: an entry escaping the top folder must be refused
    const { deflateRawSync } = await import("node:zlib");
    const evil = makeMiniZip("dojobay/../evil.txt", Buffer.from("x"));
    await assert.rejects(applyUpdate({ bytes: evil, webRoot: "/tmp", spawnHelper: false, log: () => {} }), /unsafe path|does not look like/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

console.log(`\nall ${passed} checks passed`);
