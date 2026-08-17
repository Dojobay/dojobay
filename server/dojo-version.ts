// =============================================================================
// Dojo version comparison, and the minimum this directory will accept.
//
// A version reaches us two ways, and they are not equally trustworthy:
//
//   detected  read from the node's own X-Dojo-Version response header during a
//             probe. This is what the node is actually running.
//   declared  the `version` inside the pairing payload. Informational, frozen
//             when the payload was generated, and often stale — one listing
//             here declares 1.4.5 while running something far newer, because
//             the payload was restored to match the signature that covers it.
//
// So anything deciding on a version prefers the detected one, and falls back to
// the declared one only when the node did not report a header at all.
// =============================================================================

// Which network a pairing URL is for, read from the URL itself.
//
// A Dojo serves its testnet API under a `test` path segment and its mainnet API
// without one: http://<onion>/test/v2 against http://<onion>/v2. That makes the
// operator's declared network checkable against the endpoint they gave, and it
// is worth checking, because a crossed pair is wrong in a way nothing
// downstream catches. A testnet node listed as mainnet answers, reports a
// height and probes green indefinitely; the only symptom is a block height a
// few hundred thousand adrift, which reads as nothing at all, and anyone
// pairing with it is sent to a chain they did not ask for.
//
// A whole path SEGMENT, never a substring: an onion address is base32 and can
// carry those four letters in a row by chance, and /v2/testing is not a testnet
// endpoint either.
//
// It lives here rather than in the installer because the same judgement belongs
// at the submission gate, and this module is already where a node's declared
// properties are judged against what it actually is.
export function pairingNetwork(url: string): "mainnet" | "testnet" | null {
  try {
    return new URL(url).pathname.split("/").some((seg) => seg.toLowerCase() === "test")
      ? "testnet" : "mainnet";
  } catch { return null; }
}

/** The lowest Dojo this directory will accept for a NEW listing. Set to "" or
 *  "0" to disable the check entirely. Existing listings are never re-judged. */
export const MIN_DOJO_VERSION = (process.env.MIN_DOJO_VERSION ?? "1.27.0").trim();

/** "v1.27.0-rc1" -> [1, 27, 0]. Null when there is no version in there at all. */
export function parseVersion(v: unknown): number[] | null {
  if (typeof v !== "string") return null;
  const m = v.trim().replace(/^v/i, "").match(/^(\d+(?:\.\d+)*)/);
  if (!m) return null;
  const parts = m[1].split(".").map((n) => Number(n));
  return parts.every((n) => Number.isFinite(n)) ? parts : null;
}

/** -1, 0 or 1. Missing components count as zero, so 1.27 equals 1.27.0. */
export function compareVersions(a: unknown, b: unknown): number {
  const x = parseVersion(a) || [], y = parseVersion(b) || [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function meetsMinimum(version: unknown, minimum: string = MIN_DOJO_VERSION): boolean {
  if (!minimum || compareVersions(minimum, "0") === 0) return true;   // check disabled
  return compareVersions(version, minimum) >= 0;
}

/**
 * Judge a node's version for the submission gates.
 *
 * `unknown` is deliberately its own outcome rather than a silent pass or a
 * silent refusal: a node that reports no version at all is almost certainly too
 * old to carry the endpoints this directory reads, but saying so plainly is
 * more useful to an operator than either guessing.
 */
export function judgeVersion(
  detected: unknown, declared: unknown, minimum: string = MIN_DOJO_VERSION,
): { ok: boolean; version: string | null; source: "detected" | "declared" | null; reason?: string } {
  if (!minimum || compareVersions(minimum, "0") === 0) {
    return { ok: true, version: (detected as string) || (declared as string) || null,
      source: detected ? "detected" : declared ? "declared" : null };
  }
  const version = (parseVersion(detected) ? detected : parseVersion(declared) ? declared : null) as string | null;
  const source = parseVersion(detected) ? "detected" as const : parseVersion(declared) ? "declared" as const : null;
  if (!version) {
    return { ok: false, version: null, source: null,
      reason: `this Dojo did not report a version, so it cannot be checked against the minimum of ${minimum}. `
        + "Dojo has sent an X-Dojo-Version header on every response since well before that, so a node that "
        + "sends none is almost certainly older. Upgrade, then submit again." };
  }
  if (!meetsMinimum(version, minimum)) {
    return { ok: false, version, source,
      reason: `this Dojo reports version ${version}, and this directory requires ${minimum} or newer. `
        + "Earlier versions do not serve the endpoints listings are checked against. Upgrade, then submit again." };
  }
  return { ok: true, version, source };
}
