// Prova de l'app de recepció en Chromium, com si fos el mòbil de la recepcionista:
//  - Navegador A: càmera falsa que mostra un QR real (mateix format d'URL que el doGet) → verd, i després vermell.
//  - Navegador B: sense càmera: foto del QR, cerca manual, mode sense connexió i sincronització.
//  - Mode demostració i pàgina de codis de prova.
// L'Apps Script és el REAL (apps-script/Codi.gs) executat a Node amb fulls simulats.
//   node tests/recepcio/app.test.cjs     (captures a tests/recepcio/captures/)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const qrcode = require("../../recepcio/vendor/qrcode-generator-1.4.4.js");
const { crearBackend } = require("./harness.cjs");

const ARREL = path.join(__dirname, "../../recepcio");
const CAPTURES = path.join(__dirname, "captures");
const API = "https://script.google.com/macros/s/PROVA/exec";
const CODI = "entrejoves26";
const urlQR = (nom, dni, numero, tipus) =>
  `https://script.google.com/macros/s/ANTIC/exec?${new URLSearchParams({ nom, dni, numero, tipusAsistencia: tipus })}`;

const P1 = ["aya@example.com", "Aya El Idrissi", "11111111H", "600000001", "Pensió completa"];
const P2 = ["bilal@example.com", "Bilal Chakir", "22222222J", "600000002", "Només dissabte"];
const P3 = ["salma@example.com", "Salma Haddad", "33333333P", "600000003", "Pensió completa"];
const P4 = ["nour@example.com", "Nour Bennani", "55555555K", "600000005", "Pensió completa"];

// --- Utilitats ------------------------------------------------------------------------
function servidor() {
  const tipus = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
  const s = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(ARREL, p);
    if (!f.startsWith(ARREL) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": tipus[path.extname(f)] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(0, () => r(s)));
}

function matriuQR(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q;
}

// Vídeo Y4M (el format que Chrome accepta com a càmera falsa) amb un QR al mig.
function videoAmbQR(text, fitxer) {
  const W = 640, H = 480;
  const q = matriuQR(text);
  const n = q.getModuleCount();
  const escala = Math.floor(360 / (n + 8));
  const mida = escala * (n + 8);
  const x0 = Math.floor((W - mida) / 2), y0 = Math.floor((H - mida) / 2);
  const Y = Buffer.alloc(W * H, 60); // fons gris fosc, com una taula
  for (let y = 0; y < mida; y++) {
    for (let x = 0; x < mida; x++) {
      const mx = Math.floor(x / escala) - 4, my = Math.floor(y / escala) - 4;
      const negre = mx >= 0 && my >= 0 && mx < n && my < n && q.isDark(my, mx);
      Y[(y0 + y) * W + x0 + x] = negre ? 16 : 235;
    }
  }
  const UV = Buffer.alloc((W / 2) * (H / 2), 128);
  fs.writeFileSync(fitxer, Buffer.concat([
    Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), Buffer.from("FRAME\n"), Y, UV, UV,
  ]));
}

// PNG en blanc i negre d'un QR (per a "Fer una foto del QR")
function pngQR(text) {
  const { deflateSync } = require("node:zlib");
  const q = matriuQR(text);
  const n = q.getModuleCount(), e = 8, m = (n + 8) * e;
  const raw = Buffer.alloc(m * (m + 1), 255);
  for (let y = 0; y < m; y++) {
    raw[y * (m + 1)] = 0;
    for (let x = 0; x < m; x++) {
      const mx = Math.floor(x / e) - 4, my = Math.floor(y / e) - 4;
      if (mx >= 0 && my >= 0 && mx < n && my < n && q.isDark(my, mx)) raw[y * (m + 1) + 1 + x] = 0;
    }
  }
  const crcT = Array.from({ length: 256 }, (_, k) => { let c = k; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(m, 0); ihdr.writeUInt32BE(m, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function obrir(navegador, base, backend, errors) {
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "ca-ES", timezoneId: "Europe/Madrid", serviceWorkers: "block", permissions: ["camera"] });
  const estat = { offline: false };
  // La configuració de prova apunta a l'Apps Script simulat (el camp de l'adreça queda amagat, com en producció).
  await ctx.route(`${base}/config.js`, (route) => route.fulfill({
    contentType: "text/javascript",
    body: `window.RECEPCIO = { API_URL: "${API}", ESDEVENIMENT: "XVII Congrés Islàmic de Catalunya" };`,
  }));
  await ctx.route(`${API}*`, async (route) => {
    if (estat.offline) return route.abort("internetdisconnected");
    const req = route.request();
    assert.equal(req.method(), "POST");
    assert.match(req.headers()["content-type"], /^text\/plain/, "sense preflight CORS");
    route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: backend.peticio(req.postData()) });
  });
  await ctx.route(/googleusercontent\.com|drive\.google\.com/, (route) => route.abort());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  return { ctx, page, estat };
}

async function entrar(page, codi) {
  assert.equal(await page.locator("#camp-api").isVisible(), false, "amb API_URL configurada no es demana l'adreça");
  await page.fill("#codi", codi);
  await page.getByRole("button", { name: "Entrar" }).click();
}

// --- Proves -------------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(CAPTURES, { recursive: true });
  const srv = await servidor();
  const base = `http://localhost:${srv.address().port}`;
  const errors = [];
  const backend = crearBackend({
    codi: CODI,
    pagats: [P1, P2, P3, P4],
    assistencia: [[new Date(Date.now() - 50 * 60e3), P3[1], P3[2], P3[3], P3[4]]], // registrada amb el doGet antic
  });

  // ============ A: càmera falsa amb el QR de l'Aya ============
  const video = path.join(CAPTURES, "camera.y4m");
  videoAmbQR(urlQR(P1[1], P1[2], P1[3], P1[4]), video);
  const navA = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${video}`] });
  const A = await obrir(navA, base, backend, errors);

  await A.page.getByRole("heading", { name: "Recepció" }).waitFor();
  await A.page.locator(".logo-gran.sense-imatge .logo-text").waitFor(); // sense logo, es veu el nom
  await A.page.screenshot({ path: path.join(CAPTURES, "01-inici.png") });
  await entrar(A.page, "dolent");
  await A.page.getByText("Codi d'accés incorrecte.").waitFor();
  await A.page.fill("#codi", CODI);
  await A.page.getByRole("button", { name: "Entrar" }).click();

  // La càmera veu el QR → verd
  await A.page.locator("#resultat.ok").waitFor({ timeout: 15000 });
  assert.equal(await A.page.locator("#res-titol").textContent(), "Pot passar");
  assert.equal(await A.page.locator("#res-nom").textContent(), "Aya El Idrissi");
  assert.equal(await A.page.locator("#res-tipus").textContent(), "Pensió completa");
  assert.equal(await A.page.locator("#res-dni").textContent(), "11111111H");
  await A.page.screenshot({ path: path.join(CAPTURES, "03-verd.png") });
  const fila = backend.fulls["Assistència"].files.at(-1);
  assert.deepEqual(fila.slice(1), ["Aya El Idrissi", "11111111H", "600000001", "Pensió completa"]);
  assert.equal(fila.length, 5, "només A–E");
  console.log("✓ càmera: llegeix el QR del doGet, verd i registre al full");

  // Es tanca sol, i en tornar a llegir el mateix QR → vermell
  // El verd NO es tanca sol: es queda fins que es prem el botó
  await A.page.waitForTimeout(4000);
  assert.ok(await A.page.locator("#resultat.ok").isVisible(), "el resultat es queda a la pantalla");
  await A.page.getByRole("button", { name: "Escanejar el següent" }).click();
  await A.page.locator("#resultat").waitFor({ state: "hidden" });
  await A.page.screenshot({ path: path.join(CAPTURES, "02-escaner.png") });
  await A.page.locator("#resultat.ko").waitFor({ timeout: 15000 });
  assert.equal(await A.page.locator("#res-titol").textContent(), "No pot passar");
  assert.equal(await A.page.locator("#res-motiu").textContent(), "Aquesta entrada ja s'ha utilitzat");
  assert.equal(await A.page.locator("#res-hora-etiqueta").textContent(), "Ja va entrar");
  assert.match(await A.page.locator("#res-hora").textContent(), /^\d\d:\d\d$/);
  await A.page.screenshot({ path: path.join(CAPTURES, "04-vermell-repetit.png") });
  assert.equal(backend.fulls["Assistència"].files.length, 4, "no es duplica");
  assert.equal(await A.page.locator("#n-registrats").textContent(), "2");
  assert.equal(await A.page.locator("#n-pagats").textContent(), "4");
  console.log("✓ càmera: el resultat es queda fins al botó; el mateix QR després → vermell amb l'hora");
  await navA.close();

  // ============ B: sense càmera ============
  const navB = await chromium.launch();
  const B = await obrir(navB, base, backend, errors);
  await entrar(B.page, CODI);
  await B.page.locator("#visor-error").waitFor();

  // Foto d'un QR d'algú que no ha pagat
  await B.page.setInputFiles("#foto-qr", { name: "qr.png", mimeType: "image/png", buffer: pngQR(urlQR("Karim Sabri", "77777777B", "600000009", "Pensió completa")) });
  await B.page.locator("#resultat.ko").waitFor();
  assert.match(await B.page.locator("#res-motiu").textContent(), /No consta a la llista de pagaments/);
  assert.equal(await B.page.locator("#res-dni").textContent(), "77777777B");
  await B.page.screenshot({ path: path.join(CAPTURES, "05-vermell-no-pagat.png") });
  await B.page.locator("#res-seguent").click();

  // QR que no és una entrada
  await B.page.setInputFiles("#foto-qr", { name: "qr.png", mimeType: "image/png", buffer: pngQR("https://www.instagram.com/entrejoves.ucidcat/") });
  await B.page.locator("#resultat.ko").waitFor();
  assert.equal(await B.page.locator("#res-titol").textContent(), "Codi no vàlid");
  await B.page.locator("#res-seguent").click();
  console.log("✓ foto del QR: no pagat i codi no vàlid");

  // Cerca manual
  await B.page.getByRole("button", { name: "Cercar" }).click();
  await B.page.fill("#cerca-text", "bilal");
  await B.page.getByRole("button", { name: "Registrar l'entrada" }).click();
  await B.page.screenshot({ path: path.join(CAPTURES, "06-cerca.png") });
  await B.page.getByRole("button", { name: "Sí, registrar" }).click();
  await B.page.locator("#resultat.ok").waitFor();
  assert.equal(await B.page.locator("#res-nom").textContent(), "Bilal Chakir");
  assert.equal(backend.fulls["Assistència"].files.at(-1)[1], "Bilal Chakir");
  await B.page.locator("#res-seguent").click();
  await B.page.getByRole("button", { name: "Cercar" }).click();
  await B.page.fill("#cerca-text", "salma");
  await B.page.getByText(/Ja entrat \d\d:\d\d/).waitFor();
  await B.page.locator("#dlg-cerca [data-tancar]").click();
  console.log("✓ cerca manual i persona ja entrada amb el sistema antic");

  // Sense connexió
  B.estat.offline = true;
  await B.page.setInputFiles("#foto-qr", { name: "qr.png", mimeType: "image/png", buffer: pngQR(urlQR(P4[1], P4[2], P4[3], P4[4])) });
  await B.page.locator("#resultat.ok").waitFor({ timeout: 15000 });
  assert.ok(await B.page.locator("#res-offline").isVisible(), "avisa que és sense connexió");
  await B.page.screenshot({ path: path.join(CAPTURES, "07-verd-sense-connexio.png") });
  await B.page.locator("#res-seguent").click();
  assert.match(await B.page.locator("#estat-text").textContent(), /Sense connexió · 1/);
  const filesAbans = backend.fulls["Assistència"].files.length;

  B.estat.offline = false;
  await B.page.locator("#estat-xarxa").click();
  await B.page.waitForFunction(() => document.getElementById("estat-text").textContent === "En línia", null, { timeout: 15000 });
  assert.equal(backend.fulls["Assistència"].files.length, filesAbans + 1);
  assert.deepEqual(backend.fulls["Assistència"].files.at(-1).slice(1), ["Nour Bennani", "55555555K", "600000005", "Pensió completa"]);
  console.log("✓ sense connexió: valida amb la llista i envia el registre quan torna la xarxa");

  await B.page.getByRole("button", { name: "Historial" }).click();
  assert.equal(await B.page.locator("#historial li").count(), 4);
  await B.page.screenshot({ path: path.join(CAPTURES, "08-historial.png") });
  await B.page.locator("#dlg-historial [data-tancar]").click();
  await navB.close();

  // ============ C: mode demostració ============
  const navC = await chromium.launch();
  const ctxC = await navC.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "ca-ES", serviceWorkers: "block" });
  const C = await ctxC.newPage();
  C.on("pageerror", (e) => errors.push(e.message));
  await C.goto(`${base}/`);
  await C.getByRole("button", { name: "Provar-ho amb dades de prova" }).click();
  await C.locator("#avis-demo").waitFor();
  await C.waitForFunction(() => document.getElementById("n-pagats").textContent === "8");
  await C.getByRole("button", { name: "Opcions" }).click();
  await C.getByRole("link", { name: "Obrir" }).click();
  await C.getByRole("heading", { name: "Codis de prova" }).waitFor();
  await C.screenshot({ path: path.join(CAPTURES, "09-codis-prova.png"), fullPage: false });
  await C.locator(".codi", { hasText: "Aya El Idrissi" }).getByRole("button").click();
  await C.locator("#resultat.ok").waitFor({ timeout: 10000 });
  console.log("✓ mode demostració i codis de prova");
  await navC.close();

  assert.deepEqual(errors, [], `errors de JavaScript: ${errors.join(" | ")}`);
  fs.rmSync(video);
  srv.close();
  console.log("OK: l'app de recepció funciona de principi a fi");
}

main().catch((e) => { console.error(e); process.exit(1); });
