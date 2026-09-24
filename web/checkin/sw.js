// Service worker de la app de la puerta: guarda la "carcasa" de la app para que abra sin conexión.
// Las llamadas a Supabase NUNCA se cachean aquí (los datos offline van en IndexedDB, desde app.js).
// Sube VERSION cada vez que cambies alguno de los archivos de SHELL.
const VERSION = "checkin-v1";
const SHELL = [
  "./",
  "./checkin.css",
  "./app.js",
  "./manifest.webmanifest",
  "./vendor/supabase-2.117.1.js",
  "./vendor/jsQR-1.4.0.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "../config.js",
  "../assets/fonts/bricolage-grotesque.woff2",
  "../assets/fonts/instrument-sans.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Página: red primero (máx. 3 s), si no la copia guardada.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await Promise.race([
          fetch(req),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
        ]);
        if (res.ok && !res.redirected) cache.put("./", res.clone());
        return res;
      } catch {
        return (await cache.match("./")) ?? Response.error();
      }
    })());
    return;
  }

  // Resto de archivos: la copia guardada al instante y actualización en segundo plano.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => undefined);
    return cached ?? (await network) ?? Response.error();
  })());
});
