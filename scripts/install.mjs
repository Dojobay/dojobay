#!/usr/bin/env node
// The Dojo Bay guided installer (phase one: sequential styled flow).
//
//   sudo node scripts/install.mjs       (or double-click install.sh / the
//                                        .desktop launcher on a desktop)
//
// Walks an operator from a bare Debian/Ubuntu box to a running, verified,
// optionally pre-populated Dojo Bay: prerequisites, backend dependencies,
// identity (BIP47 payment code), the hidden service (generated fresh or an
// imported vanity key), the MANDATORY operator signature binding the onion to
// the code, the anchor node (live-probed over Tor before it is accepted),
// an optional bootstrap import from a trusted instance, then nginx, systemd,
// first build and source pack. Interactive only, by design: it re-prompts on
// invalid input instead of dying, shows a review screen before writing
// anything, and is re-runnable (existing managed artefacts are replaced,
// instance data is never touched).
import { createInterface } from "node:readline/promises";
import { readFile, writeFile, mkdir, stat, copyFile, chmod, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  banner, red, dim, bold, ok, bad,
  isPaymentCode, isOnionHost, onionHostOf, isNodeName, parsePairing,
  operatorMessage, mergeTorrc, renderServerUnit, renderUpdateUnit, renderNginx,
  anchorSeed, operatorDoc,
} from "./installer-lib.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rl = createInterface({ input: process.stdin, output: process.stdout });

const say = (s = "") => process.stdout.write(s + "\n");
const step = (n, t) => say("\n" + red("── ") + bold(`${n}. ${t}`) + red(" " + "─".repeat(Math.max(2, 50 - t.length))));
async function ask(label, { validate, hint, secretDefault } = {}) {
  for (;;) {
    if (hint) say(dim("   " + hint));
    const v = (await rl.question(red(" ▸ ") + label + ": ")).trim();
    if (secretDefault !== undefined && v === "") return secretDefault;
    if (!validate) return v;
    const r = validate(v);
    if (r === true) return v;
    say(bad("   ✗ " + (typeof r === "string" ? r : "invalid value, try again")));
  }
}
async function askMultiline(label, endWord = "END") {
  say(red(" ▸ ") + label + dim(`  (paste, then a line with just ${endWord})`));
  const lines = [];
  for (;;) {
    const l = await rl.question("");
    if (l.trim() === endWord) return lines.join("\n");
    lines.push(l);
  }
}
const yes = async (q, dflt = true) => {
  const v = (await rl.question(red(" ▸ ") + q + (dflt ? " [Y/n]: " : " [y/N]: "))).trim().toLowerCase();
  return v === "" ? dflt : v.startsWith("y");
};

async function main() {
  if (!process.stdin.isTTY) {
    console.error("The installer is interactive; run it in a terminal (over SSH is fine).");
    process.exit(1);
  }
  say("\n" + banner());
  if (process.getuid && process.getuid() !== 0) {
    say(bad("Run as root: the installer writes torrc, an nginx site and systemd units.\n  sudo node scripts/install.mjs"));
    process.exit(1);
  }

  // ---- 1. prerequisites -----------------------------------------------------
  step(1, "Prerequisites");
  const nodeMajor = +process.versions.node.split(".")[0];
  if (nodeMajor < 20) { say(bad(`Node ${process.versions.node} found; Node 20+ is required.`)); process.exit(1); }
  say(ok(`   ✓ Node ${process.versions.node}`));
  const missing = [];
  for (const bin of ["tor", "nginx"]) {
    try { await run("sh", ["-c", `command -v ${bin}`]); say(ok(`   ✓ ${bin}`)); }
    catch { missing.push(bin); say(bad(`   ✗ ${bin} not found`)); }
  }
  if (missing.length) {
    if (await yes(`Install ${missing.join(" + ")} with apt now?`)) {
      await run("apt-get", ["update"]);
      await run("apt-get", ["install", "-y", ...missing]);
      say(ok("   ✓ installed"));
    } else { say(bad("Cannot continue without them.")); process.exit(1); }
  }
  const webRoot = await ask("Web root", { hint: "where the site lives; Enter for /var/www/dojobay", secretDefault: "/var/www/dojobay" }) || "/var/www/dojobay";
  if (path.resolve(webRoot) !== ROOT) {
    say(dim(`   (installer running from ${ROOT}; files will be copied to ${webRoot} at the end)`));
  }

  // ---- 2. backend dependencies ----------------------------------------------
  step(2, "Backend dependencies");
  say(dim("   npm ci in server/ (needed for signature verification below)…"));
  await run("npm", ["ci", "--omit=dev"], { cwd: path.join(ROOT, "server") });
  say(ok("   ✓ server dependencies installed"));
  const crypto = await import("../server/crypto.mjs");

  // ---- 3. identity ------------------------------------------------------------
  step(3, "Your identity");
  const paymentCode = await ask("Your BIP47 payment code (PM8T…)", {
    hint: "Samourai/Ashigaru → PayNym → your payment code. This code becomes the admin of this instance.",
    validate: (v) => isPaymentCode(v) || "not a valid BIP47 payment code (PM8T…, 116 base58 chars)",
  });
  let paynym = await ask("Your PayNym handle (+name)", { hint: "Enter to skip; it can be resolved later", secretDefault: "" });
  if (paynym && !paynym.startsWith("+")) paynym = "+" + paynym;

  // ---- 4. hidden service ------------------------------------------------------
  step(4, "Hidden service");
  const hsDir = "/var/lib/tor/dojobay";
  const useVanity = await yes("Import an existing .onion key (e.g. a vanity address)?", false);
  if (useVanity) {
    const keyPath = await ask("Path to hs_ed25519_secret_key (or a directory containing it)", {
      validate: () => true,
    });
    let src = keyPath;
    try { if ((await stat(keyPath)).isDirectory()) src = path.join(keyPath, "hs_ed25519_secret_key"); } catch {}
    const keyBuf = await readFile(src);
    if (keyBuf.length !== 96 || !keyBuf.subarray(0, 29).toString("latin1").startsWith("== ed25519v1-secret")) {
      say(bad("   ✗ that is not a Tor v3 hidden-service secret key (expected 96 bytes, ed25519v1-secret header)"));
      process.exit(1);
    }
    await mkdir(hsDir, { recursive: true });
    await copyFile(src, path.join(hsDir, "hs_ed25519_secret_key"));
    // tor regenerates the public key and hostname from the secret
    await run("chown", ["-R", "debian-tor:debian-tor", hsDir]);
    await chmod(hsDir, 0o700);
    await chmod(path.join(hsDir, "hs_ed25519_secret_key"), 0o600);
    say(ok("   ✓ vanity key installed (tor will derive the hostname)"));
  }
  const torrcPath = "/etc/tor/torrc";
  const torrc = await readFile(torrcPath, "utf8").catch(() => "");
  await writeFile(torrcPath, mergeTorrc(torrc, hsDir));
  say(dim("   restarting tor and waiting for the hidden service…"));
  await run("systemctl", ["restart", "tor"]);
  let onionHost = "";
  for (let i = 0; i < 30 && !onionHost; i++) {
    onionHost = (await readFile(path.join(hsDir, "hostname"), "utf8").catch(() => "")).trim();
    if (!onionHost) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!isOnionHost(onionHost)) { say(bad("   ✗ tor did not produce a hostname; check journalctl -u tor")); process.exit(1); }
  say(ok(`   ✓ your directory: http://${onionHost}/`));

  // ---- 5. operator signature (mandatory) --------------------------------------
  step(5, "Operator signature (required)");
  const message = operatorMessage(onionHost, paymentCode);
  say("   Sign this EXACT text in your wallet (Tools → Sign message), then paste the full signed block:\n");
  say(bold(message.split("\n").map((l) => "     " + l).join("\n")) + "\n");
  let opDoc;
  for (;;) {
    const block = await askMultiline("Signed block");
    opDoc = operatorDoc(onionHost, paymentCode, block.trim());
    const v = crypto.verifyOperatorDoc(opDoc, { expectedOnion: `http://${onionHost}` });
    if (v.ok) { say(ok("   ✓ signature verifies against your payment code's notification address")); break; }
    say(bad("   ✗ " + v.error));
  }

  // ---- 6. your anchor node ------------------------------------------------------
  step(6, "Your Dojo (the anchor node)");
  say(dim("   Running a Dojo Bay requires running a Dojo. This node seeds your directory."));
  const network = (await yes("Is your Dojo on mainnet? (No = testnet)")) ? "mainnet" : "testnet";
  const name = await ask("Node name", { validate: (v) => isNodeName(v) || "letters/digits (≤40 chars)" });
  const jurisdiction = await ask("Jurisdiction", { hint: "e.g. Europe; Enter to skip", secretDefault: "" });
  const hardware = await ask("Hardware", { hint: "e.g. N100 16GB; Enter to skip", secretDefault: "" });
  let payload;
  for (;;) {
    const parsed = parsePairing(await askMultiline("Dojo pairing payload (JSON from your Dojo maintenance tool)"));
    if (!parsed.ok) { say(bad("   ✗ " + parsed.error)); continue; }
    payload = parsed.payload;
    say(dim("   probing your Dojo over Tor (can take ~30s)…"));
    const { probe } = await import("../server/probe.mjs");
    const check = await probe(payload.pairing.url, { apikey: payload.pairing.apikey, network });
    if (check.up) { say(ok(`   ✓ reachable, block height ${check.height ?? "?"}`)); break; }
    say(bad(`   ✗ not reachable: ${check.reason || "no response"}`));
    if (!(await yes("Edit the payload and try again?"))) process.exit(1);
  }

  // ---- 7. bootstrap import -------------------------------------------------------
  step(7, "Bootstrap from a trusted Dojo Bay (optional)");
  let bootstrap = null;
  if (await yes("Import nodes + history from an existing instance you trust?", false)) {
    const bOnion = onionHostOf(await ask("Trusted instance .onion", { validate: (v) => isOnionHost(v) || "not a v3 onion address" }));
    const bCode = await ask("That operator's BIP47 payment code", {
      hint: "from their footer chip or Verify popup; the import verifies their signature against it",
      validate: (v) => isPaymentCode(v) || "not a valid payment code",
    });
    bootstrap = { onionHost: bOnion, trustedCode: bCode };
  }

  // ---- 8. review + apply -----------------------------------------------------------
  step(8, "Review");
  say(`   onion        http://${onionHost}/
   admin code   ${paymentCode.slice(0, 12)}…${paymentCode.slice(-6)}  ${paynym || ""}
   anchor       ${network}-${name}  (${payload.pairing.url.slice(0, 40)}…)
   web root     ${webRoot}
   bootstrap    ${bootstrap ? bootstrap.onionHost : "none"}`);
  if (!(await yes("Write configuration and start services?"))) { say("Nothing written."); process.exit(0); }

  if (path.resolve(webRoot) !== ROOT) {
    await mkdir(webRoot, { recursive: true });
    await run("cp", ["-a", ROOT + "/.", webRoot]);
  }
  const dataDir = path.join(webRoot, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "seed.json"), JSON.stringify(
    anchorSeed({ network, name, paymentCode, paynym: paynym || null, payload, jurisdiction, hardware }), null, 2) + "\n");
  await writeFile(path.join(dataDir, "operator.json"), JSON.stringify(opDoc, null, 2) + "\n");

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

  if (bootstrap) {
    say(dim("   verifying and importing from the trusted instance (over Tor)…"));
    process.env.PUBLIC_DATA_DIR = dataDir;
    process.env.SERVER_DATA_DIR = path.join(webRoot, "server", "data");
    const { bootstrapImport } = await import(path.join(webRoot, "scripts/bootstrap-import.mjs"));
    try { await bootstrapImport({ ...bootstrap, log: (m) => say(dim("   " + m)) }); }
    catch (e) { say(bad("   ✗ bootstrap import failed: " + e.message + " (continuing without it; re-run scripts/bootstrap-import.mjs later)")); }
  }

  say(dim("   building the public list and source archive…"));
  await run("node", ["build-public.mjs"], { cwd: path.join(webRoot, "server"), env: { ...process.env } });
  await run("node", [path.join(webRoot, "scripts/pack-source.mjs")]);
  await run("systemctl", ["enable", "--now", "nginx", "dojobay-server.service", "dojobay-update.timer"]);
  await run("systemctl", ["restart", "nginx", "dojobay-server.service"]);

  say("\n" + ok(bold("Done.")) + ` Your Dojo Bay is live at ${bold("http://" + onionHost + "/")}
   · sign in at /admin with your PayNym (Auth47) to moderate
   · the ten-minute timer keeps statuses, history and avatars current
   · the footer's branch icon serves this instance's own source zip\n`);
}

main().catch((e) => { console.error(bad("fatal: " + e.message)); process.exit(1); }).finally(() => rl.close());
