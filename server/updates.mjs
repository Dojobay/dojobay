// How far behind is this instance? Compares the local data/version.json
// commit against the GitHub repository, over Tor (TLS through the same SOCKS
// tunnel the probes use), and reports commits behind plus releases published
// since this instance was built. Consumed by GET /api/admin/updates for the
// admin console's update line. Everything degrades gracefully: if GitHub is
// unreachable over Tor, the endpoint says so rather than failing the panel.
//
// "Releases behind" counts releases published after this build's timestamp,
// which is an approximation (it needs no tag-ancestry walking and no extra
// API calls) but an honest one: a release published after your build is a
// release you don't have.
import tls from "node:tls";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { socks5Connect } from "../scripts/update.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB_REPO = process.env.GITHUB_REPO || "Dojobay/dojobay";
const API_HOST = "api.github.com";

// One HTTPS GET to api.github.com through the Tor SOCKS proxy. HTTP/1.1 with
// Connection: close; handles both content-length and chunked replies.
export async function githubGet(apiPath, { proxyHost, proxyPort, timeoutMs = 30000 } = {}) {
  const raw = await socks5Connect(proxyHost, proxyPort, API_HOST, 443, timeoutMs);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, timeoutMs);
    const socket = tls.connect({ socket: raw, servername: API_HOST }, () => {
      socket.write(
        `GET ${apiPath} HTTP/1.1\r\nHost: ${API_HOST}\r\nUser-Agent: dojobay-update-check\r\n` +
        `Accept: application/vnd.github+json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
    });
    const chunks = [];
    socket.on("data", (d) => chunks.push(d));
    socket.on("error", (e) => { clearTimeout(timer); reject(e); });
    socket.on("close", () => {
      clearTimeout(timer);
      try {
        const all = Buffer.concat(chunks).toString("latin1");
        const m = all.match(/^HTTP\/1\.[01] (\d{3})/);
        const i = all.indexOf("\r\n\r\n");
        if (!m || i < 0) return reject(new Error("malformed reply"));
        const head = all.slice(0, i).toLowerCase();
        let body = all.slice(i + 4);
        if (/transfer-encoding:\s*chunked/.test(head)) {
          let out = "", rest = body;
          for (;;) {
            const nl = rest.indexOf("\r\n");
            if (nl < 0) break;
            const size = parseInt(rest.slice(0, nl), 16);
            if (!size) break;
            out += rest.slice(nl + 2, nl + 2 + size);
            rest = rest.slice(nl + 2 + size + 2);
          }
          body = out;
        }
        resolve({ status: +m[1], body: Buffer.from(body, "latin1").toString("utf8") });
      } catch (e) { reject(e); }
    });
  });
}

export async function checkUpdates({ repo = GITHUB_REPO, transport = githubGet, cfg = {} } = {}) {
  const verPath = path.join(process.env.PUBLIC_DATA_DIR || path.join(ROOT, "data"), "version.json");
  const version = JSON.parse(await readFile(verPath, "utf8"));
  if (!version.commit || version.commit === "dev") throw new Error("local version.json has no deployed commit");

  const cmp = await transport(`/repos/${repo}/compare/${encodeURIComponent(version.commit)}...main`, cfg);
  if (cmp.status !== 200) throw new Error(`compare: HTTP ${cmp.status}`);
  const compare = JSON.parse(cmp.body);

  const rel = await transport(`/repos/${repo}/releases?per_page=30`, cfg);
  if (rel.status !== 200) throw new Error(`releases: HTTP ${rel.status}`);
  const releases = JSON.parse(rel.body);
  const builtAt = Date.parse(version.built || 0) || 0;
  const releasesBehind = releases.filter((r) => Date.parse(r.published_at || 0) > builtAt).length;

  return {
    commit: version.commit,
    built: version.built || null,
    commits_behind: compare.ahead_by ?? 0,        // main is ahead of us by this many
    status: compare.status || "unknown",           // identical | behind | ahead | diverged
    latest_release: releases[0] ? releases[0].tag_name : null,
    releases_behind: releasesBehind,
    repo,
    checked_at: new Date().toISOString(),
  };
}
