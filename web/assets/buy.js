// Página de compra: lista eventos publicados, recoge los datos mínimos y reserva plaza.
// No crea entradas: la función create-order devuelve una referencia para pagar por Bizum o
// transferencia, y la entrada se envía cuando un organizador confirma el pago.
(() => {
  "use strict";

  const cfg = window.APP_CONFIG;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const money = (cents, currency) =>
    new Intl.NumberFormat("es-ES", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  const when = (iso) =>
    new Intl.DateTimeFormat("es-ES", {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: cfg.TIME_ZONE,
    }).format(new Date(iso));

  function show(el, text) {
    if (text !== undefined) el.textContent = text;
    el.hidden = false;
  }

  function eventCard(ev) {
    const a = document.createElement("a");
    a.className = "event-link";
    a.href = `?e=${encodeURIComponent(ev.slug)}`;
    const card = document.createElement("div");
    card.className = "event-card";
    const w = document.createElement("div"); w.className = "when"; w.textContent = when(ev.starts_at);
    const h = document.createElement("h2"); h.style.fontSize = "28px"; h.textContent = ev.name;
    const v = document.createElement("div"); v.className = "venue"; v.textContent = ev.venue;
    const p = document.createElement("div"); p.className = "price-row";
    const k = document.createElement("span"); k.textContent = ev.sales_open ? "Comprar entrada" : "Venta cerrada";
    const pr = document.createElement("span"); pr.className = "price"; pr.textContent = money(ev.price_cents, ev.currency);
    p.append(k, pr);
    card.append(w, h, v, p);
    a.append(card);
    return a;
  }

  async function loadEvents() {
    const url = new URL(`${cfg.SUPABASE_URL}/rest/v1/events`);
    url.searchParams.set("select", "slug,name,venue,starts_at,price_cents,currency,min_age,collect_birth_date,sales_open");
    url.searchParams.set("published", "eq.true");
    url.searchParams.set("starts_at", `gte.${new Date(Date.now() - 6 * 3600e3).toISOString()}`);
    url.searchParams.set("order", "starts_at.asc");
    const res = await fetch(url, { headers: { apikey: cfg.SUPABASE_ANON_KEY } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function renderBuy(ev) {
    document.title = `Entradas · ${ev.name}`;
    $("ev-when").textContent = when(ev.starts_at);
    $("ev-name").textContent = ev.name;
    $("ev-venue").textContent = ev.venue;
    $("ev-price").textContent = money(ev.price_cents, ev.currency);
    $("ev-kind").textContent = ev.min_age ? `Entrada general · +${ev.min_age}` : "Entrada general";
    $("pay").textContent = `Reservar · ${money(ev.price_cents, ev.currency)}`;

    const birth = $("birth_date");
    if (ev.collect_birth_date) {
      birth.required = true;
      birth.max = new Date().toISOString().slice(0, 10);
      if (!ev.min_age) $("birth-hint").textContent = "La organización necesita tu edad para este evento.";
    } else {
      $("birth-field").hidden = true;
    }

    const data = ev.collect_birth_date ? "nombre, email y fecha de nacimiento" : "nombre y email";
    const consent = $("consent-text");
    consent.append(
      `Acepto que ${cfg.ORGANIZER} trate mis datos (${data}) solo para gestionar mi entrada y el acceso a este evento, según la `,
      Object.assign(document.createElement("a"), { href: "privacidad.html", textContent: "política de privacidad", target: "_blank" }),
      `. Se borrarán ${cfg.RETENTION_DAYS} días después del evento.`,
    );

    if (!ev.sales_open) {
      show($("closed"), "La venta de entradas para este evento no está abierta.");
      $("form").hidden = true;
    }

    $("form").addEventListener("submit", (e) => submit(e, ev));
    show($("buy"));
  }

  function validate(ev) {
    const name = $("name").value.trim();
    const email = $("email").value.trim();
    const birth = $("birth_date").value;
    if (name.length < 2) return ["name", "Escribe tu nombre y apellidos."];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return ["email", "El email no es válido."];
    if (ev.collect_birth_date && !birth) return ["birth_date", "Indica tu fecha de nacimiento."];
    if (!document.querySelector("input[name=payment_method]:checked")) return ["pm-bizum", "Elige cómo vas a pagar."];
    if (!$("consent").checked) return ["consent", "Debes aceptar la política de privacidad para continuar."];
    return null;
  }

  async function submit(e, ev) {
    e.preventDefault();
    const errBox = $("form-error");
    errBox.hidden = true;

    const problem = validate(ev);
    if (problem) {
      show(errBox, problem[1]);
      $(problem[0]).focus();
      return;
    }

    const btn = $("pay");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Reservando…";

    try {
      const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/create-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: cfg.SUPABASE_ANON_KEY },
        body: JSON.stringify({
          event_slug: ev.slug,
          name: $("name").value,
          email: $("email").value,
          birth_date: ev.collect_birth_date ? $("birth_date").value : null,
          payment_method: document.querySelector("input[name=payment_method]:checked").value,
          consent: $("consent").checked,
          website: $("website").value,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.reference) throw new Error(body.error || "No hemos podido reservar tu entrada. Inténtalo de nuevo.");
      showDone(body);
    } catch (err) {
      show(errBox, err instanceof TypeError ? "Sin conexión. Revisa tu internet e inténtalo de nuevo." : err.message);
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function showDone(o) {
    const bizum = o.payment_method === "bizum";
    $("done-email").textContent = o.email;
    $("done-how").textContent = bizum
      ? "Haz un Bizum con estos datos desde la app de tu banco:"
      : "Haz una transferencia con estos datos:";
    $("done-amount").textContent = o.amount;
    $("done-dest-label").textContent = bizum ? "Bizum al teléfono" : "IBAN";
    $("done-dest").textContent = bizum ? o.bizum_phone : o.iban;
    $("done-holder").textContent = o.holder;
    $("done-holder-row").hidden = bizum;
    $("done-ref").textContent = o.reference;
    $("done-until").textContent = new Intl.DateTimeFormat("es-ES", {
      weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: cfg.TIME_ZONE,
    }).format(new Date(o.expires_at));
    $("buy").hidden = true;
    show($("done"));
    window.scrollTo({ top: 0 });
    $("done").querySelector("h1").focus?.();
  }

  // Botones "Copiar": copian el texto del elemento indicado; si el navegador no deja, lo seleccionan.
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const el = $(btn.dataset.copy);
    const text = el.textContent.replace(/\s+/g, btn.dataset.copy === "done-dest" ? "" : " ").trim();
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copiado";
      setTimeout(() => { btn.textContent = "Copiar"; }, 1500);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  });

  async function main() {
    $("brand").textContent = cfg.BRAND;

    let events;
    try {
      events = await loadEvents();
    } catch {
      $("loading").hidden = true;
      show($("page-error"), "No hemos podido cargar los eventos. Recarga la página en unos segundos.");
      return;
    }
    $("loading").hidden = true;

    const slug = params.get("e");
    const chosen = slug ? events.find((ev) => ev.slug === slug) : events.length === 1 ? events[0] : null;

    if (chosen) return renderBuy(chosen);
    if (slug) show($("page-error"), "Este evento no existe o ya ha pasado.");
    if (events.length === 0) {
      show($("page-error"), "Ahora mismo no hay eventos a la venta.");
      return;
    }
    const list = $("event-list");
    events.forEach((ev) => list.append(eventCard(ev)));
    list.hidden = false;
  }

  main();
})();
