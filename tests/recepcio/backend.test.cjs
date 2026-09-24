// Executa apps-script/Codi.gs a Node amb uns fulls simulats (mateixa estructura que el full real)
// i comprova totes les respostes de l'API.   node tests/recepcio/backend.test.cjs
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");

// --- Fulls simulats ------------------------------------------------------------------
function makeSheet(rows) {
  return {
    rows,
    getLastRow() { return this.rows.length; },
    getRange(r, c, nr = 1, nc = 1) {
      const self = this;
      return {
        getValues() {
          return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (self.rows[r - 1 + i] ?? [])[c - 1 + j] ?? ""));
        },
      };
    },
    appendRow(values) { this.rows.push(values); },
  };
}

const pagada = makeSheet([
  ["ASISTENTS AMB EL PAGAMENT FET"],
  ["Correu", "Nom", "DNI", "Numero", "Tipus Assistència"],
  ["marwa@example.com", "Marwa Test Prova", "12345678Z", 600111222, "Pensió completa"],
  ["fatima@example.com", "Fàtima El Amrani", "X1234567-L", 611222333, "Només dissabte"],
  ["youssef@example.com", "Youssef Benali", "48765432Z", 622333444, "Pensió completa"],
  ["", "", "", "", ""],
]);
const assistencia = makeSheet([
  ["ASSISTÈNCIA"],
  ["Data de Registre", "Nom i Cognoms", "DNI", "Número de telèfon", "Tipus d'Assistència"],
  [new Date("2026-12-18T09:15:00Z"), "Youssef Benali", "48765432Z", 622333444, "Pensió completa"], // registrat pel doGet antic
]);

const props = { CODI_ACCES: "recepcio2026" };
let lockHeld = false;
let slept = 0;

const context = {
  console,
  SpreadsheetApp: {
    openById(id) {
      assert.equal(id, "1B59AnMRZjBGOK9jhjKb-h2DiclBiedWHZ4aERqn-Ff4");
      return { getSheetByName: (n) => ({ "Assistència Pagada": pagada, "Assistència": assistencia }[n] ?? null) };
    },
    flush() {},
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null }) },
  LockService: {
    getScriptLock: () => ({
      waitLock() { assert.equal(lockHeld, false, "el bloqueig no s'ha alliberat"); lockHeld = true; },
      releaseLock() { lockHeld = false; },
    }),
  },
  Utilities: {
    sleep(ms) { slept += ms; },
    formatDate(d, tz, fmt) {
      assert.equal(fmt, "yyyy-MM-dd");
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
    },
    computeDigest(_alg, text) {
      return [...crypto.createHash("sha256").update(text, "utf8").digest()].map((b) => (b > 127 ? b - 256 : b));
    },
    DigestAlgorithm: { SHA_256: "SHA_256" },
    Charset: { UTF_8: "UTF_8" },
  },
  ContentService: {
    createTextOutput(text) { return { text, setMimeType() { return this; } }; },
    MimeType: { JSON: "json" },
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../../apps-script/Codi.gs"), "utf8"), context);

const call = (body) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).text);
const CODI = "recepcio2026";

// --- Proves ----------------------------------------------------------------------------
let r;

r = call({ accio: "ping", codi: "dolent" });
assert.deepEqual(r, { ok: false, error: "codi_incorrecte" });
assert.ok(slept >= 800, "un codi incorrecte fa esperar");
assert.equal(JSON.parse(context.doPost({ postData: { contents: "no és json" } }).text).error, "peticio_no_valida");

r = call({ accio: "ping", codi: CODI });
assert.equal(r.ok, true);
assert.deepEqual(r.estadistiques, { pagats: 3, registrats: 1 });
console.log("✓ codi d'accés i ping");

// QR real: el paràmetre dni amb una altra forma d'escriure'l (minúscules, espais)
r = call({ accio: "registrar", codi: CODI, personal: "Aisha", qr: { nom: "Marwa Test Prova", dni: " 12345678z ", numero: "600111222", tipus: "Pensió completa" } });
assert.equal(r.estat, "correcte", JSON.stringify(r));
assert.equal(r.persona.nom, "Marwa Test Prova");
assert.equal(r.persona.tipus, "Pensió completa");
assert.deepEqual(r.estadistiques, { pagats: 3, registrats: 2 });
const nova = assistencia.rows.at(-1);
assert.equal(Object.prototype.toString.call(nova[0]), "[object Date]");
assert.deepEqual([...nova.slice(1)], ["Marwa Test Prova", "12345678Z", "600111222", "Pensió completa", "Aisha", "QR"]);
console.log("✓ entrada vàlida: s'afegeix a Assistència amb qui i com");

r = call({ accio: "registrar", codi: CODI, personal: "Omar", qr: { dni: "12345678Z" } });
assert.equal(r.estat, "ja_registrat");
assert.equal(r.registratPer, "Aisha");
assert.ok(r.registratA);
assert.equal(assistencia.rows.length, 4, "no s'afegeix cap fila més");

r = call({ accio: "registrar", codi: CODI, qr: { dni: "48765432Z" } });
assert.equal(r.estat, "ja_registrat", "també detecta els registres fets amb el doGet antic");
console.log("✓ ja registrat (també els del sistema antic)");

r = call({ accio: "registrar", codi: CODI, qr: { nom: "Algú", dni: "99999999R" } });
assert.equal(r.estat, "no_pagat");
r = call({ accio: "registrar", codi: CODI, qr: { nom: "Sense DNI" } });
assert.equal(r.estat, "qr_no_valid");
console.log("✓ no pagat i QR no vàlid");

// Cerca i registre manual per fila
r = call({ accio: "cercar", codi: CODI, text: "fatima" });
assert.equal(r.resultats.length, 1, "la cerca ignora els accents");
assert.equal(r.resultats[0].registrat, false);
r = call({ accio: "cercar", codi: CODI, text: "x1234567" });
assert.equal(r.resultats[0].nom, "Fàtima El Amrani", "cerca pel DNI sense guions");
const fila = r.resultats[0].fila;
r = call({ accio: "registrar", codi: CODI, personal: "Omar", fila, metode: "manual" });
assert.equal(r.estat, "correcte");
assert.equal(assistencia.rows.at(-1)[6], "Manual");
r = call({ accio: "cercar", codi: CODI, text: "Fàtima" });
assert.equal(r.resultats[0].registrat, true);
console.log("✓ cerca i registre manual");

// Cua sense connexió: respecta l'hora de l'escaneig
const abans = new Date(Date.now() - 5 * 60e3).toISOString();
assistencia.rows = assistencia.rows.slice(0, 3);
r = call({ accio: "registrar", codi: CODI, personal: "Porta 2", qr: { dni: "12345678Z" }, escanejatA: abans });
assert.equal(r.estat, "correcte");
assert.equal(assistencia.rows.at(-1)[0].toISOString(), abans);
assert.equal(assistencia.rows.at(-1)[6], "QR (sense connexió)");
console.log("✓ registres sense connexió amb l'hora real");

// Sincronització: sense DNI en clar
r = call({ accio: "sincronitzar", codi: CODI });
assert.equal(r.persones.length, 3);
const z = r.persones.find((p) => p.n === "Marwa Test Prova");
assert.equal(z.h, crypto.createHash("sha256").update("12345678Z").digest("hex"));
assert.ok(z.r);
assert.ok(!JSON.stringify(r).includes("12345678Z"), "el DNI no viatja en clar");
console.log("✓ sincronització amb hash del DNI");

// Mode diari
vm.runInContext("CONFIG_RECEPCIO.MODE = 'diari'", context);
assistencia.rows = [assistencia.rows[0], assistencia.rows[1], [new Date(Date.now() - 36 * 3600e3), "Marwa Test Prova", "12345678Z", "", "", "Aisha", "QR"]];
r = call({ accio: "registrar", codi: CODI, qr: { dni: "12345678Z" } });
assert.equal(r.estat, "correcte", "en mode diari, ahir no compta");
r = call({ accio: "registrar", codi: CODI, qr: { dni: "12345678Z" } });
assert.equal(r.estat, "ja_registrat", "però avui sí");
console.log("✓ mode diari");

assert.equal(lockHeld, false);
console.log("OK: totes les proves del backend han passat");
