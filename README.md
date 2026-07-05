# The Dojo Bay

Static front-end for the public Dojo directory. No build step and no framework:
plain HTML, CSS and JavaScript. The page fetches its data and its text from
separate files at load and renders everything from them, so contributors can
edit one concern at a time.

## Project structure

```
index.html                 # slim shell: loads the css + js below
manifest.json              # PWA manifest
sw.js                      # service worker (offline app shell)
favicon.svg                # SVG favicon
og-image.png               # social preview image
assets/
  css/styles.css           # all styling (CSS variables + @font-face at the top)
  js/app.js                # directory UI: fetch data, render cards, modals
  js/markdown.js           # tiny dependency-free Markdown renderer
  js/qrcode.js             # vendored QR encoder (qrcode-generator, MIT)
  fonts/                   # self-hosted woff2 (Archivo, Hanken Grotesk, JetBrains Mono)
  icons/192x192.png        # PWA icons
  icons/512x512.png
content/
  about.md                 # ← edit these to change the modal text
  faq.md
  disclaimer.md
data/
  dojos.json               # current snapshot (also the node list)
  history.json             # rolling reliability history
scripts/
  update.mjs               # Tor reachability updater (see below)
  selftest.mjs             # offline test of the reachability logic
  serve.mjs                # local dev server
  dojobay-update.{service,timer}
deploy/
  nginx.conf.example       # clearnet web-server config (for step 2/3 later)
  nginx-onion.conf.example # onion-only config (localhost bind) — use this first
.github/workflows/
  deploy.yml               # CI: push the site to your VPS on every commit
LICENSE                    # MIT
```

## Brand assets

The favicon, PWA icons and social image are committed to the repository, so no
build step is required to serve the site. They were generated once from the
torii-and-waves logo; if the logo changes, regenerate them to the specifications
below by whatever means a maintainer prefers (an SVG editor, ImageMagick, a Node
rasteriser, Pillow, and so on). The vector master is `favicon.svg`, and the raster
files are rasterisations of the same geometry.

Shared palette: the torii and its two beams are dark red `#b5302a`; the two waves
are the lighter red `#d6534a`, with the lower wave at roughly 60% opacity; the
background is near-black `#0b0b0c`, matching the site's black ground.

`favicon.svg` is a 48x48 viewBox holding the torii gate (a gently upswept top
beam, a straight second beam, two slightly inward-leaning posts) over two
horizontal waves, on a rounded near-black tile.

`assets/icons/192x192.png` and `assets/icons/512x512.png` are the PWA icons:
square, on the solid near-black background with no transparency (so the platform
maskable crop behaves), with the logo centred and scaled to about 60% of the
canvas so it sits inside the maskable safe zone. `manifest.json` references both
at `purpose: "any maskable"`.

`og-image.png` is the 1200x630 social card on the near-black background, carrying
a small logo top-left, the wordmark "THE DOJO BAY" in Archivo ExtraBold (about
108px) in off-white `#f4f4f3`, the tagline "Public Dojo Directory" in Archivo
SemiBold (about 40px) in grey `#a0a0a8`, a line "Samourai / Ashigaru / reachable
over Tor" in JetBrains Mono (about 27px) in the lighter red `#d6534a`, a short red
underline, and a faint torii watermark bleeding off the right edge at about 10%
opacity. The three families (Archivo, Hanken Grotesk, JetBrains Mono) are the same
self-hosted fonts the site uses, under `assets/fonts/`; the site loads them via
`@font-face` in `styles.css` with no external CDN.

Everything is loaded with `fetch`, so the site must be served over HTTP, not
opened from disk (`file://`), which the browser blocks. For local development
(no dependencies, Node only):

```
npm run dev            # serves the repo at http://localhost:8080
```

(`npm run dev` runs `scripts/serve.mjs`, a tiny zero-dependency static server.
Any static server works too, e.g. `npx serve`. Opening `index.html` straight
from disk shows a short reminder to serve it over HTTP.)

Fonts are self-hosted from `assets/fonts/` (no Google Fonts / external CDN), and
the site is an installable PWA: `manifest.json`, the icons in `assets/icons/`,
and `sw.js` (a service worker that precaches the shell and serves data
network-first) make it installable and usable offline.

## Editing the text

The About / FAQ / Disclaimer popups are plain Markdown in `content/*.md`. Edit
those files to change the copy: no HTML or JS required. The renderer supports
headings, paragraphs, **bold**, `code`, [links](https://example.com), lists and
`>` blockquotes (which render as the highlighted callout boxes). Adding a node,
its PayNym, jurisdiction, hardware and pairing payload is done in
`data/dojos.json` (see the schema below).

## Downloading the data

`data/dojos.json` and `data/history.json` are plain static files, so they are
already a queryable, scriptable endpoint once the site is hosted:

```
curl https://your-host/data/dojos.json
curl -s https://your-host/data/dojos.json | jq '.nodes[] | select(.status=="active") | .name'
```

In the UI the same file is offered as the **JSON ↓** pill in the header
(pointing at `data/dojos.json`). Server notes for the VPS:

- Serve the `data/` files with `Content-Type: application/json` (nginx does this
  by default) so clients parse them cleanly.
- The files change every 10 minutes, so set a short cache header
  (e.g. `Cache-Control: max-age=60`) to avoid stale CDN/proxy copies.
- Add `Access-Control-Allow-Origin: *` on the `data/` location only if you want
  other origins (a dashboard, another site) to fetch the directory in-browser.

## data/dojos.json

```jsonc
{
  "generated_at": "2026-06-29T14:10:00Z",
  "interval_minutes": 10,
  "nodes": [
    {
      "id": "mainnet-compiler",      // stable key: network + slug(name)
      "network": "mainnet",          // mainnet | testnet
      "name": "Compiler",
      "status": "active",            // active | inactive (from the health check)
      "paynym": "+bumpyblank89",     // or null
      "jurisdiction": "North America",
      "country": null,               // ISO-3166 alpha-2 for a flag, or null for a region
      "hardware": "Ryzen 9 processor 32gb",
      "version": "1.27.0",
      "apikey_required": true,
      "checked_at": "2026-06-29 14:09:08",
      "block_height": 872345,        // tip height read from the Dojo API, or null
      "payload": { "pairing": { ... }, "explorer": { ... }, "indexer": { ... } },  // verbatim pairing payload
      "signed":  "-----BEGIN BITCOIN SIGNED MESSAGE----- ..."   // BIP47-signed message, or null
    }
  ]
}
```

`payload.indexer` is optional and renders an "Electrum Server" box below the
Dojo API and Explorer boxes on the card. Its shape is
`{ "type": "indexer", "kind": "fulcrum", "url": "tcp://<56-char>.onion:50001" }`;
the URL is a bare TCP (or SSL) Electrum endpoint, not HTTP, so it is display-only
and is never probed by the reachability checker or the connection gate. For seed
nodes you add this field by hand; for self-service submissions the backend
extracts it automatically from an explicit `indexer` field or from a modern
`services` array in the operator's pairing payload (the entry whose
`type` is `indexer`). A node without an indexer simply renders no Electrum box.

`country` drives the flag emoji and is only set for single countries
(Canada, Japan, Singapore, Thailand, USA in the current data). Regions such as
"Europe" or "North America" stay as `country: null` and render without a flag.

## data/history.json

Keyed by the same `id`. Each run appends the latest check and trims to the
window. The reliability strip and uptime percentage are computed from this.

```jsonc
{
  "generated_at": "2026-06-29T14:10:00Z",
  "interval_minutes": 10,
  "window_checks": 72,               // 12h at 10-min cadence
  "nodes": {
    "mainnet-compiler": {
      "checks": [                    // oldest -> newest
        { "t": "2026-06-29T02:10Z", "up": true },
        { "t": "2026-06-29T02:20Z", "up": true }
      ]
    }
  }
}
```

## The updater

`scripts/update.mjs` is a zero-dependency Node script (no `npm install` needed)
that probes every node and rewrites both JSON files. It is meant to run on a
10-minute cron/timer.

`dojos.json` is the source of truth for the node **list**: to add or remove a
node, edit `dojos.json` in the repo (its `name`, `paynym`, `payload`, `signed`,
etc.) and deploy. The updater only fills in `status` + `checked_at` and appends
to the history, so hand-maintained fields are never touched; any statuses a
deploy ships are refreshed within one 10-minute cycle. `history.json` is owned
by the server: the repo carries an empty skeleton for local preview, the deploy
workflow never syncs it, and new nodes get a fresh series automatically while
removed nodes are pruned.

### What "active" means

A `.onion` only resolves through Tor, so the script opens each connection
through Tor's SOCKS5 proxy (default `127.0.0.1:9050`) using remote DNS. For a
node whose pairing payload carries an `apikey`, the check is an authenticated
read of the chain tip: it POSTs the apikey to `/v2/auth/login`, then reads
`info.latest_block.height` from `GET /v2/wallet` (passing a throwaway per-network
xpub declared `new`, so the node performs no rescan). The node is **active**
only if it returns a numeric height, which proves the whole stack (Tor, nginx,
the Dojo API, and bitcoind serving block data) is working, and that height is
recorded on the node as `block_height` and shown on the card. A node whose
payload has no apikey falls back to a plain reachability probe (active if the
onion returns an HTTP response line), with `block_height` left null. On a down
cycle the last known `block_height` is retained so the card can still show where
the node last was. Set `CONNECT_ONLY=1` to treat a successful Tor connect as up
without any HTTP exchange.

### Requirements

- Node.js >= 16
- A running Tor daemon exposing a SOCKS proxy (`apt install tor`; the default
  `SocksPort 9050` is fine). No hidden service of your own is required.

### Run

```
node scripts/update.mjs        # one pass; writes data/dojos.json + data/history.json
npm test                       # offline self-test (mock SOCKS proxy, no Tor)
```

Config is via environment variables: `TOR_SOCKS_HOST`, `TOR_SOCKS_PORT`,
`DATA_DIR`, `TIMEOUT_MS` (default 30000), `CONCURRENCY` (default 6),
`WINDOW_CHECKS` (default 72), `CONNECT_ONLY`.

### Schedule (every 10 minutes)

systemd (recommended): copy `scripts/dojobay-update.service` and
`scripts/dojobay-update.timer` into `/etc/systemd/system/`, adjust
`WorkingDirectory`/`User`, then:

```
sudo systemctl daemon-reload
sudo systemctl enable --now dojobay-update.timer
```

Or cron:

```
*/10 * * * * cd /var/www/dojobay && /usr/bin/node scripts/update.mjs >> /var/log/dojobay-update.log 2>&1
```

Writes are atomic (write-temp-then-rename), so the website never serves a
half-written file mid-update.

## Deployment — Step 1: onion-only test

This walks through the current plan's first step only: publish the repo to
GitHub, stand up a MyNymBox.io VPS in Finland, and serve the site as a Tor
onion service for a week to observe how well the node checks behave. Later
steps (handover to the dojobay.pw operator's infrastructure, or the clearnet
contingency) reuse the same workflow with different secrets and the clearnet
nginx config, and are deliberately not covered here.

### 1. Publish the repository to GitHub

1. Create the repository on GitHub (public, since the project is open source).
2. In `assets/js/app.js`, set `REPO_URL` at the top of the file to the new
   repository's URL (the footer GitHub mark links there). Leave `ONION_URL`
   empty for now; you can set it after Tor generates your address.
3. Push the whole tree, including `.github/workflows/deploy.yml`:

   ```
   git init && git add -A && git commit -m "Initial import"
   git branch -M main
   git remote add origin git@github.com:YOUR_USER/YOUR_REPO.git
   git push -u origin main
   ```

   The first push will run the deploy workflow and fail, because the VPS
   secrets don't exist yet. That is expected; ignore it until step 3 below.
4. Generate a dedicated deploy key on your own machine (not on the VPS):

   ```
   ssh-keygen -t ed25519 -f dojobay_deploy -C "github-actions deploy" -N ""
   ```

5. In the repo, Settings -> Secrets and variables -> Actions, add:

   | Secret | Value |
   | --- | --- |
   | `VPS_HOST` | the VPS IP address (no domain needed) |
   | `VPS_USER` | `deploy` |
   | `VPS_PATH` | `/var/www/dojobay` |
   | `VPS_SSH_KEY` | the contents of the private key file `dojobay_deploy` |
   | `VPS_PORT` | only if SSH is not on 22 |

### 2. Prepare the VPS (MyNymBox.io, Finland)

1. Order the server: a KVM VPS in their Finland location, Debian 12, 1 vCPU
   and 1–2 GB RAM is ample (MyNymBox accepts Bitcoin/Monero and asks for no
   identity, which suits this project; keep the account's recovery details
   somewhere safe since there is no KYC trail to recover through). Note the
   IP and root password from the provisioning email/panel.
2. Log in and do the base setup:

   ```
   ssh root@VPS_IP
   apt update && apt upgrade -y
   apt install -y tor nginx git nodejs rsync ufw
   node --version        # Debian 12 ships v18 — anything >=16 is fine
   ```

3. Create the deploy user, its web root, and install the CI deploy key:

   ```
   adduser --disabled-password --gecos "" deploy
   mkdir -p /var/www/dojobay && chown deploy:deploy /var/www/dojobay
   install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
   nano /home/deploy/.ssh/authorized_keys    # paste the PUBLIC key (dojobay_deploy.pub)
   chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
   ```

4. Allow the deploy user to reload nginx and manage the updater timer without
   a password, so CI's post-deploy step works (use the full `/usr/bin` path;
   sudo matches the resolved path on Debian):

   ```
   echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx, /usr/bin/systemctl enable --now dojobay-update.timer' > /etc/sudoers.d/dojobay
   chmod 440 /etc/sudoers.d/dojobay
   ```

5. Firewall: onion-only means nothing inbound except SSH. nginx will bind to
   localhost, so it needs no rule at all:

   ```
   ufw allow OpenSSH
   ufw enable
   ```

### 3. First deploy

Re-run the failed workflow (repo -> Actions -> "Deploy to VPS" -> Re-run), or
push any commit. It rsyncs the site to `/var/www/dojobay` and will try to
reload nginx (harmless if that sub-step errors before nginx is configured).
Confirm on the VPS that `/var/www/dojobay/index.html` and
`/var/www/dojobay/data/dojos.json` exist. Note that `data/history.json` is
never synced by the workflow: the server owns the reliability history and a
deploy can never wipe it.

### 4. nginx on localhost + the Tor hidden service

1. Install the onion nginx config (it listens only on `127.0.0.1:8080`):

   ```
   cp /var/www/dojobay/deploy/nginx-onion.conf.example /etc/nginx/sites-available/dojobay
   ln -s /etc/nginx/sites-available/dojobay /etc/nginx/sites-enabled/
   rm -f /etc/nginx/sites-enabled/default
   nginx -t && systemctl reload nginx
   curl -s http://127.0.0.1:8080/ | head -3    # should print the page's HTML
   ```

2. Mine a vanity address (do this on a trusted local machine, NOT the VPS,
   since it produces the secret key that is the onion identity). The tool is
   Cathugger's `mkp224o`; a 7-character prefix like `dojobay` typically takes
   from a few minutes to a couple of hours depending on core count, because
   each extra base32 character multiplies the search space by 32:

   ```
   sudo apt install -y git gcc libsodium-dev make autoconf
   git clone https://github.com/cathugger/mkp224o.git && cd mkp224o
   ./autogen.sh && ./configure && make
   ./mkp224o dojobay -d ~/dojobay-onion -s -n 1
   ```

   It writes a folder named for the full address under `~/dojobay-onion/`
   containing `hs_ed25519_secret_key`, `hs_ed25519_public_key` and `hostname`:
   exactly the three files Tor expects in a `HiddenServiceDir`. Copy that folder
   to the VPS with `scp` (never paste the key into a commit or chat), keep one
   offline backup, then install it and point Tor at it:

   ```
   # on the VPS, as root — adjust the source path to your mined folder
   install -d -m 700 -o debian-tor -g debian-tor /var/lib/tor/dojobay
   install -m 600 -o debian-tor -g debian-tor dojobay*/hs_ed25519_secret_key /var/lib/tor/dojobay/
   install -m 600 -o debian-tor -g debian-tor dojobay*/hs_ed25519_public_key /var/lib/tor/dojobay/
   install -m 600 -o debian-tor -g debian-tor dojobay*/hostname               /var/lib/tor/dojobay/
   printf '\nHiddenServiceDir /var/lib/tor/dojobay/\nHiddenServicePort 80 127.0.0.1:8080\n' >> /etc/tor/torrc
   systemctl reload tor
   cat /var/lib/tor/dojobay/hostname       # -> your mined dojobay...onion
   ```

   On Debian the Tor daemon runs as `debian-tor` (some distributions use `tor`);
   the directory must be `700` and the keys `600` owned by that user or Tor
   refuses to load the service. Whoever holds `hs_ed25519_secret_key` controls
   the address, so guard the offline backup accordingly.

   Fallback (no vanity address): skip the mining and let Tor generate a random
   address by writing only the two `torrc` lines above, then reading
   `cat /var/lib/tor/dojobay/hostname`.

3. Optionally set `ONION_URL` in `assets/js/app.js` to your
   `http://youraddress.onion/` and push, if you want the header pill shown
   during the test.

### 5. The updater timer

The systemd units arrived with the deploy; wire them up:

```
cp /var/www/dojobay/scripts/dojobay-update.service /etc/systemd/system/
cp /var/www/dojobay/scripts/dojobay-update.timer   /etc/systemd/system/
sed -i 's#WorkingDirectory=.*#WorkingDirectory=/var/www/dojobay#; s/^User=.*/User=deploy/; s/^Group=.*/Group=deploy/' /etc/systemd/system/dojobay-update.service
systemctl daemon-reload
systemctl enable --now dojobay-update.timer
systemctl start dojobay-update.service     # run one probe cycle immediately
journalctl -u dojobay-update.service -n 40 # per-node UP/DOWN, timing, reason
```

The first run rewrites every node's `status` and `checked_at` and appends the
first point to each reliability strip.

### 6. Verify over Tor

From your own machine:

```
torsocks curl -s http://yourNEWaddress.onion/data/dojos.json | head
```

and open `http://yourNEWaddress.onion/` in Tor Browser. Check that the cards
render, the mainnet/testnet toggle works, pairing details open with the QR and
copy buttons, and `generated_at` in the JSON advances every 10 minutes. Two
Tor Browser behaviours are expected rather than bugs: the site needs JavaScript,
so the "Safest" security level shows a static notice instead of the directory
(Standard and Safer are fine), and Tor Browser disables service workers, so the
PWA/offline layer simply doesn't activate there.

### 7. What to watch during the week

- `journalctl -u dojobay-update.service -f` during a cycle: per-node latency
  and failure reasons (`timeout`, `SOCKS host unreachable`, `read-timeout`).
- The reliability strips fill left-to-right and represent a full 12 hours
  (72 checks) after the first half-day; judge flappiness only after that.
- Compare a node the site calls Inactive against a manual probe
  (`torsocks curl -s -o /dev/null -w '%{http_code}' http://NODEADDR.onion/v2`)
  to confirm the checker isn't producing false negatives. If slow-but-alive
  nodes flap, raise `TIMEOUT_MS` (or lower `CONCURRENCY`) via `Environment=`
  lines in the service unit.
- Confirm a `git push` deploys cleanly and that `data/history.json` on the
  server survives it.

## Self-service submission (step 2 feature — NOT part of the step 1 onion test)

The static site above is unchanged and ships with the submission feature dormant:
the "Manage my Dojo" nav button only appears if a backend answers `/api/me`, so
your step 1 onion-only deployment behaves exactly as before with nothing extra
running. Everything in this section is for step 2, once the project is under the
GitHub organisation on the operator's VPS.

### What it does

Operators log in with **Auth47** (they scan a challenge QR with Samourai or
Ashigaru, which signs it with their payment code's notification key; the server
verifies the proof with `@samouraiwallet/auth47`). Once authenticated they get a
"Manage my Dojo" panel to submit or edit one record per network: jurisdiction,
hardware, the pairing code, and an optional signed pairing message. Two gates
apply on every create and on any edit that changes the pairing details:

1. **Connection gate** — the server runs the same Tor `probe()` the updater uses
   against the pairing code's `.onion`, and refuses to save unless it answers.
2. **Signature gate** — if a signed message is supplied, it is verified with
   `@samouraiwallet/bitcoinjs-message` against the notification address of the
   authenticated payment code, over the exact pairing JSON submitted (the same
   check as the paymentcode.io lab). A payload signed by a different code, or a
   tampered one, is rejected.

On submission the server resolves the operator's registered **PayNym** from
paynym.rs (over Tor, best-effort: if paynym.rs is unreachable the record simply
carries no PayNym until it can be resolved, and nothing blocks). Passing both
gates puts the record in a **moderation queue** (`status: pending`). A maintainer
approves it with `admin.mjs` (which fills the PayNym if it is still unset, or
takes an explicit override), and `build-public.mjs` merges the curated list
(`data/seed.json`) with approved records into the public `data/dojos.json` that
the site and the 10-minute updater consume. Under this model `data/dojos.json`
is a generated artifact owned by the server and excluded from the deploy, while
`data/seed.json` is the version-controlled curated list; the deploy regenerates
`dojos.json` from the freshly-synced seed on every push. Deliberate design
point: a passing connection check proves reachability, not honesty, so nothing
goes live without a human approving it.

For onion-only enablement on a live box, follow `README-stage2.md`.

### Files

```
server/
  index.mjs         HTTP API (Auth47 login + gated submit/edit), binds 127.0.0.1
  crypto.mjs        Auth47 + BIP47 signed-payload verification
  paynym.mjs        paynym.rs lookup (Tor-routed, best-effort)
  probe.mjs         re-exports the updater's Tor probe (one source of truth)
  store.mjs         atomic JSON store (submissions, sessions, nonces)
  admin.mjs         maintainer CLI: list / approve / reject / remove
  build-public.mjs  merge approved submissions -> data/dojos.json
  selftest.mjs      offline end-to-end test (mock proxy + simulated wallet)
  package.json
scripts/dojobay-server.service   systemd unit
data/seed.json      (optional) the curated node list maintainers control
```

### Enabling it (step 2)

1. Install deps and run the offline test:

   ```
   cd /var/www/dojobay/server
   npm ci
   npm test        # 9 checks: Auth47 login, both gates, moderation, publish
   ```

2. Set the backend's public origin and start it (BASE_URL must be your onion,
   as Auth47 signs it into the challenge):

   ```
   sudo cp scripts/dojobay-server.service /etc/systemd/system/
   sudo sed -i 's#YOURONIONADDRESS.onion#your-real-address.onion#' /etc/systemd/system/dojobay-server.service
   sudo systemctl daemon-reload && sudo systemctl enable --now dojobay-server
   ```

3. Uncomment the `location /api/` block in your nginx config (both samples
   include it) and reload nginx. The "Manage my Dojo" button now appears.

4. Moderation flow, run on the server:

   ```
   cd /var/www/dojobay/server
   node admin.mjs list
   node admin.mjs approve <id>              # PayNym auto-resolved from paynym.rs
   node admin.mjs approve <id> +override    # or set it explicitly
   node build-public.mjs                    # updater picks up status within 10 min
   ```

### Security note

This turns a static onion into an authenticated, state-mutating service. It runs
as the unprivileged deploy user bound to localhost, uses httpOnly SameSite
session cookies, single-use 5-minute Auth47 nonces, and caps request bodies, but
you are now running code that writes to disk in response to network input. Keep
`server/` on the maintainer-controlled production box (step 2), not on the
throwaway step 1 test box, and review `server/data/store.json` periodically.
