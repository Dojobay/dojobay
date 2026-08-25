# Decisions

Why things are shaped as they are, what went wrong, and what was tried and
rejected. Newest first, one entry per decision, headed with the date, the update
number and a title. Comments in the code hold present-tense invariants only;
anything in the past tense belongs here. `README.md` is for operators and
`CONTRIBUTING.md` is for people changing the code, and neither takes postmortems.

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
