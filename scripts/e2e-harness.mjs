// Front-end harness. Loads assets/js/app.js inside JSDom with a stubbed fetch
// and asserts rendering and interaction behaviour: card titles and ordering,
// the payment-code chip, build-hash persistence across re-renders, the
// hamburger, Manage-panel ordering and the inline editor (versionless: the
// Dojo version is read live from the node by the updater and is not editable),
// the pairing popup, the footer operator avatar and the source-download link.
//
// One-time setup:  mkdir -p /tmp/e2e && cd /tmp/e2e && npm init -y && npm install jsdom
// Run (repo root): node scripts/e2e-harness.mjs
// jsdom is resolved from /tmp/e2e (override with E2E_DIR); it is deliberately
// not in any package.json so the front end and scripts/ stay dependency-free.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import assert from "node:assert";

const E2E_DIR = process.env.E2E_DIR || "/tmp/e2e";
let JSDOM;
try {
  ({ JSDOM } = createRequire(path.join(E2E_DIR, "/"))("jsdom"));
} catch {
  console.error(`jsdom not found under ${E2E_DIR}. One-time setup:\n  mkdir -p ${E2E_DIR} && cd ${E2E_DIR} && npm init -y && npm install jsdom\nthen re-run from the repo root: node scripts/e2e-harness.mjs`);
  process.exit(1);
}

const REPO = process.env.REPO_DIR || process.cwd();
const appJs = readFileSync(REPO + "/assets/js/app.js", "utf8");

const DOJOS = {
  generated_at: "2026-07-14T00:00:00Z",
  interval_minutes: 10,
  nodes: [
    { id: "mainnet-91xtx93-yellow", network: "mainnet", name: "yellow", paynym: "+91xTx93x3",
      paymentCode: "PM8TJfHaHuh5xgKoEbrkWaBtytb8qrRNYdmHzxiFcvacD6HpyyxvSV3VLKYsr6UvMxB4jvJP4xxNvCp2pRY3cJPNmLB2L8nYEttaFVszXSBjXNMy8cD9",
      status: "active", block_height: 906000, checked_at: "2026-07-14 00:00",
      payload: { pairing: { type: "dojo.api", version: "1.28.0", url: "http://" + "a".repeat(56) + ".onion/v2" } } },
    { id: "mainnet-freshnode", network: "mainnet", name: "freshnode", paynym: "+fresh",
      status: "active", block_height: 906000, checked_at: "2026-07-14 00:00",
      payload: { pairing: { type: "dojo.api", version: "1.28.0", url: "http://" + "d".repeat(56) + ".onion/v2" } } },
    { id: "mainnet-deadnode", network: "mainnet", name: "deadnode", paynym: "+dead",
      status: "inactive", block_height: null, checked_at: "2026-07-14 00:00",
      payload: { pairing: { type: "dojo.api", version: "1.20.0", url: "http://" + "e".repeat(56) + ".onion/v2" } } },
    { id: "mainnet-kilombino", network: "mainnet", name: "Kilombino", paynym: null,
      status: "active", block_height: 906000, checked_at: "2026-07-14 00:00",
      payload: { pairing: { type: "dojo.api", version: "1.27.0", url: "http://" + "b".repeat(56) + ".onion/v2" } } },
  ],
};
const up = (n) => Array.from({length:n},()=>({t:"2026-07-14 00:00",up:true}));
const down = (n) => Array.from({length:n},()=>({t:"2026-07-14 00:00",up:false}));
const HIST = { interval_minutes: 10, window_checks: 144, nodes: {
  "mainnet-91xtx93-yellow": { checks: up(12) },                       // 24h 100%
  "mainnet-kilombino": { checks: up(9).concat(down(3)) },             // 24h 75%
  "mainnet-deadnode": { checks: down(12) },                           // 24h 0%
} };
const VERSION = { commit: "abc1234", built: "2026-07-14" };
// deliberately shuffled: testnet first, names reversed
const ME = { authenticated: true, paymentCode: "PM8TJTESTCODE000000000000", admin: true, submissions: [
  { id: "testnet-blue", network: "testnet", name: "blue", status: "approved", payload: { pairing: { url: "http://x.onion/v2" } } },
  { id: "mainnet-yellow2", network: "mainnet", name: "yellow", status: "approved", payload: { pairing: { url: "http://y.onion/v2" } } },
  { id: "mainnet-91xtx93-red", network: "mainnet", name: "red", status: "approved", payload: { pairing: { url: "http://z.onion/v2" } } },
] };

let meCalls = 0;
const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="root"></div></body></html>`, {
  url: "http://dojobay.onion/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t) => { window.__copied = t; } } });
window.__editPosts = [];
window.confirm = () => true;
window.prompt = () => "";
window.__reloaded = false;
try { window.location.reload = () => { window.__reloaded = true; }; } catch (e) {}
window.qrcode = (t, ec) => { window.__lastEC = ec; return { addData(){}, make(){}, getModuleCount(){ return 21; }, isDark(){ return false; } }; };
window.markdown = { render: (t) => t };
window.__updateStatusSeq = [];
window.fetch = async (url, opts) => {
  if (opts && opts.method === "POST" && /\/api\/admin\/update$/.test(url)) {
    window.__updateStarted = JSON.parse(opts.body || "{}");
    return { ok: true, status: 202, headers: { get: () => null }, json: async () => ({ started: true, id: "x" }), text: async () => '{"started":true,"id":"x"}' };
  }
  if (/\/api\/admin\/update\/status/.test(url)) {
    const next = window.__updateStatusSeq.shift() || { job: { phase: "restarting", done: true, ok: true, needsRefresh: true } };
    return { ok: true, status: next._status || 200, headers: { get: () => null }, json: async () => next, text: async () => JSON.stringify(next) };
  }
  if (opts && opts.method === "POST" && /\/api\/dojo\/edit/.test(url)) {
    window.__editPosts.push(JSON.parse(opts.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }), text: async () => '{"ok":true}' };
  }
  const body =
    /dojos\.json/.test(url) ? DOJOS :
    /history\.json/.test(url) ? HIST :
    /history-daily\.json/.test(url) ? { nodes: {
      "mainnet-91xtx93-yellow": { days: [{d:"2026-07-12",pct:100,close:905900},{d:"2026-07-13",pct:99.3,close:906000}] },
      "mainnet-kilombino": { days: Array.from({length:7},(_,i)=>({d:"2026-07-0"+(7+i),pct:90,close:905000+i})) },
      "mainnet-deadnode": { days: Array.from({length:7},(_,i)=>({d:"2026-07-0"+(7+i),pct:0,close:null})) },
    } } :
    /version\.json/.test(url) ? VERSION :
    /operator\.json/.test(url) ? { onion: "http://x.onion/", paymentCode: "PM8TJfHaHuh5xgKoEbrkWaBtytb8qrRNYdmHzxiFcvacD6HpyyxvSV3VLKYsr6UvMxB4jvJP4xxNvCp2pRY3cJPNmLB2L8nYEttaFVszXSBjXNMy8cD9", verifySigned: "-----BEGIN..." } :
    /\/api\/admin\/updates/.test(url) ? { available: true, commit: "abc1234", built: "2026-01-01", commits_behind: 3, status: "behind", latest_release: "v0.1", releases_behind: 1 } :
    /\/api\/me/.test(url) ? (meCalls++, ME) :
    null;
  if (body === null) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
};
window.eval(appJs);
await new Promise((r) => setTimeout(r, 80));   // let the async boot + detectBackend settle

const doc = window.document;
const titles = [...doc.querySelectorAll(".cname")].map((e) => e.textContent.trim());
assert.ok(titles.includes("yellow") && !titles.some((t) => t.includes("·")), "card titled by name alone, got: " + JSON.stringify(titles));
console.log("  ok - migrated card titled 'yellow' (name alone, no composite)");
assert.ok(titles.includes("Kilombino"), "seed card shows name alone");
console.log("  ok - curated seed card titled 'Kilombino'");

const hash = () => [...doc.querySelectorAll("footer .ver a")].map((a) => a.textContent).join("");
assert.strictEqual(hash(), "build abc1234", "build hash rendered on first paint");
console.log("  ok - build hash rendered from VERSION state");

// re-render via the network toggle, twice, and again via banner dismiss
doc.querySelector('[data-net="testnet"]').dispatchEvent(new window.Event("click", { bubbles: true }));
doc.querySelector('[data-net="mainnet"]').dispatchEvent(new window.Event("click", { bubbles: true }));
assert.strictEqual(hash(), "build abc1234", "build hash survives re-renders");
console.log("  ok - build hash survives re-renders (network toggle x2)");

// manage panel ordering with a shuffled /api/me
doc.body.insertAdjacentHTML("beforeend",
  '<div class="ov" id="ov"><div class="modal"><h2 id="ov-title"></h2><div id="ov-body"></div></div></div>');
doc.getElementById("root").insertAdjacentHTML("beforeend", '<button data-act="manage" id="mg">m</button>');
doc.getElementById("mg").dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
const rows = [...doc.querySelectorAll("#ov-body .box b")].map((e) => e.textContent);
assert.deepStrictEqual(rows, ["red", "yellow", "blue"], "manage rows ordered, got: " + JSON.stringify(rows));
console.log("  ok - Manage rows ordered mainnet-then-testnet, then by name (red, yellow, blue)");

// the form carries the required node-name field
assert.ok(doc.getElementById("m-name"), "node name input present in the form");
console.log("  ok - submission form has the node-name field");


// 90-day strip lives on the card, under the 24h strip, hydrated after render,
// with a day-count reliability stat ("pct% · up/total days", up = day pct>=50)
const yellowCard = doc.querySelector('.card[data-id="mainnet-91xtx93-yellow"]');
const rel = yellowCard.querySelector(".rel"), h90 = yellowCard.querySelector(".hist90");
assert.ok(rel && h90 && (rel.compareDocumentPosition(h90) & 4), "hist90 rendered on the card after the 24h strip");
assert.ok(h90.querySelectorAll(".d90").length === 2, "hist90 hydrated with daily bars, got " + h90.querySelectorAll(".d90").length);
assert.ok(/100% · 2\/2 days/.test(h90.querySelector(".d90foot").textContent), "hist90 stat line, got: " + h90.querySelector(".d90foot").textContent);
const deadFoot = doc.querySelector('.card[data-id="mainnet-deadnode"] .hist90 .d90foot');
assert.ok(deadFoot && /0% · 0\/7 days/.test(deadFoot.textContent), "dead node reads 0% · 0/7 days, got: " + (deadFoot && deadFoot.textContent));
console.log("  ok - 90-day strip on the card, hydrated, with pct · up/total day stat");

// hamburger: state-driven toggle
assert.ok(doc.querySelector(".burger"), "burger button rendered");
assert.ok(!doc.querySelector("nav").classList.contains("open"), "menu starts closed");
doc.querySelector(".burger").dispatchEvent(new window.Event("click", { bubbles: true }));
assert.ok(doc.querySelector("nav").classList.contains("open"), "menu opens");
assert.strictEqual(hash(), "build abc1234", "build hash survives the menu re-render");
doc.querySelector('nav [data-modal="about"]').dispatchEvent(new window.Event("click", { bubbles: true }));
assert.ok(!doc.querySelector("nav").classList.contains("open"), "menu closes when an item opens a modal");
console.log("  ok - hamburger toggles the nav, closes on item click, hash survives");

// openManage refreshes the session and links an admin to the console
const before = meCalls;
doc.getElementById("root").insertAdjacentHTML("beforeend", '<button data-act="manage" id="mg2">m</button>');
doc.getElementById("mg2").dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
assert.ok(meCalls > before, "openManage re-reads /api/me (session shared with /admin)");
assert.ok(/open the admin console/.test(doc.getElementById("ov-body").innerHTML), "admin sees a console link in Manage");
console.log("  ok - Manage refreshes the shared session and cross-links the admin console");


// card ordering: 7-day desc, 24h desc; null-history above long-dead
const order = [...doc.querySelectorAll(".card")].map((c) => c.getAttribute("data-id"));
assert.deepStrictEqual(order,
  ["mainnet-91xtx93-yellow", "mainnet-kilombino", "mainnet-freshnode", "mainnet-deadnode"],
  "uptime ordering, got: " + JSON.stringify(order));
console.log("  ok - cards ordered by 7d then 24h uptime; fresh above dead, both at the end");

// payment code chip: truncated display, click copies the full code
const chip = doc.querySelector('.card[data-id="mainnet-91xtx93-yellow"] .pcode');
assert.ok(chip, "payment code chip rendered");
assert.strictEqual(chip.textContent, "PM8TJfHa…XNMy8cD9", "chip truncation, got: " + chip.textContent);
const relEl = doc.querySelector('.card[data-id="mainnet-91xtx93-yellow"] .rel');
assert.ok(chip.compareDocumentPosition(relEl) & 4, "chip sits above the reliability strip");
chip.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 20));
assert.ok(window.__copied && window.__copied.endsWith("XNMy8cD9") && window.__copied.length > 100, "click copies the full code");
console.log("  ok - payment code chip: PM8TJfHa…XNMy8cD9 shown, full code copied on click");

// edit flow: one row at a time, save posts the fields. The Dojo version is NOT
// part of the form: it is read live from the node's X-Dojo-Version header by
// the updater, so the editor offers name/hardware/link only, shows a read-only
// note, and the POST must never carry a version key.
const editBtns = () => [...doc.querySelectorAll('#ov-body [data-mact="edit"]')];
editBtns()[0].dispatchEvent(new window.Event("click", { bubbles: true }));
assert.ok(doc.querySelector("#ov-body .medit"), "editor opens");
assert.ok(editBtns().filter((b) => b.disabled).length === 2, "other rows' Edit buttons disabled while one is open");
assert.ok(!doc.querySelector("#ov-body .medit .e-ver"), "no version input in the editor");
assert.ok(/read live from the node/i.test(doc.querySelector("#ov-body .medit").textContent), "editor notes the version is read from the node");
doc.querySelector("#ov-body .medit .e-name").value = "crimson";
doc.querySelector("#ov-body .medit .e-hw").value = "N100 32GB";
doc.querySelector("#ov-body .medit .e-url").value = "https://example.org/red";
doc.querySelector('#ov-body [data-mact="editsave"]').dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
assert.strictEqual(window.__editPosts.length, 1, "one edit POST sent");
assert.deepStrictEqual(
  { name: window.__editPosts[0].name, hardware: window.__editPosts[0].hardware, name_url: window.__editPosts[0].name_url },
  { name: "crimson", hardware: "N100 32GB", name_url: "https://example.org/red" }, "edit POST carries the fields");
assert.ok(!("version" in window.__editPosts[0]), "edit POST never carries a version key");
assert.ok(!doc.querySelector("#ov-body .medit"), "editor closes after save");
console.log("  ok - inline edit: single-open, versionless form, fields posted, editor closes on save");


// endpoints live on the card, below the meta block (Last checked)
const yCard = doc.querySelector('.card[data-id="mainnet-91xtx93-yellow"]');
const eps = yCard.querySelector(".card-eps");
assert.ok(eps && /Dojo API/.test(eps.textContent) && eps.textContent.includes("a".repeat(56)), "Dojo API endpoint on the card");
const metaEl = yCard.querySelector(".meta");
assert.ok(metaEl.compareDocumentPosition(eps) & 4, "endpoints sit below the meta (Last checked) block");
assert.ok(!yCard.querySelector(".pair"), "no inline pairing section on the card");
console.log("  ok - Dojo API/Explorer endpoints on the card below Last checked");

// pairing details open in the shared popup: EC-H QR + avatar + copy buttons
yCard.querySelector('[data-act="pair"]').dispatchEvent(new window.Event("click", { bubbles: true }));
const ovBody = doc.getElementById("ov-body");
assert.strictEqual(doc.getElementById("ov-title").textContent, "yellow · pairing", "popup titled by node name");
assert.strictEqual(window.__lastEC, "H", "pairing QR generated at EC level H, got " + window.__lastEC);
const av = ovBody.querySelector(".tile .qr-avatar");
assert.ok(av && /data\/avatars\/PM8TJfHa/.test(av.getAttribute("src")), "avatar overlay in the popup from the local mirror");
assert.ok(ovBody.querySelector('[data-act="copypairing"][data-id="mainnet-91xtx93-yellow"]'), "popup copy button carries the node id");
doc.querySelector('.card[data-id="mainnet-kilombino"] [data-act="pair"]').dispatchEvent(new window.Event("click", { bubbles: true }));
assert.ok(!ovBody.querySelector(".qr-avatar"), "no overlay without a payment code");
console.log("  ok - pairing details in a Verify-style popup (EC-H QR, avatar, id-carrying copy)");


// footer: circular operator avatar beside Verify; Disclaimer gone from the nav
const opAv = doc.querySelector("footer .op-avatar");
assert.ok(opAv && /data\/avatars\/PM8TJfHa/.test(opAv.getAttribute("src")), "operator avatar in the footer from the local mirror");
const verifyBtn = doc.querySelector("footer .verify-link");
assert.ok(opAv.compareDocumentPosition(verifyBtn) & 4, "avatar sits beside (before) the Verify button");
assert.ok(!doc.querySelector('[data-modal="disclaimer"]'), "Disclaimer removed from the nav");
console.log("  ok - footer operator avatar beside Verify; Disclaimer menu item gone");


// footer: the instance serves its own source as a zip
const srcLink = doc.querySelector('footer a[download="dojobay-src.zip"]');
assert.ok(srcLink && srcLink.getAttribute("href") === "data/dojobay-src.zip", "source zip download link in the footer");
console.log("  ok - footer source-download icon links the instance's own code zip");


console.log("\nall 16 front-end checks passed");
