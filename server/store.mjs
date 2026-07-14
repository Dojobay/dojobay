// Tiny JSON-file store for the backend. Single-writer (one server process),
// atomic writes, no external database. Holds submissions, live sessions and
// outstanding Auth47 nonces.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const DIR = process.env.SERVER_DATA_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");
const FILE = path.join(DIR, "store.json");

const EMPTY = { submissions: {}, sessions: {}, nonces: {} };
let cache = null;

// A submission's ownership is a paymentCodes ARRAY, because one PayNym often
// carries two BIP47 codes (segwit and legacy variants) and the wallet may sign
// Auth47 with either. Records written before this schema carried a scalar
// paymentCode; normalise those on read so old store files keep working.
function normaliseSubmission(rec) {
  if (!rec || typeof rec !== "object") return rec;
  if (!Array.isArray(rec.paymentCodes)) {
    rec.paymentCodes = rec.paymentCode ? [rec.paymentCode] : [];
  }
  rec.paymentCodes = [...new Set(rec.paymentCodes.filter((c) => typeof c === "string" && c))];
  delete rec.paymentCode;
  return rec;
}

async function load() {
  if (cache) return cache;
  await mkdir(DIR, { recursive: true });
  try {
    cache = { ...EMPTY, ...JSON.parse(await readFile(FILE, "utf8")) };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    cache = structuredClone(EMPTY);
  }
  for (const rec of Object.values(cache.submissions)) normaliseSubmission(rec);
  return cache;
}

async function persist() {
  const tmp = FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(cache, null, 2) + "\n");
  await rename(tmp, FILE);
}

export const store = {
  async get() { return load(); },
  async save() { await persist(); },

  // --- nonces (single-use, short lived) ---
  async putNonce(nonce, data) { (await load()).nonces[nonce] = data; await persist(); },
  async takeNonce(nonce) {
    const s = await load();
    const n = s.nonces[nonce];
    if (n) { delete s.nonces[nonce]; await persist(); }
    return n || null;
  },
  async gcNonces(now = Date.now()) {
    const s = await load();
    let changed = false;
    for (const [k, v] of Object.entries(s.nonces)) {
      if (!v || v.expires < now) { delete s.nonces[k]; changed = true; }
    }
    if (changed) await persist();
  },

  // --- sessions ---
  async putSession(data) {
    const s = await load();
    const id = randomBytes(32).toString("hex");
    s.sessions[id] = data;
    await persist();
    return id;
  },
  async getSession(id) {
    if (!id) return null;
    const s = await load();
    const sess = s.sessions[id];
    if (!sess) return null;
    if (sess.expires < Date.now()) { delete s.sessions[id]; await persist(); return null; }
    return sess;
  },
  async dropSession(id) {
    const s = await load();
    if (s.sessions[id]) { delete s.sessions[id]; await persist(); }
  },

  // --- submissions (keyed by network + name slug; owned by paymentCodes[]) ---
  async listSubmissions() { return Object.values((await load()).submissions); },
  async submissionsFor(paymentCode) {
    return Object.values((await load()).submissions)
      .filter((r) => Array.isArray(r.paymentCodes) && r.paymentCodes.includes(paymentCode));
  },
  async putSubmission(rec) {
    const s = await load();
    s.submissions[rec.id] = normaliseSubmission(rec);
    await persist();
    return rec;
  },
  async getSubmission(id) {
    const rec = (await load()).submissions[id] || null;
    return rec ? normaliseSubmission(rec) : null;
  },
  async deleteSubmission(id) {
    const s = await load();
    if (s.submissions[id]) { delete s.submissions[id]; await persist(); }
  },
};
