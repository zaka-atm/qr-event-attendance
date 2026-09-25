// Guarda l'app perquè s'obri encara que no hi hagi cobertura a l'entrada.
// Les consultes a l'Apps Script no es guarden mai aquí (les dades offline les gestiona app.js).
// Puja VERSIO cada vegada que canviïs algun fitxer de la llista.
const VERSIO = "recepcio-v10";
const FITXERS = [
  "./",
  "./app.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./vendor/jsQR-1.4.0.js",
  "./fonts/plus-jakarta-sans.woff2",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSIO).then((c) => c.addAll(FITXERS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((claus) => Promise.all(claus.filter((k) => k !== VERSIO).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Pàgines: primer la xarxa (màx. 3 s) i, si no, la còpia guardada.
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      const cache = await caches.open(VERSIO);
      try {
        const res = await Promise.race([fetch(req), new Promise((_, ko) => setTimeout(() => ko(new Error("temps")), 3000))]);
        if (res.ok && !res.redirected && url.pathname.endsWith("/")) cache.put("./", res.clone());
        return res;
      } catch {
        return (await cache.match(req)) ?? (await cache.match("./")) ?? Response.error();
      }
    })());
    return;
  }

  // La resta: la còpia guardada a l'instant i actualització en segon pla.
  e.respondWith((async () => {
    const cache = await caches.open(VERSIO);
    const guardat = await cache.match(req);
    const xarxa = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => undefined);
    return guardat ?? (await xarxa) ?? Response.error();
  })());
});
