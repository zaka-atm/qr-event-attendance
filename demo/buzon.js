// Buzón de la demo: pinta los emails que la app habría enviado (guardados por demo/mock.js).
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const tz = window.APP_CONFIG.TIME_ZONE;
  const el = (tag, props = {}, ...children) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return n;
  };
  const longDate = (s) => new Intl.DateTimeFormat("es-ES", {
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: tz,
  }).format(new Date(s));
  const shortCode = (id) => id.replaceAll("-", "").slice(0, 8).toUpperCase();

  function qrImage(text, alt) {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return el("img", { src: qr.createDataURL(8, 2), alt, width: 240, height: 240, className: "qr" });
  }

  function orderBody(d) {
    const bizum = d.method === "bizum";
    return el("div", { className: "mail-body" },
      el("p", { textContent: `Hola ${d.name.split(" ")[0]}, hemos reservado tu plaza para ${d.event_name}. Para recibir la entrada:` }),
      el("p", {}, bizum ? `Haz un Bizum de ${d.amount} al ${d.bizum_phone} con este concepto:` : `Haz una transferencia de ${d.amount} a ${d.iban} (${d.holder}) con este concepto:`),
      el("div", { className: "mail-ref", textContent: d.reference }),
      el("p", { className: "hint", textContent: `La reserva se mantiene hasta el ${longDate(d.expires_at)}. En la demo, confirma el pago en «Pagos» para recibir la entrada.` }),
    );
  }

  function ticketBody(d) {
    const btn = el("button", { className: "btn", type: "button", textContent: "Probar en la puerta" });
    btn.addEventListener("click", () => window.DEMO.tryAtDoor(d.ticket_id, d.event_id));
    return el("div", { className: "mail-body ticket-mail" },
      el("div", { className: "ticket-head" },
        el("span", { className: "when", textContent: "Tu entrada" }),
        el("strong", { textContent: d.event_name }),
        el("span", { textContent: `${longDate(d.starts_at)} · ${d.venue}` }),
      ),
      el("p", { textContent: `Hola ${d.name.split(" ")[0]}, este es tu código de acceso:` }),
      qrImage(d.ticket_id, `Código QR de la entrada ${shortCode(d.ticket_id)}`),
      el("div", { className: "mail-ref small", textContent: shortCode(d.ticket_id) }),
      el("p", { className: "hint", textContent: "El QR solo contiene el identificador de la entrada, sin datos personales. En la demo no hay cámara: pulsa el botón para simular que lo escaneas en la puerta." }),
      btn,
    );
  }

  const mails = [...window.DEMO.db().outbox].reverse();
  $("empty").hidden = mails.length > 0;
  $("mails").replaceChildren(...mails.map((m, i) => {
    const details = el("details", { className: "mail", open: i === 0 },
      el("summary", {},
        el("span", { className: "mail-to", textContent: `Para: ${m.to}` }),
        el("strong", { textContent: m.subject }),
        el("span", { className: "mail-at", textContent: new Date(m.at).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) }),
      ),
      m.kind === "ticket" ? ticketBody(m.data) : orderBody(m.data),
    );
    return el("li", {}, details);
  }));
})();
