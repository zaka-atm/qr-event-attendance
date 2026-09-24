// Pruebas de las funciones create-order y manage-order sin red: Supabase y Resend se simulan
// interceptando fetch. Ejecutar con:  deno test -A tests/functions/

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { decodeBase64 } from "jsr:@std/encoding@1/base64";
import jsQRModule from "npm:jsqr@1.4.0";
import { PNG } from "npm:pngjs@7.0.0";
import { Buffer } from "node:buffer";

// deno-lint-ignore no-explicit-any
const jsQR = ((jsQRModule as any).default ?? jsQRModule) as (
  data: Uint8ClampedArray, width: number, height: number,
) => { data: string } | null;

const SUPABASE_URL = "https://proyecto-falso.supabase.co";
const SERVICE_KEY = "service-role-falsa";
const ORDER_ID = crypto.randomUUID();
const TICKET_ID = crypto.randomUUID();

Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
Deno.env.set("SUPABASE_ANON_KEY", "anon-falsa");
Deno.env.set("SITE_URL", "https://entradas.example.com");
Deno.env.set("RESEND_API_KEY", "re_falsa");
Deno.env.set("EMAIL_FROM", "Entradas <entradas@example.com>");
Deno.env.set("ORGANIZER_NAME", "Organizador de prueba");
Deno.env.set("BIZUM_PHONE", "600 000 000");
Deno.env.set("BANK_IBAN", "ES00 0000 0000 0000 0000 0000");

// --- Supabase y Resend simulados ------------------------------------------------------
const db = { tickets: 0, emailStatus: "pending", ticketEmail: "ana@example.com" };
type Sent = { to: string[]; subject: string; html: string; text: string; key: string; attachments?: Array<{ content: string; content_id: string }> };
const sent: Sent[] = [];
const rpcCalls: Array<{ fn: string; auth: string | null; body: Record<string, unknown> }> = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);

  if (url.origin === SUPABASE_URL) {
    const auth = req.headers.get("Authorization");
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const fn = url.pathname.split("/").pop()!;
      const body = await req.json();
      rpcCalls.push({ fn, auth, body });
      if (fn === "create_order") {
        assertEquals(auth, `Bearer ${SERVICE_KEY}`, "create_order se llama con la service role");
        return Response.json({
          order_id: ORDER_ID, reference: "K7M2QX", payment_method: body.p_payment_method,
          amount_cents: 1500, currency: "eur", event_name: "Fiesta <Test>", event_slug: "fiesta",
          email: body.p_email, expires_at: new Date(Date.now() + 72 * 3600e3).toISOString(),
        });
      }
      // Las funciones de organizador se ejecutan con el token del usuario que llama
      if (auth !== "Bearer token-organizador") {
        return Response.json({ code: "42501", message: "forbidden", details: null, hint: null }, { status: 403 });
      }
      if (fn === "confirm_order") {
        const created = db.tickets === 0;
        if (created) db.tickets = 1;
        return Response.json({ ticket_id: TICKET_ID, created, email_status: db.emailStatus });
      }
      if (fn === "prepare_resend") {
        if (body.p_email) db.ticketEmail = String(body.p_email).toLowerCase();
        db.emailStatus = "pending";
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname === "/rest/v1/tickets" && req.method === "GET") {
      assertEquals(auth, `Bearer ${SERVICE_KEY}`);
      return Response.json({
        id: TICKET_ID, name: "Ana López", email: db.ticketEmail, email_status: db.emailStatus, anonymized_at: null,
        events: { name: "Fiesta <Test>", venue: "Sala X", starts_at: "2026-10-18T20:00:00Z" },
      });
    }
    if (url.pathname === "/rest/v1/tickets" && req.method === "PATCH") {
      db.emailStatus = (await req.json()).email_status;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Llamada inesperada a Supabase: ${req.method} ${url.pathname}`);
  }

  if (url.href === "https://api.resend.com/emails") {
    const key = req.headers.get("Idempotency-Key")!;
    // Resend: la misma clave en 24 h no vuelve a enviar
    if (!sent.some((s) => s.key === key)) sent.push({ ...(await req.json()), key });
    return Response.json({ id: "email" });
  }
  return realFetch(req);
};

// Cada módulo llama a Deno.serve: le damos un puerto distinto a cada uno.
const ports: number[] = [];
const realServe = Deno.serve;
let nextPort = 8790;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (handler: Deno.ServeHandler) => {
  const port = nextPort++;
  ports.push(port);
  return realServe({ port, onListen() {} }, handler);
};
await import("../../supabase/functions/create-order/index.ts");
await import("../../supabase/functions/manage-order/index.ts");
const [CREATE, MANAGE] = ports;

async function call(port: number, body: unknown, token?: string) {
  const res = await realFetch(`http://localhost:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const FORM = {
  event_slug: "fiesta", name: "  Ana   López ", email: "ANA@example.com", birth_date: "1990-05-01",
  payment_method: "bizum", consent: true, website: "",
};

// --- create-order ---------------------------------------------------------------------
Deno.test("create-order: sin consentimiento o sin método de pago no se reserva nada", async () => {
  assertEquals((await call(CREATE, { ...FORM, consent: false })).status, 422);
  assertEquals((await call(CREATE, { ...FORM, payment_method: "paypal" })).status, 422);
  assertEquals((await call(CREATE, { ...FORM, website: "http://spam" })).status, 400);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("create-order: reserva y devuelve/envía las instrucciones de pago", async () => {
  const r = await call(CREATE, FORM);
  assertEquals(r.status, 200);
  assertEquals(r.body.reference, "K7M2QX");
  assertEquals(r.body.bizum_phone, "600 000 000");
  assertMatch(r.body.amount, /15,00/);
  assertEquals(rpcCalls[0].body.p_name, "Ana López", "nombre normalizado");
  assertEquals(rpcCalls[0].body.p_email, "ana@example.com");

  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, ["ana@example.com"]);
  assert(sent[0].html.includes("K7M2QX"));
  assert(sent[0].html.includes("600 000 000"));
  assert(sent[0].html.includes("Fiesta &lt;Test&gt;"), "HTML escapado");
});

// --- manage-order -----------------------------------------------------------------------
Deno.test("manage-order: sin sesión o sin ser organizador no se confirma nada", async () => {
  assertEquals((await call(MANAGE, { action: "confirm", order_id: ORDER_ID })).status, 401);
  const r = await call(MANAGE, { action: "confirm", order_id: ORDER_ID }, "token-intruso");
  assertEquals(r.status, 403);
  assertEquals(db.tickets, 0);
});

Deno.test("manage-order: confirmar dos veces => una entrada y un email con el QR", async () => {
  const r1 = await call(MANAGE, { action: "confirm", order_id: ORDER_ID }, "token-organizador");
  const r2 = await call(MANAGE, { action: "confirm", order_id: ORDER_ID }, "token-organizador");
  assertEquals(r1.body, { ticket_id: TICKET_ID, created: true, email_status: "sent" });
  assertEquals(r2.body.created, false);
  assertEquals(r2.body.email_status, "sent");

  const tickets = sent.filter((s) => s.attachments?.length);
  assertEquals(tickets.length, 1, "no se manda un segundo email");
  const png = PNG.sync.read(Buffer.from(decodeBase64(tickets[0].attachments![0].content)));
  assertEquals(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data, TICKET_ID, "el QR contiene SOLO el ID");
});

Deno.test("manage-order: reenviar la entrada a un email corregido", async () => {
  const r = await call(MANAGE, { action: "resend", ticket_id: TICKET_ID, email: "ana.bien@example.com" }, "token-organizador");
  assertEquals(r.body.email_status, "sent");
  const tickets = sent.filter((s) => s.attachments?.length);
  assertEquals(tickets.length, 2);
  assertEquals(tickets[1].to, ["ana.bien@example.com"]);
});
