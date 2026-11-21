// Service worker: lets the app install on the home screen, open offline with the last copy,
// and show the reminders the sync job sends.
const CACHE = "tawaqoat-v1";
const SHELL = ["./", "index.html", "app.js", "core.js", "fb.js", "config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "badge-72.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Always try the network first so updates show up right away; fall back to the saved copy offline.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith(".mjs")) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === "basic") {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))));
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "دوري التوقعات", {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "badge-72.png",
    tag: d.tag || "tawaqoat",
    renotify: true,
    lang: "ar",
    dir: "rtl",
    data: { url: d.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    if (open) {
      open.postMessage({ type: "open", url: target });
      return open.focus();
    }
    return self.clients.openWindow(target);
  }));
});
