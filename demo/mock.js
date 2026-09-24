// DEMO: simula Supabase (base de datos, login y funciones) dentro del navegador.
// Se incluye al final de config.js SOLO en la versión demo (scripts/build-demo.mjs). La app de verdad
// no lo carga nunca. Los datos viven en localStorage de este navegador; no se cobra ni se envía nada.
(() => {
  "use strict";

  const SCRIPT = document.currentScript;
  const BASE = new URL(".", SCRIPT ? SCRIPT.src : location.href).href; // raíz de la web (donde está config.js)
  const API = "https://demo.supabase.invalid";
  const DB_KEY = "demo-db-v1";
  const DEMO_USER = { email: "puerta@demo.es", password: "demo1234" };
  const ORG_ID = "0de70000-0000-4000-8000-00000000000a";
  const PAY = { bizum_phone: "600 123 456", iban: "ES00 1234 5678 9012 3456 7890", holder: "Mi Sala Eventos S.L." };

  window.APP_CONFIG = {
    SUPABASE_URL: API,
    SUPABASE_ANON_KEY: "demo-anon",
    BRAND: "Mi Sala",
    ORGANIZER: "Mi Sala Eventos S.L.",
    RETENTION_DAYS: 30,
    TIME_ZONE: "Europe/Madrid",
    DEMO: true,
    DEMO_BASE: BASE,
  };

  // ---------------------------------------------------------------------------
  // Datos de ejemplo
  // ---------------------------------------------------------------------------
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
  const iso = (d) => new Date(d).toISOString();
  const H = 3600e3;

  function nextSaturday(hour, minute, weeksAhead = 0) {
    const d = new Date();
    d.setDate(d.getDate() + (((6 - d.getDay() + 7) % 7) || 7) + weeksAhead * 7);
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  function seed() {
    const now = Date.now();
    const E1 = "0de7e001-0000-4000-8000-000000000001";
    const E2 = "0de7e002-0000-4000-8000-000000000002";
    const events = [
      { id: E1, slug: "fiesta-otono", name: "Fiesta de Otoño", venue: "Sala Principal, Madrid", starts_at: iso(nextSaturday(22, 0)),
        price_cents: 1500, currency: "eur", capacity: 200, min_age: 18, collect_birth_date: true, published: true, sales_open: true },
      { id: E2, slug: "concierto-acustico", name: "Concierto acústico", venue: "Café Teatro, Madrid", starts_at: iso(nextSaturday(20, 30, 2)),
        price_cents: 1000, currency: "eur", capacity: 80, min_age: null, collect_birth_date: false, published: true, sales_open: true },
    ];
    const people = [
      ["0de70001-0000-4000-8000-000000000001", E1, "Ana López García", "ana@example.com", "1995-03-10", null, "QH4T7M"],
      ["0de70002-0000-4000-8000-000000000002", E1, "Luis Martín", "luis@example.com", "2000-07-01", null, "ZR8K2P"],
      ["0de70003-0000-4000-8000-000000000003", E1, "Eva Núñez", "eva@example.com", "1988-12-24", iso(now - H), "M3XW9A"],
      ["0de70004-0000-4000-8000-000000000004", E1, "Pablo Ruiz", "pablo@example.com", "1999-01-15", null, "T6NB4C"],
      ["0de70005-0000-4000-8000-000000000005", E1, "Carmen Díaz", "carmen@example.com", "1992-06-30", null, "J2VF8D"],
      ["0de70006-0000-4000-8000-000000000006", E1, "Jorge Sanz", "jorge@example.com", "1985-11-02", iso(now - 0.5 * H), "W7QH3E"],
      ["0de70007-0000-4000-8000-000000000007", E2, "Marta Gil", "marta@example.com", null, null, "R5KD6G"],
    ];
    const orders = [];
    const tickets = [];
    people.forEach(([id, ev, name, email, birth, checked, ref], i) => {
      const orderId = uuid();
      const event = events.find((e) => e.id === ev);
      orders.push({ id: orderId, event_id: ev, reference: ref, status: "paid", payment_method: i % 2 ? "transfer" : "bizum",
        name: null, email: null, birth_date: null, amount_cents: event.price_cents, currency: "eur",
        expires_at: iso(now + 48 * H), paid_at: iso(now - (30 - i) * H), cancelled_at: null, created_at: iso(now - (40 - i) * H) });
      tickets.push({ id, event_id: ev, order_id: orderId, name, email, birth_date: birth, checked_in_at: checked, email_status: "sent" });
    });
    const pending = [
      ["K7M2QX", "Lucía Fernández", "lucia.f@example.com", "1997-04-22", "bizum", now - 2 * H, now + 70 * H],
      ["P4R8TZ", "Daniel Ortega", "dani.ortega@example.com", "1990-09-09", "transfer", now - 20 * H, now + 52 * H],
      ["B9W3NE", "Sara Molina", "sara.m@example.com", "2001-02-14", "bizum", now - 80 * H, now - 8 * H],
    ];
    for (const [ref, name, email, birth, method, created, expires] of pending) {
      orders.push({ id: uuid(), event_id: E1, reference: ref, status: "pending", payment_method: method, name, email, birth_date: birth,
        amount_cents: 1500, currency: "eur", expires_at: iso(expires), paid_at: null, cancelled_at: null, created_at: iso(created) });
    }
    const db = { events, orders, tickets, outbox: [] };
    db.outbox.push(ticketEmail(db, tickets[0], iso(now - 29 * H)));
    return db;
  }

  let memory = null;
  function load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* sin almacenamiento: se usa memoria */ }
    return memory ?? (memory = seed());
  }
  function save(db) {
    memory = db;
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch { /* nada */ }
  }

  function money(cents) {
    return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(cents / 100);
  }

  function ticketEmail(db, t, at = iso(Date.now())) {
    const ev = db.events.find((e) => e.id === t.event_id);
    return { id: uuid(), kind: "ticket", to: t.email, at, subject: `Tu entrada para ${ev.name}`,
      data: { ticket_id: t.id, name: t.name, event_name: ev.name, venue: ev.venue, starts_at: ev.starts_at, event_id: ev.id } };
  }

  // ---------------------------------------------------------------------------
  // Sesión (JWT falso: la demo no verifica firmas)
  // ---------------------------------------------------------------------------
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  function session() {
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const user = { id: ORG_ID, email: DEMO_USER.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: iso(0) };
    return {
      access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: ORG_ID, email: DEMO_USER.email, role: "authenticated", aud: "authenticated", exp })}.demo`,
      token_type: "bearer", expires_in: 12 * 3600, expires_at: exp, refresh_token: "demo-refresh", user,
    };
  }
  const isOrg = (req) => (req.headers.get("Authorization") ?? "").includes(".demo");

  // ---------------------------------------------------------------------------
  // PostgREST mínimo
  // ---------------------------------------------------------------------------
  function filter(rows, params) {
    for (const [col, raw] of params) {
      if (["select", "order", "offset", "limit"].includes(col)) continue;
      const m = raw.match(/^(eq|gte|gt|lte|lt|in)\.(.*)$/);
      if (!m) continue;
      const [, op, val] = m;
      const list = op === "in" ? val.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")) : null;
      rows = rows.filter((r) => {
        const x = r[col] === null || r[col] === undefined ? null : String(r[col]);
        if (op === "eq") return x === val;
        if (op === "in") return list.includes(x);
        if (x === null) return false;
        if (op === "gte") return x >= val;
        if (op === "gt") return x > val;
        if (op === "lte") return x <= val;
        return x < val;
      });
    }
    const order = params.get("order");
    if (order) {
      const [col, dir] = order.split(".");
      rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === "desc" ? -1 : 1));
    }
    const offset = Number(params.get("offset") ?? 0);
    const limit = params.has("limit") ? Number(params.get("limit")) : Infinity;
    return rows.slice(offset, offset + limit);
  }

  function pick(rows, select, extra) {
    if (!select || select === "*") return rows;
    const cols = select.replace(/\w+\([^)]*\)/g, "").split(",").map((c) => c.trim()).filter(Boolean);
    return rows.map((r) => {
      const o = {};
      for (const c of cols) o[c] = r[c] ?? null;
      return extra ? extra(r, o) : o;
    });
  }

  function reply(body, status = 200, single = false) {
    if (single) {
      if (!Array.isArray(body) || body.length !== 1) return json({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, 406);
      body = body[0];
    }
    return json(body, status);
  }
  function json(body, status = 200) {
    return new Response(body === null ? null : JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json", "Content-Range": "0-0/*" },
    });
  }

  async function rest(req, url) {
    const db = load();
    const table = url.pathname.replace("/rest/v1/", "");
    const params = url.searchParams;
    const single = (req.headers.get("Accept") ?? "").includes("vnd.pgrst.object");
    const org = isOrg(req);

    if (table === "rpc/check_in") {
      if (!org) return json({ code: "42501", message: "forbidden" }, 403);
      const { p_ticket_id, p_event_id, p_scanned_at } = await req.json();
      const t = db.tickets.find((x) => x.id === String(p_ticket_id).trim().toLowerCase());
      if (!t) return json({ status: "invalid" });
      if (t.event_id !== p_event_id) return json({ status: "wrong_event", event_name: db.events.find((e) => e.id === t.event_id)?.name });
      if (!t.checked_in_at) {
        const at = p_scanned_at && new Date(p_scanned_at) < new Date() ? p_scanned_at : iso(Date.now());
        t.checked_in_at = at;
        save(db);
        return json({ status: "ok", name: t.name, birth_date: t.birth_date, checked_in_at: at });
      }
      return json({ status: "used", name: t.name, birth_date: t.birth_date, checked_in_at: t.checked_in_at });
    }

    if (req.method !== "GET") return json({ code: "42501", message: "permission denied" }, 403);

    if (table === "events") {
      const rows = db.events.filter((e) => org || e.published);
      return reply(pick(filter(rows, params), params.get("select")), 200, single);
    }
    if (table === "organizers") return reply(org ? pick(filter([{ user_id: ORG_ID }], params), params.get("select")) : [], 200, single);
    if (!org) return reply([], 200, single); // RLS: los anónimos no ven nada
    if (table === "tickets") return reply(pick(filter(db.tickets, params), params.get("select")), 200, single);
    if (table === "orders") {
      const embed = (params.get("select") ?? "").includes("tickets(");
      return reply(pick(filter(db.orders, params), params.get("select"), (r, o) => {
        if (embed) o.tickets = db.tickets.filter((t) => t.order_id === r.id).map((t) => ({ id: t.id, name: t.name, email_status: t.email_status }));
        return o;
      }), 200, single);
    }
    return json({ message: `tabla ${table} no simulada` }, 404);
  }

  // ---------------------------------------------------------------------------
  // Funciones (create-order y manage-order), con las mismas reglas que las de verdad
  // ---------------------------------------------------------------------------
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const newRef = (db) => {
    for (;;) {
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      const ref = [...bytes].map((b) => ALPHABET[b % 32]).join("");
      if (!db.orders.some((o) => o.reference === ref)) return ref;
    }
  };
  const taken = (db, eventId) => db.tickets.filter((t) => t.event_id === eventId).length
    + db.orders.filter((o) => o.event_id === eventId && o.status === "pending" && new Date(o.expires_at) > new Date()).length;

  async function createOrder(req) {
    const b = await req.json();
    const db = load();
    const name = String(b.name ?? "").trim().replace(/\s+/g, " ");
    const email = String(b.email ?? "").trim().toLowerCase();
    if (b.website) return json({ error: "Petición no válida." }, 400);
    if (b.consent !== true) return json({ error: "Debes aceptar la política de privacidad." }, 422);
    if (name.length < 2) return json({ error: "Escribe tu nombre y apellidos." }, 422);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "El email no es válido." }, 422);
    if (b.payment_method !== "bizum" && b.payment_method !== "transfer") return json({ error: "Elige cómo vas a pagar." }, 422);
    const ev = db.events.find((e) => e.slug === b.event_slug && e.published && e.sales_open);
    if (!ev) return json({ error: "La venta de este evento no está abierta." }, 409);
    if (ev.collect_birth_date && !b.birth_date) return json({ error: "Indica tu fecha de nacimiento." }, 422);
    if (ev.min_age) {
      const s = new Date(ev.starts_at), bd = new Date(`${b.birth_date}T00:00:00`);
      let age = s.getFullYear() - bd.getFullYear();
      if (s.getMonth() < bd.getMonth() || (s.getMonth() === bd.getMonth() && s.getDate() < bd.getDate())) age--;
      if (age < ev.min_age) return json({ error: "No cumples la edad mínima para este evento." }, 422);
    }
    let order = db.orders.find((o) => o.event_id === ev.id && o.email === email && o.status === "pending" && new Date(o.expires_at) > new Date());
    if (!order) {
      if (taken(db, ev.id) >= ev.capacity) return json({ error: "Lo sentimos, las entradas están agotadas." }, 409);
      order = { id: uuid(), event_id: ev.id, reference: newRef(db), status: "pending", payment_method: b.payment_method, name, email,
        birth_date: ev.collect_birth_date ? b.birth_date : null, amount_cents: ev.price_cents, currency: ev.currency,
        expires_at: iso(Date.now() + 72 * H), paid_at: null, cancelled_at: null, created_at: iso(Date.now()) };
      db.orders.push(order);
      db.outbox.push({ id: uuid(), kind: "order", to: email, at: iso(Date.now()), subject: `Pedido ${order.reference}: cómo pagar tu entrada para ${ev.name}`,
        data: { reference: order.reference, name, event_name: ev.name, amount: money(order.amount_cents), method: order.payment_method, expires_at: order.expires_at, ...PAY } });
      save(db);
    }
    return json({ reference: order.reference, payment_method: order.payment_method, amount: money(order.amount_cents), event_name: ev.name,
      email, expires_at: order.expires_at, ...PAY });
  }

  async function manageOrder(req) {
    if (!isOrg(req)) return json({ error: "Inicia sesión como organizador." }, 401);
    const b = await req.json();
    const db = load();
    if (b.action === "confirm" || b.action === "cancel") {
      const o = db.orders.find((x) => x.id === b.order_id);
      if (!o) return json({ error: "Este pedido no existe." }, 404);
      if (b.action === "cancel") {
        const ok = o.status === "pending";
        if (ok) Object.assign(o, { status: "cancelled", cancelled_at: iso(Date.now()), name: null, email: null, birth_date: null });
        save(db);
        return json({ cancelled: ok });
      }
      if (o.status === "paid") {
        const t = db.tickets.find((x) => x.order_id === o.id);
        return json({ ticket_id: t.id, created: false, email_status: t.email_status });
      }
      if (o.status === "cancelled") return json({ error: "Este pedido está cancelado." }, 409);
      if (new Date(o.expires_at) <= new Date()) {
        const ev = db.events.find((e) => e.id === o.event_id);
        if (taken(db, o.event_id) >= ev.capacity) return json({ error: "La reserva había caducado y ya no queda aforo." }, 409);
      }
      const t = { id: uuid(), event_id: o.event_id, order_id: o.id, name: o.name, email: o.email, birth_date: o.birth_date,
        checked_in_at: null, email_status: "sent" };
      db.tickets.push(t);
      Object.assign(o, { status: "paid", paid_at: iso(Date.now()), name: null, email: null, birth_date: null });
      db.outbox.push(ticketEmail(db, t));
      save(db);
      return json({ ticket_id: t.id, created: true, email_status: "sent" });
    }
    if (b.action === "resend") {
      const t = db.tickets.find((x) => x.id === b.ticket_id);
      if (!t) return json({ error: "Esta entrada no existe o ya se anonimizó." }, 404);
      if (b.email) t.email = String(b.email).trim().toLowerCase();
      t.email_status = "sent";
      db.outbox.push(ticketEmail(db, t));
      save(db);
      return json({ email_status: "sent" });
    }
    return json({ error: "Acción no válida." }, 400);
  }

  // ---------------------------------------------------------------------------
  // Interceptar fetch
  // ---------------------------------------------------------------------------
  const realFetch = window.fetch.bind(window);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function handle(req) {
    const url = new URL(req.url);
    await wait(200 + Math.random() * 200); // que se note que "va al servidor"
    if (url.pathname === "/auth/v1/token") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        const b = await req.json();
        if (String(b.email).trim().toLowerCase() !== DEMO_USER.email || b.password !== DEMO_USER.password) {
          return json({ error: "invalid_grant", error_description: "Invalid login credentials", code: "invalid_credentials" }, 400);
        }
      }
      return json(session());
    }
    if (url.pathname === "/auth/v1/user") return isOrg(req) ? json(session().user) : json({ message: "no session" }, 401);
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    if (url.pathname.startsWith("/rest/v1/")) return rest(req, url);
    if (url.pathname === "/functions/v1/create-order") return createOrder(req);
    if (url.pathname === "/functions/v1/manage-order") return manageOrder(req);
    return json({ message: "no simulado" }, 404);
  }

  window.fetch = (input, init) => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    if (!req.url.startsWith(API)) return realFetch(input, init);
    if (init?.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return handle(req);
  };

  // ---------------------------------------------------------------------------
  // Ayudas para la demo: barra superior, login rellenado, "Probar en la puerta"
  // ---------------------------------------------------------------------------
  const DEMO = window.DEMO = {
    base: BASE,
    db: load,
    save,
    reset() {
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith("demo-") || k.startsWith("checkin-")) localStorage.removeItem(k);
      } catch { /* nada */ }
      memory = null;
      try { indexedDB.deleteDatabase("checkin"); } catch { /* nada */ }
    },
    // Deja la sesión del organizador y el evento preparados y abre la puerta escaneando esa entrada.
    tryAtDoor(ticketId, eventId) {
      const db = load();
      const ev = db.events.find((e) => e.id === eventId);
      try {
        localStorage.setItem("checkin-auth", JSON.stringify(session()));
        localStorage.setItem("checkin-organizer", ORG_ID);
        localStorage.setItem("checkin-email", DEMO_USER.email);
        if (ev) localStorage.setItem("checkin-event", JSON.stringify({ id: ev.id, name: ev.name, venue: ev.venue, starts_at: ev.starts_at }));
        localStorage.setItem("demo-scan", ticketId);
      } catch { /* nada */ }
      location.href = new URL("checkin/index.html", BASE).href;
    },
  };

  window.DEMO_HOOKS = {
    checkinReady(scan, isReady) {
      let code = null;
      try { code = localStorage.getItem("demo-scan"); localStorage.removeItem("demo-scan"); } catch { /* nada */ }
      if (!code) return;
      const started = Date.now();
      const tick = () => {
        if (isReady()) return setTimeout(() => scan(code), 600);
        if (Date.now() - started < 15000) setTimeout(tick, 200);
      };
      tick();
    },
  };

  function banner() {
    const link = (href, text) => `<a href="${new URL(href, BASE).href}" style="color:#F4EFE6;text-decoration:underline;text-underline-offset:3px;white-space:nowrap">${text}</a>`;
    const n = load().outbox.length;
    const bar = document.createElement("div");
    bar.setAttribute("role", "note");
    bar.style.cssText = "position:relative;z-index:5;background:#2B3A8C;color:#F4EFE6;font:600 13px/1.4 system-ui,-apple-system,sans-serif;padding:10px 16px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center";
    bar.innerHTML = `<span style="background:#F4EFE6;color:#2B3A8C;border-radius:6px;padding:2px 8px;letter-spacing:.08em">DEMO</span>`
      + `<span style="font-weight:500">Datos de ejemplo: no se cobra ni se envían emails.</span>`
      + `<span style="display:flex;flex-wrap:wrap;gap:6px 14px">`
      + link("../", "Inicio") + link("index.html", "Comprar") + link("admin/index.html", "Pagos")
      + link("checkin/index.html", "Puerta") + link("demo/buzon.html", `Buzón (${n})`) + link("demo/entradas.html", "QR de ejemplo")
      + `<button type="button" id="demo-reset" style="font:inherit;color:#F4EFE6;background:transparent;border:1px solid #F4EFE6;border-radius:6px;padding:2px 8px;cursor:pointer">Reiniciar demo</button>`
      + `</span>`;
    document.body.prepend(bar);
    bar.querySelector("#demo-reset").addEventListener("click", () => { DEMO.reset(); location.reload(); });
  }

  function prefillLogin() {
    const email = document.getElementById("login-email");
    const pass = document.getElementById("login-password");
    if (!email || !pass) return;
    email.value = DEMO_USER.email;
    pass.value = DEMO_USER.password;
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = `Demo: usuario ${DEMO_USER.email} y contraseña ${DEMO_USER.password} ya rellenados. Pulsa «Entrar».`;
    email.closest("form")?.prepend(hint);
  }

  document.addEventListener("DOMContentLoaded", () => { banner(); prefillLogin(); });
})();
