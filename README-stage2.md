# The Dojo Bay: enabling stage 2 (self-service submission), onion-only

This brings the dormant `server/` backend online on your existing VPS, over the
onion only, with no clearnet domain. After this, operators can log in with Auth47
and submit their own Dojo, subject to a live Tor connection check and, if they
supply one, a valid signature, into a moderation queue that you approve before
anything appears.

The site keeps working exactly as now until you complete these steps: the "Manage
my Dojo" button only shows once a backend answers `/api/me`.

## How the data now flows

The curated node list moves to `data/seed.json`, which is version-controlled and
deployed. `data/dojos.json` becomes a generated artifact (seed plus approved
submissions, merged by `server/build-public.mjs`, statuses filled by the updater)
and is now owned by the VPS, excluded from the deploy so a push can never wipe
live status, reliability history, or operator submissions. Operator submissions
live in `server/data/store.json` on the box, also VPS-owned. A push therefore
carries code and the curated `seed.json`; the box regenerates `dojos.json` from
them on every deploy.

## 1. Push the updated repository files

Copy the current files into your local repo and commit them in the ordered
sequence given alongside this run-book (four labelled commits: stage-2
enablement, the paynym.rs onion, the card display changes, and the history
retention change). The stage-2 enablement commit carries the files that make
submissions possible:

- `.github/workflows/deploy.yml` (excludes the VPS-owned `dojos.json`,
  `history.json` and `history-daily.json`; regenerates the list and restarts the
  backend after each deploy)
- `data/seed.json` (your 19 curated nodes; the source of truth for the list)
- `server/build-public.mjs` (merges seed + approved; preserves live status and
  block height when regenerating)
- `server/index.mjs`, `server/paynym.mjs` (submission API, indexer extraction,
  PayNym lookup over the paynym.rs onion)
- `server/package-lock.json` (reproducible `npm ci` on the box)
- `scripts/dojobay-server.service` (BASE_URL preset to your onion)
- `deploy/nginx-onion.conf.example` (the `/api/` proxy block is now live)

Your `app.js` already holds `REPO_URL` and `ONION_URL`, so those are untouched.
After `git push`, the deploy syncs the code and `seed.json`, regenerates
`dojos.json` on the box, and attempts to restart the backend (which harmlessly
no-ops until you install it in step 3). Nothing user-visible changes yet.

## 2. Install the backend dependencies on the VPS

```
cd /var/www/dojobay/server
npm ci
npm test        # 9 checks: Auth47 login, both gates, moderation, publish
```

`npm test` runs entirely offline against a mock proxy and a simulated wallet; all
9 checks should pass before you go further.

## 3. Install and start the backend service

The unit already has `BASE_URL` set to your onion, which Auth47 signs into every
challenge, so it must match the address wallets actually reach.

```
cp /var/www/dojobay/scripts/dojobay-server.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dojobay-server
systemctl status dojobay-server --no-pager
curl -s http://127.0.0.1:8787/api/me      # expect {"authenticated":false}
```

## 4. Let the deploy user restart the backend (extend the sudoers rule)

So future deploys can restart the service to pick up code changes:

```
echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx, /usr/bin/systemctl enable --now dojobay-update.timer, /usr/bin/systemctl restart dojobay-server' > /etc/sudoers.d/dojobay
chmod 440 /etc/sudoers.d/dojobay
visudo -c -f /etc/sudoers.d/dojobay       # expect: parsed OK
```

## 5. Activate the nginx /api/ proxy

The updated onion config already has the `/api/` block live, so reinstall it and
reload:

```
cp /var/www/dojobay/deploy/nginx-onion.conf.example /etc/nginx/sites-available/dojobay
nginx -t && systemctl reload nginx
curl -s http://127.0.0.1:8080/api/me      # expect {"authenticated":false} via nginx
```

## 6. Verify over Tor

Open your onion in Tor Browser (Standard or Safer, not Safest, which blocks JS).
The header now shows "Manage my Dojo". Click it, and an Auth47 challenge QR
appears. Scan it with Samourai or Ashigaru (Settings, then pair by Auth47), which
signs the challenge with your payment code's notification key. Once the wallet
posts the proof, the panel switches to the submission form.

Submit a test Dojo. It must be reachable over Tor at the moment you submit (the
connection gate), and if you paste a signed pairing message it must verify against
your payment code's notification address (the signature gate). On success it lands
as "Pending review".

## 7. Moderate and publish

On the VPS:

```
cd /var/www/dojobay/server
node admin.mjs list
node admin.mjs approve <id>          # PayNym auto-resolved from paynym.rs over Tor
node admin.mjs approve <id> +override # or set the PayNym explicitly
node build-public.mjs                # merge approved into dojos.json
systemctl start dojobay-update.service   # fill its status now rather than waiting
```

`node admin.mjs reject <id>` or `remove <id>` handle the other cases; run
`build-public.mjs` after any change.

## Ongoing maintenance

To edit the curated list, change `data/seed.json` and push: the deploy regenerates
`dojos.json` on the box. To moderate submissions, use `admin.mjs` then
`build-public.mjs` on the VPS. The updater keeps every node's status fresh every
10 minutes regardless of source.

## Security posture

You are now running an authenticated, state-mutating service on the box, so it is
worth being clear about the containment. The backend binds to `127.0.0.1:8787` and
is reachable only through the nginx `/api/` proxy over the onion; it runs as the
unprivileged `deploy` user, not root; sessions are httpOnly SameSite=Strict
cookies with no Secure flag (correct for http onion) and expire after 12 hours;
Auth47 nonces are single-use and expire after 5 minutes; request bodies are capped;
and every submission passes both gates and then waits in a moderation queue that
only you release. The one credential that still sits above all of this is your
MyNymBox account, so keep its 2FA on. Review `server/data/store.json` periodically,
and remember it is never synced, so keep your own backup if the submissions matter.
