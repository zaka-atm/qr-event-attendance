// Carrega apps-script/Codi.gs dins de Node amb fulls de càlcul simulats.
// Ho fan servir les proves del navegador per parlar amb el backend REAL (no amb una imitació).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

function full(files) {
  return {
    files,
    getLastRow() { return this.files.length; },
    getRange(r, c, nr = 1, nc = 1) {
      const self = this;
      return {
        getValues: () => Array.from({ length: nr }, (_, i) =>
          Array.from({ length: nc }, (_, j) => (self.files[r - 1 + i] ?? [])[c - 1 + j] ?? "")),
      };
    },
    appendRow(v) { this.files.push([...v]); },
  };
}

function crearBackend({ pagats, assistencia = [], codi = "prova" }) {
  const fulls = {
    "Assistència Pagada": full([["ASISTENTS AMB EL PAGAMENT FET"], ["Correu", "Nom", "DNI", "Numero", "Tipus Assistència"], ...pagats]),
    "Assistència": full([["ASSISTÈNCIA"], ["Data de Registre", "Nom i Cognoms", "DNI", "Número de telèfon", "Tipus d'Assistència"], ...assistencia]),
  };
  const context = {
    console,
    SpreadsheetApp: { openById: () => ({ getSheetByName: (n) => fulls[n] ?? null }), flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === "CODI_ACCES" ? codi : null) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      sleep() {},
      formatDate: (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d),
      computeDigest: (_a, t) => [...crypto.createHash("sha256").update(t, "utf8").digest()].map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 1 },
      Charset: { UTF_8: 1 },
    },
    ContentService: { createTextOutput: (text) => ({ text, setMimeType() { return this; } }), MimeType: { JSON: 1 } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../../apps-script/Codi.gs"), "utf8"), context);
  return {
    fulls,
    peticio: (cos) => context.doPost({ postData: { contents: cos } }).text,
  };
}

module.exports = { crearBackend };
