// Control de acceso (PWA para el equipo de la puerta).
//
// Con conexión: cada escaneo llama a check_in() en Postgres, que es atómico y la única fuente de verdad.
// Sin conexión (o con una señal tan mala que la petición tarda más de REQUEST_TIMEOUT_MS): se valida contra
// la lista de entradas descargada, se muestra una etiqueta "Sin conexión" y el check-in se guarda en una cola
// (IndexedDB) que se sincroniza con la hora real del escaneo al volver la conexión.
(() => {
  "use strict";

  const cfg = window.APP_CONFIG;
  const REQUEST_TIMEOUT_MS = 4000;
  const HEARTBEAT_MS = 15000;
  const SNAPSHOT_EVERY_MS = 120000;
  const SAME_CODE_COOLDOWN_MS = 3000;
  const OK_AUTOCLOSE_MS = 2000;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "checkin-auth" },
  });

  const $ = (id) => document.getElementById(id);
  const state = {
    user: null,
    event: null,
    tickets: new Map(), // id -> { id, name, birth_date, checked_in_at, local }
    fetchedAt: null,
    queue: [],
    issues: [],
    online: navigator.onLine,
    syncing: false,
    showingResult: false,
    busy: false,
    lastCode: null,
    lastCodeAt: 0,
    lastSnapshotAt: 0,
  };

  // ------------------------------------------------------------------------
  // IndexedDB: lista de entradas por evento, cola offline e incidencias.
  // ------------------------------------------------------------------------
  const idb = (() => {
    let dbp = null;
    const open = () => dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("checkin", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("snapshots", { keyPath: "event_id" });
        db.createObjectStore("queue", { keyPath: "key", autoIncrement: true });
        db.createObjectStore("issues", { keyPath: "key", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const run = async (store, mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
      });
    };
    return {
      get: (s, k) => run(s, "readonly", (st) => st.get(k)),
      all: (s) => run(s, "readonly", (st) => st.getAll()),
      put: (s, v) => run(s, "readwrite", (st) => st.put(v)),
      del: (s, k) => run(s, "readwrite", (st) => st.delete(k)),
      clear: (s) => run(s, "readwrite", (st) => st.clear()),
      async destroy() {
        if (dbp) (await dbp).close();
        dbp = null;
        await new Promise((r) => { const q = indexedDB.deleteDatabase("checkin"); q.onsuccess = q.onerror = q.onblocked = r; });
      },
    };
  })();

  // ------------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------------
  const hhmm = (iso) => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString()
      ? time
      : `${d.toLocaleDateString("es-ES", { day: "numeric", month: "short" })} ${time}`;
  };
  const ageOf = (birth) => {
    if (!birth) return null;
    const b = new Date(`${birth}T00:00:00`);
    const now = new Date();
    let age = now.getFullYear() - b.getFullYear();
    if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
    return age;
  };
  const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const shortCode = (id) => id.replaceAll("-", "").slice(0, 8).toUpperCase();

  function show(screen) {
    for (const id of ["screen-login", "screen-events", "screen-scan"]) $(id).hidden = id !== screen;
    if (screen === "screen-scan") startCamera(); else stopCamera();
  }

  function withTimeout(builder, ms = REQUEST_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return builder.abortSignal(ctrl.signal).then((r) => { clearTimeout(timer); return r; });
  }

  // postgrest-js devuelve status 0 (o ninguno) cuando la petición ni siquiera llegó al servidor.
  const isNetworkFailure = (res) => !res.status || res.status === 0;

  // ------------------------------------------------------------------------
  // Sonido, vibración y pantalla siempre encendida
  // ------------------------------------------------------------------------
  let audio = null;
  function unlockAudio() {
    try { audio ??= new AudioContext(); audio.resume(); } catch { /* sin audio */ }
  }
  // Los navegadores solo dejan sonar audio tras un gesto del usuario.
  document.addEventListener("pointerdown", unlockAudio, { once: true, capture: true });
  function beep(ok) {
    if (!audio) return;
    const tones = ok ? [[880, 0, 0.12], [1320, 0.13, 0.15]] : [[220, 0, 0.25], [180, 0.3, 0.35]];
    for (const [freq, start, dur] of tones) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = ok ? "sine" : "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, audio.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + start + dur);
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + start);
      osc.stop(audio.currentTime + start + dur);
    }
    navigator.vibrate?.(ok ? 80 : [200, 100, 200]);
  }

  let wakeLock = null;
  async function keepAwake() {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* no soportado */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !$("screen-scan").hidden) keepAwake();
  });

  // ------------------------------------------------------------------------
  // Estado de conexión
  // ------------------------------------------------------------------------
  function setOnline(value) {
    state.online = value;
    const pill = $("net-pill");
    pill.classList.toggle("offline", !value);
    const pending = state.queue.length;
    $("net-text").textContent = value
      ? (pending ? `En línea · ${pending} pendientes` : "En línea")
      : (pending ? `Sin conexión · ${pending} pendientes` : "Sin conexión");
    renderFooter();
  }
  window.addEventListener("online", () => heartbeat());
  window.addEventListener("offline", () => setOnline(false));

  async function heartbeat() {
    if (!state.event) return;
    if (!state.online) {
      const res = await withTimeout(sb.from("events").select("id").limit(1)).catch(() => ({ status: 0 }));
      if (isNetworkFailure(res)) return;
      setOnline(true);
    }
    await syncQueue();
    if (Date.now() - state.lastSnapshotAt > SNAPSHOT_EVERY_MS) await refreshSnapshot().catch(() => {});
  }
  setInterval(heartbeat, HEARTBEAT_MS);

  // ------------------------------------------------------------------------
  // Autenticación
  // ------------------------------------------------------------------------
  async function isOrganizer(userId) {
    const res = await withTimeout(sb.from("organizers").select("user_id").eq("user_id", userId).maybeSingle())
      .catch(() => ({ status: 0 }));
    if (isNetworkFailure(res)) return localStorage.getItem("checkin-organizer") === userId; // offline: último resultado
    const ok = !!res.data;
    if (ok) localStorage.setItem("checkin-organizer", userId);
    else localStorage.removeItem("checkin-organizer");
    return ok;
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    unlockAudio();
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
        throw new Error("Este usuario no tiene permiso para validar entradas.");
      }
      state.user = data.user;
      localStorage.setItem("checkin-email", data.user.email ?? "");
      $("login-password").value = "";
      const saved = JSON.parse(localStorage.getItem("checkin-event") || "null");
      if (saved) await selectEvent(saved);
      else await openEvents();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Entrar";
    }
  });

  async function logout() {
    const pending = state.queue.length;
    if (pending && !confirm(`Hay ${pending} validaciones sin sincronizar. Si cierras sesión se perderán. ¿Continuar?`)) return;
    // RGPD: la lista de asistentes no se queda en el móvil.
    state.user = null; // evita que onAuthStateChange recargue antes de borrar los datos
    stopCamera();
    await sb.auth.signOut().catch(() => {});
    await idb.destroy();
    for (const k of ["checkin-organizer", "checkin-email", "checkin-event", "checkin-events"]) localStorage.removeItem(k);
    location.reload();
  }
  $("logout-1").addEventListener("click", logout);
  $("logout-2").addEventListener("click", logout);

  // ------------------------------------------------------------------------
  // Eventos
  // ------------------------------------------------------------------------
  async function openEvents() {
    show("screen-events");
    const list = $("event-list");
    const err = $("events-error");
    err.hidden = true;
    list.replaceChildren();

    let events;
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const res = await withTimeout(
      sb.from("events").select("id,name,venue,starts_at").gte("starts_at", since).order("starts_at"),
    ).catch(() => ({ status: 0 }));
    if (!isNetworkFailure(res) && !res.error) {
      events = res.data;
      localStorage.setItem("checkin-events", JSON.stringify(events));
    } else {
      events = JSON.parse(localStorage.getItem("checkin-events") || "[]");
      err.textContent = "Sin conexión: se muestran los eventos guardados.";
      err.hidden = false;
    }

    if (!events.length) {
      err.textContent = "No hay eventos próximos.";
      err.hidden = false;
    }
    for (const ev of events) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "event-btn";
      const name = document.createElement("strong");
      name.textContent = ev.name;
      const meta = document.createElement("span");
      meta.textContent = `${new Date(ev.starts_at).toLocaleString("es-ES", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · ${ev.venue}`;
      b.append(name, meta);
      b.addEventListener("click", () => { unlockAudio(); selectEvent(ev); });
      list.append(b);
    }
  }

  async function selectEvent(ev) {
    state.event = ev;
    localStorage.setItem("checkin-event", JSON.stringify(ev));
    $("scan-event").textContent = ev.name;
    $("scan-who").textContent = `Puerta · ${state.user?.email ?? ""}`;
    await loadLocal();
    show("screen-scan");
    keepAwake();
    await refreshSnapshot().catch(() => setOnline(false));
    syncQueue();
  }

  $("change-event").addEventListener("click", () => { state.event = null; openEvents(); });

  // ------------------------------------------------------------------------
  // Lista local de entradas (para validar sin conexión)
  // ------------------------------------------------------------------------
  async function loadLocal() {
    state.queue = (await idb.all("queue")).filter((q) => q.event_id === state.event.id);
    state.issues = (await idb.all("issues")).filter((q) => q.event_id === state.event.id);
    const snap = await idb.get("snapshots", state.event.id);
    applySnapshot(snap?.tickets ?? [], snap?.fetched_at ?? null);
  }

  function applySnapshot(rows, fetchedAt) {
    const pending = new Map(state.queue.map((q) => [q.ticket_id, q.scanned_at]));
    state.tickets = new Map(rows.map((r) => [r.id, {
      ...r,
      checked_in_at: r.checked_in_at ?? pending.get(r.id) ?? null,
      local: !r.checked_in_at && pending.has(r.id),
    }]));
    state.fetchedAt = fetchedAt;
    renderStats();
    renderFooter();
  }

  async function refreshSnapshot() {
    const ev = state.event;
    const rows = [];
    const PAGE = 1000; // límite por defecto de filas por petición en Supabase
    for (let from = 0; ; from += PAGE) {
      const res = await withTimeout(
        sb.from("tickets").select("id,name,birth_date,checked_in_at").eq("event_id", ev.id).order("id").range(from, from + PAGE - 1),
        10000,
      );
      if (isNetworkFailure(res)) throw new Error("offline");
      if (res.error) throw res.error;
      rows.push(...res.data);
      if (res.data.length < PAGE) break;
    }
    if (state.event?.id !== ev.id) return;
    const fetchedAt = new Date().toISOString();
    await idb.put("snapshots", { event_id: ev.id, fetched_at: fetchedAt, tickets: rows });
    state.lastSnapshotAt = Date.now();
    applySnapshot(rows, fetchedAt);
    setOnline(true);
  }

  function renderStats() {
    let inside = 0;
    for (const t of state.tickets.values()) if (t.checked_in_at) inside++;
    $("stat-in").textContent = String(inside);
    $("stat-total").textContent = String(state.tickets.size);
  }

  function renderFooter() {
    const parts = [];
    parts.push(state.fetchedAt ? `Lista descargada a las ${hhmm(state.fetchedAt)}` : "Lista sin descargar");
    parts.push(`${state.queue.length} pendientes de sincronizar`);
    $("sync-info").textContent = parts.join(" · ");
    $("issues-btn").hidden = state.issues.length === 0;
    $("issues-count").textContent = String(state.issues.length);
  }

  // ------------------------------------------------------------------------
  // Check-in
  // ------------------------------------------------------------------------
  async function checkIn(code) {
    const ev = state.event;
    if (state.online) {
      let res = await withTimeout(sb.rpc("check_in", { p_ticket_id: code, p_event_id: ev.id })).catch(() => ({ status: 0 }));
      if (res.status === 401) {
        await sb.auth.refreshSession().catch(() => {});
        res = await withTimeout(sb.rpc("check_in", { p_ticket_id: code, p_event_id: ev.id })).catch(() => ({ status: 0 }));
      }
      if (!isNetworkFailure(res) && !res.error) {
        applyServerResult(code, res.data);
        return { ...res.data, offline: false };
      }
      if (res.error?.code === "42501") {
        return { status: "error", message: "Tu usuario ya no tiene permiso para validar entradas." };
      }
      setOnline(false); // red lenta o caída: seguimos con la lista local
    }
    return offlineCheckIn(code);
  }

  function applyServerResult(code, r) {
    const t = state.tickets.get(code.trim().toLowerCase());
    if (t && (r.status === "ok" || r.status === "used")) {
      t.checked_in_at = r.checked_in_at;
      t.local = false;
      renderStats();
    }
  }

  function offlineCheckIn(code) {
    const id = code.trim().toLowerCase();
    const t = UUID_RE.test(id) ? state.tickets.get(id) : null;
    if (!t) return { status: "invalid", offline: true };
    if (t.checked_in_at) return { status: "used", name: t.name, checked_in_at: t.checked_in_at, offline: true };

    const scannedAt = new Date().toISOString();
    t.checked_in_at = scannedAt;
    t.local = true;
    const item = { ticket_id: id, event_id: state.event.id, scanned_at: scannedAt, name: t.name };
    state.queue.push(item);
    idb.put("queue", item).then((key) => { item.key = key; });
    renderStats();
    setOnline(false);
    return { status: "ok", name: t.name, birth_date: t.birth_date, checked_in_at: scannedAt, offline: true };
  }

  // Token caducado: si no se puede renovar, pedimos volver a entrar SIN borrar la cola pendiente.
  async function renewOrRelogin() {
    const { error } = await sb.auth.refreshSession().catch(() => ({ error: { status: 0 } }));
    if (error && error.status) {
      show("screen-login");
      const err = $("login-error");
      err.textContent = "Tu sesión ha caducado. Vuelve a entrar: las validaciones pendientes se conservan.";
      err.hidden = false;
    }
  }

  async function syncQueue() {
    if (state.syncing || !state.online || !state.event) return;
    state.syncing = true;
    try {
      const items = (await idb.all("queue")).filter((q) => q.event_id === state.event.id);
      for (const q of items) {
        const res = await withTimeout(sb.rpc("check_in", {
          p_ticket_id: q.ticket_id, p_event_id: q.event_id, p_scanned_at: q.scanned_at,
        })).catch(() => ({ status: 0 }));
        if (isNetworkFailure(res)) { setOnline(false); break; }
        if (res.status === 401) { await renewOrRelogin(); break; }
        if (res.error) { console.error("sync", res.error); break; }

        const r = res.data;
        // "used" con la misma hora = ya lo habíamos sincronizado antes (p. ej. se cerró la app a mitad).
        const sameScan = r.status === "used" && Math.abs(new Date(r.checked_in_at) - new Date(q.scanned_at)) < 1000;
        if (r.status !== "ok" && !sameScan) {
          const { key: _key, ...rest } = q;
          const issue = { ...rest, server: r, detected_at: new Date().toISOString() };
          await idb.put("issues", issue);
          state.issues.push(issue);
        }
        await idb.del("queue", q.key);
        state.queue = state.queue.filter((x) => x.key !== q.key);
        const t = state.tickets.get(q.ticket_id);
        if (t && r.checked_in_at) { t.checked_in_at = r.checked_in_at; t.local = false; }
      }
    } finally {
      state.syncing = false;
      renderStats();
      setOnline(state.online);
    }
  }

  $("sync-btn").addEventListener("click", async () => {
    const btn = $("sync-btn");
    btn.disabled = true;
    btn.textContent = "Sincronizando…";
    state.online = true; // forzar un intento aunque creamos estar offline
    try {
      await syncQueue();
      if (state.online) await refreshSnapshot();
    } catch {
      setOnline(false);
    } finally {
      btn.disabled = false;
      btn.textContent = "Sincronizar";
    }
  });

  // ------------------------------------------------------------------------
  // Pantalla de resultado (verde / rojo)
  // ------------------------------------------------------------------------
  let autoClose = null;
  function showResult(r) {
    const box = $("result");
    const title = $("result-title");
    const name = $("result-name");
    const chip = $("result-chip");
    const time = $("result-time");
    const sub = $("result-sub");
    const next = $("result-next");

    box.className = "result";
    time.hidden = true;
    chip.textContent = "";
    name.textContent = "";
    sub.textContent = "";
    $("result-offline").hidden = !r.offline;

    if (r.status === "ok") {
      box.classList.add("ok");
      title.textContent = "¡Bienvenido!";
      name.textContent = r.name;
      const age = ageOf(r.birth_date);
      if (age !== null) chip.textContent = `${age} años`;
      sub.textContent = `Entrada validada a las ${hhmm(r.checked_in_at)}`;
      next.textContent = "Siguiente";
    } else if (r.status === "used") {
      box.classList.add("bad", "used");
      title.textContent = "Entrada ya utilizada";
      time.hidden = false;
      $("result-time-value").textContent = hhmm(r.checked_in_at);
      sub.textContent = r.name ? `A nombre de ${r.name}` : "";
      next.textContent = "Siguiente";
    } else if (r.status === "wrong_event") {
      box.classList.add("bad", "invalid");
      title.textContent = "Entrada de otro evento";
      sub.textContent = `Esta entrada es para «${r.event_name}», no para ${state.event.name}.`;
    } else if (r.status === "error") {
      box.classList.add("bad", "invalid");
      title.textContent = "No se puede validar";
      sub.textContent = r.message;
    } else {
      box.classList.add("bad", "invalid");
      title.textContent = "Entrada no válida";
      sub.textContent = r.offline
        ? `No está en la lista descargada${state.fetchedAt ? ` a las ${hhmm(state.fetchedAt)}` : ""}. Si se compró hace muy poco, compruébalo cuando vuelva la conexión.`
        : `Este código no corresponde a ninguna entrada de ${state.event.name}.`;
    }

    state.showingResult = true;
    box.hidden = false;
    beep(r.status === "ok");
    next.focus({ preventScroll: true });
    clearTimeout(autoClose);
    if (r.status === "ok") autoClose = setTimeout(hideResult, OK_AUTOCLOSE_MS);
  }

  function hideResult() {
    clearTimeout(autoClose);
    $("result").hidden = true;
    state.showingResult = false;
    state.lastCodeAt = Date.now(); // evita releer al instante el QR que sigue delante de la cámara
  }
  $("result-next").addEventListener("click", hideResult);
  // El verde se cierra tocando en cualquier sitio; el rojo solo con el botón, para no saltárselo sin querer.
  $("result").addEventListener("click", () => { if ($("result").classList.contains("ok")) hideResult(); });

  async function onCode(raw) {
    const code = String(raw).trim();
    const now = Date.now();
    if (state.showingResult || state.busy) return;
    if (code === state.lastCode && now - state.lastCodeAt < SAME_CODE_COOLDOWN_MS) return;
    state.lastCode = code;
    state.lastCodeAt = now;
    state.busy = true;
    $("camera-msg").textContent = "Comprobando…";
    try {
      showResult(await checkIn(code));
    } finally {
      state.busy = false;
      $("camera-msg").textContent = "Apunta a la entrada QR";
    }
  }

  // ------------------------------------------------------------------------
  // Cámara y lectura del QR (BarcodeDetector nativo si existe; si no, jsQR)
  // ------------------------------------------------------------------------
  const video = $("video");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stream = null;
  let detector = null;
  let scanning = false;
  let lastTick = 0;

  async function startCamera() {
    if (stream) return;
    try {
      if ("BarcodeDetector" in window) {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes("qr_code")) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      }
    } catch { detector = null; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      $("camera-msg").textContent = "Apunta a la entrada QR";
      scanning = true;
      requestAnimationFrame(tick);
    } catch (e) {
      $("camera-msg").textContent = e?.name === "NotAllowedError"
        ? "Permite el acceso a la cámara en los ajustes del navegador. Mientras, usa «Buscar / código»."
        : "No se ha podido abrir la cámara. Usa «Buscar / código».";
    }
  }

  function stopCamera() {
    scanning = false;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    wakeLock?.release?.().catch(() => {});
  }

  async function tick(ts) {
    if (!scanning) return;
    if (ts - lastTick > 120 && !state.showingResult && !state.busy && video.readyState >= 2) {
      lastTick = ts;
      const code = await readFrame();
      if (code) await onCode(code);
    }
    requestAnimationFrame(tick);
  }

  async function readFrame() {
    if (detector) {
      try {
        const found = await detector.detect(video);
        return found[0]?.rawValue ?? null;
      } catch {
        detector = null; // si falla una vez, pasamos a jsQR
      }
    }
    // Recorte cuadrado central reducido: más rápido en móviles modestos.
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const side = Math.min(vw, vh);
    const size = Math.min(side, 600);
    canvas.width = canvas.height = size;
    ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    const res = window.jsQR(img.data, size, size, { inversionAttempts: "dontInvert" });
    return res?.data ?? null;
  }

  // ------------------------------------------------------------------------
  // Búsqueda manual (QR ilegible, móvil sin batería...)
  // ------------------------------------------------------------------------
  const manual = $("manual");
  $("manual-btn").addEventListener("click", () => {
    $("manual-input").value = "";
    $("manual-results").replaceChildren();
    manual.showModal();
    $("manual-input").focus();
  });

  $("manual-input").addEventListener("input", () => {
    const q = $("manual-input").value.trim();
    const list = $("manual-results");
    list.replaceChildren();
    if (q.length < 2) return;

    let matches;
    if (UUID_RE.test(q)) {
      matches = [state.tickets.get(q.toLowerCase()) ?? { id: q.toLowerCase(), name: "Código completo", checked_in_at: null }];
    } else if (/^[0-9a-f]{6,8}$/i.test(q)) {
      const code = q.toUpperCase();
      matches = [...state.tickets.values()].filter((t) => shortCode(t.id).startsWith(code));
    } else {
      const f = fold(q);
      matches = [...state.tickets.values()].filter((t) => fold(t.name).includes(f));
    }

    if (!matches.length) {
      const li = document.createElement("li");
      li.className = "item";
      li.textContent = "Sin resultados en la lista descargada.";
      list.append(li);
      return;
    }
    for (const t of matches.slice(0, 20)) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      const n = document.createElement("span");
      n.textContent = `${t.name} · ${shortCode(t.id)}`;
      const tag = document.createElement("span");
      tag.className = t.checked_in_at ? "tag in" : "tag";
      tag.textContent = t.checked_in_at ? `Dentro ${hhmm(t.checked_in_at)}` : "Validar";
      b.append(n, tag);
      b.addEventListener("click", () => { manual.close(); state.lastCode = null; onCode(t.id); });
      li.append(b);
      list.append(li);
    }
  });

  // Foto del QR: para cuando la cámara en directo no funciona (permisos, móvil antiguo...).
  $("photo-input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const err = $("photo-error");
    err.hidden = true;
    try {
      const code = await decodeImage(file);
      if (!code) throw new Error("No se ve ningún QR en la foto. Prueba a hacerla más cerca y con luz.");
      manual.close();
      state.lastCode = null;
      onCode(code);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  async function decodeImage(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(bitmap, 0, 0, w, h);
    const img = cx.getImageData(0, 0, w, h);
    return window.jsQR(img.data, w, h)?.data ?? null;
  }

  // ------------------------------------------------------------------------
  // Incidencias
  // ------------------------------------------------------------------------
  $("issues-btn").addEventListener("click", () => {
    const list = $("issues-list");
    list.replaceChildren();
    for (const i of state.issues) {
      const li = document.createElement("li");
      li.className = "item";
      const what = i.server.status === "used"
        ? `ya validada a las ${hhmm(i.server.checked_in_at)} en otra puerta`
        : i.server.status === "wrong_event" ? "es de otro evento" : "no válida";
      li.textContent = `${i.name ?? shortCode(i.ticket_id)} (${shortCode(i.ticket_id)}): escaneada sin conexión a las ${hhmm(i.scanned_at)}, ${what}.`;
      list.append(li);
    }
    $("issues").showModal();
  });
  $("issues-clear").addEventListener("click", async () => {
    await idb.clear("issues");
    state.issues = [];
    renderFooter();
    $("issues").close();
  });
  $("net-pill").addEventListener("click", () => $("sync-btn").click());

  // ------------------------------------------------------------------------
  // Arranque
  // ------------------------------------------------------------------------
  async function boot() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    setOnline(navigator.onLine);

    const saved = JSON.parse(localStorage.getItem("checkin-event") || "null");
    const { data } = await sb.auth.getSession();
    const user = data.session?.user;

    if (!user) {
      // Sin conexión y con la sesión caducada no se puede renovar el token, pero la puerta no se
      // puede parar: si este móvil ya era de un organizador, seguimos con la lista local y la cola.
      const cachedOrganizer = localStorage.getItem("checkin-organizer");
      if (!navigator.onLine && cachedOrganizer && saved) {
        state.user = { id: cachedOrganizer, email: localStorage.getItem("checkin-email") ?? "" };
        await selectEvent(saved);
        return;
      }
      show("screen-login");
      return;
    }
    if (!(await isOrganizer(user.id))) {
      show("screen-login");
      return;
    }
    state.user = user;
    if (saved) await selectEvent(saved);
    else await openEvents();
  }

  // La demo usa esto para "escanear" una entrada desde el buzón de ejemplo.
  window.DEMO_HOOKS?.checkinReady?.((code) => { state.lastCode = null; return onCode(code); }, () => !!state.event);

  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && state.user) location.reload();
  });

  boot();
})();
