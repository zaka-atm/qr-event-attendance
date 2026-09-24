// POST /functions/v1/stripe-webhook
// La ÚNICA vía por la que se crean entradas. Stripe puede entregar el mismo evento varias
// veces (o dos a la vez): fulfill_order bloquea el pedido y devuelve la entrada existente.
//
// Eventos a activar en Stripe: checkout.session.completed,
// checkout.session.async_payment_succeeded, checkout.session.expired.

import Stripe from "npm:stripe@17.7.0";
import { admin, env, stripe } from "../_shared/env.ts";
import { deliverTicket } from "../_shared/deliver.ts";

const cryptoProvider = Stripe.createSubtleCryptoProvider();
const WEBHOOK_SECRET = env("STRIPE_WEBHOOK_SECRET");

// Errores de negocio: reintentar no los arregla, así que respondemos 200 y lo dejamos en el log.
const PERMANENT = new Set(["order_not_found", "session_mismatch", "amount_mismatch", "order_data_missing"]);

function orderIdOf(session: Stripe.Checkout.Session): string | null {
  return session.client_reference_id ?? session.metadata?.order_id ?? null;
}

async function handlePaid(session: Stripe.Checkout.Session): Promise<Response> {
  if (session.payment_status !== "paid") {
    // Pago diferido (p. ej. transferencia): llegará checkout.session.async_payment_succeeded.
    return new Response("pending", { status: 200 });
  }
  const orderId = orderIdOf(session);
  if (!orderId) return new Response("sin order_id", { status: 200 });

  const paymentIntent = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null;

  const { data, error } = await admin.rpc("fulfill_order", {
    p_order_id: orderId,
    p_session_id: session.id,
    p_payment_intent: paymentIntent,
    p_amount_cents: session.amount_total ?? 0,
  });
  if (error) {
    if (PERMANENT.has(error.message)) {
      console.error(`ALERTA ${error.message}: pedido ${orderId}, sesión ${session.id}. Revisar a mano / reembolsar.`);
      return new Response(error.message, { status: 200 });
    }
    throw error; // error transitorio: 500 y Stripe reintenta
  }

  // Si el email ya salió en una entrega anterior no se repite; si falló, se reintenta aquí.
  if (data.email_status !== "sent") await deliverTicket(data.ticket_id);

  return new Response(data.created ? "created" : "duplicate", { status: 200 });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Falta la firma", { status: 400 });

  // Hay que verificar la firma sobre el cuerpo EXACTO recibido.
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch (e) {
    console.warn("Firma de Stripe no válida", (e as Error).message);
    return new Response("Firma no válida", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return await handlePaid(event.data.object);

      case "checkout.session.expired":
      case "checkout.session.async_payment_failed": {
        const orderId = orderIdOf(event.data.object);
        if (orderId) {
          const { error } = await admin.rpc("expire_order", { p_order_id: orderId });
          if (error) throw error;
        }
        return new Response("expired", { status: 200 });
      }

      default:
        return new Response("ignorado", { status: 200 });
    }
  } catch (e) {
    console.error(`Error procesando ${event.type} ${event.id}`, e);
    return new Response("Error interno", { status: 500 });
  }
});
