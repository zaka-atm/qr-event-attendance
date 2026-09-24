import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { admin, env, EVENT_TIMEZONE, SITE_URL } from "./env.ts";
import { ticketQrPng } from "./qr.ts";
import { renderTicketEmail, shortCode } from "./email-template.ts";
import { sendMail } from "./resend.ts";

const QR_CID = "qr-entrada";

/**
 * Genera el QR y envía la entrada por Resend. Marca email_status en la base de datos.
 * `attempt` distingue un reenvío pedido por el organizador de una repetición accidental.
 */
export async function deliverTicket(ticketId: string, attempt = "1"): Promise<"sent" | "failed" | "skipped"> {
  const { data: ticket, error } = await admin
    .from("tickets")
    .select("id, name, email, email_status, anonymized_at, events(name, venue, starts_at)")
    .eq("id", ticketId)
    .single();
  if (error) throw error;
  if (ticket.email_status === "sent" || !ticket.email || ticket.anonymized_at) return "skipped";

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

  try {
    await sendMail({
      to: ticket.email,
      ...mail,
      tag: "ticket",
      idempotencyKey: `ticket-email-${ticket.id}-${attempt}`,
      attachments: [{ filename: `entrada-${shortCode(ticket.id)}.png`, content: encodeBase64(png), content_id: QR_CID }],
    });
  } catch (e) {
    await admin.from("tickets")
      .update({ email_status: "failed", email_error: String((e as Error).message).slice(0, 500) })
      .eq("id", ticket.id);
    console.error("deliverTicket", e);
    return "failed";
  }

  await admin.from("tickets")
    .update({ email_status: "sent", email_sent_at: new Date().toISOString(), email_error: null })
    .eq("id", ticket.id);
  return "sent";
}
