#!/usr/bin/env node
// The Dojo Bay guided installer.
//
//   sudo node scripts/install.mjs [--plain]
//
// Phase two: a full-screen TUI (persistent header, arrow-key forms, progress
// panels for the slow Tor operations) on capable terminals, falling back to
// the phase-one sequential flow on dumb/tiny terminals or with --plain. All
// stage logic is UI-independent and talks to scripts/installer-ui.mjs; the
// TUI's pure core (key decoding, form reduction, frame rendering) lives in
// scripts/tui.mjs and is covered by scripts/selftest.mjs.
//
// The flow: prerequisites -> backend deps -> identity -> hidden service
// (fresh, or an imported vanity key) -> the REQUIRED operator signature ->
// the anchor node (live-probed over Tor before acceptance) -> optional
// bootstrap import from a trusted instance (signature-gated) -> review ->
// apply. Re-runnable; instance data is never touched by a re-run.
import { readFile, writeFile, mkdir, stat, copyFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPaymentCode, isOnionHost, onionHostOf, isNodeName, parsePairing,
  operatorMessage, mergeTorrc, renderServerUnit, renderUpdateUnit, renderNginx,
  anchorSeed, operatorDoc,
} from "./installer-lib.mjs";
import { chooseUI } from "./installer-ui.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOTAL = 8;

async function main() {
  if (!process.stdin.isTTY) {
    console.error("The installer is interactive; run it in a terminal (over SSH is fine).");
    process.exit(1);
  }
  const ui = chooseUI();
  if (process.getuid && process.getuid() !== 0) {
    await ui.fail("Run as root: the installer writes torrc, an nginx site and systemd units.\n  sudo node scripts/install.mjs");
  }

  // ---- 1. prerequisites -------------------------------------------------------
  await ui.step(1, TOTAL, "Prerequisites");
  const nodeMajor = +process.versions.node.split(".")[0];
  if (nodeMajor < 20) await ui.fail(`Node ${process.versions.node} found; Node 20+ is required.`);
  ui.ok(`Node ${process.versions.node}`);
  const missing = [];
  for (const bin of ["tor", "nginx"]) {
    try { await run("sh", ["-c", `command -v ${bin}`]); ui.ok(bin); }
    catch { missing.push(bin); ui.err(`${bin} not found`); }
  }
  if (missing.length) {
    if (!(await ui.confirm(`Install ${missing.join(" + ")} with apt now?`, true))) {
      await ui.fail("Cannot continue without " + missing.join(" and ") + ".");
    }
    await ui.progress("installing packages", async (log) => {
      log("apt-get update"); await run("apt-get", ["update"]);
      log("apt-get install -y " + missing.join(" ")); await run("apt-get", ["install", "-y", ...missing]);
      log("installed ✓");
    });
  }
  const { webRoot } = await ui.form([
    { key: "webRoot", label: "Web root", type: "text", value: "/var/www/dojobay",
      hint: "where the site lives", validate: (v) => v.startsWith("/") || "must be an absolute path" },
  ]);

  // ---- 2. backend dependencies ---------------------------------------------------
  await ui.step(2, TOTAL, "Backend dependencies");
  await ui.progress("npm ci in server/ (needed for signature verification)", async (log) => {
    await run("npm", ["ci", "--omit=dev"], { cwd: path.join(ROOT, "server") });
    log("server dependencies installed ✓");
  });
  const crypto = await import("../server/crypto.mjs");

  // ---- 3. identity -----------------------------------------------------------------
  await ui.step(3, TOTAL, "Your identity");
  const id = await ui.form([
    { key: "paymentCode", label: "Your BIP47 payment code (PM8T…)", type: "text",
      hint: "Samourai/Ashigaru → PayNym. This code becomes this instance's admin.",
      validate: (v) => isPaymentCode(v) || "not a valid BIP47 payment code (PM8T…, 116 base58 chars)" },
    { key: "paynym", label: "Your PayNym handle (+name, optional)", type: "text",
      hint: "leave empty to skip; it can be resolved later" },
  ], { note: "No accounts and no email: your payment code is your identity here." });
  const paymentCode = id.paymentCode;
  const paynym = id.paynym ? (id.paynym.startsWith("+") ? id.paynym : "+" + id.paynym) : "";

  // ---- 4. hidden service ---------------------------------------------------------
  await ui.step(4, TOTAL, "Hidden service");
  const hsDir = "/var/lib/tor/dojobay";
  if (await ui.confirm("Import an existing .onion key (e.g. a vanity address)?", false)) {
    const { keyPath } = await ui.form([
      { key: "keyPath", label: "Path to hs_ed25519_secret_key (or its directory)", type: "text",
        validate: (v) => v.startsWith("/") || "must be an absolute path" },
    ], { note: "Only the key is imported here; generating vanity keys is out of scope." });
    let src = keyPath;
    try { if ((await stat(keyPath)).isDirectory()) src = path.join(keyPath, "hs_ed25519_secret_key"); } catch {}
    const keyBuf = await readFile(src).catch(() => null);
    if (!keyBuf || keyBuf.length !== 96 || !keyBuf.subarray(0, 29).toString("latin1").startsWith("== ed25519v1-secret")) {
      await ui.fail("That is not a Tor v3 hidden-service secret key (expected 96 bytes, ed25519v1-secret header).");
    }
    await mkdir(hsDir, { recursive: true });
    await copyFile(src, path.join(hsDir, "hs_ed25519_secret_key"));
    await run("chown", ["-R", "debian-tor:debian-tor", hsDir]);
    await chmod(hsDir, 0o700);
    await chmod(path.join(hsDir, "hs_ed25519_secret_key"), 0o600);
    ui.ok("vanity key installed (tor derives the hostname)");
  }
  const onionHost = await ui.progress("configuring tor and waiting for the hidden service", async (log) => {
    const torrcPath = "/etc/tor/torrc";
    const torrc = await readFile(torrcPath, "utf8").catch(() => "");
    await writeFile(torrcPath, mergeTorrc(torrc, hsDir));
    log("torrc updated (managed block)");
    await run("systemctl", ["restart", "tor"]);
    log("tor restarted; waiting for hostname…");
    for (let i = 0; i < 30; i++) {
      const h = (await readFile(path.join(hsDir, "hostname"), "utf8").catch(() => "")).trim();
      if (isOnionHost(h)) { log("hostname: " + h); return h; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("tor did not produce a hostname; check journalctl -u tor");
  });

  // ---- 5. operator signature (required) --------------------------------------------
  await ui.step(5, TOTAL, "Operator signature (required)");
  const message = operatorMessage(onionHost, paymentCode);
  let opDoc;
  for (;;) {
    const block = await ui.paste("Signed block", {
      note: "Sign this EXACT text in your wallet (Tools → Sign message):\n\n"
        + message.split("\n").map((l) => "    " + l).join("\n")
        + "\n\nThen paste the full signed block below.",
    });
    opDoc = operatorDoc(onionHost, paymentCode, block.trim());
    const v = crypto.verifyOperatorDoc(opDoc, { expectedOnion: `http://${onionHost}` });
    if (v.ok) { ui.ok("signature verifies against your payment code's notification address"); break; }
    ui.err(v.error);
    if (!(await ui.confirm("Try pasting the signed block again?", true))) {
      await ui.fail("The operator signature is required; cannot continue without it.");
    }
  }

  // ---- 6. anchor node ------------------------------------------------------------------
  await ui.step(6, TOTAL, "Your Dojo (the anchor node)");
  const anchor = await ui.form([
    { key: "network", label: "Network", type: "toggle", options: ["mainnet", "testnet"], value: 0 },
    { key: "name", label: "Node name", type: "text",
      validate: (v) => isNodeName(v) || "letters/digits (≤40 chars)" },
    { key: "jurisdiction", label: "Jurisdiction (optional)", type: "text", hint: "e.g. Europe" },
    { key: "hardware", label: "Hardware (optional)", type: "text", hint: "e.g. N100 16GB" },
  ], { note: "Running a Dojo Bay requires running a Dojo. This node seeds your directory." });
  let payload;
  for (;;) {
    const parsed = parsePairing(await ui.paste("Dojo pairing payload", {
      note: "The JSON from your Dojo maintenance tool (pairing + explorer).",
    }));
    if (!parsed.ok) { ui.err(parsed.error); continue; }
    try {
      payload = await ui.progress("probing your Dojo over Tor", async (log) => {
        const { probe } = await import("../server/probe.mjs");
        log("connecting to " + parsed.payload.pairing.url.slice(0, 46) + "…");
        const check = await probe(parsed.payload.pairing.url, {
          apikey: parsed.payload.pairing.apikey, network: anchor.network,
        });
        if (!check.up) throw new Error(check.reason || "no response");
        log(`reachable ✓  block height ${check.height ?? "?"}`);
        return parsed.payload;
      });
      break;
    } catch (e) {
      ui.err("not reachable: " + e.message);
      if (!(await ui.confirm("Edit the payload and try again?", true))) process.exit(1);
    }
  }

  // ---- 7. bootstrap import -----------------------------------------------------------
  await ui.step(7, TOTAL, "Bootstrap from a trusted Dojo Bay (optional)");
  let bootstrap = null;
  if (await ui.confirm("Import nodes + history from an existing instance you trust?", false)) {
    const b = await ui.form([
      { key: "onion", label: "Trusted instance .onion", type: "text",
        validate: (v) => isOnionHost(v) || "not a v3 onion address" },
      { key: "code", label: "That operator's BIP47 payment code", type: "text",
        hint: "from their footer chip or Verify popup; their signature is verified against it",
        validate: (v) => isPaymentCode(v) || "not a valid payment code" },
    ], { note: "Nothing is imported unless the remote operator.json signature verifies for exactly this onion and code." });
    bootstrap = { onionHost: onionHostOf(b.onion), trustedCode: b.code };
  }

  // ---- 8. review + apply ------------------------------------------------------------------
  await ui.step(8, TOTAL, "Review");
  await ui.show("About to write", [
    `onion       http://${onionHost}/`,
    `admin code  ${paymentCode.slice(0, 12)}…${paymentCode.slice(-6)}  ${paynym}`,
    `anchor      ${anchor.network}-${anchor.name}`,
    `web root    ${webRoot}`,
    `bootstrap   ${bootstrap ? bootstrap.onionHost : "none"}`,
  ]);
  if (!(await ui.confirm("Write configuration and start services?", true))) {
    await ui.fail("Nothing written.");
  }
  await ui.progress("installing", async (log) => {
    if (path.resolve(webRoot) !== ROOT) {
      await mkdir(webRoot, { recursive: true });
      await run("cp", ["-a", ROOT + "/.", webRoot]);
      log("files copied to " + webRoot);
    }
    const dataDir = path.join(webRoot, "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "seed.json"), JSON.stringify(anchorSeed({
      network: anchor.network, name: anchor.name, paymentCode, paynym: paynym || null,
      payload, jurisdiction: anchor.jurisdiction, hardware: anchor.hardware,
    }), null, 2) + "\n");
    await writeFile(path.join(dataDir, "operator.json"), JSON.stringify(opDoc, null, 2) + "\n");
    log("seed.json (anchor) + operator.json written");

    const nginxTpl = await readFile(path.join(webRoot, "deploy/nginx-onion.conf.example"), "utf8");
    await writeFile("/etc/nginx/sites-available/dojobay", renderNginx(nginxTpl, { webRoot }));
    await run("ln", ["-sf", "/etc/nginx/sites-available/dojobay", "/etc/nginx/sites-enabled/dojobay"]);
    const srvTpl = await readFile(path.join(webRoot, "scripts/dojobay-server.service"), "utf8");
    await writeFile("/etc/systemd/system/dojobay-server.service",
      renderServerUnit(srvTpl, { webRoot, baseUrl: `http://${onionHost}`, adminCode: paymentCode }));
    const updTpl = await readFile(path.join(webRoot, "scripts/dojobay-update.service"), "utf8");
    await writeFile("/etc/systemd/system/dojobay-update.service", renderUpdateUnit(updTpl, { webRoot }));
    await copyFile(path.join(webRoot, "scripts/dojobay-update.timer"), "/etc/systemd/system/dojobay-update.timer");
    await run("systemctl", ["daemon-reload"]);
    log("nginx site + systemd units installed");

    if (bootstrap) {
      log("verifying trusted instance and importing (over Tor)…");
      process.env.PUBLIC_DATA_DIR = dataDir;
      process.env.SERVER_DATA_DIR = path.join(webRoot, "server", "data");
      const { bootstrapImport } = await import(path.join(webRoot, "scripts/bootstrap-import.mjs"));
      try { await bootstrapImport({ ...bootstrap, log }); }
      catch (e) { log("✗ bootstrap import failed: " + e.message); log("  (continuing; re-run scripts/bootstrap-import.mjs later)"); }
    }

    await run("node", ["build-public.mjs"], { cwd: path.join(webRoot, "server"), env: { ...process.env } });
    await run("node", [path.join(webRoot, "scripts/pack-source.mjs")]);
    log("public list built; source archive packed");
    await run("systemctl", ["enable", "--now", "nginx", "dojobay-server.service", "dojobay-update.timer"]);
    await run("systemctl", ["restart", "nginx", "dojobay-server.service"]);
    log("services enabled and started");
  });

  await ui.finish([
    `Your Dojo Bay is live at http://${onionHost}/`,
    "· sign in at /admin with your PayNym (Auth47) to moderate",
    "· the ten-minute timer keeps statuses, history and avatars current",
    "· the footer's branch icon serves this instance's own source zip",
  ]);
}

main().catch((e) => { console.error("fatal: " + e.message); process.exit(1); });
