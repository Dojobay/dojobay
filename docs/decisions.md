# Decisions

Why things are shaped as they are, what went wrong, and what was tried and
rejected. Newest first, one entry per decision, headed with the date, the update
number and a title. Comments in the code hold present-tense invariants only;
anything in the past tense belongs here. `README.md` is for operators and
`CONTRIBUTING.md` is for people changing the code, and neither takes postmortems.

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
| `indexer_url` | mixed | `effectiveIndexer`: node-reported when probed, otherwise the declared URL, which is **not signed** |
| `checked_at` | site-controlled | when this instance last probed |
| `payload` | operator-signed | except `payload.indexer`, added at submission outside the signed material |
| `signed` | operator-signed | the block itself |

Two rows are weaker than the cards imply. `payload` is published wholesale
because a visitor needs it byte for byte to pair, and the signature covers
`pairing` and `explorer` only, so an `indexer` entry rides inside an otherwise
attested object without being attested. `indexer_url` inherits that through the
declared fallback, which is the only field on a card that can show an endpoint
neither signed for nor probed. Dropping the fallback would need three changes,
not one: `effectiveIndexer`, the initial value in `toPublicNode`, and
`indexerUrl` in `app.js`, which re-derives the same URL from the payload
client-side so that a stale `dojos.json` keeps working.

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
