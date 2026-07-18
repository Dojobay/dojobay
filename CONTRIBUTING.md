# Contributing to The Dojo Bay

Thanks for helping. This file covers development setup, the project's layout,
how to run the test suites, and the conventions the codebase follows. What
the project is and how to run a production instance are in the
[README](README.md). Node listings are not contributions to this repository:
operators submit them through the site's Auth47 flow.

## Development setup

The front end needs nothing but Node (any static server works too, but
opening `index.html` from disk is blocked by the browser because everything
loads over `fetch`):

```
npm run dev            # serves the repo at http://localhost:8080
```

The backend runs separately when you are working on submissions, Auth47 or
moderation:

```
cd server && npm ci
PORT=8787 BASE_URL=http://localhost:8080 ADMIN_PAYMENT_CODES=<your PM8...> node index.mjs
```

The front end shows **Manage my Dojo** only once `/api/me` answers, so the
button appearing is your sign the backend is up. `PUBLIC_DATA_DIR` and
`SERVER_DATA_DIR` override where the public JSON and the submission store
live; the test suites rely on those to isolate themselves from real data.

## Project structure

```
index.html                 # slim shell: loads the css + js below
manifest.json, sw.js       # PWA manifest and service worker
assets/
  css/styles.css           # all styling (CSS variables + @font-face at the top)
  js/app.js                # directory UI, Manage panel, admin console
  js/markdown.js           # tiny dependency-free Markdown renderer
  js/qrcode.js             # vendored QR encoder (qrcode-generator, MIT)
  fonts/, icons/           # self-hosted woff2 + PWA icons
content/
  about.md, faq.md, disclaimer.md   # modal copy: edit these, no JS required
data/
  seed.json                # instance ANCHOR: the operator's own node (exactly one)
  dojos.json               # GENERATED public list: seed + approved submissions
  history.json             # rolling 24h check series   (instance-owned)
  history-daily.json       # 90-day daily rollups       (instance-owned)
  operator.json            # signed onion<->payment-code binding for Verify
  paynym-codes.json        # PayNym -> BIP47 code variants (migration + display)
server/
  index.mjs                # Auth47 + submissions + moderation API (localhost)
  updates.mjs              # commits/releases-behind check against GitHub, over Tor
  self-update.mjs          # fetch (github/peer) + verify + stage a source update
  build-public.mjs         # merges seed + approved store into dojos.json
  store.mjs, crypto.mjs, paynym.mjs, admin.mjs
  selftest.mjs             # backend test suite (see below)
scripts/
  install.mjs              # guided installer; stages talk to installer-ui.mjs
  installer-ui.mjs         # one interface, two faces: full-screen TUI + sequential
  tui.mjs                  # TUI toolkit; pure core (keys, forms, frames) is self-tested
  installer-lib.mjs        # installer's pure logic: validators, config renderers
  bootstrap-import.mjs     # import nodes + history from a trusted instance (signature-gated)
  update.mjs               # ten-minute Tor prober; maintains statuses + history
  apply-update.mjs         # detached helper: swap staged code + restart service
  migrate-seed-to-store.mjs# idempotent seed -> store migration (--dry-run)
  selftest.mjs             # offline tests of the reachability logic
  pack-source.mjs          # packs the instance's own code into data/dojobay-src.zip
  serve.mjs                # zero-dependency dev server
  dojobay-server.service, dojobay-update.{service,timer}
deploy/
  nginx-onion.conf.example # localhost bind, /api/ proxy, /server/ blocked
.github/workflows/deploy.yml
```

`data/dojos.json`, both history files and `server/data/` are owned by the
running instance: never hand-edit them, and never let a deploy overwrite
them. The deploy workflow excludes them for that reason, and `server/data/`
is gitignored because the store holds Dojo API keys and live sessions.

## Tests

Three suites, and all of them must pass before a change ships.

**Backend** — `cd server && node selftest.mjs`. Spins up the real API against
temp data directories with a mock Tor proxy and a mock Dojo, and exercises
Auth47 end to end with a throwaway BIP39 wallet: challenge, signed callback,
sessions, the connection and signature gates, submissions, name uniqueness,
multi-code ownership, editing, moderation, publish failures, history
retirement and resurrection, the migration script (dry-run, apply,
idempotence) and the export endpoint.

**Updater** — `node scripts/selftest.mjs`. Offline checks of the
reachability-detection logic against mock sockets.

**Front end** — `scripts/e2e-harness.mjs`, a JSDom harness that boots
`assets/js/app.js` with stubbed fetch and asserts rendering behaviour:
card titles and ordering, the payment-code chip, build-hash persistence
across re-renders, the mobile menu, Manage-panel ordering and the inline
editor (name, hardware and link only — the Dojo version is read live from
the node by the updater and is not editable). The harness is committed;
its single dependency (jsdom) is side-installed once and never added to a
package.json, so the front end and `scripts/` stay dependency-free:

```
mkdir -p /tmp/e2e && cd /tmp/e2e && npm init -y && npm install jsdom
cd <repo> && node scripts/e2e-harness.mjs
```

One invariant applies to every test run: the instance-owned files must be
byte-identical before and after. Gate your runs with checksums —

```
sha256sum data/dojos.json data/history*.json > /tmp/before.sha
# ... run tests ...
sha256sum -c /tmp/before.sha
```

— and treat any difference as a bug in the test's isolation, not as noise.

## Conventions

The front end is dependency-free and stays that way: no framework, no build
step, no CDN. Anything vendored (the QR encoder) is committed. Fonts are
self-hosted. Scripts under `scripts/` use Node builtins only, so the updater
and migration run on a bare box with nothing but Node installed; the
`server/` directory is the one place with npm dependencies, kept minimal.

Rendered state lives in variables read by templates at render time, never
poked into the DOM afterwards. `render()` rebuilds the page wholesale, so a
one-shot DOM injection silently vanishes on the next re-render; the build
hash, the Manage button and the mobile menu all exist as state for exactly
this reason. Follow the pattern for anything new.

The site is onion-only and the code must not assume clearnet: outbound
requests (probes, PayNym lookups) go through the Tor SOCKS proxy, nginx
binds to localhost, and nothing in the front end loads a remote resource.

Copy is British English. The modal text lives in `content/*.md` (the
renderer supports headings, bold, code, links, lists and `>` callouts);
editing copy needs no JavaScript. Records are keyed by
`network-slug(name)` with names unique per network; ids are stable once
created because the reliability history is keyed by them. Every node carries
a BIP47 payment code — ownership, Auth47 sign-in and the card chip key on it
— and the single seed entry is the instance operator's own node; code-less
records exist only as grandfathered, `/admin`-managed exceptions and cannot
be newly created.

## Brand assets

The favicon, PWA icons and social image are committed so no build step is
needed. The vector master is `favicon.svg`: a torii gate over two waves on a
near-black rounded tile. Palette: torii and beams `#b5302a`, waves `#d6534a`
(lower wave at ~60% opacity), background `#0b0b0c`. The PWA icons
(`assets/icons/192x192.png`, `512x512.png`) put the logo at ~60% of a solid
near-black square for the maskable safe zone; `og-image.png` is the 1200x630
social card using the site's self-hosted families (Archivo, Hanken Grotesk,
JetBrains Mono). If the logo changes, regenerate all of them from the SVG by
whatever means you prefer.

## Pull requests

Keep commits scoped to one concern with a message describing behaviour, not
files. Extend the relevant self-test with any behavioural change — the suites
above are the spec — and run all three plus the checksum gate before pushing.
For anything security-adjacent (the Auth47 flow, the signature gate, nginx
examples, the store), describe the threat you considered in the PR text.
