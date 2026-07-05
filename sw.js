// The Dojo Bay — service worker.
// Strategy:
//   * app shell (html, css, js, fonts, icons, content) is precached and served
//     cache-first, so the installed PWA opens instantly and works offline;
//   * live data (data/*.json) and the Markdown text (content/*.md) are fetched
//     network-first so a connected client always sees the latest snapshot,
//     falling back to cache when offline.
// Bump CACHE when you ship new assets to retire the old cache.
const CACHE = "dojobay-v1";

const SHELL = [
  "./",
  "index.html",
  "assets/css/styles.css",
  "assets/js/app.js",
  "assets/js/markdown.js",
  "assets/js/qrcode.js",
  "assets/fonts/archivo.woff2",
  "assets/fonts/hanken-grotesk.woff2",
  "assets/fonts/jetbrains-mono.woff2",
  "favicon.svg",
  "manifest.json",
  "assets/icons/192x192.png",
  "assets/icons/512x512.png",
  "content/about.md",
  "content/faq.md",
  "content/disclaimer.md",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // ignore cross-origin

  const fresh = url.pathname.includes("/data/") || url.pathname.endsWith(".md");

  if (fresh) {
    // network-first: keep status/history and text current, fall back offline
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req))
    );
  } else {
    // cache-first for the static shell
    e.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
      )
    );
  }
});
