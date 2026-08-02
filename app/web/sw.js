/* 離線閱讀 Service Worker。
 * 快取策略:
 *   - shell(html/css/pwa.js):stale-while-revalidate,自動跟上新版
 *   - vendor:cache-first;換 vendor 檔或改 precache 清單時,手動 bump CACHE_VERSION
 *   - GET api/* 與 course-view/*:network-first(4s timeout),斷線時退快取
 *   - 非 GET(進度/批改/助教 SSE):完全不攔,原生走網路
 * 路徑一律相對 scope,根路徑與 /learning/ 子路徑部署都適用。
 */
'use strict';

const CACHE_VERSION = 'v6';
const STATIC_CACHE = 'learning-static-' + CACHE_VERSION;
const CONTENT_CACHE = 'learning-content';

const SHELL = [
  './', 'index.html', 'reader.html', 'style.css', 'pwa.js',
  'manifest.json', 'icon.svg', 'apple-touch-icon.png',
];
const KATEX_FONTS = [
  'KaTeX_AMS-Regular', 'KaTeX_Caligraphic-Bold', 'KaTeX_Caligraphic-Regular',
  'KaTeX_Fraktur-Bold', 'KaTeX_Fraktur-Regular', 'KaTeX_Main-Bold',
  'KaTeX_Main-BoldItalic', 'KaTeX_Main-Italic', 'KaTeX_Main-Regular',
  'KaTeX_Math-BoldItalic', 'KaTeX_Math-Italic', 'KaTeX_SansSerif-Bold',
  'KaTeX_SansSerif-Italic', 'KaTeX_SansSerif-Regular', 'KaTeX_Script-Regular',
  'KaTeX_Size1-Regular', 'KaTeX_Size2-Regular', 'KaTeX_Size3-Regular',
  'KaTeX_Size4-Regular', 'KaTeX_Typewriter-Regular',
];
const VENDOR = [
  'vendor/cytoscape.min.js',
  'vendor/markdown-it.min.js',
  'vendor/highlight.min.js',
  'vendor/highlight-github-dark.min.css',
  'vendor/mermaid.min.js',
  'vendor/katex/katex.min.js',
  'vendor/katex/katex.min.css',
  'vendor/katex/auto-render.min.js',
  ...KATEX_FONTS.map(f => `vendor/katex/fonts/${f}.woff2`),
];
// shell 中走 stale-while-revalidate 的檔(vendor 不在此列,靠版本 bump)
const SWR = new Set(['./', 'index.html', 'reader.html', 'style.css', 'pwa.js']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(c => c.addAll([...SHELL, ...VENDOR]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('learning-static-') && name !== STATIC_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/SSE 直通網路,不經 respondWith
  const scope = self.registration.scope; // 以 '/' 結尾
  if (!req.url.startsWith(scope)) return;
  const rel = req.url.slice(scope.length).split('?')[0];
  if (rel.startsWith('api/') || rel.startsWith('course-view/')) event.respondWith(apiNetworkFirst(req));
  else event.respondWith(staticServe(event, req, rel));
});

async function apiNetworkFirst(req) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(req, { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) {
      const c = await caches.open(CONTENT_CACHE);
      c.put(req, r.clone());
    }
    return r;
  } catch {
    const hit = await caches.match(req);
    if (hit) return withMarker(hit);
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Sw-Cache': 'miss' },
    });
  }
}

// Response headers 不可變,重建一份才能加離線標記
function withMarker(res) {
  const h = new Headers(res.headers);
  h.set('X-Sw-Cache', 'hit');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function staticServe(event, req, rel) {
  const isHTML = req.mode === 'navigate' || rel === '' || rel.endsWith('.html');
  const key = rel === '' ? './' : rel;
  // reader.html?course=… 要命中不帶 query 的快取
  const cached = await caches.match(req, { ignoreSearch: isHTML });
  if (cached) {
    if (SWR.has(key)) event.waitUntil(refreshStatic(req, key));
    return cached;
  }
  const r = await fetch(req);
  if (r.ok) {
    // 順手快取沒列在 precache 的靜態檔(vendor/courses/* lab 資產等)
    const c = await caches.open(CONTENT_CACHE);
    c.put(req, r.clone());
  }
  return r;
}

async function refreshStatic(req, key) {
  try {
    const r = await fetch(req);
    if (r.ok) {
      const c = await caches.open(STATIC_CACHE);
      await c.put(key, r);
    }
  } catch { /* 離線時背景更新失敗屬正常 */ }
}
