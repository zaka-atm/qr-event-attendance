// Recepció · Congrés Islàmic de Catalunya
// Escaneja el QR que ja reben els assistents (URL del doGet amb nom, dni, numero i tipusAsistencia),
// pregunta a l'Apps Script de recepció si la persona pot passar i ho mostra a pantalla completa.
// Sense connexió, valida amb la llista descarregada i guarda els registres per enviar-los després.
(() => {
  "use strict";

  const CFG = window.RECEPCIO || {};
  const $ = (id) => document.getElementById(id);
  // Apps Script pot trigar uns segons, sobretot la primera consulta després d'estar aturat.
  const TEMPS_API_MS = { registrar: 15000, cercar: 12000, ping: 12000, sincronitzar: 30000 };
  const TEMPS_SI_SEMBLA_OFFLINE_MS = 6000;
  const BATEC_MS = 20000;             // cada quant es reintenta la cua / es comprova la connexió
  const SINCRO_MS = 3 * 60000;        // cada quant es refresca la llista per al mode sense connexió
  const MATEIX_CODI_MS = 4000;        // no tornar a llegir el mateix QR just després

  // ------------------------------------------------------------------------
  // Emmagatzematge local (tot amb try/catch: pot no estar disponible)
  // ------------------------------------------------------------------------
  const guarda = {
    get(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ple o bloquejat */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* res */ } },
  };
  const K = { sessio: "recepcio-sessio", cache: "recepcio-cache", cua: "recepcio-cua", hist: "recepcio-historial", inc: "recepcio-incidencies" };

  const estat = {
    sessio: guarda.get(K.sessio, null),      // { apiUrl, codi }
    cache: guarda.get(K.cache, null),        // { persones: [{h,n,t,f,r}], a, estadistiques }
    cua: guarda.get(K.cua, []),              // registres pendents d'enviar
    historial: guarda.get(K.hist, []),
    incidencies: guarda.get(K.inc, []),
    enLinia: navigator.onLine,
    ocupat: false,
    mostrantResultat: false,
    darrerCodi: null,
    darrerCodiA: 0,
    enviantCua: false,
  };

  // ------------------------------------------------------------------------
  // Utilitats
  // ------------------------------------------------------------------------
  const normDni = (v) => String(v ?? "").toUpperCase().replace(/[\s.\-]/g, "");
  const normText = (v) => String(v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const hora = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const h = d.toLocaleTimeString("ca-ES", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? h : `${d.toLocaleDateString("ca-ES", { day: "numeric", month: "numeric" })} ${h}`;
  };
  const ambHora = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const h = d.toLocaleTimeString("ca-ES", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString()
      ? `a les ${h}`
      : `el ${d.toLocaleDateString("ca-ES", { day: "numeric", month: "numeric" })} a les ${h}`;
  };
  const el = (tag, props = {}, ...fills) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...fills.filter((f) => f !== null && f !== undefined && f !== false));
    return n;
  };
  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  /**
   * El QR conté l'URL del doGet: https://script.google.com/macros/s/…/exec?nom=…&dni=…&numero=…&tipusAsistencia=…
   * Acceptem també variants (només els paràmetres, majúscules, "tipusAssistencia"…).
   */
  function llegirQR(text) {
    const t = String(text ?? "").trim();
    let params;
    try {
      params = new URL(t).searchParams;
    } catch {
      params = new URLSearchParams(t.includes("?") ? t.slice(t.indexOf("?") + 1) : t);
    }
    const valor = (...claus) => {
      for (const clau of claus) for (const [k, v] of params) if (k.toLowerCase() === clau.toLowerCase()) return v.trim();
      return "";
    };
    const dni = valor("dni", "nie", "dni/nie");
    if (!dni) return null;
    return {
      nom: valor("nom", "name", "nomicognoms"),
      dni,
      numero: valor("numero", "número", "telefon", "telèfon"),
      tipus: valor("tipusAsistencia", "tipusAssistencia", "tipus", "tipusassistència"),
    };
  }

  // ------------------------------------------------------------------------
  // API (Apps Script)
  // ------------------------------------------------------------------------
  class SenseConnexio extends Error {
    constructor(motiu) { super(motiu); this.temps = motiu === "temps"; }
  }

  async function api(accio, dades = {}, tempsMax = TEMPS_API_MS[accio] ?? 12000) {
    const s = estat.sessio;
    const cos = { accio, codi: s.codi, ...dades };

    const ctrl = new AbortController();
    let esgotat = false;
    const temps = setTimeout(() => { esgotat = true; ctrl.abort(); }, tempsMax);
    let res;
    try {
      // text/plain evita la comprovació prèvia CORS; Apps Script llegeix el JSON igualment.
      res = await fetch(s.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(cos),
        signal: ctrl.signal,
        redirect: "follow",
      });
    } catch {
      throw new SenseConnexio(esgotat ? "temps" : "xarxa");
    } finally {
      clearTimeout(temps);
    }
    if (!res.ok) throw new SenseConnexio(`http ${res.status}`);
    const json = await res.json().catch(() => { throw new SenseConnexio("resposta"); });
    if (!json.ok && json.error === "codi_incorrecte") {
      tornarAInici("El codi d'accés ja no és vàlid. Demana el nou codi a l'organització.");
      throw new Error("codi_incorrecte");
    }
    return json;
  }

  // ------------------------------------------------------------------------
  // Pantalles
  // ------------------------------------------------------------------------
  function mostrar(vista) {
    $("vista-inici").hidden = vista !== "inici";
    $("vista-escaner").hidden = vista !== "escaner";
    document.body.classList.toggle("a-escaner", vista === "escaner");
    if (vista === "escaner") engegarCamera(); else aturarCamera();
  }

  function tornarAInici(missatge) {
    const s = estat.sessio;
    estat.sessio = null;
    guarda.del(K.sessio);
    mostrar("inici");
    omplirInici(s);
    if (missatge) mostrarErrorInici(missatge);
  }

  function omplirInici(previ) {
    $("inici-esdeveniment").textContent = CFG.ESDEVENIMENT || "Congrés Islàmic de Catalunya";
    const apiFixa = !!CFG.API_URL;
    $("camp-api").hidden = apiFixa;
    $("api-url").value = apiFixa ? CFG.API_URL : (previ?.apiUrl ?? guarda.get("recepcio-darrera-api", ""));
  }

  function mostrarErrorInici(text) {
    $("inici-error").textContent = text;
    $("inici-error").hidden = false;
  }

  $("form-inici").addEventListener("submit", async (e) => {
    e.preventDefault();
    desbloquejarAudio();
    $("inici-error").hidden = true;
    const apiUrl = (CFG.API_URL || $("api-url").value).trim();
    const codi = $("codi").value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(apiUrl)) return mostrarErrorInici("Enganxa l'adreça de l'Apps Script (comença per https://script.google.com/…).");
    if (!codi) return mostrarErrorInici("Escriu el codi d'accés.");

    const boto = $("inici-boto");
    boto.disabled = true;
    boto.querySelector("span").textContent = "Connectant…";
    estat.sessio = { apiUrl, codi };
    try {
      const r = await api("ping");
      if (!r.ok) throw new Error(r.error || "error");
      guarda.set(K.sessio, estat.sessio);
      guarda.set("recepcio-darrera-api", apiUrl);
      $("codi").value = "";
      pintarEstadistiques(r.estadistiques);
      entrarEscaner();
    } catch (err) {
      estat.sessio = null;
      if (err instanceof SenseConnexio) mostrarErrorInici("No s'ha pogut connectar. Revisa l'adreça i que el mòbil tingui internet.");
      else if (err.message === "codi_incorrecte") mostrarErrorInici("Codi d'accés incorrecte.");
      else mostrarErrorInici("L'Apps Script ha respost amb un error. Revisa que estigui ben configurat.");
    } finally {
      boto.disabled = false;
      boto.querySelector("span").textContent = "Entrar";
    }
  });

  function entrarEscaner() {
    $("barra-esdeveniment").textContent = CFG.ESDEVENIMENT || "Congrés Islàmic de Catalunya";
    mostrar("escaner");
    mantenirPantalla();
    pintarEstadistiques(estat.cache?.estadistiques);
    pintarXarxa();
    sincronitzar().then(enviarCua);
  }

  // ------------------------------------------------------------------------
  // Estadístiques i estat de la connexió
  // ------------------------------------------------------------------------
  function pintarEstadistiques(e) {
    if (!e) return;
    $("n-registrats").textContent = String(e.registrats);
    $("n-pagats").textContent = String(e.pagats);
    const queden = Math.max(0, e.pagats - e.registrats);
    $("n-queden").textContent = queden === 0 && e.pagats ? "Tothom dins" : `Falten ${queden}`;
    $("progres").style.width = `${e.pagats ? Math.min(100, (e.registrats / e.pagats) * 100) : 0}%`;
    if (estat.cache) { estat.cache.estadistiques = e; guarda.set(K.cache, estat.cache); }
  }

  function posarEnLinia(valor) {
    estat.enLinia = valor;
    pintarXarxa();
  }

  function pintarXarxa() {
    const b = $("estat-xarxa");
    const n = estat.cua.length;
    b.classList.toggle("offline", !estat.enLinia);
    b.classList.toggle("pendent", estat.enLinia && n > 0);
    $("estat-text").textContent = !estat.enLinia
      ? (n ? `Sense connexió · ${n}` : "Sense connexió")
      : (n ? `Enviant ${n}…` : "En línia");
    b.setAttribute("aria-label", !estat.enLinia
      ? `Sense connexió${n ? `, ${n} registres pendents d'enviar` : ""}. Toca per tornar-ho a provar.`
      : n ? `${n} registres pendents d'enviar` : "En línia");
  }

  window.addEventListener("online", () => batec());
  window.addEventListener("offline", () => posarEnLinia(false));
  $("estat-xarxa").addEventListener("click", () => batec(true));

  let darreraSincro = 0;
  async function batec(forcat = false) {
    if (!estat.sessio) return;
    if (!estat.enLinia || forcat) {
      try {
        const r = await api("ping");
        if (r.ok) { posarEnLinia(true); pintarEstadistiques(r.estadistiques); }
      } catch { posarEnLinia(false); return; }
    }
    await enviarCua();
    if (Date.now() - darreraSincro > SINCRO_MS) await sincronitzar();
  }
  setInterval(() => batec(), BATEC_MS);

  async function sincronitzar() {
    try {
      const r = await api("sincronitzar");
      if (!r.ok) return;
      // Els registres pendents d'enviar continuen comptant com a fets.
      const pendents = new Set(estat.cua.map((c) => c.h).filter(Boolean));
      const pendentsFila = new Set(estat.cua.map((c) => c.fila).filter(Boolean));
      for (const p of r.persones) if (!p.r && (pendents.has(p.h) || pendentsFila.has(p.f))) p.r = new Date().toISOString();
      estat.cache = { persones: r.persones, a: r.a, estadistiques: r.estadistiques };
      guarda.set(K.cache, estat.cache);
      darreraSincro = Date.now();
      pintarEstadistiques(r.estadistiques);
      posarEnLinia(true);
      pintarMenu();
    } catch (e) {
      if (e instanceof SenseConnexio && !e.temps) posarEnLinia(false);
    }
  }

  async function enviarCua() {
    if (estat.enviantCua || !estat.cua.length || !estat.sessio) return;
    estat.enviantCua = true;
    pintarXarxa();
    try {
      while (estat.cua.length) {
        const item = estat.cua[0];
        let r;
        try {
          r = await api("registrar", { qr: item.qr, fila: item.fila, metode: item.metode, escanejatA: item.escanejatA });
        } catch (e) {
          if (e instanceof SenseConnexio) posarEnLinia(false);
          break;
        }
        posarEnLinia(true);
        const mateix = r.estat === "ja_registrat" && r.registratA && Math.abs(new Date(r.registratA) - new Date(item.escanejatA)) < 2000;
        if (r.estat !== "correcte" && !mateix) {
          estat.incidencies.unshift({
            nom: r.persona?.nom || item.nom || item.qr?.nom || "Sense nom",
            escanejatA: item.escanejatA,
            estat: r.estat,
            registratA: r.registratA || null,
          });
          guarda.set(K.inc, estat.incidencies.slice(0, 100));
        }
        if (r.estadistiques) pintarEstadistiques(r.estadistiques);
        estat.cua.shift();
        guarda.set(K.cua, estat.cua);
      }
    } finally {
      estat.enviantCua = false;
      pintarXarxa();
      pintarMenu();
    }
  }

  // ------------------------------------------------------------------------
  // Registrar (QR o manual)
  // ------------------------------------------------------------------------
  async function processarCodi(text, metode = "qr") {
    if (estat.mostrantResultat || estat.ocupat) return;
    const ara = Date.now();
    if (text === estat.darrerCodi && ara - estat.darrerCodiA < MATEIX_CODI_MS) return;
    estat.darrerCodi = text;
    estat.darrerCodiA = ara;

    const qr = llegirQR(text);
    if (!qr) return mostrarResultat({ estat: "qr_no_valid" });
    await registrar({ qr, metode });
  }

  async function registrar({ qr = null, fila = null, metode = "qr", nom = "" }) {
    estat.ocupat = true;
    $("comprovant").hidden = false;
    try {
      // Sempre es pregunta primer al full; només si no respon es fa servir la llista del mòbil.
      if (navigator.onLine !== false) {
        try {
          const r = await api("registrar", { qr, fila, metode }, estat.enLinia ? TEMPS_API_MS.registrar : TEMPS_SI_SEMBLA_OFFLINE_MS);
          posarEnLinia(true);
          if (!r.ok) return mostrarResultat({ estat: "error_servidor" });
          actualitzarCache(r);
          if (r.estadistiques) pintarEstadistiques(r.estadistiques);
          return mostrarResultat({ ...r, qrNom: qr?.nom, qrDni: qr?.dni });
        } catch (e) {
          if (!(e instanceof SenseConnexio)) return;
          posarEnLinia(false);
        }
      }
      return mostrarResultat(await registrarSenseConnexio({ qr, fila, metode, nom }));
    } finally {
      estat.ocupat = false;
      $("comprovant").hidden = true;
    }
  }

  function actualitzarCache(r) {
    if (!estat.cache || !r.persona) return;
    const p = estat.cache.persones.find((x) => x.f === r.persona.fila);
    if (p && (r.estat === "correcte" || r.estat === "ja_registrat")) p.r = r.registratA || p.r || "si";
    guarda.set(K.cache, estat.cache);
  }

  async function registrarSenseConnexio({ qr, fila, metode, nom }) {
    const persones = estat.cache?.persones;
    if (!persones) return { estat: "sense_llista", offline: true };
    const h = qr ? await sha256(normDni(qr.dni)) : null;
    const p = fila ? persones.find((x) => x.f === fila) : persones.find((x) => x.h === h);
    if (!p) return { estat: "no_pagat", offline: true, qrNom: qr?.nom, qrDni: qr?.dni };
    const persona = { nom: p.n, tipus: p.t, dni: qr?.dni || "", fila: p.f };
    if (p.r) return { estat: "ja_registrat", offline: true, persona, registratA: p.r === "si" ? null : p.r };

    const escanejatA = new Date().toISOString();
    p.r = escanejatA;
    guarda.set(K.cache, estat.cache);
    estat.cua.push({ id: uid(), qr, fila: qr ? null : p.f, h: p.h, metode, escanejatA, nom: p.n || nom });
    guarda.set(K.cua, estat.cua);
    const e = estat.cache.estadistiques;
    if (e) pintarEstadistiques({ ...e, registrats: e.registrats + 1 });
    pintarXarxa();
    return { estat: "correcte", offline: true, persona, registratA: escanejatA };
  }

  // ------------------------------------------------------------------------
  // Pantalla de resultat
  // ------------------------------------------------------------------------
  function mostrarResultat(r) {
    for (const d of document.querySelectorAll("dialog[open]")) d.close(); // el resultat sempre per sobre
    const caixa = $("resultat");
    const ok = r.estat === "correcte";
    const repetit = r.estat === "ja_registrat";
    caixa.className = `resultat ${ok ? "ok" : "ko"} ${repetit ? "repetit" : "no-valid"}`;

    const persona = r.persona;
    const nom = persona?.nom || r.qrNom || "";
    $("res-fitxa").hidden = !nom;
    $("res-nom").textContent = nom;
    $("res-tipus").textContent = persona?.tipus || "";
    $("res-dni").textContent = persona?.dni || r.qrDni || "—";
    $("res-hora-bloc").hidden = !r.registratA || !(ok || repetit);
    $("res-hora-etiqueta").textContent = ok ? "Hora d'entrada" : "Ja va entrar";
    $("res-hora").textContent = r.registratA ? hora(r.registratA) : "";

    const textos = {
      correcte: ["Pot passar", "Entrada registrada correctament"],
      ja_registrat: ["No pot passar", "Aquesta entrada ja s'ha utilitzat"],
      no_pagat: ["No pot passar", r.offline ? "No apareix a la llista descarregada" : "No consta a la llista de pagaments"],
      qr_no_valid: ["Codi no vàlid", "Aquest QR no és una entrada del Congrés"],
      sense_llista: ["Sense connexió", "Connecta't a internet i torna-ho a provar"],
      error_servidor: ["Error", "No s'ha pogut comprovar. Torna-ho a provar"],
    };
    const [titol, motiu] = textos[r.estat] || ["No pot passar", ""];
    $("res-titol").textContent = titol;
    $("res-motiu").textContent = motiu;

    // Es queda a la pantalla fins que es prem «Escanejar el següent».
    estat.mostrantResultat = true;
    caixa.hidden = false;
    caixa.scrollTop = 0;
    so(ok);
    $("res-seguent").focus({ preventScroll: true });

    afegirHistorial({ a: new Date().toISOString(), nom: nom || "Codi no vàlid", estat: r.estat, tipus: persona?.tipus || "", offline: !!r.offline });
  }

  function amagarResultat() {
    $("resultat").hidden = true;
    estat.mostrantResultat = false;
    estat.darrerCodiA = Date.now(); // el mateix QR encara pot ser davant la càmera
  }
  $("res-seguent").addEventListener("click", amagarResultat);
  document.addEventListener("keydown", (e) => {
    if (estat.mostrantResultat && (e.key === "Enter" || e.key === " ") && document.activeElement !== $("res-seguent")) {
      e.preventDefault();
      amagarResultat();
    }
  });

  // ------------------------------------------------------------------------
  // So, vibració i pantalla encesa
  // ------------------------------------------------------------------------
  let audio = null;
  function desbloquejarAudio() {
    try { audio ??= new AudioContext(); audio.resume(); } catch { /* sense so */ }
  }
  document.addEventListener("pointerdown", desbloquejarAudio, { once: true, capture: true });
  function so(ok) {
    navigator.vibrate?.(ok ? 90 : [220, 90, 220]);
    if (!audio) return;
    const notes = ok ? [[784, 0, .12], [1175, .12, .18]] : [[311, 0, .22], [233, .26, .32]];
    for (const [f, t, d] of notes) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = ok ? "sine" : "square";
      o.frequency.value = f;
      g.gain.setValueAtTime(.22, audio.currentTime + t);
      g.gain.exponentialRampToValueAtTime(.001, audio.currentTime + t + d);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + t);
      o.stop(audio.currentTime + t + d);
    }
  }

  let wakeLock = null;
  async function mantenirPantalla() {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* no disponible */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !$("vista-escaner").hidden) { mantenirPantalla(); batec(); }
  });

  // ------------------------------------------------------------------------
  // Càmera i lectura del QR
  // ------------------------------------------------------------------------
  const video = $("video");
  const llenç = document.createElement("canvas");
  const ctx = llenç.getContext("2d", { willReadFrequently: true });
  let flux = null;
  let detector = null;
  let escanejant = false;
  let darrerFotograma = 0;
  let llanternaOn = false;

  async function engegarCamera() {
    if (flux) return;
    $("visor-error").hidden = true;
    try {
      if ("BarcodeDetector" in window && (await window.BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
        detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      }
    } catch { detector = null; }
    try {
      flux = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = flux;
      await video.play();
      escanejant = true;
      requestAnimationFrame(bucle);
      const pista = flux.getVideoTracks()[0];
      const capacitats = pista.getCapabilities?.() ?? {};
      $("llanterna").hidden = !capacitats.torch;
    } catch (e) {
      flux = null;
      $("visor-error-text").textContent = e?.name === "NotAllowedError"
        ? "Cal permís per fer servir la càmera. Activa'l a la configuració del navegador per a aquesta web."
        : "No s'ha pogut obrir la càmera. Pots fer una foto del QR o cercar la persona pel nom.";
      $("visor-error").hidden = false;
    }
  }

  function aturarCamera() {
    escanejant = false;
    flux?.getTracks().forEach((t) => t.stop());
    flux = null;
    llanternaOn = false;
    $("llanterna").setAttribute("aria-pressed", "false");
  }

  async function bucle(t) {
    if (!escanejant) return;
    const obert = document.querySelector("dialog[open]");
    if (t - darrerFotograma > 110 && !estat.mostrantResultat && !estat.ocupat && !obert && video.readyState >= 2) {
      darrerFotograma = t;
      const codi = await llegirFotograma();
      if (codi) await processarCodi(codi);
    }
    requestAnimationFrame(bucle);
  }

  async function llegirFotograma() {
    if (detector) {
      try {
        const trobats = await detector.detect(video);
        return trobats[0]?.rawValue ?? null;
      } catch { detector = null; }
    }
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !window.jsQR) return null;
    const costat = Math.min(vw, vh);
    const mida = Math.min(costat, 640);
    llenç.width = llenç.height = mida;
    ctx.drawImage(video, (vw - costat) / 2, (vh - costat) / 2, costat, costat, 0, 0, mida, mida);
    const img = ctx.getImageData(0, 0, mida, mida);
    return window.jsQR(img.data, mida, mida, { inversionAttempts: "dontInvert" })?.data ?? null;
  }

  $("reintentar-camera").addEventListener("click", engegarCamera);
  $("llanterna").addEventListener("click", async () => {
    const pista = flux?.getVideoTracks()[0];
    if (!pista) return;
    llanternaOn = !llanternaOn;
    try { await pista.applyConstraints({ advanced: [{ torch: llanternaOn }] }); } catch { llanternaOn = false; }
    $("llanterna").setAttribute("aria-pressed", String(llanternaOn));
  });

  $("foto-qr").addEventListener("change", async (e) => {
    const fitxer = e.target.files?.[0];
    e.target.value = "";
    if (!fitxer) return;
    try {
      const bmp = await createImageBitmap(fitxer);
      const escala = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * escala), h = Math.round(bmp.height * escala);
      llenç.width = w;
      llenç.height = h;
      ctx.drawImage(bmp, 0, 0, w, h);
      const codi = window.jsQR?.(ctx.getImageData(0, 0, w, h).data, w, h)?.data;
      if (!codi) return mostrarResultat({ estat: "qr_no_valid" });
      estat.darrerCodi = null;
      processarCodi(codi);
    } catch {
      mostrarResultat({ estat: "qr_no_valid" });
    }
  });

  // ------------------------------------------------------------------------
  // Cerca manual
  // ------------------------------------------------------------------------
  const dlgCerca = $("dlg-cerca");
  let cercaId = 0;
  let cercaTemps = null;

  $("obrir-cerca").addEventListener("click", () => {
    $("cerca-text").value = "";
    $("cerca-resultats").replaceChildren();
    $("cerca-nota").textContent = "Per a qui no porta el QR o si no es pot llegir.";
    dlgCerca.showModal();
    $("cerca-text").focus();
  });

  $("cerca-text").addEventListener("input", () => {
    clearTimeout(cercaTemps);
    cercaTemps = setTimeout(cercar, 300);
  });

  async function cercar() {
    const text = $("cerca-text").value.trim();
    const id = ++cercaId;
    const llista = $("cerca-resultats");
    if (text.length < 2) { llista.replaceChildren(); return; }

    let resultats = null;
    if (navigator.onLine !== false) {
      $("cerca-nota").textContent = "Cercant…";
      try {
        const r = await api("cercar", { text });
        if (r.ok) resultats = r.resultats.map((x) => ({ ...x, offline: false }));
      } catch (e) {
        if (e instanceof SenseConnexio && !e.temps) posarEnLinia(false);
      }
    }
    if (!resultats) {
      const q = normText(text);
      resultats = (estat.cache?.persones ?? [])
        .filter((p) => normText(p.n).includes(q))
        .slice(0, 20)
        .map((p) => ({ nom: p.n, tipus: p.t, fila: p.f, dni: "", registrat: !!p.r, registratA: p.r && p.r !== "si" ? p.r : null, offline: true }));
    }
    if (id !== cercaId) return;
    $("cerca-nota").textContent = resultats.length
      ? (resultats[0].offline ? "Sense connexió: resultats de la llista descarregada (només per nom)." : `${resultats.length} ${resultats.length === 1 ? "resultat" : "resultats"}`)
      : "No hi ha ningú amb aquest nom o DNI a la llista de pagaments.";
    llista.replaceChildren(...resultats.map(elementCerca));
  }

  function elementCerca(p) {
    const li = el("li", { className: "element" });
    const cap = el("div", { className: "element-cap" },
      el("div", {}, el("strong", { textContent: p.nom }), el("small", { textContent: [p.tipus, p.dni].filter(Boolean).join(" · ") })),
      p.registrat
        ? el("span", { className: "xip ko", textContent: p.registratA ? `Ja entrat ${hora(p.registratA)}` : "Ja entrat" })
        : el("span", { className: "xip ok", textContent: "Pendent" }),
    );
    li.append(cap);
    if (!p.registrat) {
      const boto = el("button", { className: "boto principal", type: "button", textContent: "Registrar l'entrada" });
      boto.addEventListener("click", () => {
        const conf = el("div", { className: "confirmacio" },
          el("p", { textContent: `Has comprovat la identitat de ${p.nom}?` }),
          el("div", { className: "fila-botons" },
            el("button", { className: "boto principal", type: "button", textContent: "Sí, registrar", onclick: async () => {
              dlgCerca.close();
              await registrar({ fila: p.fila, metode: "manual", nom: p.nom });
            } }),
            el("button", { className: "boto", type: "button", textContent: "Cancel·lar", onclick: () => conf.replaceWith(boto) }),
          ),
        );
        boto.replaceWith(conf);
      });
      li.append(boto);
    }
    return li;
  }

  // ------------------------------------------------------------------------
  // Historial
  // ------------------------------------------------------------------------
  function afegirHistorial(e) {
    estat.historial.unshift(e);
    estat.historial = estat.historial.slice(0, 100);
    guarda.set(K.hist, estat.historial);
  }

  const ETIQUETES = {
    correcte: ["Ha passat", "ok"],
    ja_registrat: ["Ja havia entrat", "ko"],
    no_pagat: ["No pagat", "ko"],
    qr_no_valid: ["QR no vàlid", "ko"],
    sense_llista: ["Sense llista", "avis"],
    error_servidor: ["Error", "avis"],
  };

  $("obrir-historial").addEventListener("click", () => {
    const llista = $("historial");
    llista.replaceChildren(...estat.historial.map((h) => {
      const [text, classe] = ETIQUETES[h.estat] ?? ["—", "neutre"];
      return el("li", { className: "element" },
        el("div", { className: "element-cap" },
          el("div", {}, el("strong", { textContent: h.nom }), el("small", { textContent: [hora(h.a), h.tipus, h.offline ? "sense connexió" : ""].filter(Boolean).join(" · ") })),
          el("span", { className: `xip ${classe}`, textContent: text }),
        ));
    }));
    $("historial-buit").hidden = estat.historial.length > 0;
    $("dlg-historial").showModal();
  });

  // ------------------------------------------------------------------------
  // Menú
  // ------------------------------------------------------------------------
  function pintarMenu() {
    if (!estat.sessio) return;
    $("menu-sincro").textContent = estat.cache?.a
      ? `${estat.cache.persones.length} persones · ${hora(estat.cache.a)}${estat.cua.length ? ` · ${estat.cua.length} pendents d'enviar` : ""}`
      : "Encara no s'ha descarregat";
    $("menu-incidencies-fila").hidden = estat.incidencies.length === 0;
    $("menu-incidencies-text").textContent = `${estat.incidencies.length} per revisar`;
  }

  $("obrir-menu").addEventListener("click", () => {
    pintarMenu();
    $("confirmar-sortir").hidden = true;
    $("incidencies").hidden = true;
    $("dlg-menu").showModal();
  });

  $("sincronitzar").addEventListener("click", async () => {
    const b = $("sincronitzar");
    b.disabled = true;
    b.textContent = "Actualitzant…";
    await batec(true);
    await sincronitzar();
    b.disabled = false;
    b.textContent = "Actualitzar";
    pintarMenu();
  });

  $("veure-incidencies").addEventListener("click", () => {
    const llista = $("incidencies");
    llista.replaceChildren(...estat.incidencies.map((i) => el("li", { className: "element" },
      el("div", { className: "element-cap" },
        el("div", {},
          el("strong", { textContent: i.nom }),
          el("small", { textContent: `Escanejat sense connexió ${ambHora(i.escanejatA)}. ${i.estat === "ja_registrat"
            ? `Ja havia entrat ${i.registratA ? ambHora(i.registratA) : "abans"}.`
            : i.estat === "no_pagat" ? "No consta com a pagat." : "No s'ha pogut registrar."}` })),
        el("span", { className: "xip avis", textContent: "Revisar" }),
      ))));
    llista.hidden = false;
  });

  $("tancar-sessio").addEventListener("click", () => {
    $("confirmar-sortir-text").textContent = estat.cua.length
      ? `Hi ha ${estat.cua.length} registres sense enviar. Si tanques la sessió es perdran. Continuar?`
      : "Es tancarà la sessió i s'esborraran les dades d'aquest mòbil.";
    $("confirmar-sortir").hidden = false;
  });
  $("sortir-no").addEventListener("click", () => { $("confirmar-sortir").hidden = true; });
  $("sortir-si").addEventListener("click", () => {
    for (const k of Object.values(K)) guarda.del(k);
    estat.cache = null;
    estat.cua = [];
    estat.historial = [];
    estat.incidencies = [];
    $("dlg-menu").close();
    tornarAInici();
  });

  for (const b of document.querySelectorAll("[data-tancar]")) b.addEventListener("click", () => b.closest("dialog").close());
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); }); // tocar fora tanca
  }

  // ------------------------------------------------------------------------
  // Logo (enllaç públic; si no carrega, es veu el nom en text)
  // ------------------------------------------------------------------------
  // El logo que ha carregat es fa servir també com a icona de la pestanya (i de la pantalla d'inici a iOS).
  let faviconPosat = false;
  function posarFavicon(url) {
    if (faviconPosat || !url) return;
    faviconPosat = true;
    const ico = $("favicon");
    ico.removeAttribute("type");
    ico.href = url;
    $("favicon-apple").href = url;
  }

  function carregarLogos() {
    const urls = Array.isArray(CFG.LOGO) ? CFG.LOGO : CFG.LOGO ? [CFG.LOGO] : [];
    for (const caixa of document.querySelectorAll("[data-logo]")) {
      const img = caixa.querySelector("[data-logo-img]");
      let i = 0;
      const seguent = () => {
        if (i >= urls.length) { caixa.classList.add("sense-imatge"); return; }
        img.src = urls[i++];
      };
      img.addEventListener("error", seguent);
      img.addEventListener("load", () => {
        caixa.classList.remove("sense-imatge");
        posarFavicon(img.currentSrc || img.src);
      });
      if (!urls.length) caixa.classList.add("sense-imatge");
      else seguent();
    }
  }

  $("veure-codi").addEventListener("click", () => {
    const input = $("codi");
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    $("veure-codi").setAttribute("aria-pressed", String(!visible));
    $("veure-codi").setAttribute("aria-label", visible ? "Mostrar el codi" : "Amagar el codi");
    input.focus();
  });

  // ------------------------------------------------------------------------
  // Arrencada
  // ------------------------------------------------------------------------
  async function arrencar() {
    carregarLogos();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    if (estat.sessio?.demo) { estat.sessio = null; guarda.del(K.sessio); } // el mode de prova ja no existeix
    if (estat.sessio) {
      // Si l'adreça de l'Apps Script canvia a config.js, els mòbils ja connectats la fan servir sense tornar a entrar.
      if (CFG.API_URL && estat.sessio.apiUrl !== CFG.API_URL) {
        estat.sessio.apiUrl = CFG.API_URL;
        guarda.set(K.sessio, estat.sessio);
      }
      entrarEscaner();
    } else {
      omplirInici(null);
      mostrar("inici");
    }
  }

  // Per a les proves automàtiques
  window.__recepcio = { llegirQR };

  arrencar();
})();
