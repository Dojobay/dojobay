# Decisions

Why things are shaped as they are, what went wrong, and what was tried and
rejected. Newest first, one entry per decision, headed with the date, the update
number and a title. Comments in the code hold present-tense invariants only;
anything in the past tense belongs here. `README.md` is for operators and
`CONTRIBUTING.md` is for people changing the code, and neither takes postmortems.

## 2026-08-26 · 106 · A card's Electrum endpoint is probed or absent

`effectiveIndexer` returned `detected || declared`, so a URL an operator's Dojo
export happened to carry was published when no probe had read one. The argument
for removing it was that `payload` is published wholesale for visitors to pair
with, and `canonicalPairing` covers `pairing` and `explorer` only, so a declared
indexer rode inside an attested object unattested. The argument against was that
new listings would show N/A until their first probe.

Measurement settled it rather than reasoning. On the live instance, 15 records in
the store and 14 published nodes, with zero carrying a declared indexer and zero
cards on the fallback. Nothing was relying on it, so removing it changed no card.
The fallback was also worse than "until the first probe" implied: `update.mjs`
only overwrites `detected_indexer` when a probe actually reads a URL, and
deliberately so, since a node down for one cycle should not flip its card to N/A.
A node that is healthy and simply exposes no Electrum endpoint therefore never
acquires a detected value, and its declared URL was published indefinitely,
indistinguishable from a node awaiting its first probe. The comment claiming N/A
meant "no exposed indexer" was unreachable for any listing that declared one.

Removing it turned up the wider hole. The submission gate rebuilt `payload` as
`{ pairing, explorer }` plus a validated indexer, but the pairing-update endpoint
assigned `rec.payload = body.payload` wholesale, and `validatePayload` does not
reject unknown keys. An operator updating their pairing details could therefore
store arbitrary unsigned JSON inside the object the directory publishes as the
signed artefact. Both paths now store exactly the two keys the signature covers,
which is the invariant that was assumed all along and never enforced.

Four places had to change for one behaviour: `effectiveIndexer`, the value
`toPublicNode` seeds, the submission and pairing gates, and `indexerUrl` in
`app.js`, which re-derived the endpoint from the payload client-side so a stale
`dojos.json` kept working. Changing the server alone would have left the same
URL on the same cards.

## 2026-08-25 · 103 · Where every published field comes from

The directory's whole argument is that its claims are checkable, so each of the
nineteen keys in `PUBLIC_NODE_KEYS` is one of four things, and a reader should be
able to tell which without reading `build-public.ts`. Operator-signed means the
value is covered by the wallet signature on the record. Node-reported means the
updater read it from the node itself, over an endpoint the operator's signature
fixed. Operator-asserted means a human typed it and nothing checks it. And
site-controlled means this instance computed it.

| Key | Provenance | Notes |
| --- | --- | --- |
| `id` | site-controlled | `<network>-<slug>`, assigned at submission and never reused |
| `network` | operator-asserted | declared in the submission, but refused when `pairingNetwork` disagrees with the signed URL |
| `name` | operator-asserted | editable without resubmission; falls back to the PayNym, then the id |
| `status` | node-reported | the last probe's verdict |
| `paynym` | site-controlled | resolved from paynym.rs against the authenticated payment code |
| `paymentCode` | operator-signed | inside the signed text, so the signature covers it |
| `jurisdiction` | operator-asserted | free text, 64 characters, unchecked by design |
| `country` | site-controlled | inferred by `countryFor` from the jurisdiction text; only decides a flag |
| `hardware` | operator-asserted | free text, editable without resubmission |
| `version` | node-reported | `effectiveVersion`: the detected header, else the payload's declared version |
| `detected_version` | node-reported | `X-Dojo-Version` read live each cycle |
| `detected_indexer` | node-reported | read from `/support/services` on the attested API endpoint |
| `operator_domain` | operator-signed | and domain-proven: a TXT record naming the code, plus a signed statement naming the domain |
| `operator_domain_proof` | operator-signed | the two halves published so a reader can check them without trusting the badge |
| `block_height` | node-reported | from the probe |
| `indexer_url` | node-reported | `effectiveIndexer`: the probed endpoint or null (see 106; a declared URL is no longer a fallback) |
| `checked_at` | site-controlled | when this instance last probed |
| `payload` | operator-signed | exactly `pairing` and `explorer`, which is exactly what the signature covers (see 106) |
| `signed` | operator-signed | the block itself |

Two rows were weaker than the cards implied when this was written, both fixed in
106: `payload` could carry an unsigned `indexer` entry inside an otherwise
attested object, and `indexer_url` inherited that through the declared fallback.
The table above reflects the code after that change.

The comment at `build-public.ts:83` gave "a Dojo older than v1.27.0" as the
reason the declared fallback exists. The version gate refuses new listings below
`MIN_DOJO_VERSION`, so for anything registering now that window is closed; what
remains is the gap between approval and the first successful probe, and listings
that predate the gate, which are not re-judged when their operator edits them.

## 2026-08-25 · 102 · The gate compares payload structure, not canonical bytes

Consolidating the canonical pairing string into `crypto.ts` was justified by the
belief that divergent copies would produce a signature accepted at submission and
reported invalid by a later audit. Proving the new test bites disproved it.
Reversing the key order inside `canonicalPairing` and running the backend suite
failed nothing except the assertion written for exactly that, 210 of 211 checks
passing on a definition that no longer produced the text the suite signs. The
reason is `sameSignedPayload`, which returns early on a byte match and otherwise
parses both sides and compares them stably: key order and whitespace are
tolerated deliberately, because a byte-exact comparison against our own
re-serialisation is what once rejected genuine wallet exports. `audit-signed.mjs`
reproduces the gate's verdict rather than forming its own, so it inherits that
tolerance, and the submission-versus-audit contradiction cannot arise from
serialisation alone.

The real exposure is narrower and stranger. `diagnose-signed.mjs` compares byte
for byte on purpose, since its job is to report the first differing offset and
say whether two texts are the same data in a different serialisation. A copy of
the canonical string that had drifted there would report a fleet of perfectly
valid listings as mismatched, and an operator would chase a fault that does not
exist. The consolidation is still right; the reason for it is not the one that
motivated the item.
