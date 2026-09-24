// Recorre la demo (dist/demo) en Chromium como lo haría una persona: reservar, confirmar el pago,
// abrir el buzón y validar en la puerta. Antes: node scripts/build-demo.mjs
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const DIST = path.join(__dirname, "../../dist/demo");
const SHOTS = path.join(__dirname, "screenshots");

function serve() {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(DIST, p);
    if (!file.startsWith(DIST) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "es-ES", timezoneId: "Europe/Madrid", serviceWorkers: "block" });
  // Sin acceso a internet en las pruebas: los CDN se sirven con las copias del repositorio.
  const CDN = {
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/dist/umd/supabase.js": "web/checkin/vendor/supabase-2.117.1.js",
    "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js": "web/checkin/vendor/jsQR-1.4.0.js",
    "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js": "demo/vendor/qrcode-generator-1.4.4.js",
  };
  await context.route("https://cdn.jsdelivr.net/**", (route) => {
    const local = CDN[route.request().url()];
    if (!local) return route.abort();
    route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(__dirname, "../..", local)) });
  });
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ contentType: "text/css", body: "" }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/getUserMedia|camera|NotFound|Requested device/i.test(m.text())) errors.push(m.text()); });

  // Portada
  await page.goto(`${base}/`);
  await page.getByRole("heading", { name: "Entradas QR" }).waitFor();
  await page.screenshot({ path: path.join(SHOTS, "demo-00-portada.png"), fullPage: true });

  // 1. Reservar
  await page.getByRole("link", { name: "Abrir la página de compra" }).click();
  await page.getByRole("heading", { name: "Fiesta de Otoño" }).waitFor();
  assert.ok(await page.getByText("DEMO").first().isVisible(), "barra de demo visible");
  await page.fill("#name", "Irene Prueba");
  await page.fill("#email", "irene@example.com");
  await page.fill("#birth_date", "1996-04-02");
  await page.check("#consent");
  await page.screenshot({ path: path.join(SHOTS, "demo-01-compra.png"), fullPage: true });
  await page.locator("#pay").click();
  await page.getByRole("heading", { name: "¡Plaza reservada!" }).waitFor();
  const ref = (await page.locator("#done-ref").textContent()).trim();
  assert.match(ref, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(await page.locator("#done-dest").textContent(), "600 123 456");
  await page.screenshot({ path: path.join(SHOTS, "demo-02-reservada.png"), fullPage: true });
  console.log(`✓ reserva hecha, referencia ${ref}`);

  // 2. Confirmar el pago en el panel
  await page.getByRole("link", { name: "Pagos" }).click();
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.locator(".order-ref", { hasText: ref }).waitFor();
  assert.equal(await page.locator("#count-pending").textContent(), "4");
  await page.screenshot({ path: path.join(SHOTS, "demo-03-pagos.png"), fullPage: true });
  const card = page.locator(".order", { has: page.locator(".order-ref", { hasText: ref }) });
  await card.getByRole("button", { name: "Confirmar pago" }).click();
  await card.getByText(`con el concepto ${ref}`).waitFor();
  await page.screenshot({ path: path.join(SHOTS, "demo-04-confirmar.png") });
  await card.getByRole("button", { name: "Sí, enviar la entrada" }).click();
  await page.getByText(`Pago de ${ref} confirmado. Entrada enviada a irene@example.com.`).waitFor();
  await page.waitForFunction(() => document.getElementById("count-pending").textContent === "3");
  console.log("✓ pago confirmado en el panel");

  // 3. Buzón
  await page.getByRole("link", { name: /Buzón/ }).click();
  await page.getByText("Tu entrada para Fiesta de Otoño").first().waitFor();
  const first = page.locator("details.mail").first();
  assert.match(await first.textContent(), /Para: irene@example.com/);
  assert.ok(await first.locator("img.qr").isVisible());
  await page.screenshot({ path: path.join(SHOTS, "demo-05-buzon.png"), fullPage: true });
  console.log("✓ email con la entrada en el buzón");

  // 4. Puerta: verde y después rojo
  await first.getByRole("button", { name: "Probar en la puerta" }).click();
  await page.locator("#result.ok").waitFor({ timeout: 15000 });
  assert.equal(await page.locator("#result-name").textContent(), "Irene Prueba");
  await page.screenshot({ path: path.join(SHOTS, "demo-06-verde.png") });
  await page.locator("#result-next").click();

  await page.getByRole("link", { name: /Buzón/ }).click();
  await page.locator("details.mail").first().getByRole("button", { name: "Probar en la puerta" }).click();
  await page.locator("#result.used").waitFor({ timeout: 15000 });
  assert.equal(await page.locator("#result-title").textContent(), "Entrada ya utilizada");
  await page.screenshot({ path: path.join(SHOTS, "demo-07-rojo.png") });
  await page.locator("#result-next").click();

  // QR falso
  await page.getByRole("link", { name: "QR de ejemplo" }).click();
  await page.locator(".qr-card", { hasText: "QR falso" }).getByRole("button").click();
  await page.locator("#result.invalid").waitFor({ timeout: 15000 });
  assert.equal(await page.locator("#result-title").textContent(), "Entrada no válida");
  await page.locator("#result-next").click();
  await page.screenshot({ path: path.join(SHOTS, "demo-08-puerta.png") });
  console.log("✓ puerta: verde, ya utilizada y no válida");

  // Reiniciar
  await page.getByRole("button", { name: "Reiniciar demo" }).click();
  await page.waitForLoadState("load");

  assert.deepEqual(errors, [], `errores: ${errors.join(" | ")}`);
  await browser.close();
  server.close();
  console.log("OK: la demo funciona de principio a fin");
}

main().catch((e) => { console.error(e); process.exit(1); });
