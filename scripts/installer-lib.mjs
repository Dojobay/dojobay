// Pure helpers for the Dojo Bay installer: input validators, config
// renderers, and the terminal theme. No I/O and no prompts here -- everything
// is a plain function so scripts/selftest.mjs can exercise the installer's
// logic without a terminal. Node builtins only.
import path from "node:path";

// ---- validators -------------------------------------------------------------
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export const isPaymentCode = (v) =>
  typeof v === "string" && v.startsWith("PM8T") && v.length === 116 && BASE58.test(v);
export const isOnionHost = (v) =>
  typeof v === "string" && /^[a-z2-7]{56}\.onion$/.test(v.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
export const onionHostOf = (v) =>
  String(v || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
export const isNodeName = (v) => {
  const slug = String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 && String(v).trim().length <= 40;
};
export function parsePairing(text) {
  let p;
  try { p = JSON.parse(text); } catch { return { ok: false, error: "not valid JSON" }; }
  const url = p?.pairing?.url;
  if (p?.pairing?.type !== "dojo.api") return { ok: false, error: "pairing.type must be dojo.api" };
  if (typeof url !== "string" || !/^http:\/\/[a-z2-7]{56}\.onion/.test(url)) {
    return { ok: false, error: "pairing.url must be an http .onion URL" };
  }
  if (!p.pairing.apikey) return { ok: false, error: "pairing.apikey missing" };
  return { ok: true, payload: p };
}

// The exact text the operator signs in the wallet: onion URL, blank line,
// BIP47 line. This whole text is inside the signature (see crypto.mjs).
export const operatorMessage = (onionHost, paymentCode) =>
  `http://${onionHost}/\n\nBIP47: ${paymentCode}`;

// ---- torrc ------------------------------------------------------------------
export const TORRC_MARK = "# dojobay hidden service (managed by scripts/install.mjs)";
export function torrcBlock(hsDir) {
  return `${TORRC_MARK}\nHiddenServiceDir ${hsDir}\nHiddenServicePort 80 127.0.0.1:8080\n`;
}
// Idempotent: replaces an existing managed block, appends otherwise.
export function mergeTorrc(existing, hsDir) {
  const block = torrcBlock(hsDir);
  const re = new RegExp(TORRC_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n(?:HiddenService\\S* [^\\n]*\\n?)*", "m");
  if (re.test(existing)) return existing.replace(re, block);
  return existing.replace(/\n*$/, "\n\n") + block;
}

// ---- systemd + nginx rendering ----------------------------------------------
// Templates ship in scripts/ and deploy/ with the reference values baked in;
// rendering is a substitution over those known markers.
export function renderServerUnit(template, { webRoot, baseUrl, adminCode }) {
  return template
    .replace(/WorkingDirectory=.*/g, `WorkingDirectory=${path.join(webRoot, "server")}`)
    .replace(/Environment=BASE_URL=.*/g, `Environment=BASE_URL=${baseUrl}`)
    .replace(/Environment=ADMIN_PAYMENT_CODES=.*/g, `Environment=ADMIN_PAYMENT_CODES=${adminCode}`)
    .replace(/ExecStart=.*/g, `ExecStart=/usr/bin/env node ${path.join(webRoot, "server", "index.mjs")}`);
}
export function renderUpdateUnit(template, { webRoot }) {
  return template
    .replace(/WorkingDirectory=.*/g, `WorkingDirectory=${webRoot}`)
    .replace(/ExecStart=.*/g, `ExecStart=/usr/bin/env node ${path.join(webRoot, "scripts", "update.mjs")}`);
}
export function renderNginx(template, { webRoot }) {
  return template.replace(/root \/var\/www\/dojobay;/g, `root ${webRoot};`);
}

// ---- seed / operator documents ----------------------------------------------
export function anchorSeed({ network, name, paymentCode, paynym, payload, jurisdiction, hardware, name_url }) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return { nodes: [{
    id: `${network}-${slug}`, network, name: String(name).trim(),
    paynym: paynym || null, paymentCode,
    jurisdiction: jurisdiction || null, hardware: hardware || null,
    name_url: name_url || null, payload,
  }] };
}
export const operatorDoc = (onionHost, paymentCode, verifySigned) =>
  ({ onion: `http://${onionHost}/`, paymentCode, verifySigned });

// ---- terminal theme ---------------------------------------------------------
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
export const red = (s) => (TTY ? `\x1b[38;5;160m${s}\x1b[0m` : s);
export const dim = (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s);
export const bold = (s) => (TTY ? `\x1b[1m${s}\x1b[0m` : s);
export const ok = (s) => (TTY ? `\x1b[38;5;71m${s}\x1b[0m` : s);
export const bad = (s) => (TTY ? `\x1b[38;5;196m${s}\x1b[0m` : s);

// The torii gate over two waves, in the brand red. Falls back to a plain
// title on narrow or non-TTY terminals.
export function banner(width = (process.stdout.columns || 80)) {
  const art = [
    "  ______________________________________  ",
    "  \\____________________________________/  ",
    "     |    ________________________    |   ",
    "     |    \\______________________/    |   ",
    "     |     |                    |     |   ",
    "     |     |   THE  DOJO  BAY   |     |   ",
    "     |     |                    |     |   ",
    "    _|_____|_                  _|_____|_  ",
    "   ~~~\\~~~~/~~~~~~~~~~~~~~~~~~~~\\~~~~/~~~ ",
    "  ~~~~~~~~~~~~  ~~~~~~~~  ~~~~~~~~~~~~~~  ",
  ];
  if (!process.stdout.isTTY || width < 46) return bold("THE DOJO BAY — installer\n");
  return art.map((l) => red(l)).join("\n") + "\n" + dim("  onion-only Dojo directory · guided install\n");
}
