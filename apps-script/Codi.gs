/**
 * API de RECEPCIÓ · Congrés Islàmic de Catalunya
 *
 * Aquest projecte és NOU i independent del "Script QR's Project": no el toca, i els QR que ja
 * heu enviat continuen funcionant igual. L'app de recepció llegeix el QR, n'extreu el DNI i
 * pregunta aquí si la persona pot passar.
 *
 *   - Comprova que el DNI sigui al full "Assistència Pagada" (si no hi és, NO passa).
 *   - Comprova que no estigui ja al full "Assistència" (si hi és, NO passa i diu quan i qui).
 *   - Si tot és correcte, afegeix la fila a "Assistència" (data, nom, DNI, número i tipus), com sempre.
 *
 * Instal·lació (5 minuts): mira el fitxer LLEGEIX-ME.md d'aquesta carpeta.
 *
 * IMPORTANT: posa'l en un projecte d'Apps Script NOU, no al del doGet ni al dels correus.
 * (No defineix doGet ni CONFIG, per no trepitjar-los si algú l'hi enganxa per error.)
 */

var CONFIG_RECEPCIO = {
  ID_FULL_CALCUL: '1B59AnMRZjBGOK9jhjKb-h2DiclBiedWHZ4aERqn-Ff4',
  ESDEVENIMENT: 'XVII Congrés Islàmic de Catalunya',
  ZONA_HORARIA: 'Europe/Madrid',

  // Full amb les persones que han pagat (la font de veritat)
  FULL_PAGATS: 'Assistència Pagada',
  PRIMERA_FILA_PAGATS: 3,
  COL_PAGATS: { correu: 1, nom: 2, dni: 3, numero: 4, tipus: 5 },   // A, B, C, D, E

  // Full on es registra l'entrada
  FULL_ASSISTENCIA: 'Assistència',
  PRIMERA_FILA_ASSISTENCIA: 3,
  COL_ASSISTENCIA: { data: 1, nom: 2, dni: 3, numero: 4, tipus: 5 }, // A…E

  // 'unic'  = cada persona entra una sola vegada en tot el congrés
  // 'diari' = cada persona pot entrar una vegada cada dia (18, 19 i 20)
  MODE: 'unic'
};

// ---------------------------------------------------------------------------
// Punts d'entrada web
// ---------------------------------------------------------------------------

function doPost(e) {
  var peticio;
  try {
    peticio = JSON.parse(e.postData.contents);
  } catch (err) {
    return sortida({ ok: false, error: 'peticio_no_valida' });
  }
  try {
    return sortida(gestionar(peticio));
  } catch (err) {
    console.error(err);
    return sortida({ ok: false, error: 'error_intern', detall: String(err && err.message || err) });
  }
}

function sortida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function gestionar(p) {
  if (!codiCorrecte(p.codi)) {
    Utilities.sleep(800); // frena qui intenti endevinar el codi
    return { ok: false, error: 'codi_incorrecte' };
  }
  switch (p.accio) {
    case 'ping':
      return { ok: true, esdeveniment: CONFIG_RECEPCIO.ESDEVENIMENT, mode: CONFIG_RECEPCIO.MODE, estadistiques: estadistiques() };
    case 'sincronitzar':
      return sincronitzar();
    case 'registrar':
      return registrar(p);
    case 'cercar':
      return cercar(p.text);
    default:
      return { ok: false, error: 'accio_desconeguda' };
  }
}

function codiCorrecte(codi) {
  var esperat = PropertiesService.getScriptProperties().getProperty('CODI_ACCES');
  if (!esperat) throw new Error('Falta la propietat CODI_ACCES (Configuració del projecte > Propietats de l\'script).');
  return typeof codi === 'string' && codi.trim() === esperat.trim();
}

// ---------------------------------------------------------------------------
// Lectura dels fulls
// ---------------------------------------------------------------------------

function llibre() {
  return SpreadsheetApp.openById(CONFIG_RECEPCIO.ID_FULL_CALCUL);
}

function full(nom) {
  var f = llibre().getSheetByName(nom);
  if (!f) throw new Error('No trobo la pestanya "' + nom + '"');
  return f;
}

/** DNI/NIE comparable: majúscules i sense espais, punts ni guions. */
function normDni(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[\s.\-]/g, '');
}

/** Text comparable per a cerques: minúscules i sense accents. */
function normText(v) {
  return String(v == null ? '' : v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function llegirPagats() {
  var f = full(CONFIG_RECEPCIO.FULL_PAGATS);
  var ultima = f.getLastRow();
  if (ultima < CONFIG_RECEPCIO.PRIMERA_FILA_PAGATS) return [];
  var c = CONFIG_RECEPCIO.COL_PAGATS;
  var ncols = Math.max(c.correu, c.nom, c.dni, c.numero, c.tipus);
  var valors = f.getRange(CONFIG_RECEPCIO.PRIMERA_FILA_PAGATS, 1, ultima - CONFIG_RECEPCIO.PRIMERA_FILA_PAGATS + 1, ncols).getValues();
  var persones = [];
  for (var i = 0; i < valors.length; i++) {
    var v = valors[i];
    var dni = normDni(v[c.dni - 1]);
    if (!dni) continue;
    persones.push({
      fila: CONFIG_RECEPCIO.PRIMERA_FILA_PAGATS + i,
      nom: String(v[c.nom - 1]).trim(),
      dni: String(v[c.dni - 1]).trim(),
      clau: dni,
      numero: String(v[c.numero - 1]).trim(),
      tipus: String(v[c.tipus - 1]).trim()
    });
  }
  return persones;
}

function llegirAssistencia() {
  var f = full(CONFIG_RECEPCIO.FULL_ASSISTENCIA);
  var ultima = f.getLastRow();
  if (ultima < CONFIG_RECEPCIO.PRIMERA_FILA_ASSISTENCIA) return [];
  var c = CONFIG_RECEPCIO.COL_ASSISTENCIA;
  var ncols = Math.max(c.data, c.dni);
  var valors = f.getRange(CONFIG_RECEPCIO.PRIMERA_FILA_ASSISTENCIA, 1, ultima - CONFIG_RECEPCIO.PRIMERA_FILA_ASSISTENCIA + 1, ncols).getValues();
  var registres = [];
  for (var i = 0; i < valors.length; i++) {
    var v = valors[i];
    var clau = normDni(v[c.dni - 1]);
    if (!clau) continue;
    var data = v[c.data - 1];
    registres.push({
      clau: clau,
      data: data instanceof Date ? data : (data ? new Date(data) : null)
    });
  }
  return registres;
}

function dia(data) {
  return Utilities.formatDate(data, CONFIG_RECEPCIO.ZONA_HORARIA, 'yyyy-MM-dd');
}

/** Registre que bloqueja l'entrada (en mode 'diari', només el d'avui compta). */
function registreQueBloqueja(registres, clau, ara) {
  for (var i = 0; i < registres.length; i++) {
    var r = registres[i];
    if (r.clau !== clau) continue;
    if (CONFIG_RECEPCIO.MODE === 'diari' && (!r.data || dia(r.data) !== dia(ara))) continue;
    return r;
  }
  return null;
}

function estadistiques(pagats, registres) {
  pagats = pagats || llegirPagats();
  registres = registres || llegirAssistencia();
  var ara = new Date();
  var dins = {};
  for (var i = 0; i < registres.length; i++) {
    var r = registres[i];
    if (CONFIG_RECEPCIO.MODE === 'diari' && (!r.data || dia(r.data) !== dia(ara))) continue;
    dins[r.clau] = true;
  }
  return { pagats: pagats.length, registrats: Object.keys(dins).length };
}

function publica(p) {
  return { nom: p.nom, dni: p.dni, tipus: p.tipus, fila: p.fila };
}

// ---------------------------------------------------------------------------
// Accions
// ---------------------------------------------------------------------------

/**
 * p.qr = { nom, dni, numero, tipus }  (llegit del QR)   o bé   p.fila = fila d'"Assistència Pagada"
 * p.escanejatA = hora real (si ve de la cua sense connexió)
 */
function registrar(p) {
  var clau = p.fila ? null : normDni(p.qr && p.qr.dni);
  if (!p.fila && !clau) return { ok: true, estat: 'qr_no_valid' };

  // Un sol registre alhora: si dues persones escanegen el mateix QR al mateix segon, només una el registra.
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var pagats = llegirPagats();
    var persona = null;
    for (var i = 0; i < pagats.length; i++) {
      if (p.fila ? pagats[i].fila === Number(p.fila) : pagats[i].clau === clau) { persona = pagats[i]; break; }
    }
    if (!persona) {
      return { ok: true, estat: 'no_pagat', qr: { nom: p.qr && p.qr.nom || '' }, estadistiques: estadistiques(pagats) };
    }

    var ara = new Date();
    var hora = ara;
    if (p.escanejatA) {
      var t = new Date(p.escanejatA);
      if (!isNaN(t) && t <= ara && ara - t < 24 * 3600 * 1000) hora = t;
    }

    var registres = llegirAssistencia();
    var previ = registreQueBloqueja(registres, persona.clau, hora);
    if (previ) {
      return {
        ok: true, estat: 'ja_registrat', persona: publica(persona),
        registratA: previ.data ? previ.data.toISOString() : null,
        estadistiques: estadistiques(pagats, registres)
      };
    }

    var c = CONFIG_RECEPCIO.COL_ASSISTENCIA;
    var fila = [];
    fila[c.data - 1] = hora;
    fila[c.nom - 1] = persona.nom;
    fila[c.dni - 1] = persona.dni;
    fila[c.numero - 1] = persona.numero;
    fila[c.tipus - 1] = persona.tipus;
    for (var k = 0; k < fila.length; k++) if (fila[k] === undefined) fila[k] = '';
    full(CONFIG_RECEPCIO.FULL_ASSISTENCIA).appendRow(fila);
    SpreadsheetApp.flush();

    registres.push({ clau: persona.clau, data: hora });
    return {
      ok: true, estat: 'correcte', persona: publica(persona), registratA: hora.toISOString(),
      estadistiques: estadistiques(pagats, registres)
    };
  } finally {
    lock.releaseLock();
  }
}

/** Llista per validar sense connexió. El DNI no surt mai en clar: només el seu hash SHA-256. */
function sincronitzar() {
  var pagats = llegirPagats();
  var registres = llegirAssistencia();
  var ara = new Date();
  var persones = pagats.map(function (p) {
    var r = registreQueBloqueja(registres, p.clau, ara);
    return { h: sha256(p.clau), n: p.nom, t: p.tipus, f: p.fila, r: r && r.data ? r.data.toISOString() : (r ? 'si' : null) };
  });
  return { ok: true, mode: CONFIG_RECEPCIO.MODE, persones: persones, estadistiques: estadistiques(pagats, registres), a: ara.toISOString() };
}

function cercar(text) {
  var q = normText(text);
  if (q.length < 2) return { ok: true, resultats: [] };
  var qDni = normDni(text);
  var pagats = llegirPagats();
  var registres = llegirAssistencia();
  var ara = new Date();
  var resultats = [];
  for (var i = 0; i < pagats.length && resultats.length < 20; i++) {
    var p = pagats[i];
    if (normText(p.nom).indexOf(q) === -1 && p.clau.indexOf(qDni) === -1) continue;
    var r = registreQueBloqueja(registres, p.clau, ara);
    resultats.push({
      nom: p.nom, dni: p.dni, tipus: p.tipus, fila: p.fila,
      registratA: r && r.data ? r.data.toISOString() : null, registrat: !!r
    });
  }
  return { ok: true, resultats: resultats };
}

function sha256(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

// ---------------------------------------------------------------------------
// Eines per a l'administrador (s'executen des de l'editor)
// ---------------------------------------------------------------------------

/** Executa-la un cop per comprovar que l'script veu bé els dos fulls. Mira el resultat al registre. */
function provarConfiguracio() {
  var pagats = llegirPagats();
  var registres = llegirAssistencia();
  console.log('Pagats: ' + pagats.length + ' · Registres d\'assistència: ' + registres.length);
  if (pagats[0]) console.log('Primera persona pagada: ' + pagats[0].nom + ' (' + pagats[0].tipus + ')');
  var codi = PropertiesService.getScriptProperties().getProperty('CODI_ACCES');
  console.log(codi ? 'Codi d\'accés configurat ✔' : 'FALTA el codi d\'accés: afegeix la propietat CODI_ACCES');
}
