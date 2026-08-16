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
// BIP47 line. This whole text is inside the signature (see crypto.ts).
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

// The reverse of mergeTorrc: take out the block we put in, and nothing else.
// Surgical on purpose — a torrc usually carries an operator's other hidden
// services and settings, and an uninstaller that rewrites the file wholesale
// would take those with it.
export function stripTorrc(existing) {
  const re = new RegExp("\\n*" + TORRC_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    + "\\n(?:HiddenService\\S* [^\\n]*\\n?)*", "m");
  if (!re.test(existing)) return { text: existing, removed: false };
  return { text: existing.replace(re, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, ""), removed: true };
}

// ---- systemd + nginx rendering ----------------------------------------------
// Templates ship in scripts/ and deploy/ with the reference values baked in;
// rendering is a substitution over those known markers.
// The account both services run as. It is rendered into the units, and the
// installer creates it, because the templates shipped with names that were true
// of one particular machine and of nobody else's: the backend unit said deploy
// and the updater unit said dojobay, neither renderer touched either line, and
// the installer created neither account. On a fresh box both services therefore
// failed to start with 217/USER. Nothing said so out loud: nginx serves the
// directory as static files whether or not the backend is alive, so the site
// came up looking correct while the updater never ran once, which is why an
// install could finish with stale statuses, no block heights and no avatars.
export const SERVICE_USER = "dojobay";

export function renderServerUnit(template, { webRoot, baseUrl, adminCode, user = SERVICE_USER }) {
  return template
    .replace(/^User=.*$/gm, `User=${user}`)
    .replace(/^Group=.*$/gm, `Group=${user}`)
    .replace(/WorkingDirectory=.*/g, `WorkingDirectory=${path.join(webRoot, "server")}`)
    .replace(/Environment=BASE_URL=.*/g, `Environment=BASE_URL=${baseUrl}`)
    .replace(/Environment=ADMIN_PAYMENT_CODES=.*/g, `Environment=ADMIN_PAYMENT_CODES=${adminCode}`)
    .replace(/ExecStart=.*/g, `ExecStart=/usr/bin/env node ${path.join(webRoot, "server", "index.mjs")}`);
}
export function renderUpdateUnit(template, { webRoot, user = SERVICE_USER }) {
  return template
    .replace(/^User=.*$/gm, `User=${user}`)
    .replace(/^Group=.*$/gm, `Group=${user}`)
    .replace(/WorkingDirectory=.*/g, `WorkingDirectory=${webRoot}`)
    .replace(/ExecStart=.*/g, `ExecStart=/usr/bin/env node ${path.join(webRoot, "scripts", "update.mjs")}`);
}
export function renderNginx(template, { webRoot }) {
  return template.replace(/root \/var\/www\/dojobay;/g, `root ${webRoot};`);
}

// ---- seed / operator documents ----------------------------------------------
// `signed` is not optional, and the parameter is deliberately not defaulted:
// the rebuild withholds a seed node without a signed pairing block, exactly as
// it withholds any other unsigned listing, so an anchor built without one
// produces an instance whose directory is empty and which says nothing about
// why. It was optional once, and that is precisely what happened.
/**
 * @param {{ network: string, name: string, paymentCode: string, signed: string,
 *   paynym?: string|null, payload: any, jurisdiction?: string|null,
 *   hardware?: string|null, name_url?: string|null }} n
 */
export function anchorSeed({ network, name, paymentCode, paynym, payload, signed, jurisdiction, hardware, name_url }) {
  if (!signed || typeof signed !== "string" || !signed.includes("BEGIN BITCOIN SIGNATURE")) {
    throw new Error("anchorSeed: a signed pairing block is required, or the anchor will be withheld from the published directory");
  }
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return { nodes: [{
    id: `${network}-${slug}`, network, name: String(name).trim(),
    paynym: paynym || null, paymentCode,
    jurisdiction: jurisdiction || null, hardware: hardware || null,
    name_url: name_url || null, payload, signed,
  }] };
}
// paynym is optional and carries no security weight: the binding that matters
// is verifySigned, which proves the payment code signed this onion address. The
// name is a convenience so the Verify popup can link to the PayNym directory
// and a reader can check the operator's reputation for themselves. Instances
// installed before this field existed simply have no link, unless their
// operator adds it by hand or their own listing supplies it; nothing about
// verification changes either way.
export const operatorDoc = (onionHost, paymentCode, verifySigned, paynym = null) =>
  ({ onion: `http://${onionHost}/`, paymentCode, paynym: paynym || null, verifySigned });

// Collect a multiline paste from a readline interface, terminated by a line
// containing only `endWord`.
//
// CRITICAL: this MUST be a "line" listener, not a loop of rl.question(). A
// paste arrives as one or a few chunks, and readline emits a "line" event for
// every line in a chunk synchronously. A one-shot question consumes only the
// first of them; every other line in that chunk is emitted with nothing
// listening and is silently DROPPED. That is exactly what broke the installer's
// operator-signature step: the block came back missing lines, failed to parse,
// and reported "not a recognisable signed block" even though the operator had
// pasted a perfectly good signature. Attach the listener BEFORE prompting, so
// nothing can arrive unlistened.
/**
 * Collect a multi-line paste.
 *
 * Ends on a line containing just `endWord`, or as soon as `endMarker` is seen.
 *
 * The marker matters more than it looks. A wallet's signed block ends with
 * "-----END BITCOIN SIGNATURE-----", so an operator who pastes one and presses
 * Enter has, to their eye, finished — the block plainly says END. The collector
 * was still waiting for a bare END on its own line, so the installer looked
 * hung, and the only way out was Ctrl-C. Recognising the wallet's own
 * terminator means the commonest paste needs nothing typed after it.
 *
 * @param {import("node:readline").Interface} rl
 * @param {string} [endWord]
 * @param {{ endMarker?: string|null }} [opts]
 */
export function collectPasteFrom(rl, endWord = "END", { endMarker = null } = {}) {
  return new Promise((resolve) => {
    const lines = [];
    const cleanup = () => { rl.off("line", onLine); rl.off("close", onClose); };
    const onLine = (l) => {
      if (l.trim() === endWord) { cleanup(); resolve(lines.join("\n")); return; }
      lines.push(l);
      if (endMarker && l.trim() === endMarker) { cleanup(); resolve(lines.join("\n")); }
    };
    const onClose = () => { cleanup(); resolve(lines.join("\n")); };
    rl.on("line", onLine);
    rl.on("close", onClose);
  });
}

// ---- terminal theme ---------------------------------------------------------
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
// The brand red, #b5302a, the same --accent the site uses. Given exactly when
// the terminal admits to 24-bit colour and approximated as xterm 124 otherwise.
// Nearest-by-RGB-distance picks 130 for this colour, which is a burnt orange:
// the metric is not perceptual and the eye disagrees with it, so 124 is chosen
// by looking rather than by arithmetic.
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || "");
export const red = (s) => (TTY ? `\x1b[${TRUECOLOR ? "38;2;181;48;42" : "38;5;124"}m${s}\x1b[0m` : s);
export const dim = (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s);
export const bold = (s) => (TTY ? `\x1b[1m${s}\x1b[0m` : s);
export const ok = (s) => (TTY ? `\x1b[38;5;71m${s}\x1b[0m` : s);
export const bad = (s) => (TTY ? `\x1b[38;5;196m${s}\x1b[0m` : s);

// The torii gate over three bands of wave, drawn in ones and zeroes: a
// directory of machines, marked with the only two symbols any of them has.
//
// Sixty-six columns and thirty-four rows, which is the whole thing rather than
// a version of it that fits somewhere convenient. A first attempt squeezed it
// to forty-four columns and one wave band so the TUI could redraw it every
// frame, and the result was not a smaller gate but a different and much worse
// picture. If it will not fit, it is not drawn at all.
//
// Symmetry is structural rather than checked afterwards: every row is laid out
// from the centre and its left half mirrored onto its right. Note that for an
// even width the mirror axis falls BETWEEN two columns, so a crest centred on
// c pairs with one centred on W-c; centring on the middle column instead puts
// each crest half a cell off the axis and the mirror clips one side of it.
export const TORII = [
  "0000000000011                                        1100000000000",
  "100000000000000000000000000000000000000000000000000000000000000001",
  "100000000000000000000000000000000000000000000000000000000000000001",
  "          1100000000000000000000000000000000000000000011",
  "          1000000000000000000000000000000000000000000001",
  "          1000000000000000000000000000000000000000000001",
  "                100001                      100001",
  "                000000                      000000",
  "                000000                      000000",
  "                000000                      000000",
  "                100001                      100001",
  "                000000                      000000",
  "                000000                      000000",
  "                000000                      000000",
  "                100001                      100001",
  "                000000                      000000",
  "                000000                      000000",
  "                000000                      000000",
  "                100001                      100001",
  "                000000                      000000",
  "                000000                      000000",
  "",
  "        10000001      10000001      10000001      10000001",
  "      100000000001  100000000001  100000000001  100000000001",
  "00000000001  100000000001  100000000001  100000000001  10000000000",
  "  100001        100001        100001        100001        100001",
  "        10000001      10000001      10000001      10000001",
  "      100000000001  100000000001  100000000001  100000000001",
  "00000000001  100000000001  100000000001  100000000001  10000000000",
  "  100001        100001        100001        100001        100001",
  "        11111111      11111111      11111111      11111111",
  "      111111111111  111111111111  111111111111  111111111111",
  "11111111111  111111111111  111111111111  111111111111  11111111111",
  "  111111        111111        111111        111111        111111",
];

export function banner(width = (process.stdout.columns || 80)) {
  const art = TORII[0].length;
  // Nothing is gained by drawing two thirds of a gate: below the full width it
  // wraps into rubble, so the name alone is the better answer.
  if (!process.stdout.isTTY || width < art + 2) return bold("THE DOJO BAY \u2014 installer\n");
  return TORII.map((l) => red(l)).join("\n")
    + "\n\n" + bold("  THE DOJO BAY") + dim("  \u00b7  onion-only Dojo directory \u00b7 guided install\n");
}
