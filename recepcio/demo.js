// Mode demostració: simula l'Apps Script de recepció amb persones INVENTADES.
// Mateixes regles que apps-script/Codi.gs. Les dades es guarden només en aquest navegador.
(() => {
  "use strict";
  const CLAU = "recepcio-demo-db";
  const normDni = (v) => String(v ?? "").toUpperCase().replace(/[\s.\-]/g, "");
  const normText = (v) => String(v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  const PERSONES = [
    ["aya@example.com", "Aya El Idrissi", "11111111H", "600000001", "Pensió completa"],
    ["bilal@example.com", "Bilal Chakir", "22222222J", "600000002", "Pensió completa"],
    ["salma@example.com", "Salma Haddad", "33333333P", "600000003", "Només dissabte"],
    ["ibrahim@example.com", "Ibrahim Ouali", "44444444A", "600000004", "Pensió completa"],
    ["nour@example.com", "Nour Bennani", "55555555K", "600000005", "Només diumenge"],
    ["hamza@example.com", "Hamza Tazi", "66666666Q", "600000006", "Pensió completa"],
    ["meryem@example.com", "Meryem Amrani", "X0000001T", "600000007", "Pensió completa"],
    ["adam@example.com", "Adam Fassi", "Y0000002Z", "600000008", "Només dissabte"],
  ];

  function inicial() {
    const ara = Date.now();
    return {
      pagats: PERSONES.map(([correu, nom, dni, numero, tipus], i) => ({ fila: 3 + i, correu, nom, dni, numero, tipus })),
      assistencia: [
        { clau: "44444444A", data: new Date(ara - 42 * 60e3).toISOString(), per: "Omar" },
        { clau: "Y0000002Z", data: new Date(ara - 15 * 60e3).toISOString(), per: "Aisha" },
      ],
    };
  }
  function carregar() {
    try { return JSON.parse(localStorage.getItem(CLAU)) ?? inicial(); } catch { return inicial(); }
  }
  function desar(db) {
    try { localStorage.setItem(CLAU, JSON.stringify(db)); } catch { /* res */ }
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const publica = (p) => ({ nom: p.nom, dni: p.dni, tipus: p.tipus, fila: p.fila });
  const bloqueja = (db, clau) => db.assistencia.find((r) => r.clau === clau) ?? null;
  const estadistiques = (db) => ({ pagats: db.pagats.length, registrats: new Set(db.assistencia.map((r) => r.clau)).size });

  async function gestionar(p) {
    await espera(350 + Math.random() * 250);
    const db = carregar();
    switch (p.accio) {
      case "ping":
        return { ok: true, esdeveniment: "Demostració", mode: "unic", estadistiques: estadistiques(db) };

      case "sincronitzar": {
        const persones = [];
        for (const x of db.pagats) {
          const r = bloqueja(db, normDni(x.dni));
          persones.push({ h: await sha256(normDni(x.dni)), n: x.nom, t: x.tipus, f: x.fila, r: r ? r.data : null });
        }
        return { ok: true, mode: "unic", persones, estadistiques: estadistiques(db), a: new Date().toISOString() };
      }

      case "cercar": {
        const q = normText(p.text);
        const qDni = normDni(p.text);
        if (q.length < 2) return { ok: true, resultats: [] };
        const resultats = db.pagats
          .filter((x) => normText(x.nom).includes(q) || normDni(x.dni).includes(qDni))
          .slice(0, 20)
          .map((x) => {
            const r = bloqueja(db, normDni(x.dni));
            return { ...publica(x), registrat: !!r, registratA: r?.data ?? null, registratPer: r?.per ?? "" };
          });
        return { ok: true, resultats };
      }

      case "registrar": {
        const clau = p.fila ? null : normDni(p.qr?.dni);
        if (!p.fila && !clau) return { ok: true, estat: "qr_no_valid" };
        const persona = db.pagats.find((x) => (p.fila ? x.fila === Number(p.fila) : normDni(x.dni) === clau));
        if (!persona) return { ok: true, estat: "no_pagat", estadistiques: estadistiques(db) };
        const previ = bloqueja(db, normDni(persona.dni));
        if (previ) {
          return { ok: true, estat: "ja_registrat", persona: publica(persona), registratA: previ.data, registratPer: previ.per, estadistiques: estadistiques(db) };
        }
        const t = p.escanejatA && new Date(p.escanejatA) <= new Date() ? p.escanejatA : new Date().toISOString();
        db.assistencia.push({ clau: normDni(persona.dni), data: t, per: p.personal || "Recepció", metode: p.metode });
        desar(db);
        return { ok: true, estat: "correcte", persona: publica(persona), registratA: t, estadistiques: estadistiques(db) };
      }

      default:
        return { ok: false, error: "accio_desconeguda" };
    }
  }

  // Codis de prova (proves.html): el mateix format d'URL que els QR reals del doGet.
  function urlQR(nom, dni, numero, tipus) {
    const q = new URLSearchParams({ nom, dni, numero, tipusAsistencia: tipus });
    return `https://script.google.com/macros/s/DEMOSTRACIO/exec?${q}`;
  }
  const codisProva = () => [
    ...PERSONES.map(([, nom, dni, numero, tipus]) => ({ nom, tipus, text: urlQR(nom, dni, numero, tipus) })),
    { nom: "Karim Sabri", tipus: "Pensió completa", text: urlQR("Karim Sabri", "77777777B", "600000009", "Pensió completa"), noPagat: true },
    { nom: "Un altre QR qualsevol", tipus: "", text: "https://www.instagram.com/entrejoves.ucidcat/", noValid: true },
  ];

  window.RecepcioDemo = { gestionar, codisProva, reiniciar: () => desar(inicial()), carregar };
})();
