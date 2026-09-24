// POST /functions/v1/manage-order   (solo organizadores, con su sesión iniciada)
//   { "action": "confirm", "order_id": "…" }            -> pago comprobado: crea la entrada y la envía
//   { "action": "cancel",  "order_id": "…" }            -> el pago no llegó: libera la plaza
//   { "action": "resend",  "ticket_id": "…", "email"? } -> reenvía la entrada (opcionalmente a otro email)
//
// Las operaciones se ejecutan con el token del organizador: es Postgres (is_organizer) quien decide
// si puede hacerlas. Solo el envío del email usa la service role.

import { asCaller } from "../_shared/env.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { deliverTicket } from "../_shared/deliver.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERRORS: Record<string, [number, string]> = {
  forbidden: [403, "Tu usuario no tiene permiso para gestionar pedidos."],
  order_not_found: [404, "Este pedido no existe."],
  order_cancelled: [409, "Este pedido está cancelado."],
  order_data_missing: [409, "Este pedido ya no tiene datos del comprador."],
  ticket_not_found: [404, "Esta entrada no existe o ya se anonimizó."],
  sold_out: [409, "La reserva había caducado y ya no queda aforo."],
};

function fail(error: { message: string; code?: string }) {
  const key = error.code === "42501" ? "forbidden" : error.message;
  const known = ERRORS[key];
  if (known) return json({ error: known[1], code: key }, known[0]);
  console.error("manage-order", error);
  return json({ error: "No se ha podido completar la operación." }, 500);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

  const db = asCaller(req);
  if (!db) return json({ error: "Inicia sesión como organizador." }, 401);

  // deno-lint-ignore no-explicit-any
  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Petición no válida." }, 400);
  }

  switch (body.action) {
    case "confirm": {
      if (!UUID_RE.test(body.order_id ?? "")) return json({ error: "Pedido no válido." }, 400);
      const { data, error } = await db.rpc("confirm_order", { p_order_id: body.order_id });
      if (error) return fail(error);
      const email = data.email_status === "sent" ? "sent" : await deliverTicket(data.ticket_id);
      return json({ ticket_id: data.ticket_id, created: data.created, email_status: email === "skipped" ? data.email_status : email });
    }

    case "cancel": {
      if (!UUID_RE.test(body.order_id ?? "")) return json({ error: "Pedido no válido." }, 400);
      const { data, error } = await db.rpc("cancel_order", { p_order_id: body.order_id });
      if (error) return fail(error);
      return json({ cancelled: data });
    }

    case "resend": {
      if (!UUID_RE.test(body.ticket_id ?? "")) return json({ error: "Entrada no válida." }, 400);
      const newEmail = typeof body.email === "string" ? body.email.trim() : "";
      if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(newEmail)) return json({ error: "El email no es válido." }, 422);
      const { error } = await db.rpc("prepare_resend", { p_ticket_id: body.ticket_id, p_email: newEmail || null });
      if (error) return fail(error);
      const email = await deliverTicket(body.ticket_id, `resend-${Date.now()}`);
      return json({ email_status: email });
    }

    default:
      return json({ error: "Acción no válida." }, 400);
  }
});
