# The Dojo Bay

An onion-only directory of public Bitcoin **Dojo** nodes for
[Samourai](https://web.archive.org/web/20240424023506/https://samouraiwallet.com/) and
[Ashigaru](https://ashigaru.rs/) wallets.
The reference instance runs at:

```
http://dojobayeryasshgghz537de5ckgd5hhi4z5sdeil3roeh65fwhdnu2yd.onion/
```

Each listed node shows its PayNym and payment code, jurisdiction, hardware,
Dojo version, current block height, a 24-hour reliability strip, a 90-day
daily history, and the pairing payload as a scannable QR with copyable
endpoints (Dojo API, explorer, and Electrum server where one is exposed).
Cards are ordered by measured uptime. Node operators list and manage their
own Dojos by signing in with their PayNym over **Auth47**: no accounts, no
email, no passwords — signing a challenge in the wallet proves control of the
payment code, and submissions pass a live Tor connection check plus a
moderation review before publication.

Everything is served from a Tor hidden service. There is no clearnet aspect:
the web server binds to localhost, only the Tor daemon reaches it, and the
site's outbound probes and PayNym lookups travel over Tor.

This repository is the complete, self-hostable software: anyone with a Debian
or Ubuntu box — including the one already running their node — can operate
their own Dojo Bay.

## How it works

The front end is a static single-page app (plain HTML, CSS and JavaScript, no
build step, no framework) served by nginx behind a Tor hidden service. It
renders entirely from JSON files fetched at load, so the data pipeline and
the presentation never touch.

The node list is generated, not hand-edited. `data/seed.json` is the
instance **anchor**: exactly one node, the instance operator's own Dojo,
which is what guarantees a Dojo Bay is never empty and that whoever runs a
directory also runs a node. Every other listing lives in a server-side store,
created and managed by its operator over Auth47, and `server/build-public.mjs`
merges the anchor with every approved submission into the public
`data/dojos.json`, preserving live statuses. Every listed node carries a
BIP47 payment code — the code is what ownership, sign-in and the card's
payment-code chip all key on. (The reference instance grandfathers one
code-less listing from its pre-Auth47 era as an admin-managed exception; the
build warns about such records, and new ones cannot be created.) A systemd timer runs `scripts/update.mjs` every ten minutes, which
logs into each listed Dojo's API over Tor, reads the chain tip, and maintains
`data/dojos.json` (statuses and block heights), `data/history.json` (the
24-hour check series) and `data/history-daily.json` (90-day daily rollups).
Reliability history is retained under a grace stamp for fourteen days after a
node leaves the list, so a transient mistake never destroys accumulated data.

The backend (`server/index.mjs`, a dependency-light Node service on
localhost, proxied by nginx as `/api/`) handles Auth47 challenges and
sessions, operator submissions and edits, and the moderation console at
`/admin`. Admin rights belong to whichever payment codes the instance
operator sets in the service environment — the same Auth47 sign-in, no
separate credentials.

## Run your own Dojo Bay

Requirements: Debian 12 or Ubuntu 24.04 (or similar), **Node.js 20 or
newer**, `tor`, `nginx`, and `git`. Everything below assumes the site lives
at `/var/www/dojobay`.

1. **Clone and install the backend's dependencies.**

   ```
   sudo git clone https://github.com/Dojobay/dojobay /var/www/dojobay
   cd /var/www/dojobay/server && sudo npm ci --omit=dev
   ```

2. **Create the hidden service.** In `/etc/tor/torrc`:

   ```
   HiddenServiceDir /var/lib/tor/dojobay/
   HiddenServicePort 80 127.0.0.1:8080
   ```

   Restart Tor and read your onion address from
   `/var/lib/tor/dojobay/hostname`.

3. **Configure nginx** from `deploy/nginx-onion.conf.example`. It binds to
   `127.0.0.1:8080` (never a public interface), proxies `/api/` to the
   backend, and returns 404 for everything under `/server/` — that block is
   security-critical, because the submission store (which contains Dojo API
   keys) lives inside the web root.

4. **Install the systemd units** from `scripts/`:
   `dojobay-server.service` (the Auth47 backend — set `BASE_URL` to your
   onion address, since Auth47 challenges embed it and wallets sign exactly
   that string, and set `ADMIN_PAYMENT_CODES` to your own payment code to
   make yourself the moderator), and `dojobay-update.service` plus
   `dojobay-update.timer` (the ten-minute prober). Enable the timer and the
   service.

5. **Seed your anchor and build the list.** Running a Dojo Bay requires
   running a Dojo: put your own node — mainnet or testnet — into
   `data/seed.json` as its single entry, with your PayNym and BIP47 payment
   code (the same code you set in `ADMIN_PAYMENT_CODES`). Then generate the
   public list:

   ```
   node server/build-public.mjs
   ```

   From here the timer keeps statuses and history current, other operators
   list themselves through **Manage my Dojo**, and you approve at `/admin`.
   If you are transitioning an instance that still has an old-style curated
   list in its seed, `scripts/migrate-seed-to-store.mjs --dry-run` shows how
   each entry would move into the operator-managed store.

6. **Prove you operate the site** (optional but recommended). Sign your
   onion URL with your wallet (Tools → Sign message) and place the result in
   `data/operator.json` as `{ "onion", "paymentCode", "verifySigned" }`; the
   footer's **Verify** popup then lets visitors check the signature against
   your PayNym's notification address.

The deploy pipeline in `.github/workflows/deploy.yml` shows how the reference
instance ships updates (rsync over SSH, excluding the VPS-owned data files
and the store, then a rebuild and backend restart); adapt or ignore it — a
`git pull` followed by `node server/build-public.mjs` and a service restart
does the same by hand.

## Data access

All directory data is plain JSON, fetchable from any instance:

- `data/dojos.json` — the current list (also the **JSON ↓** pill in the header)
- `data/history.json` — the rolling 24-hour check series per node
- `data/history-daily.json` — 90 days of daily uptime and closing heights
- `/api/history/export` — both windows merged per node; `?id=<node-id>`
  filters to one node

For example, over Tor:

```
curl -s --socks5-hostname 127.0.0.1:9050 http://<onion>/data/dojos.json \
  | jq '.nodes[] | select(.status=="active") | .name'
```

## Getting listed on the reference instance

Open **Manage my Dojo** in the header, scan the Auth47 challenge with
Samourai or Ashigaru (Settings → Pair wallet → Auth47), and submit your
node's name, details and pairing payload. The server checks the Dojo answers
over Tor before the submission is accepted, and a signed pairing message, if
you provide one, must verify against your payment code's notification
address. Approved listings appear with your PayNym; you can edit the display
fields or remove the listing at any time with the same sign-in.

## Verifying a directory

Any Dojo Bay instance can be verified against its operator: the **Verify**
link in the footer shows a Bitcoin-signed message binding the onion address
to the operator's payment code. Check it with the
[BIP47 Message Verifier](http://ab64uow264ohynkalvlyhdrduwwl75n4urvc2vrbo3xjd4jycygiirqd.onion/lab)
or with **Tools → Verify message** in the wallet.

## Contributing and licence

Development setup, project structure, the test suites and coding conventions
are in [CONTRIBUTING.md](CONTRIBUTING.md). The code is MIT-licensed
([LICENSE](LICENSE)). Listings are not added through pull requests — they go
through the Auth47 flow above.
