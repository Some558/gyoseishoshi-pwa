const CACHE = 'gyoseishoshi-v7';
const ASSETS = ['./index.html', './manifest.json', './heic2any.min.js', './client.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // AIへの問い合わせ系はキャッシュを一切通さない(素通りさせてブラウザ既定の動作にする)
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  if (url.hostname === 'api.anthropic.com') return;
  // ローカルゲートウェイの疎通確認と API パス
  if (url.pathname === '/healthz' || url.pathname.startsWith('/v1/')) return;

  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
