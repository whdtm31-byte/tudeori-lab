/* 서비스 워커: 앱 파일을 저장해 두어 인터넷이 없어도 열리게 한다.
   - 같은 출처의 GET 요청만 처리 (Anthropic API 같은 외부 요청은 건드리지 않음)
   - "네트워크 우선": 온라인이면 항상 최신 파일을 받고, 오프라인일 때만 저장본을 쓴다
   - 기록 데이터는 localStorage에 있으므로 여기서 다루지 않는다 */
const CACHE = 'tudeori-v1';
const ASSETS = ['./index.html', './style.css', './app.js', './sim.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 페이지 이동은 ?text=… 같은 쿼리가 달라도 하나의 index.html로 저장/조회
  const key = req.mode === 'navigate' ? new Request(new URL('./index.html', self.location).href) : req;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit || caches.match('./index.html')))
  );
});
