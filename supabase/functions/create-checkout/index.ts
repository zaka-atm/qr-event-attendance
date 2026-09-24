// POST /functions/v1/create-checkout
// Recibe los datos del formulario, reserva plaza (create_order) y devuelve la URL de Stripe Checkout.
// NO crea entradas: eso solo lo hace el webhook cuando Stripe confirma el pago.

import { admin, SITE_URL, stripe } from "../_shared/env.ts";
import { corsHeaders, json } from "../_shared/http.ts";

const CONSENT_VERSION = Deno.env.get("CONSENT_VERSION") ?? "2026-09";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ERRORS: Record<string, [number, string]> = {
  event_not_available: [409, "La venta de este evento no está abierta."],
  sold_out: [409, "Lo sentimos, las entradas están agotadas."],
  too_young: [422, "No cumples la edad mínima para este evento."],
  birth_date_required: [422, "Indica tu fecha de nacimiento."],
};

interface Body {
  event_slug?: unknown;
  name?: unknown;
  email?: unknown;
  birth_date?: unknown;
  consent?: unknown;
  website?: unknown; // campo trampa para bots: debe llegar vacío
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Petición no válida." }, 400);
  }

  const slug = typeof body.event_slug === "string" ? body.event_slug.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const birthDate = typeof body.birth_date === "string" && body.birth_date ? body.birth_date : null;

  if (body.website) return json({ error: "Petición no válida." }, 400);
  if (body.consent !== true) return json({ error: "Debes aceptar la política de privacidad." }, 422);
  if (!slug) return json({ error: "Falta el evento." }, 400);
  if (name.length < 2 || name.length > 120) return json({ error: "Escribe tu nombre y apellidos." }, 422);
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "El email no es válido." }, 422);
  if (birthDate !== null && (!DATE_RE.test(birthDate) || Number.isNaN(Date.parse(birthDate)))) {
    return json({ error: "La fecha de nacimiento no es válida." }, 422);
  }

  const { data: order, error } = await admin.rpc("create_order", {
    p_event_slug: slug,
    p_name: name,
    p_email: email,
    p_birth_date: birthDate,
    p_consent_version: CONSENT_VERSION,
  });
  if (error) {
    const known = ERRORS[error.message];
    if (known) return json({ error: known[1], code: error.message }, known[0]);
    console.error("create_order", error);
    return json({ error: "No hemos podido reservar tu entrada. Inténtalo de nuevo." }, 500);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      locale: "es",
      customer_email: email,
      client_reference_id: order.order_id,
      metadata: { order_id: order.order_id },
      payment_intent_data: { metadata: { order_id: order.order_id } },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: order.currency,
          unit_amount: order.amount_cents,
          product_data: { name: `Entrada · ${order.event_name}` },
        },
      }],
      // Stripe exige al menos 30 minutos; la reserva en la base de datos dura 35.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      success_url: `${SITE_URL}/gracias.html?e=${encodeURIComponent(order.event_slug)}`,
      cancel_url: `${SITE_URL}/?e=${encodeURIComponent(order.event_slug)}&cancelado=1`,
    }, { idempotencyKey: `checkout-${order.order_id}` });

    const { error: upd } = await admin.from("orders")
      .update({ stripe_session_id: session.id })
      .eq("id", order.order_id);
    if (upd) console.error("guardar stripe_session_id", upd);

    return json({ url: session.url });
  } catch (e) {
    console.error("stripe.checkout.sessions.create", e);
    await admin.rpc("expire_order", { p_order_id: order.order_id });
    return json({ error: "No hemos podido abrir el pago. Inténtalo de nuevo." }, 502);
  }
});
