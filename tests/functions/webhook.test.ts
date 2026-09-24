// Prueba de extremo a extremo del webhook de Stripe, sin red: Supabase y Resend se simulan
// interceptando fetch. Ejecutar con:  deno test -A tests/functions/webhook.test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { decodeBase64 } from "jsr:@std/encoding@1/base64";
import jsQRModule from "npm:jsqr@1.4.0";
import { PNG } from "npm:pngjs@7.0.0";
import { Buffer } from "node:buffer";

// jsqr es CommonJS: según el entorno la función llega como default o como el propio módulo.
// deno-lint-ignore no-explicit-any
const jsQR = ((jsQRModule as any).default ?? jsQRModule) as (
  data: Uint8ClampedArray, width: number, height: number,
) => { data: string } | null;

const SUPABASE_URL = "https://proyecto-falso.supabase.co";
const WEBHOOK_SECRET = "whsec_test_secret";
const PORT = 8787;
const TICKET_ID = crypto.randomUUID();
const ORDER_ID = crypto.randomUUID();

Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-falsa");
Deno.env.set("STRIPE_SECRET_KEY", "sk_test_falsa");
Deno.env.set("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
Deno.env.set("SITE_URL", "https://entradas.example.com");
Deno.env.set("RESEND_API_KEY", "re_falsa");
Deno.env.set("EMAIL_FROM", "Entradas <entradas@example.com>");
Deno.env.set("ORGANIZER_NAME", "Organizador de prueba");

// --- Estado simulado --------------------------------------------------------------
const db = { tickets: 0, emailStatus: "pending" as string, fulfillCalls: 0 };
const sentEmails: Array<Record<string, unknown>> = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);

  if (url.origin === SUPABASE_URL) {
    if (url.pathname === "/rest/v1/rpc/fulfill_order") {
      db.fulfillCalls++;
      const body = await req.json();
      assertEquals(body.p_order_id, ORDER_ID);
      const created = db.tickets === 0;
      if (created) db.tickets = 1;
      return Response.json({ ticket_id: TICKET_ID, created, email_status: db.emailStatus });
    }
    if (url.pathname === "/rest/v1/tickets" && req.method === "GET") {
      return Response.json({
        id: TICKET_ID, name: "Ana López", email: "ana@example.com", email_status: db.emailStatus,
        anonymized_at: null,
        events: { name: "Fiesta <Test>", venue: "Sala X", starts_at: "2026-10-18T20:00:00Z" },
      });
    }
    if (url.pathname === "/rest/v1/tickets" && req.method === "PATCH") {
      const body = await req.json();
      db.emailStatus = body.email_status;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Llamada inesperada a Supabase: ${req.method} ${url.pathname}`);
  }

  if (url.href === "https://api.resend.com/emails") {
    assert(req.headers.get("Idempotency-Key")?.includes(TICKET_ID));
    sentEmails.push(await req.json());
    return Response.json({ id: "email_1" });
  }

  return realFetch(req);
};

// Deno.serve del módulo escucha en el puerto que indiquemos.
const realServe = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (handler: Deno.ServeHandler) =>
  realServe({ port: PORT, onListen() {} }, handler);

await import("../../supabase/functions/stripe-webhook/index.ts");

function sessionEvent(type: string, paymentStatus = "paid"): string {
  return JSON.stringify({
    id: `evt_${crypto.randomUUID()}`,
    object: "event",
    type,
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        client_reference_id: ORDER_ID,
        metadata: { order_id: ORDER_ID },
        payment_status: paymentStatus,
        payment_intent: "pi_1",
        amount_total: 1500,
      },
    },
  });
}

// Firma igual que Stripe: t=<timestamp>,v1=HMAC-SHA256(secret, "<timestamp>.<payload>")
async function sign(payload: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

async function post(payload: string, signature?: string): Promise<Response> {
  const sig = signature ?? await sign(payload);
  return await realFetch(`http://localhost:${PORT}/`, {
    method: "POST",
    headers: { "stripe-signature": sig, "content-type": "application/json" },
    body: payload,
  });
}

Deno.test("rechaza una firma no válida sin tocar la base de datos", async () => {
  const res = await post(sessionEvent("checkout.session.completed"), "t=1,v1=firma-falsa");
  assertEquals(res.status, 400);
  await res.body?.cancel();
  assertEquals(db.fulfillCalls, 0);
});

Deno.test("un pago pendiente no crea entrada", async () => {
  const res = await post(sessionEvent("checkout.session.completed", "unpaid"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "pending");
  assertEquals(db.fulfillCalls, 0);
});

Deno.test("el mismo webhook dos veces => una entrada y un email", async () => {
  const payload = sessionEvent("checkout.session.completed");
  const r1 = await post(payload);
  assertEquals(await r1.text(), "created");
  const r2 = await post(payload);
  assertEquals(await r2.text(), "duplicate");

  assertEquals(db.tickets, 1);
  assertEquals(sentEmails.length, 1, "no se debe mandar un segundo email");
  assertEquals(db.emailStatus, "sent");
});

Deno.test("el email escapa HTML y el QR contiene SOLO el ID de la entrada", () => {
  const mail = sentEmails[0] as {
    to: string[]; subject: string; html: string;
    attachments: Array<{ content: string; content_id: string }>;
  };
  assertEquals(mail.to, ["ana@example.com"]);
  assert(mail.html.includes("Fiesta &lt;Test&gt;"), "el nombre del evento va escapado");
  assert(!mail.html.includes("<Test>"));
  assert(mail.html.includes(`cid:${mail.attachments[0].content_id}`));

  const png = PNG.sync.read(Buffer.from(decodeBase64(mail.attachments[0].content)));
  const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert(qr, "el QR se puede leer");
  assertEquals(qr.data, TICKET_ID);
});

Deno.test({
  name: "cerrar servidor",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    // El servidor del módulo se cierra al terminar el proceso de pruebas.
  },
});
