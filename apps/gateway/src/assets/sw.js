/* 面板壳缓存 service worker:网关重启窗口内刷新/打开页面→缓存壳+「服务重启中」横幅,
 * 不再裸 ERR_CONNECTION_REFUSED。network-first:在线时永远拿最新面板与资产(缓存只作离线/停机回退,不引陈旧)。
 * 排除:非 GET、跨源、已下线的旧重资产;WS 不经 fetch 不受影响。 */
const CACHE = "gh-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.add(new Request("/", { cache: "reload" })))
      .then(() => self.skipWaiting())
      .catch(() => { /* 首装时服务不可达:下次在线注册时重试 */ })
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const cl = res.clone();
        caches.open(CACHE).then((c) => c.put(req, cl)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match("/")))
  );
});
