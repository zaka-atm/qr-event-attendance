// Panel de pagos: el organizador comprueba en el banco los Bizum/transferencias y confirma cada pedido.
// Confirmar llama a la función manage-order, que crea la entrada (una sola, aunque se pulse dos veces)
// y la envía por email con el QR. Usa la misma sesión que la app de la puerta.
(() => {
  "use strict";

  const cfg = window.APP_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "checkin-auth" },
  });
  const $ = (id) => document.getElementById(id);
  const state = { user: null, events: [], event: null, orders: [], tab: "pending", open: null };

  const money = (cents, currency = "eur") =>
    new Intl.NumberFormat("es-ES", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  const when = (iso) => new Date(iso).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const fold = (s) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  };

  function show(screen) {
    for (const id of ["screen-login", "screen-panel"]) $(id).hidden = id !== screen;
  }

  function toast(text, warn = false) {
    const t = $("toast");
    t.textContent = text;
    t.classList.toggle("warn", warn);
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  // ------------------------------------------------------------------------
  // Sesión
  // ------------------------------------------------------------------------
  async function isOrganizer(userId) {
    const { data } = await sb.from("organizers").select("user_id").eq("user_id", userId).maybeSingle();
    return !!data;
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("login-error");
    const btn = $("login-btn");
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Entrando…";
    try {
      const { data, error } = await sb.auth.signInWithPassword({
        email: $("login-email").value.trim(),
        password: $("login-password").value,
      });
      if (error) throw new Error(error.status === 400 ? "Email o contraseña incorrectos." : "No se ha podido iniciar sesión. Revisa la conexión.");
      if (!(await isOrganizer(data.user.id))) {
        await sb.auth.signOut();
        throw new Error("Este usuario no tiene permiso para gestionar pedidos.");
      }
      localStorage.setItem("checkin-organizer", data.user.id);
      localStorage.setItem("checkin-email", data.user.email ?? "");
      state.user = data.user;
      $("login-password").value = "";
      await openPanel();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Entrar";
    }
  });

  $("logout").addEventListener("click", async () => {
    state.user = null;
    await sb.auth.signOut().catch(() => {});
    // RGPD: también se borra la lista offline de la puerta, si este móvil la tenía.
    indexedDB.deleteDatabase("checkin");
    for (const k of ["checkin-organizer", "checkin-email", "checkin-event", "checkin-events"]) localStorage.removeItem(k);
    location.reload();
  });

  // ------------------------------------------------------------------------
  // Datos
  // ------------------------------------------------------------------------
  async function openPanel() {
    show("screen-panel");
    const since = new Date(Date.now() - 2 * 24 * 3600e3).toISOString();
    const { data, error } = await sb.from("events").select("id,name,starts_at,capacity").gte("starts_at", since).order("starts_at");
    if (error) return showError("No se han podido cargar los eventos.");
    state.events = data;
    const sel = $("event-select");
    sel.replaceChildren(...data.map((ev) => el("option", { value: ev.id, textContent: `${ev.name} · ${new Date(ev.starts_at).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}` })));
    const saved = JSON.parse(localStorage.getItem("checkin-event") || "null");
    state.event = data.find((ev) => ev.id === saved?.id) ?? data[0] ?? null;
    if (!state.event) {
      $("empty").textContent = "No hay eventos próximos.";
      $("empty").hidden = false;
      return;
    }
    sel.value = state.event.id;
    await loadOrders();
  }

  $("event-select").addEventListener("change", async (e) => {
    state.event = state.events.find((ev) => ev.id === e.target.value);
    localStorage.setItem("checkin-event", JSON.stringify(state.event));
    state.open = null;
    await loadOrders();
  });

  async function loadOrders() {
    const { data, error } = await sb.from("orders")
      .select("id,reference,status,payment_method,name,email,amount_cents,currency,expires_at,paid_at,created_at,tickets(id,name,email_status)")
      .eq("event_id", state.event.id)
      .in("status", ["pending", "paid"])
      .order("created_at", { ascending: false });
    if (error) return showError("No se han podido cargar los pedidos. Revisa la conexión.");
    $("panel-error").hidden = true;
    state.orders = data.map((o) => ({ ...o, ticket: Array.isArray(o.tickets) ? o.tickets[0] : o.tickets }));
    render();
  }

  function showError(text) {
    $("panel-error").textContent = text;
    $("panel-error").hidden = false;
  }

  setInterval(() => { if (state.event && !state.open && document.visibilityState === "visible") loadOrders(); }, 30000);

  async function manage(body) {
    const { data, error } = await sb.functions.invoke("manage-order", { body });
    if (error) {
      const detail = await error.context?.json?.().catch(() => null);
      throw new Error(detail?.error ?? "No se ha podido completar la operación. Revisa la conexión.");
    }
    return data;
  }

  // ------------------------------------------------------------------------
  // Pintar
  // ------------------------------------------------------------------------
  function render() {
    const pending = state.orders.filter((o) => o.status === "pending");
    const paid = state.orders.filter((o) => o.status === "paid");
    const activePending = pending.filter((o) => new Date(o.expires_at) > new Date());
    $("count-pending").textContent = String(pending.length);
    $("count-paid").textContent = String(paid.length);
    $("summary").replaceChildren(
      stat("Por cobrar", money(pending.reduce((s, o) => s + o.amount_cents, 0))),
      stat("Vendidas", String(paid.length)),
      stat("Plazas libres", String(Math.max(0, state.event.capacity - paid.length - activePending.length))),
    );

    for (const tab of ["pending", "paid"]) $(`tab-${tab}`).setAttribute("aria-selected", String(state.tab === tab));

    const q = fold($("search").value.trim());
    const list = (state.tab === "pending" ? pending : paid).filter((o) =>
      !q || fold(o.reference).includes(q) || fold(o.name ?? o.ticket?.name).includes(q) || fold(o.email).includes(q));

    $("orders").replaceChildren(...list.map((o) => (o.status === "pending" ? pendingItem(o) : paidItem(o))));
    $("empty").hidden = list.length > 0;
    $("empty").textContent = q
      ? "Ningún pedido coincide con la búsqueda."
      : state.tab === "pending" ? "No hay pagos pendientes de confirmar." : "Todavía no hay pedidos pagados.";
  }

  function stat(label, value) {
    return el("div", { className: "stat" }, el("span", { className: "muted", textContent: label }), el("strong", { textContent: value }));
  }

  function pendingItem(o) {
    const expired = new Date(o.expires_at) <= new Date();
    const li = el("li", { className: "order" },
      el("div", { className: "order-top" },
        el("span", { className: "order-ref", textContent: o.reference }),
        el("span", { className: "order-amount", textContent: money(o.amount_cents, o.currency) }),
      ),
      el("div", { className: "order-who" },
        el("strong", { textContent: o.name }),
        el("span", { textContent: o.email }),
      ),
      el("div", { className: "chips" },
        el("span", { className: "chip", textContent: o.payment_method === "bizum" ? "Bizum" : "Transferencia" }),
        el("span", { className: "chip", textContent: `Reservado ${when(o.created_at)}` }),
        expired ? el("span", { className: "chip warn", textContent: "Reserva caducada" }) : null,
      ),
    );

    if (state.open?.id === o.id) {
      li.append(state.open.kind === "confirm" ? confirmBox(o) : cancelBox(o));
    } else {
      const actions = el("div", { className: "order-actions" },
        el("button", { className: "btn go", type: "button", textContent: "Confirmar pago", onclick: () => openBox(o, "confirm") }),
        el("button", { className: "btn stop", type: "button", textContent: "Cancelar", onclick: () => openBox(o, "cancel") }),
      );
      li.append(actions);
    }
    return li;
  }

  function openBox(o, kind) {
    state.open = { id: o.id, kind };
    render();
  }
  function closeBox() {
    state.open = null;
    render();
  }

  function confirmBox(o) {
    const method = o.payment_method === "bizum" ? "un Bizum" : "una transferencia";
    const yes = el("button", { className: "btn go", type: "button", textContent: "Sí, enviar la entrada" });
    yes.onclick = async () => {
      yes.disabled = true;
      yes.textContent = "Enviando…";
      try {
        const r = await manage({ action: "confirm", order_id: o.id });
        if (r.email_status === "sent") toast(`Pago de ${o.reference} confirmado. Entrada enviada a ${o.email}.`);
        else toast(`Pago de ${o.reference} confirmado, pero el email no se pudo enviar. Reenvíalo desde «Pagados».`, true);
        state.open = null;
        await loadOrders();
      } catch (e) {
        toast(e.message, true);
        yes.disabled = false;
        yes.textContent = "Sí, enviar la entrada";
      }
    };
    return el("div", { className: "confirm-box" },
      el("p", { textContent: `¿Has recibido ${method} de ${money(o.amount_cents, o.currency)} con el concepto ${o.reference}?` }),
      el("div", { className: "order-actions" }, yes, el("button", { className: "btn stop", type: "button", textContent: "Volver", onclick: closeBox })),
    );
  }

  function cancelBox(o) {
    const yes = el("button", { className: "btn", type: "button", textContent: "Sí, cancelar pedido" });
    yes.onclick = async () => {
      yes.disabled = true;
      try {
        await manage({ action: "cancel", order_id: o.id });
        toast(`Pedido ${o.reference} cancelado. La plaza vuelve a estar libre.`);
        state.open = null;
        await loadOrders();
      } catch (e) {
        toast(e.message, true);
        yes.disabled = false;
      }
    };
    return el("div", { className: "confirm-box" },
      el("p", { textContent: `Se liberará la plaza y se borrarán los datos de ${o.name}. Hazlo solo si el pago no ha llegado.` }),
      el("div", { className: "order-actions" }, yes, el("button", { className: "btn stop", type: "button", textContent: "Volver", onclick: closeBox })),
    );
  }

  function paidItem(o) {
    const status = o.ticket?.email_status;
    const chip = status === "sent"
      ? el("span", { className: "chip ok", textContent: "Entrada enviada" })
      : status === "failed"
        ? el("span", { className: "chip bad", textContent: "El email falló" })
        : el("span", { className: "chip warn", textContent: "Email pendiente" });

    const li = el("li", { className: "order" },
      el("div", { className: "order-top" },
        el("span", { className: "order-ref", textContent: o.reference }),
        el("span", { className: "order-amount", textContent: money(o.amount_cents, o.currency) }),
      ),
      el("div", { className: "order-who" },
        el("strong", { textContent: o.ticket?.name ?? "—" }),
        el("span", { textContent: `Pagado ${when(o.paid_at)}` }),
      ),
      el("div", { className: "chips" }, chip),
    );

    if (!o.ticket) return li;
    if (state.open?.id === o.id) {
      const input = el("input", { id: `resend-${o.id}`, type: "email", placeholder: "Déjalo vacío para usar el mismo email", autocomplete: "off" });
      const go = el("button", { className: "btn go", type: "button", textContent: "Reenviar entrada" });
      go.onclick = async () => {
        go.disabled = true;
        go.textContent = "Enviando…";
        try {
          const r = await manage({ action: "resend", ticket_id: o.ticket.id, email: input.value.trim() || undefined });
          toast(r.email_status === "sent" ? `Entrada de ${o.reference} reenviada.` : "No se pudo enviar el email. Revisa la dirección.", r.email_status !== "sent");
          state.open = null;
          await loadOrders();
        } catch (e) {
          toast(e.message, true);
          go.disabled = false;
          go.textContent = "Reenviar entrada";
        }
      };
      li.append(el("div", { className: "confirm-box" },
        el("div", { className: "field" }, el("label", { htmlFor: input.id, textContent: "Email corregido (opcional)" }), input),
        el("div", { className: "order-actions" }, go, el("button", { className: "btn stop", type: "button", textContent: "Volver", onclick: closeBox })),
      ));
    } else {
      li.append(el("div", { className: "order-actions single" },
        el("button", { className: "btn", type: "button", textContent: "Reenviar entrada", onclick: () => openBox(o, "resend") }),
      ));
    }
    return li;
  }

  $("tab-pending").addEventListener("click", () => { state.tab = "pending"; state.open = null; render(); });
  $("tab-paid").addEventListener("click", () => { state.tab = "paid"; state.open = null; render(); });
  $("search").addEventListener("input", render);

  // ------------------------------------------------------------------------
  async function boot() {
    const { data } = await sb.auth.getSession();
    const user = data.session?.user;
    if (!user || !(await isOrganizer(user.id))) return show("screen-login");
    state.user = user;
    await openPanel();
  }
  boot();
})();
