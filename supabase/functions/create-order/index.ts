// POST /functions/v1/create-order
// Recibe el formulario de compra, reserva plaza (create_order) y devuelve las instrucciones de pago
// (Bizum o transferencia con una referencia). NO crea entradas: eso lo hace un organizador al
// confirmar el pago en el panel (función manage-order).

import { admin, EVENT_TIMEZONE, env, paymentDetails } from "../_shared/env.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { renderOrderEmail } from "../_shared/email-template.ts";
import { sendMail } from "../_shared/resend.ts";

const CONSENT_VERSION = Deno.env.get("CONSENT_VERSION") ?? "2026-09";
const HOLD_HOURS = Number(Deno.env.get("RESERVATION_HOURS") ?? "72");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ERRORS: Record<string, [number, string]> = {
  event_not_available: [409, "La venta de este evento no está abierta."],
  sold_out: [409, "Lo sentimos, las entradas están agotadas."],
  too_young: [422, "No cumples la edad mínima para este evento."],
  birth_date_required: [422, "Indica tu fecha de nacimiento."],
};

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

  // deno-lint-ignore no-explicit-any
  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Petición no válida." }, 400);
  }

  const slug = typeof body.event_slug === "string" ? body.event_slug.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const birthDate = typeof body.birth_date === "string" && body.birth_date ? body.birth_date : null;
  const method = body.payment_method;

  if (body.website) return json({ error: "Petición no válida." }, 400); // campo trampa para bots
  if (body.consent !== true) return json({ error: "Debes aceptar la política de privacidad." }, 422);
  if (!slug) return json({ error: "Falta el evento." }, 400);
  if (name.length < 2 || name.length > 120) return json({ error: "Escribe tu nombre y apellidos." }, 422);
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "El email no es válido." }, 422);
  if (method !== "bizum" && method !== "transfer") return json({ error: "Elige cómo vas a pagar." }, 422);
  if (birthDate !== null && (!DATE_RE.test(birthDate) || Number.isNaN(Date.parse(birthDate)))) {
    return json({ error: "La fecha de nacimiento no es válida." }, 422);
  }

  const { data: order, error } = await admin.rpc("create_order", {
    p_event_slug: slug,
    p_name: name,
    p_email: email,
    p_birth_date: birthDate,
    p_payment_method: method,
    p_consent_version: CONSENT_VERSION,
    p_hold_hours: HOLD_HOURS,
  });
  if (error) {
    const known = ERRORS[error.message];
    if (known) return json({ error: known[1], code: error.message }, known[0]);
    console.error("create_order", error);
    return json({ error: "No hemos podido reservar tu entrada. Inténtalo de nuevo." }, 500);
  }

  const pay = paymentDetails();
  const amount = money(order.amount_cents, order.currency);

  // Las instrucciones también van por email por si el comprador cierra la página.
  // Si el email falla, el pedido sigue siendo válido: las instrucciones se ven en pantalla.
  try {
    await sendMail({
      to: email,
      ...renderOrderEmail({
        reference: order.reference,
        attendeeName: name,
        eventName: order.event_name,
        amount,
        method,
        bizumPhone: pay.bizum_phone,
        iban: pay.iban,
        holder: pay.holder,
        holdUntil: new Date(order.expires_at),
        timeZone: EVENT_TIMEZONE,
        organizerName: env("ORGANIZER_NAME"),
      }),
      tag: "order",
      idempotencyKey: `order-email-${order.order_id}`,
    });
  } catch (e) {
    console.error("email de instrucciones", e);
  }

  return json({
    reference: order.reference,
    payment_method: method,
    amount,
    event_name: order.event_name,
    email,
    expires_at: order.expires_at,
    ...pay,
  });
});
