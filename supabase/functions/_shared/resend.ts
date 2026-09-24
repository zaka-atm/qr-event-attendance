import { env } from "./env.ts";

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; content: string; content_id?: string }>;
  tag: string;
  /** Si se repite la misma clave en 24 h, Resend no vuelve a enviar el email. */
  idempotencyKey: string;
}

export async function sendMail(mail: Mail): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": mail.idempotencyKey,
    },
    body: JSON.stringify({
      from: env("EMAIL_FROM"),
      to: [mail.to],
      reply_to: Deno.env.get("EMAIL_REPLY_TO") || undefined,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      attachments: mail.attachments,
      tags: [{ name: "type", value: mail.tag }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend respondió ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
}
