// Plantilla del email con la entrada. HTML con tablas y estilos en línea para que
// se vea bien en Gmail, Outlook y Apple Mail. El QR va como imagen adjunta en línea (cid:).

export interface TicketEmailData {
  ticketId: string;
  attendeeName: string;
  eventName: string;
  venue: string;
  startsAt: Date;
  timeZone: string;
  organizerName: string;
  privacyUrl: string;
  retentionDays: number;
  qrContentId: string;
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Los 8 primeros caracteres del ID, para buscar la entrada a mano si el QR no se lee. */
export function shortCode(ticketId: string): string {
  return ticketId.replaceAll("-", "").slice(0, 8).toUpperCase();
}

export function renderTicketEmail(d: TicketEmailData): { subject: string; html: string; text: string } {
  const longDate = new Intl.DateTimeFormat("es-ES", {
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: d.timeZone,
  }).format(d.startsAt);
  const firstName = d.attendeeName.split(/\s+/)[0] ?? d.attendeeName;
  const code = shortCode(d.ticketId);

  const subject = `Tu entrada para ${d.eventName}`;

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#E9E2D6;">
<div style="display:none;max-height:0;overflow:hidden;">Tu código QR para entrar a ${esc(d.eventName)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9E2D6;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:Helvetica,Arial,sans-serif;color:#1A1714;">
    <tr><td style="background:#1A1714;color:#F4EFE6;border-radius:16px 16px 0 0;padding:28px 32px;">
      <div style="font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#CFC6B8;">Tu entrada</div>
      <div style="font-family:Georgia,serif;font-size:30px;font-weight:bold;line-height:1.15;padding-top:8px;">${esc(d.eventName)}</div>
      <div style="font-size:16px;color:#E4DDD1;padding-top:8px;">${esc(longDate)} · ${esc(d.venue)}</div>
    </td></tr>
    <tr><td align="center" style="background:#FFFFFF;border-radius:0 0 16px 16px;padding:32px;">
      <div style="font-size:18px;padding-bottom:16px;">Hola <b>${esc(firstName)}</b>, este es tu código de acceso:</div>
      <img src="cid:${d.qrContentId}" width="260" height="260" alt="Código QR de tu entrada ${code}" style="display:block;width:260px;height:260px;border:0;">
      <div style="font-family:'Courier New',monospace;font-size:20px;letter-spacing:3px;font-weight:bold;padding-top:12px;">${code}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-top:1px dashed #CFC6B8;font-size:16px;">
        <tr><td style="padding:12px 0 6px;color:#5C544A;">Asistente</td><td align="right" style="padding:12px 0 6px;font-weight:bold;">${esc(d.attendeeName)}</td></tr>
        <tr><td style="padding:6px 0;color:#5C544A;">Fecha</td><td align="right" style="padding:6px 0;font-weight:bold;">${esc(longDate)}</td></tr>
        <tr><td style="padding:6px 0;color:#5C544A;">Lugar</td><td align="right" style="padding:6px 0;font-weight:bold;">${esc(d.venue)}</td></tr>
      </table>
      <div style="margin-top:24px;padding:16px;background:#F4EFE6;border-radius:10px;font-size:15px;line-height:1.5;text-align:left;">
        Enseña este QR en la puerta, en el móvil o impreso. Es personal y solo vale para una entrada:
        si alguien lo usa antes que tú, no podrás entrar. No lo compartas.
      </div>
    </td></tr>
    <tr><td style="padding:20px 8px;font-size:12px;line-height:1.5;color:#5C544A;">
      Has recibido este email porque compraste una entrada para ${esc(d.eventName)}.
      ${esc(d.organizerName)} usa tus datos solo para gestionar el acceso y los borra
      ${d.retentionDays} días después del evento.
      <a href="${esc(d.privacyUrl)}" style="color:#2B3A8C;">Política de privacidad</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    `Hola ${firstName}:`,
    ``,
    `Esta es tu entrada para ${d.eventName}.`,
    `Fecha: ${longDate}`,
    `Lugar: ${d.venue}`,
    `Asistente: ${d.attendeeName}`,
    `Código: ${code}`,
    ``,
    `El código QR va en la imagen adjunta. Enséñalo en la puerta, en el móvil o impreso.`,
    `Es personal y solo vale para una entrada. No lo compartas.`,
    ``,
    `${d.organizerName} usa tus datos solo para gestionar el acceso y los borra ${d.retentionDays} días después del evento.`,
    `Política de privacidad: ${d.privacyUrl}`,
  ].join("\n");

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Email de "pedido recibido" con las instrucciones de pago (Bizum / transferencia)
// ---------------------------------------------------------------------------

export interface OrderEmailData {
  reference: string;
  attendeeName: string;
  eventName: string;
  amount: string;           // ya formateado, p. ej. "15,00 €"
  method: "bizum" | "transfer";
  bizumPhone: string;
  iban: string;
  holder: string;
  holdUntil: Date;
  timeZone: string;
  organizerName: string;
}

export function renderOrderEmail(d: OrderEmailData): { subject: string; html: string; text: string } {
  const until = new Intl.DateTimeFormat("es-ES", {
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: d.timeZone,
  }).format(d.holdUntil);
  const firstName = d.attendeeName.split(/\s+/)[0] ?? d.attendeeName;
  const how = d.method === "bizum"
    ? `Haz un Bizum de <b>${esc(d.amount)}</b> al <b>${esc(d.bizumPhone)}</b>`
    : `Haz una transferencia de <b>${esc(d.amount)}</b> a la cuenta <b>${esc(d.iban)}</b> (titular: ${esc(d.holder)})`;
  const howText = d.method === "bizum"
    ? `Haz un Bizum de ${d.amount} al ${d.bizumPhone}`
    : `Haz una transferencia de ${d.amount} a la cuenta ${d.iban} (titular: ${d.holder})`;

  const subject = `Pedido ${d.reference}: cómo pagar tu entrada para ${d.eventName}`;
  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#E9E2D6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9E2D6;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:Helvetica,Arial,sans-serif;color:#1A1714;background:#FFFFFF;border-radius:16px;">
    <tr><td style="padding:32px;">
      <div style="font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#5C544A;">Pedido recibido</div>
      <div style="font-family:Georgia,serif;font-size:26px;font-weight:bold;padding-top:8px;">${esc(d.eventName)}</div>
      <p style="font-size:16px;line-height:1.5;">Hola <b>${esc(firstName)}</b>, hemos reservado tu plaza. Para recibir la entrada:</p>
      <p style="font-size:16px;line-height:1.5;">${how} con este concepto:</p>
      <div style="font-family:'Courier New',monospace;font-size:34px;font-weight:bold;letter-spacing:6px;text-align:center;padding:16px;background:#F4EFE6;border-radius:10px;">${esc(d.reference)}</div>
      <p style="font-size:16px;line-height:1.5;">Cuando comprobemos el pago te enviaremos la entrada con el código QR a este email.
        La reserva se mantiene hasta el <b>${esc(until)}</b>.</p>
      <p style="font-size:13px;line-height:1.5;color:#5C544A;">Si no has hecho tú este pedido, ignora este email. ${esc(d.organizerName)}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
  const text = [
    `Hola ${firstName}:`,
    ``,
    `Hemos reservado tu plaza para ${d.eventName}. Para recibir la entrada:`,
    `${howText} con el concepto ${d.reference}.`,
    ``,
    `Cuando comprobemos el pago te enviaremos la entrada con el código QR. La reserva se mantiene hasta el ${until}.`,
    ``,
    d.organizerName,
  ].join("\n");
  return { subject, html, text };
}
