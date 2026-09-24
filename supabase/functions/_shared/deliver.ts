import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { admin, env, EVENT_TIMEZONE, SITE_URL } from "./env.ts";
import { ticketQrPng } from "./qr.ts";
import { renderTicketEmail, shortCode } from "./email-template.ts";

const QR_CID = "qr-entrada";

/**
 * Genera el QR y envía la entrada por Resend. Marca email_status en la base de datos.
 * Lanza un error si el envío falla, para que el webhook devuelva 500 y Stripe reintente.
 */
export async function deliverTicket(ticketId: string): Promise<void> {
  const { data: ticket, error } = await admin
    .from("tickets")
    .select("id, name, email, email_status, anonymized_at, events(name, venue, starts_at)")
    .eq("id", ticketId)
    .single();
  if (error) throw error;
  if (ticket.email_status === "sent" || !ticket.email || ticket.anonymized_at) return;

  // deno-lint-ignore no-explicit-any
  const event = ticket.events as any;
  const png = await ticketQrPng(ticket.id);
  const mail = renderTicketEmail({
    ticketId: ticket.id,
    attendeeName: ticket.name,
    eventName: event.name,
    venue: event.venue,
    startsAt: new Date(event.starts_at),
    timeZone: EVENT_TIMEZONE,
    organizerName: env("ORGANIZER_NAME"),
    privacyUrl: `${SITE_URL}/privacidad.html`,
    retentionDays: Number(Deno.env.get("RETENTION_DAYS") ?? "30"),
    qrContentId: QR_CID,
  });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
      // Si el webhook se reintenta, Resend no manda el mismo email dos veces (ventana de 24 h).
      "Idempotency-Key": `ticket-email-${ticket.id}`,
    },
    body: JSON.stringify({
      from: env("EMAIL_FROM"),
      to: [ticket.email],
      reply_to: Deno.env.get("EMAIL_REPLY_TO") || undefined,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      attachments: [{
        filename: `entrada-${shortCode(ticket.id)}.png`,
        content: encodeBase64(png),
        content_id: QR_CID,
      }],
      tags: [{ name: "type", value: "ticket" }],
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    await admin.from("tickets")
      .update({ email_status: "failed", email_error: `${res.status} ${detail}` })
      .eq("id", ticket.id);
    throw new Error(`Resend respondió ${res.status}: ${detail}`);
  }

  await admin.from("tickets")
    .update({ email_status: "sent", email_sent_at: new Date().toISOString(), email_error: null })
    .eq("id", ticket.id);
}
