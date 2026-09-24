// Prueba en navegador real (Chromium) de la página de compra y de la PWA de la puerta.
// Supabase se simula interceptando las peticiones, así que no hace falta ningún proyecto real.
//   npm install && npm run test:e2e
// Guarda capturas en tests/e2e/screenshots/.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const WEB = path.join(__dirname, "../../web");
const SHOTS = path.join(__dirname, "screenshots");
const MOCK = "https://mock.supabase.co";
const EVENT = { id: "11111111-1111-4111-8111-111111111111", name: "Fiesta de Otoño", venue: "Sala Principal", starts_at: new Date(Date.now() + 3600e3).toISOString() };
const ORG = { id: "00000000-0000-4000-8000-00000000000a", email: "puerta@example.com" };

const T_ANA = "a1b2c3d4-0000-4000-8000-000000000001";
const T_LUIS = "b2c3d4e5-0000-4000-8000-000000000002";
const T_EVA = "c3d4e5f6-0000-4000-8000-000000000003";

// ---------------------------------------------------------------------------
function serve() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(WEB, p);
    if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.firma`;
}

// Servidor Supabase simulado con la misma lógica que check_in() en SQL.
function mockSupabase() {
  const db = {
    tickets: new Map([
      [T_ANA, { id: T_ANA, name: "Ana López", birth_date: "1995-03-10", checked_in_at: null }],
      [T_LUIS, { id: T_LUIS, name: "Luis Martín", birth_date: "2000-07-01", checked_in_at: null }],
      [T_EVA, { id: T_EVA, name: "Eva Núñez", birth_date: "1988-12-24", checked_in_at: new Date(Date.now() - 600e3).toISOString() }],
    ]),
    offline: false,
    orderBodies: [],
    manageCalls: [],
    orders: [
      { id: "0f000000-0000-4000-8000-000000000001", event_id: EVENT.id, reference: "K7M2QX", status: "pending", payment_method: "bizum",
        name: "Lucía Fernández", email: "lucia@example.com", amount_cents: 1500, currency: "eur",
        expires_at: new Date(Date.now() + 48 * 3600e3).toISOString(), paid_at: null, created_at: new Date(Date.now() - 3600e3).toISOString(), tickets: [] },
      { id: "0f000000-0000-4000-8000-000000000002", event_id: EVENT.id, reference: "ZR8K2P", status: "paid", payment_method: "transfer",
        name: null, email: null, amount_cents: 1500, currency: "eur", expires_at: new Date().toISOString(),
        paid_at: new Date(Date.now() - 7200e3).toISOString(), created_at: new Date(Date.now() - 9000e3).toISOString(),
        tickets: [{ id: T_LUIS, name: "Luis Martín", email_status: "failed" }] },
    ],
  };

  async function handle(route) {
    if (db.offline) return route.abort("internetdisconnected");
    const req = route.request();
    const url = new URL(req.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname === "/auth/v1/token") {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      return json({
        access_token: jwt({ sub: ORG.id, email: ORG.email, role: "authenticated", exp, aud: "authenticated" }),
        token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "refresh",
        user: { id: ORG.id, email: ORG.email, aud: "authenticated", role: "authenticated" },
      });
    }
    if (url.pathname === "/auth/v1/logout") return route.fulfill({ status: 204 });
    if (url.pathname === "/rest/v1/organizers") return json([{ user_id: ORG.id }]);
    if (url.pathname === "/rest/v1/events") {
      // Página de compra (anon) y lista de eventos de la puerta
      return json([{ ...EVENT, slug: "fiesta-otono", price_cents: 1500, currency: "eur", min_age: 18, collect_birth_date: true, sales_open: true }]);
    }
    if (url.pathname === "/rest/v1/tickets") return json([...db.tickets.values()]);
    if (url.pathname === "/rest/v1/rpc/check_in") {
      const { p_ticket_id, p_event_id, p_scanned_at } = JSON.parse(req.postData());
      assert.equal(p_event_id, EVENT.id);
      const t = db.tickets.get(String(p_ticket_id).toLowerCase());
      if (!t) return json({ status: "invalid" });
      if (!t.checked_in_at) {
        t.checked_in_at = p_scanned_at ?? new Date().toISOString();
        return json({ status: "ok", name: t.name, birth_date: t.birth_date, checked_in_at: t.checked_in_at });
      }
      return json({ status: "used", name: t.name, birth_date: t.birth_date, checked_in_at: t.checked_in_at });
    }
    if (url.pathname === "/rest/v1/orders") return json(db.orders.filter((o) => ["pending", "paid"].includes(o.status)));
    if (url.pathname === "/functions/v1/create-order") {
      const body = JSON.parse(req.postData());
      db.orderBodies.push(body);
      if (body.name === "Agotado") return json({ error: "Lo sentimos, las entradas están agotadas." }, 409);
      return json({ reference: "Q4M8TZ", payment_method: body.payment_method, amount: "15,00 €", event_name: EVENT.name, email: body.email,
        expires_at: new Date(Date.now() + 72 * 3600e3).toISOString(), bizum_phone: "600 000 000", iban: "ES00 1111 2222 3333 4444 5555", holder: "Mi Sala S.L." });
    }
    if (url.pathname === "/functions/v1/manage-order") {
      assert.match(req.headers()["authorization"] ?? "", /^Bearer ey/, "manage-order lleva el token del organizador");
      const body = JSON.parse(req.postData());
      db.manageCalls.push(body);
      const o = db.orders.find((x) => x.id === body.order_id);
      if (body.action === "confirm") { o.status = "paid"; o.paid_at = new Date().toISOString(); o.tickets = [{ id: "t-new", name: o.name, email_status: "sent" }]; return json({ ticket_id: "t-new", created: true, email_status: "sent" }); }
      if (body.action === "resend") return json({ email_status: "sent" });
      return json({ cancelled: true });
    }
    throw new Error(`Petición no simulada: ${req.method()} ${url.pathname}`);
  }
  return { db, handle };
}

// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const mock = mockSupabase();

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "es-ES", timezoneId: "Europe/Madrid", serviceWorkers: "block" });
  await context.route(`${base}/config.js`, (route) => route.fulfill({
    contentType: "text/javascript",
    body: `window.APP_CONFIG = { SUPABASE_URL: "${MOCK}", SUPABASE_ANON_KEY: "anon", BRAND: "Mi Sala", ORGANIZER: "Mi Sala S.L.", RETENTION_DAYS: 30, TIME_ZONE: "Europe/Madrid" };`,
  }));
  await context.route(`${MOCK}/**`, mock.handle);

  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));

  // ---- Página de compra ------------------------------------------------------
  await page.goto(`${base}/`);
  await page.getByRole("heading", { name: "Fiesta de Otoño" }).waitFor();
  assert.match(await page.locator("#pay").textContent(), /Reservar · 15,00/);
  await page.screenshot({ path: path.join(SHOTS, "01-compra.png"), fullPage: true });

  await page.locator("#pay").click();
  assert.equal(await page.locator("#form-error").textContent(), "Escribe tu nombre y apellidos.");

  await page.fill("#name", "Agotado");
  await page.fill("#email", "a@example.com");
  await page.fill("#birth_date", "1990-01-01");
  await page.locator("#pay").click();
  assert.equal(await page.locator("#form-error").textContent(), "Debes aceptar la política de privacidad para continuar.");
  await page.check("#consent");
  await page.locator("#pay").click();
  await page.getByText("Lo sentimos, las entradas están agotadas.").waitFor();

  await page.fill("#name", "Ana López");
  await page.check("#pm-transfer");
  await page.locator("#pay").click();
  await page.getByRole("heading", { name: "¡Plaza reservada!" }).waitFor();
  assert.equal(await page.locator("#done-ref").textContent(), "Q4M8TZ");
  assert.equal(await page.locator("#done-dest").textContent(), "ES00 1111 2222 3333 4444 5555");
  assert.ok(await page.locator("#done-holder-row").isVisible(), "la transferencia muestra el titular");
  const sent = mock.db.orderBodies.at(-1);
  assert.deepEqual(sent, { event_slug: "fiesta-otono", name: "Ana López", email: "a@example.com", birth_date: "1990-01-01", payment_method: "transfer", consent: true, website: "" });
  await page.screenshot({ path: path.join(SHOTS, "01b-reservada.png"), fullPage: true });
  console.log("✓ compra: validación, consentimiento, error de aforo e instrucciones de pago");

  // ---- PWA de la puerta: login y evento --------------------------------------
  await page.goto(`${base}/checkin/`);
  await page.fill("#login-email", ORG.email);
  await page.fill("#login-password", "secreto");
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.getByRole("button", { name: /Fiesta de Otoño/ }).click();
  await page.locator("#screen-scan").waitFor();
  await page.waitForFunction(() => document.getElementById("stat-total").textContent === "3");
  assert.equal(await page.locator("#stat-in").textContent(), "1");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, "02-escaner.png") });
  console.log("✓ puerta: login de organizador, evento y lista descargada");

  async function manual(query, pick) {
    await page.getByRole("button", { name: "Buscar / código" }).click();
    await page.fill("#manual-input", query);
    await page.locator("#manual-results button").filter({ hasText: pick }).first().click();
    await page.locator("#result").waitFor({ state: "visible" });
  }
  async function next() {
    await page.locator("#result-next").click();
    await page.locator("#result").waitFor({ state: "hidden" });
  }

  // Verde
  await manual("ana", "Ana López");
  assert.equal(await page.locator("#result-title").textContent(), "¡Bienvenido!");
  assert.equal(await page.locator("#result-name").textContent(), "Ana López");
  assert.match(await page.locator("#result-chip").textContent(), /^\d+ años$/);
  assert.ok(await page.locator("#result").evaluate((el) => el.classList.contains("ok")));
  await page.screenshot({ path: path.join(SHOTS, "03-verde.png") });
  await next();

  // Rojo: ya utilizada (búsqueda por código corto)
  await manual("A1B2C3D4", "Ana López");
  assert.equal(await page.locator("#result-title").textContent(), "Entrada ya utilizada");
  assert.match(await page.locator("#result-time-value").textContent(), /^\d{2}:\d{2}$/);
  await page.screenshot({ path: path.join(SHOTS, "04-rojo-usada.png") });
  await next();

  // Rojo: no válida (UUID que no existe)
  await page.getByRole("button", { name: "Buscar / código" }).click();
  await page.fill("#manual-input", "99999999-0000-4000-8000-000000000999");
  await page.locator("#manual-results button").first().click();
  await page.locator("#result").waitFor({ state: "visible" });
  assert.equal(await page.locator("#result-title").textContent(), "Entrada no válida");
  await page.screenshot({ path: path.join(SHOTS, "05-rojo-no-valida.png") });
  await next();
  console.log("✓ puerta: pantallas verde, «ya utilizada» y «no válida»");

  // ---- Sin conexión ------------------------------------------------------------
  mock.db.offline = true;
  await manual("luis", "Luis Martín");
  assert.equal(await page.locator("#result-title").textContent(), "¡Bienvenido!");
  assert.ok(await page.locator("#result-offline").isVisible());
  await page.screenshot({ path: path.join(SHOTS, "06-verde-sin-conexion.png") });
  await next();
  assert.match(await page.locator("#net-text").textContent(), /Sin conexión · 1 pendientes/);

  // La misma entrada otra vez, aún sin conexión: la lista local ya la tiene como usada
  await manual("luis", "Luis Martín");
  assert.equal(await page.locator("#result-title").textContent(), "Entrada ya utilizada");
  await next();

  // Mientras tanto otra puerta (con conexión) validó a Eva... ya estaba dentro. Simulamos un conflicto real:
  // añadimos una entrada que otra puerta valida en el servidor mientras esta la valida offline.
  const T_NEW = "d4e5f6a7-0000-4000-8000-000000000004";
  mock.db.tickets.set(T_NEW, { id: T_NEW, name: "Pablo Ruiz", birth_date: "1999-01-01", checked_in_at: null });
  mock.db.offline = false;
  await page.getByRole("button", { name: "Sincronizar" }).click();
  await page.waitForFunction(() => document.getElementById("stat-total").textContent === "4");
  assert.match(await page.locator("#net-text").textContent(), /^En línea$/);
  assert.ok(mock.db.tickets.get(T_LUIS).checked_in_at, "el check-in offline llegó al servidor");

  mock.db.offline = true;
  await manual("pablo", "Pablo Ruiz");
  await next();
  mock.db.tickets.get(T_NEW).checked_in_at = new Date(Date.now() - 60e3).toISOString(); // otra puerta, antes
  mock.db.offline = false;
  await page.getByRole("button", { name: "Sincronizar" }).click();
  await page.locator("#issues-btn").waitFor({ state: "visible" });
  assert.equal(await page.locator("#issues-count").textContent(), "1");
  await page.locator("#issues-btn").click();
  assert.match(await page.locator("#issues-list").textContent(), /Pablo Ruiz .* ya validada a las .* en otra puerta/);
  await page.screenshot({ path: path.join(SHOTS, "07-incidencias.png") });
  await page.getByRole("button", { name: "Cerrar" }).last().click();
  console.log("✓ puerta: validación sin conexión, cola, sincronización e incidencia de doble entrada");

  // ---- Panel de pagos (misma sesión que la puerta) ------------------------------------
  await page.goto(`${base}/admin/`);
  await page.locator(".order-ref", { hasText: "K7M2QX" }).waitFor();
  assert.equal(await page.locator("#count-pending").textContent(), "1");
  await page.getByRole("button", { name: "Confirmar pago" }).click();
  await page.getByText("¿Has recibido un Bizum de 15,00 € con el concepto K7M2QX?").waitFor();
  await page.getByRole("button", { name: "Sí, enviar la entrada" }).click();
  await page.getByText("Pago de K7M2QX confirmado. Entrada enviada a lucia@example.com.").waitFor();
  assert.deepEqual(mock.db.manageCalls[0], { action: "confirm", order_id: "0f000000-0000-4000-8000-000000000001" });
  await page.waitForFunction(() => document.getElementById("count-pending").textContent === "0");

  await page.getByRole("tab", { name: /Pagados/ }).click();
  const luis = page.locator(".order", { hasText: "ZR8K2P" });
  await luis.getByText("El email falló").waitFor();
  await luis.getByRole("button", { name: "Reenviar entrada" }).click();
  await luis.locator("input[type=email]").fill("luis.bien@example.com");
  await page.screenshot({ path: path.join(SHOTS, "08-pagos-reenviar.png"), fullPage: true });
  await luis.getByRole("button", { name: "Reenviar entrada" }).click();
  await page.getByText("Entrada de ZR8K2P reenviada.").waitFor();
  assert.deepEqual(mock.db.manageCalls[1], { action: "resend", ticket_id: T_LUIS, email: "luis.bien@example.com" });
  console.log("✓ pagos: confirmar pago y reenviar entrada a un email corregido");

  assert.deepEqual(errors, [], `errores de JavaScript: ${errors.join(" | ")}`);
  await browser.close();
  server.close();
  console.log("OK: pruebas de navegador superadas");
}

main().catch((e) => { console.error(e); process.exit(1); });
