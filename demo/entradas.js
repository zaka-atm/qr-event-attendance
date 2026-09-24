// QR de ejemplo: entradas válidas, ya usadas, de otro evento y una falsa, para probar la puerta.
(() => {
  "use strict";
  const db = window.DEMO.db();
  const main = db.events[0];
  const el = (tag, props = {}, ...children) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return n;
  };
  const shortCode = (id) => id.replaceAll("-", "").slice(0, 8).toUpperCase();
  const time = (s) => new Date(s).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

  function card(id, title, detail, tone) {
    const qr = window.qrcode(0, "M");
    qr.addData(id);
    qr.make();
    const btn = el("button", { className: "btn small-btn", type: "button", textContent: "Probar en la puerta" });
    btn.addEventListener("click", () => window.DEMO.tryAtDoor(id, main.id));
    return el("li", { className: `qr-card ${tone}` },
      el("img", { src: qr.createDataURL(6, 2), alt: `QR ${title}`, width: 180, height: 180, className: "qr" }),
      el("strong", { textContent: title }),
      el("span", { className: "hint", textContent: detail }),
      btn,
    );
  }

  const cards = db.tickets.filter((t) => t.event_id === main.id).map((t) => card(
    t.id, t.name,
    t.checked_in_at ? `Ya dentro desde las ${time(t.checked_in_at)} → rojo` : `Código ${shortCode(t.id)} · válida → verde`,
    t.checked_in_at ? "used" : "ok",
  ));
  const other = db.tickets.find((t) => t.event_id !== main.id);
  if (other) cards.push(card(other.id, other.name, `Es de «${db.events.find((e) => e.id === other.event_id).name}» → rojo`, "used"));
  cards.push(card("8f14e45f-ceea-4e7a-9b1d-2c8f5a1e0b7d", "QR falso", "No existe en la base de datos → rojo", "used"));

  document.getElementById("grid").replaceChildren(...cards);
})();
