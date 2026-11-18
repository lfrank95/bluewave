// Bluewave Windows-Client: Hülle um die Bluewave-Web-App des eigenen Servers. Filme und Serien spielt mpv in einem
// eigenen Fenster (jede Datei unverändert, HDR, alle Spuren), den Ton mpv selbst (WASAPI, exklusiv, Bitstream) oder die
// Bluewave-Engine (WASAPI/ASIO mit Lautsprecher-Manager, aus Amberwave). Verwaltung, Bibliothek und Konten bleiben auf dem Server.
//
// Ablauf beim Start: gemerkten Server anpingen (zuerst im Heimnetz, dann die öffentliche Adresse). Antwortet keiner,
// wird das Heimnetz durchsucht (derselbe Server wird an seinem Ausweis erkannt – ein Schlüssel, den der Server mit einer
// Unterschrift belegt). Sonst: Einrichtungsseite (Suche, Liste, Adresse von Hand).
const { app, BrowserWindow, BaseWindow, ipcMain, session, globalShortcut, Tray, Menu, shell, nativeImage, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { suchen, pingen, adresseNormal, ausweisPruefen } = require('./suche');
const log = require('./log');
const { t, tm, tmMeldung } = require('./i18n');
const { Rife, MODELLE } = require('./rife');
const { Spieler } = require('./spieler');
const { mpvGeraete } = require('./mpv');

const VERSION = require('./package.json').version;
// Kennung für den Server (Profil → Geräte): Client-Version und Windows-Computername
const RECHNER = String(require('os').hostname() || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
const UA_ZUSATZ = `BluewaveClient/${VERSION}${RECHNER ? ` (${RECHNER})` : ''}`;
app.userAgentFallback = `${app.userAgentFallback} ${UA_ZUSATZ}`;
const STANDARD_PORT = 9960;
// Schnittstellen-Stand zwischen Client und Server: der Server meldet in /api/v1/ping „client_protokoll“
const PROTOKOLL = 1;

// Medientasten selbst abfangen (Chromium würde sie sonst an eine Browser-Wiedergabe geben)
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');
app.setAppUserModelId('de.bluewave.client');

if (process.env.BW_DATEN) app.setPath('userData', process.env.BW_DATEN); // für Tests
log.starten(app.getPath('userData'));
log.schreiben('INFO', `=== Bluewave Windows-Client ${VERSION} gestartet (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`);
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/* ---------- Einstellungen (pro Windows-Benutzer) ---------- */
const EINST_DATEI = path.join(app.getPath('userData'), 'einstellungen.json');
const VIDEO_STANDARD = { ton_weg: 'engine', mpv_geraet: 'auto', mpv_exklusiv: false, spdif: ['ac3', 'dts'], versatz_ms: 0, hwdec: 'auto-safe', vollbild: false, lfe_front: false, lfe_db: 0,
  // flüssige Bewegung (Test): NVIDIA Smooth Motion über das Treiber-Profil von bluewave-mpv.exe, dazu Renderer und Takt von mpv
  bewegung: 'aus', renderer: 'd3d11', vsync: true, mpv_sync: 'audio', mpv_interpolation: false, sm_balken: false, sm_log: 0,
  // RIFE (KI-Zwischenbilder über VapourSynth/vs-mlrt): Faktor, Modell, schnelle v2-Fassung, Bewegung in voller/halber Auflösung, Szenenwechsel
  rife_faktor: 2, rife_modell: 'v4_6', rife_v2: false, rife_skala: 1, rife_szene: 0.12, rife_max_fps: 31 };
let einst = { server: null, port: STANDARD_PORT, ausgabe: { geraet: '', exklusiv: false, rate: 0, aufschlag_je: {} }, fenster: null, video: { ...VIDEO_STANDARD } };
const RATEN = [0, 44100, 48000, 88200, 96000, 176400, 192000];   // 0 = folgt der Datei
const rateNormal = (r) => (RATEN.includes(Number(r)) ? Number(r) : 0);
// Stille nach einem Ratenwechsel, sobald das Gerät stabil läuft (ms, 0–5000) – je Ausgabegerät gemerkt (ein RME braucht
// nichts, manches USB-Interface schaltet seinen Ausgang erst nach Sekunden frei)
const aufschlagNormal = (a) => { const n = Number(a); return Number.isFinite(n) ? Math.max(0, Math.min(5000, Math.round(n))) : 250; };
// Standard: ASIO-Interfaces schalten beim Ratenwechsel oft spürbar langsamer frei (wie ein CD-Wechsel) → 2 s; Windows-Geräte 250 ms
// Gemerkt je Treiber (ein ASIO-Ausgang „asio:{…}#bus“ zählt zu seinem Treiber)
const treiberVon = (geraet) => String(geraet || '').split('#')[0];
const aufschlagFuer = (geraet) => {
  const je = einst.ausgabe.aufschlag_je?.[treiberVon(geraet)];
  if (je != null) return aufschlagNormal(je);
  return String(geraet || '').startsWith('asio:') ? 2000 : aufschlagNormal(einst.ausgabe.aufschlag ?? 250);
};

/* ---------- ASIO-Ausgänge (Busse): je Treiber eine Liste, mindestens „Stereo · Kanal 1/2“ ---------- */
// Engine-Kanalfolge je Layout: Stereo L R, Quadro L R Ls Rs, 5.1 L R C LFE Ls Rs
const LAYOUT_KANAELE = { stereo: 2, quadro: 4, '51': 6 };
const SYMBOLE = ['auto', 'paar', 'monitore', 'kopfhoerer', 'quadro', 'surround', 'sofa'];
const STANDARD_AUSGANG = () => ({ id: 'std', name: '', symbol: 'auto', layout: 'stereo', sub: false, karte: [0, 1] });
function ausgangPruefen(a) {
  if (!a || typeof a !== 'object') return null;
  const layout = LAYOUT_KANAELE[a.layout] ? a.layout : 'stereo';
  const sub = !!a.sub;
  const n = LAYOUT_KANAELE[layout] + (sub && layout !== '51' ? 1 : 0);   // Stereo/Quadro + Sub: LFE hinten an
  const karte = Array.isArray(a.karte) ? a.karte.slice(0, n).map((k) => Math.max(0, Math.min(255, Math.round(Number(k) || 0)))) : [];
  while (karte.length < n) karte.push(karte.length);
  return {
    id: /^[a-z0-9]{1,20}$/.test(String(a.id || '')) ? a.id : Math.random().toString(36).slice(2, 10),
    name: String(a.name || '').trim().slice(0, 60),
    symbol: SYMBOLE.includes(a.symbol) ? a.symbol : 'auto',
    layout, sub, karte,
    // Subwoofer: Trennfrequenz 50–200 Hz (10er-Schritte), Delay in ms (+ = Sub später, − = Hauptlautsprecher später)
    trenn: Math.max(50, Math.min(200, Math.round((Number(a.trenn) || 80) / 10) * 10)),
    delay: Math.max(-30, Math.min(30, Math.round((Number(a.delay) || 0) * 1000) / 1000)),
    einheit: ['ms', 'm', 'in'].includes(a.einheit) ? a.einheit : 'ms',
    phase: !!a.phase,   // Sub um 180° gedreht
    lfe: Number(a.lfe) === 0 ? 0 : 10,   // LFE der Quelle: +10 dB (Kinonorm) oder 0 dB, wenn Bluewave den Sub speist
    ...lsUndKh(a, karte),
  };
}
/* Lautsprecher-Manager: Art (Lautsprecher/Kopfhörer), Abstände → Delay, Pegel je Lautsprecher; Kopfhörer mit eigener
 * Kanalwahl, Balance, Crossfeed und Pegel. Beide Arten bleiben gespeichert, damit ein Wechsel hin und zurück nichts verliert. */
const LS_ALLE = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];
const CROSSFEED = ['aus', 'leicht', 'mittel', 'stark'];
const zahlIn = (v, lo, hi, std) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : std; };
function lsUndKh(a, karte) {
  const dist = {}, pegel = {}, delayHand = {};
  for (const k of LS_ALLE) {
    dist[k] = Math.round(zahlIn(a.dist?.[k], 0.3, 15, 2.5) * 100) / 100;
    pegel[k] = Math.round(zahlIn(a.pegel?.[k], -12, 6, 0) * 2) / 2;
    if (a.delay_hand?.[k] != null) delayHand[k] = Math.round(zahlIn(a.delay_hand[k], 0, 30, 0) * 1000) / 1000;
  }
  // ältere Einstellung: ein Sub-Delay (± ms) → von Hand gesetztes Delay am Sub bzw. an allen Hauptlautsprechern
  if (!a.dist && Number(a.delay)) {
    const d = zahlIn(a.delay, -30, 30, 0);
    if (d > 0) delayHand.LFE = d; else for (const k of LS_ALLE) if (k !== 'LFE') delayHand[k] = -d;
  }
  const kk = Array.isArray(a.kh?.karte) && a.kh.karte.length === 2 ? a.kh.karte : [karte[0] ?? 0, karte[1] ?? 1];
  const kh = {
    karte: kk.map((k) => Math.max(0, Math.min(255, Math.round(Number(k) || 0)))),
    balance: Math.round(zahlIn(a.kh?.balance, -100, 100, 0) / 5) * 5,
    crossfeed: CROSSFEED.includes(a.kh?.crossfeed) ? a.kh.crossfeed : 'aus',
    pegel: Math.round(zahlIn(a.kh?.pegel, -18, 0, 0) * 2) / 2,
  };
  if (kh.karte[0] === kh.karte[1]) kh.karte[1] = kh.karte[0] + 1;
  return { art: a.art === 'kh' ? 'kh' : 'ls', dist, pegel, delay_hand: delayHand, kh, fertig: a.fertig !== false, ...eqPruefen(a) };
}
/* Kanal-EQ je Lautsprecher: 8 Bänder (Bell, Low-/High-Shelf, Hoch-/Tiefpass), Kanalpaare lassen sich koppeln (gleiche Werte) */
const EQ_BAENDER = 8, EQ_TYPEN = 5, EQ_FLANKEN = [6, 12, 18, 24, 36, 48];
const EQ_STD_F = [50, 120, 300, 700, 1500, 3500, 8000, 14000];
const EQ_LINKS = ['LR', 'LsRs'];
function eqBand(b, i) {
  const f = Math.round(zahlIn(b?.f, 10, 24000, EQ_STD_F[i] || 1000) * 100) / 100;
  const fl = Number(b?.flanke);
  return {
    an: !!b?.an, typ: Math.round(zahlIn(b?.typ, 0, EQ_TYPEN - 1, 0)), f,
    g: Math.round(zahlIn(b?.g, -24, 24, 0) * 10) / 10, q: Math.round(zahlIn(b?.q, 0.1, 18, 1) * 100) / 100,
    flanke: EQ_FLANKEN.includes(fl) ? fl : 12,
  };
}
function eqPruefen(a) {
  const eq = {};
  for (const k of LS_ALLE) {
    const e = a.eq?.[k];
    eq[k] = { an: e ? e.an !== false : true, baender: Array.from({ length: EQ_BAENDER }, (_, i) => eqBand(e?.baender?.[i], i)) };
  }
  const link = {};
  for (const k of EQ_LINKS) link[k] = !!a.eq_link?.[k];
  return { eq, eq_link: link, eq_reserve: Math.round(zahlIn(a.eq_reserve, 0, 24, 0) * 10) / 10 };
}
/** Engine-Liste eines Kanal-EQs: [Kanal an, 8 × (an, Typ, Hz, dB, Q, Flanke)] */
const eqListe = (e) => [e && e.an ? 1 : 0, ...(e ? e.baender : Array.from({ length: EQ_BAENDER }, (_, i) => eqBand(null, i))).flatMap((b) => [b.an ? 1 : 0, b.typ, b.f, b.g, b.q, b.flanke])];
/** Lautsprecher eines Ausgangs in Engine-Reihenfolge (mit separatem Sub hinten LFE) */
const LS_LAYOUT = { stereo: ['L', 'R'], quadro: ['L', 'R', 'Ls', 'Rs'], '51': ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'] };
const lsVon = (a) => { const l = LS_LAYOUT[a.layout] || LS_LAYOUT.stereo; return a.sub && a.layout !== '51' ? [...l, 'LFE'] : l; };
/** Delay je Lautsprecher: von Hand gesetzt oder aus den Abständen (der weiteste 0 ms) */
function delaysVon(a) {
  const ls = lsVon(a), weit = Math.max(...ls.map((k) => a.dist[k]));
  return ls.map((k) => (a.delay_hand[k] != null ? a.delay_hand[k] : (weit - a.dist[k]) / 343 * 1000));
}
/** Korrektur für die Engine: Kanäle in Engine-Reihenfolge; Pegel so gesenkt, dass keiner über 0 dB liegt */
function korrekturVon(a) {
  if (!a) return { an: false, delays: [], gains: [], cf: 0 };
  if (a.art === 'kh') {
    const b = a.kh.balance, db = (x) => (x <= 0 ? -60 : 20 * Math.log10(x));
    const gains = [a.kh.pegel + (b > 0 ? db(1 - b / 100) : 0), a.kh.pegel + (b < 0 ? db(1 + b / 100) : 0)];
    const cf = CROSSFEED.indexOf(a.kh.crossfeed);
    return { an: cf > 0 || gains.some((g) => g !== 0), delays: [0, 0], gains, cf };
  }
  const ls = lsVon(a);
  const delays = delaysVon(a).map((d) => Math.round(d * 1000) / 1000);
  const hoch = Math.max(0, ...ls.map((k) => a.pegel[k]));
  const reserve = eqAktiv(a) ? a.eq_reserve || 0 : 0;   // EQ-Anhebungen: alles so weit absenken, dass nichts übersteuert
  const gains = ls.map((k) => a.pegel[k] - hoch - reserve);
  return { an: delays.some((d) => d > 0.004) || gains.some((g) => g !== 0), delays, gains, cf: 0 };
}
function ausgaengeFuer(treiber) {
  const l = (einst.asio_ausgaenge?.[treiber] || []).map(ausgangPruefen).filter(Boolean);
  return l.length ? l : [ausgangPruefen(STANDARD_AUSGANG())];
}
/** Auswahl → Geräte-ID für die Engine: ASIO-Ausgang „asio:{…}#bus“ → „asio:{…}#0,1,…“ (Kanalkarte) */
function engineGeraet(geraet) {
  const g = String(geraet || '');
  if (!g.startsWith('asio:')) return g;
  const [treiber, bus] = g.split('#');
  const l = ausgaengeFuer(treiber);
  const a = l.find((x) => x.id === bus) || l[0];
  return `${treiber}#${(a.art === 'kh' ? a.kh.karte : a.karte).join(',')}`;
}
function ausgangVon(geraet) {
  const g = String(geraet || '');
  if (!g.startsWith('asio:')) return null;
  const [treiber, bus] = g.split('#');
  const l = ausgaengeFuer(treiber);
  return l.find((x) => x.id === bus) || l[0];
}
/** Delay/Pegel je Lautsprecher bzw. Kopfhörer-Klang des gewählten Ausgangs an die Engine (sonst neutral) */
function korrAnEngine(geraet) {
  const a = ausgangVon(geraet);
  korrSenden(a, false);
}
/** Ist an diesem Ausgang mindestens ein EQ-Band aktiv? (nur Lautsprecher) */
const eqAktiv = (a) => !!a && a.art !== 'kh' && lsVon(a).some((k) => a.eq?.[k]?.an && a.eq[k].baender.some((b) => b.an));
/** Korrektur (Delay, Pegel, Crossfeed) und Kanal-EQ an die Engine; neutral = alles aus (A/B-Vergleich „Original“) */
function korrSenden(a, neutral) {
  const k = neutral ? { an: false, delays: [], gains: [], cf: 0 } : korrekturVon(a);
  engineSenden({ c: 'korrektur', 'w.an': k.an ? 1 : 0, 'w.delays': k.delays, 'w.gains': k.gains, 'w.cf': k.cf });
  const ls = a && a.art !== 'kh' && !neutral ? lsVon(a) : [];
  for (let i = 0; i < 8; i++) engineSenden({ c: 'kanal_eq', 'w.k': i, 'w.p': ls[i] ? eqListe(a.eq[ls[i]]) : [0] });
}
/** Subwoofer/Bassmanagement des gewählten ASIO-Ausgangs an die Engine (sonst aus) */
function bassAnEngine(geraet) {
  const g = String(geraet || '');
  let a = null;
  if (g.startsWith('asio:')) { const [treiber, bus] = g.split('#'); const l = ausgaengeFuer(treiber); a = l.find((x) => x.id === bus) || l[0]; }
  const an = !!a?.sub && a.art !== 'kh';
  // Delay des Subs steckt jetzt in der Korrektur (Abstände je Lautsprecher)
  engineSenden({ c: 'bass', 'w.an': an ? 1 : 0, 'w.hz': a?.trenn || 80, 'w.delay': 0, 'w.layout': a ? LAYOUT_KANAELE[a.layout] : 2, 'w.phase': an && a.phase ? 1 : 0, 'w.lfe': a?.lfe === 0 ? 0 : 10 });
  korrAnEngine(geraet);
}
function ausgabeAnEngine() {
  bassAnEngine(einst.ausgabe.geraet);
  lfeAnEngine();
  engineSenden({ c: 'ausgabe', geraet: engineGeraet(einst.ausgabe.geraet), exklusiv: einst.ausgabe.exklusiv === true, 'w.rate': rateNormal(einst.ausgabe.rate), 'w.aufschlag': aufschlagFuer(einst.ausgabe.geraet) });
}
// Antworten der Engine, auf die jemand wartet (Kanalnamen, Testton)
let antwortWarter = [];
function engineFragen(befehl, passt, ms) {
  return new Promise((r) => {
    const w = { passt, r };
    antwortWarter.push(w);
    engineSenden(befehl);
    setTimeout(() => { if (antwortWarter.includes(w)) { antwortWarter = antwortWarter.filter((x) => x !== w); r(null); } }, ms);
  });
}
try { einst = { ...einst, ...JSON.parse(fs.readFileSync(EINST_DATEI, 'utf8')) }; } catch (e) { /* erster Start */ }
einst.video = videoPruefen(einst.video);
function einstSpeichern() {
  try {
    fs.mkdirSync(path.dirname(EINST_DATEI), { recursive: true });
    fs.writeFileSync(EINST_DATEI, JSON.stringify(einst, null, 2));
  } catch (e) { console.error('Einstellungen nicht gespeichert', e); }
}
function videoPruefen(v) {
  const x = { ...VIDEO_STANDARD, ...(v && typeof v === 'object' ? v : {}) };
  return {
    ton_weg: ['engine', 'mpv', 'bitstream'].includes(x.ton_weg) ? x.ton_weg : 'engine',
    mpv_geraet: typeof x.mpv_geraet === 'string' && x.mpv_geraet.length < 300 && !/[\0\r\n]/.test(x.mpv_geraet) ? x.mpv_geraet : 'auto',
    mpv_exklusiv: !!x.mpv_exklusiv,
    spdif: Array.isArray(x.spdif) ? [...new Set(x.spdif.filter((f) => ['ac3', 'eac3', 'dts', 'dts-hd', 'truehd'].includes(f)))] : ['ac3', 'dts'],
    versatz_ms: Math.max(-500, Math.min(500, Math.round(Number(x.versatz_ms) || 0))),
    hwdec: x.hwdec === 'no' ? 'no' : 'auto-safe',
    vollbild: !!x.vollbild,
    // LFE ohne Subwoofer auf die Front: Pegel gegenüber der Norm (0 dB = wie mit Sub, je Front +4 dB)
    lfe_front: !!x.lfe_front,
    lfe_db: Math.max(-20, Math.min(6, Math.round(Number(x.lfe_db) || 0))),
    bewegung: ['smooth', 'rife'].includes(x.bewegung) ? x.bewegung : 'aus',
    rife_faktor: Math.max(2, Math.min(5, Math.round(Number(x.rife_faktor) || 2))),
    rife_modell: MODELLE[x.rife_modell] ? x.rife_modell : 'v4_6',
    rife_v2: !!x.rife_v2,
    rife_skala: Number(x.rife_skala) === 0.5 ? 0.5 : 1,
    rife_szene: Math.max(0, Math.min(0.5, Number(x.rife_szene ?? 0.12) || 0)),
    rife_max_fps: Number(x.rife_max_fps) === 61 ? 61 : 31,
    renderer: x.renderer === 'vulkan' ? 'vulkan' : 'd3d11',
    vsync: x.vsync !== false,
    mpv_sync: x.mpv_sync === 'display-resample' ? 'display-resample' : 'audio',
    mpv_interpolation: !!x.mpv_interpolation,
    sm_balken: !!x.sm_balken,
    sm_log: Math.max(0, Math.min(3, Math.round(Number(x.sm_log) || 0))),
  };
}
function lfeAnEngine() { engineSenden({ c: 'lfe', 'w.an': einst.video.lfe_front ? 1 : 0, 'w.db': einst.video.lfe_db }); }
const ports = () => [...new Set([Number(einst.port) || STANDARD_PORT, STANDARD_PORT])];

let fenster = null;
let fensterGezeigt = false;
let tray = null;
let basis = '';          // geladene Server-Adresse (Origin)
let beenden = false;

/** darf diese Seite den Client benutzen? Nur der eingerichtete Server */
function erlaubt(url) {
  try {
    const o = new URL(url).origin;
    const s = einst.server;
    if (!s) return false;
    return [s.lan, s.url].filter(Boolean).some((a) => new URL(a).origin === o);
  } catch (e) { return false; }
}
const vonSeite = (e) => erlaubt(e.senderFrame?.url || '');
const vonHaupt = (e) => vonSeite(e) && fenster && !fenster.isDestroyed() && e.sender.id === fenster.webContents.id;

/* ---------- Engine ---------- */
let engine = null;
let engineStarts = [];
let geraeteWarter = [];
let titelText = '';
const ausgabeStand = { format: null, anlauf: null, aussetzer: 0 };

function engineSenden(b) {
  if (!engine || !engine.stdin.writable) return;
  engine.stdin.write(JSON.stringify(b) + '\n');
}

function engineStarten() {
  const exe = process.env.BW_ENGINE || path.join(__dirname, 'engine', process.platform === 'win32' ? 'bluewave-engine.exe' : 'bluewave-engine');
  engineStarts = engineStarts.filter((x) => Date.now() - x < 60000);
  engineStarts.push(Date.now());
  try {
    engine = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    console.error('Engine startet nicht', e);
    engine = null;
    return;
  }
  let rest = '';
  engine.stdout.setEncoding('utf8');
  engine.stdout.on('data', (d) => {
    rest += d;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const z = rest.slice(0, i).trim();
      rest = rest.slice(i + 1);
      if (z) engineMeldung(z);
    }
  });
  engine.stderr.on('data', (d) => console.error('[engine]', String(d).trim()));
  log.schreiben('INFO', `Engine gestartet (pid ${engine.pid})`);
  const dieses = engine;
  engine.on('error', (e) => console.error('Engine-Fehler', e));
  engine.on('exit', (code) => {
    if (engine === dieses) engine = null;
    if (beenden) return;
    console.error('Engine beendet mit', code);
    if (engineStarts.length >= 5) {
      senden('engine', { e: 'fehler', id: '', text: t('Die Ton-Engine stürzt wiederholt ab – bitte Bluewave neu starten.') });
      return;
    }
    setTimeout(() => { engineStarten(); senden('engine', { e: 'neustart' }); }, 400);
  });
  ausgabeAnEngine();
}

function engineMeldung(z) {
  let m;
  try { m = JSON.parse(z); } catch (e) { return; }
  if (m.e === 'geraete') { for (const r of geraeteWarter) r(m.liste || []); geraeteWarter = []; return; }
  for (const w of antwortWarter) if (w.passt(m)) { antwortWarter = antwortWarter.filter((x) => x !== w); w.r(m); break; }
  if (['aussetzer', 'format', 'formatwechsel', 'anlauf', 'fehler'].includes(m.e)) log.schreiben(m.e === 'fehler' || m.e === 'aussetzer' ? 'WARN' : 'INFO', `Engine: ${z.length > 600 ? z.slice(0, 600) + '…' : z}`);
  if (m.e === 'format') ausgabeStand.format = m;
  if (m.e === 'anlauf') ausgabeStand.anlauf = m;
  if (m.e === 'aussetzer') ausgabeStand.aussetzer++;
  spieler.engineMeldung(m);
  if (m.e !== 'zeit') senden('engine', tmMeldung(m));
}

function senden(kanal, daten) {
  if (fenster && !fenster.isDestroyed()) fenster.webContents.send(kanal, daten);
}

/** Cookie-Kopfzeile für eine Adresse des Servers (Anmeldung der Web-App gilt auch für Engine und mpv) */
async function cookieKopf(url) {
  try {
    const cs = await session.defaultSession.cookies.get({ url });
    return cs.length ? `Cookie: ${cs.map((c) => `${c.name}=${c.value}`).join('; ')}\r\n` : '';
  } catch (e) { return ''; }
}

/* ---------- RIFE (KI-Zwischenbilder) ---------- */
const rife = new Rife({
  log: (stufe, text) => log.schreiben(stufe, text),
  appOrdner: __dirname,
  siebenZip: path.join(__dirname, 'engine', '7zr.exe'),
  melden: (stand) => senden('rife', stand),
});

/* ---------- Videowiedergabe (mpv) ---------- */
const spieler = new Spieler({
  rife,
  electron: { BrowserWindow, BaseWindow, screen },
  mpvExe: process.env.BW_MPV || path.join(__dirname, 'mpv', process.platform === 'win32' ? 'bluewave-mpv.exe' : 'mpv'),
  userData: app.getPath('userData'),
  logOrdner: path.join(app.getPath('userData'), 'log'),
  log: (stufe, text) => log.schreiben(stufe, text),
  preload: path.join(__dirname, 'preload.js'),
  icon: path.join(__dirname, 'bilder', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
  basis: () => basis,
  hauptfenster: () => fenster,
  erlaubt,
  cookieKopf,
  engineSenden,
  engineLatenz: () => { const f = ausgabeStand.format; return f ? (f.latenz || 0) / (f.geraet_rate || f.aus_rate || 48000) : 0; },
  einst: () => einst.video,
  userAgent: `Mozilla/5.0 ${UA_ZUSATZ} mpv`,
});
const vonSpieler = (e) => vonSeite(e) && spieler.istOverlay(e.sender);
ipcMain.on('video-oeffnen', (e, ziel) => {
  if (!vonHaupt(e) || !ziel || typeof ziel !== 'object' || !['film', 'folge'].includes(ziel.art)) return;
  const sauber = { art: ziel.art, id: Number(ziel.id) || 0 };
  for (const k of ['fassung_id', 'start_ms', 'serie_id', 'datei_id']) if (Number.isFinite(Number(ziel[k])) && ziel[k] !== null && ziel[k] !== undefined) sauber[k] = Number(ziel[k]);
  if (!sauber.id) return;
  spieler.oeffnen(sauber).catch((x) => log.schreiben('FEHLER', `Spieler: ${x.stack || x.message}`));
});
ipcMain.handle('video-auftrag', (e) => (vonSpieler(e) ? spieler.ziel : null));
ipcMain.on('video-laden', (e, w) => { if (vonSpieler(e)) spieler.laden(w).catch((x) => log.schreiben('FEHLER', `mpv laden: ${x.message}`)); });
ipcMain.on('video-mini', (e, an) => { if (vonSpieler(e)) spieler.mini(!!an); });
ipcMain.on('video-befehl', (e, b) => { if (vonSpieler(e)) spieler.befehl(b).catch((x) => log.schreiben('WARN', `mpv: ${x.message}`)); });
ipcMain.on('video-zu', (e) => { if (vonSpieler(e)) spieler.schliessen(); });
ipcMain.on('video-vollbild', (e) => { if (vonSpieler(e)) spieler.vollbild(); });
ipcMain.handle('video-ton-weg', (e) => (vonSpieler(e) ? spieler.tonWeg() : null));
let mpvGeraeteCache = null;
ipcMain.handle('video-einst', async (e) => {
  if (!vonSeite(e)) return null;
  if (!mpvGeraeteCache) mpvGeraeteCache = await mpvGeraete(spieler.ctx.mpvExe).catch(() => []);
  return { ...einst.video, mpv_geraete: mpvGeraeteCache };
});
ipcMain.handle('video-einst-setzen', (e, w) => {
  if (!vonSeite(e) || !w || typeof w !== 'object') return null;
  einst.video = videoPruefen({ ...einst.video, ...w });
  einstSpeichern();
  lfeAnEngine();
  return { ...einst.video, mpv_geraete: mpvGeraeteCache || [] };
});
ipcMain.handle('ausgabe-status', (e) => (vonSeite(e) ? ausgabeStand : null));

/* ---------- Flüssige Bewegung: NVIDIA Smooth Motion im Treiber-Profil, Überwachung ---------- */
const NV_EXE = path.join(__dirname, 'engine', 'bluewave-nvprofil.exe');
const MPV_NAME = 'bluewave-mpv.exe';
let nvStand = null, nvStandAm = 0;
function nvStatus(frisch = false) {
  if (!frisch && nvStand && Date.now() - nvStandAm < 10000) return Promise.resolve(nvStand);
  return new Promise((fertig) => {
    if (process.platform !== 'win32' || !fs.existsSync(NV_EXE)) { fertig({ nvidia: false, fehler: 'nur unter Windows' }); return; }
    let aus = '';
    const p = spawn(NV_EXE, ['status', MPV_NAME], { windowsHide: true });
    p.stdout.on('data', (d) => { aus += d; });
    const t = setTimeout(() => { try { p.kill(); } catch (x) { /* weg */ } }, 6000);
    p.on('error', () => { clearTimeout(t); fertig({ nvidia: false, fehler: 'Hilfsprogramm startet nicht' }); });
    p.on('exit', () => {
      clearTimeout(t);
      try { nvStand = JSON.parse(aus.trim().split(/\r?\n/).pop()); } catch (x) { nvStand = { nvidia: false, fehler: 'keine Antwort' }; }
      nvStandAm = Date.now();
      fertig(nvStand);
    });
  });
}
/** Smooth Motion ins Treiber-Profil schreiben: braucht Admin-Rechte → Windows fragt (UAC); Ergebnis über eine Datei */
function nvEintragen(an) {
  return new Promise((fertig) => {
    if (process.platform !== 'win32' || !fs.existsSync(NV_EXE)) { fertig({ ok: false, fehler: 'nur unter Windows' }); return; }
    const datei = path.join(app.getPath('temp'), `bluewave-nv-${process.pid}-${Date.now()}.json`);
    const v = einst.video;
    const q = (x) => String(x).replace(/'/g, "''");
    const args = `setzen ${MPV_NAME} "${datei}" ${an ? 1 : 0} 7 ${v.sm_balken ? 1 : 0} ${v.sm_log}`;
    const befehl = `try { Start-Process -FilePath '${q(NV_EXE)}' -ArgumentList '${q(args)}' -Verb RunAs -Wait -WindowStyle Hidden; exit 0 } catch { exit 5 }`;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', befehl], { windowsHide: true });
    p.on('error', () => fertig({ ok: false, fehler: 'PowerShell startet nicht' }));
    p.on('exit', (code) => {
      let erg = null;
      try { erg = JSON.parse(fs.readFileSync(datei, 'utf8')); fs.unlinkSync(datei); } catch (x) { /* keine Datei */ }
      if (!erg) erg = { ok: false, fehler: code === 5 ? 'Abgebrochen – ohne Admin-Bestätigung lässt sich das Treiber-Profil nicht ändern.' : 'Keine Antwort vom Hilfsprogramm' };
      log.schreiben(erg.ok ? 'INFO' : 'WARN', `Smooth Motion im Treiber ${an ? 'an' : 'aus'}: ${JSON.stringify(erg)}`);
      nvStand = null;
      fertig(erg);
    });
  });
}
// Grafikkarte: Last, Leistung, Temperatur, Takt, Speicher (nvidia-smi kommt mit dem Treiber), höchstens alle 1,5 s
let gpuStand = null, gpuAm = 0, gpuLaeuft = null;
function gpuWerte() {
  if (gpuLaeuft) return gpuLaeuft;
  if (gpuStand && Date.now() - gpuAm < 1500) return Promise.resolve(gpuStand);
  gpuLaeuft = new Promise((fertig) => {
    let aus = '';
    let p;
    try {
      p = spawn('nvidia-smi', ['--query-gpu=name,utilization.gpu,power.draw,temperature.gpu,clocks.gr,memory.used,memory.total,driver_version', '--format=csv,noheader,nounits'], { windowsHide: true });
    } catch (x) { fertig(null); return; }
    p.stdout.on('data', (d) => { aus += d; });
    const t = setTimeout(() => { try { p.kill(); } catch (x) { /* weg */ } }, 3000);
    p.on('error', () => { clearTimeout(t); fertig(null); });
    p.on('exit', () => {
      clearTimeout(t);
      const w = aus.trim().split(/\r?\n/)[0]?.split(',').map((x) => x.trim());
      gpuStand = w && w.length >= 8 ? { name: w[0], last: Number(w[1]), watt: Number(w[2]), grad: Number(w[3]), takt: Number(w[4]), vram: Number(w[5]), vram_gesamt: Number(w[6]), treiber: w[7] } : null;
      gpuAm = Date.now();
      fertig(gpuStand);
    });
  }).finally(() => { gpuLaeuft = null; });
  return gpuLaeuft;
}
/** Letzte Zeilen des Smooth-Motion-Logs des Treibers (C:\NvPresent\, nur mit Log-Stufe > 0) */
function nvLog() {
  try {
    const ordner = 'C:\\NvPresent';
    const dateien = fs.readdirSync(ordner).map((n) => ({ n, t: fs.statSync(path.join(ordner, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    if (!dateien.length) return [];
    const text = fs.readFileSync(path.join(ordner, dateien[0].n), 'utf8');
    return text.trim().split(/\r?\n/).slice(-8).map((z) => z.slice(0, 200));
  } catch (x) { return []; }
}
ipcMain.handle('bewegung-status', async (e, frisch) => (vonSeite(e) ? { nv: await nvStatus(!!frisch), gpu: await gpuWerte() } : null));
ipcMain.handle('bewegung-eintragen', async (e) => {
  if (!vonSeite(e)) return null;
  const erg = await nvEintragen(einst.video.bewegung === 'smooth');
  return { ...erg, nv: await nvStatus(true) };
});
// RIFE: Stand, Einrichten (Download), Modelle, Vorbereiten (TensorRT-Engines), Messen, Entfernen – Fortschritt kommt als Ereignis 'rife'
const rifeAufruf = (fn) => async (e, ...a) => {
  if (!vonSeite(e)) return null;
  try { return { ok: true, stand: await fn(...a) }; } catch (x) { return { ok: false, fehler: x.message || String(x), stand: rife.stand() }; }
};
ipcMain.handle('rife-stand', rifeAufruf(async () => rife.stand()));
ipcMain.handle('rife-einrichten', rifeAufruf(async () => rife.einrichten({ mlrt: true })));
ipcMain.handle('rife-modell', rifeAufruf(async (name) => rife.modellLaden(String(name))));
ipcMain.handle('rife-vorbereiten', rifeAufruf(async (groessen) => {
  const liste = (Array.isArray(groessen) ? groessen : []).filter((g) => Array.isArray(g) && g[0] >= 320 && g[0] <= 7680 && g[1] >= 240 && g[1] <= 4320).slice(0, 6);
  return rife.vorbereiten(einst.video, liste.length ? liste : [[3840, 2160], [1920, 1080]]);
}));
ipcMain.handle('rife-messen', rifeAufruf(async (b, h) => rife.messen(einst.video, Math.round(Number(b) || 3840), Math.round(Number(h) || 2160))));
ipcMain.handle('rife-entfernen', rifeAufruf(async () => rife.entfernen()));
ipcMain.handle('video-monitor', async (e) => {
  if (!vonSpieler(e)) return null;
  const [mpv, gpu, nv] = await Promise.all([spieler.monitor(), gpuWerte(), nvStatus()]);
  return { mpv, gpu, nv, log: einst.video.sm_log > 0 ? nvLog() : [], einst: einst.video, rife: einst.video.bewegung === 'rife' ? { bereit: rife.bereit(einst.video), zustand: rife.zustand() } : null };
});

// Was eine Seite der Engine selbst schicken darf: nur das Treiberfenster des ASIO-Herstellers öffnen. Wiedergabe,
// Ausgabegerät, Korrektur, Kanal-EQ, Bass und Testton setzt allein der Hauptprozess.
ipcMain.on('engine-senden', (e, b) => {
  if (!vonSeite(e) || !b || b.c !== 'asio_einstellungen') return;
  engineSenden({ c: 'asio_einstellungen' });
});

ipcMain.on('client-info', (e) => {
  const url = e.senderFrame?.url || '';
  const ok = erlaubt(url);
  e.returnValue = {
    erlaubt: ok, einrichtung: url.startsWith('file:') && url.endsWith('/einrichtung.html'), version: VERSION, plattform: process.platform, sprache: 'de',
    rolle: ok ? (spieler.istOverlay(e.sender) ? 'spieler' : 'haupt') : '',
  };
});
ipcMain.handle('geraete', (e) => {
  if (!vonSeite(e)) return [];
  // Liste der Engine plus, was dieser PC je Gerät gemerkt hat: eigener Name, ausgeblendet
  const merk = einst.geraete || {};
  return new Promise((r) => {
    // ASIO: je Treiber seine Ausgänge als eigene Geräte („asio:{…}#bus“, treiber = der Treiber, ausgang = Einstellung)
    const fertig = (liste) => r((liste || []).flatMap((g) => {
      const basis = { ...g, eigener_name: merk[g.id]?.name || '', aus: !!merk[g.id]?.aus };
      if (!g.asio) return [basis];
      return ausgaengeFuer(g.id).map((a) => ({ ...basis, id: `${g.id}#${a.id}`, treiber: g.id, ausgang: a, kanaele: a.art === 'kh' ? 2 : LAYOUT_KANAELE[a.layout] }));
    }));
    geraeteWarter.push(fertig);
    engineSenden({ c: 'geraete' });
    setTimeout(() => { geraeteWarter = geraeteWarter.filter((x) => x !== fertig); r([]); }, 4000);
  });
});
// Gerät benennen oder ausblenden (nur auf diesem PC; leerer Name = wieder der erkannte)
ipcMain.on('geraet-merken', (e, w) => {
  if (!vonSeite(e) || !w || typeof w.id !== 'string' || !w.id || w.id.length > 300 || /^(__proto__|constructor|prototype)$/.test(treiberVon(w.id))) return;
  w = { ...w, id: treiberVon(w.id) };   // Name und Ausblenden gelten für den ganzen Treiber
  const alle = { ...(einst.geraete || {}) };
  const g = { ...(alle[w.id] || {}) };
  if (typeof w.name === 'string') { const n = w.name.trim().slice(0, 80); if (n) g.name = n; else delete g.name; }
  if (typeof w.aus === 'boolean') { if (w.aus) g.aus = true; else delete g.aus; }
  if (Object.keys(g).length) alle[w.id] = g; else delete alle[w.id];
  einst.geraete = alle;
  einstSpeichern();
});
ipcMain.handle('ausgabe-lesen', () => {
  const { aufschlag_je, ...rest } = einst.ausgabe;
  return { ...rest, aufschlag: aufschlagFuer(einst.ausgabe.geraet) };
});
ipcMain.on('ausgabe-setzen', (e, w) => {
  if (!vonSeite(e) || !w) return;
  const geraet = String(w.geraet || '');
  const je = { ...(einst.ausgabe.aufschlag_je || {}) };
  // Pause gilt je Gerät (Treiber): bei einem Gerätewechsel zählt der gemerkte Wert des neuen Geräts, nicht der mitgeschickte alte
  if (w.aufschlag != null && treiberVon(geraet) === treiberVon(einst.ausgabe.geraet)) je[treiberVon(geraet)] = aufschlagNormal(w.aufschlag);
  einst.ausgabe = { geraet, exklusiv: w.exklusiv === true, rate: rateNormal(w.rate ?? einst.ausgabe.rate), aufschlag_je: je };
  einstSpeichern();
  ausgabeAnEngine();
});
// Ausgänge eines ASIO-Treibers lesen/speichern (Fenster „Ausgänge & Lautsprecher“)
const treiberGueltig = (t) => typeof t === 'string' && /^asio:[^#]{1,120}$/.test(t);
ipcMain.handle('ausgaenge-lesen', (e, treiber) => {
  if (!vonSeite(e) || !treiberGueltig(treiber)) return null;
  return { ausgaenge: ausgaengeFuer(treiber), namen: einst.asio_namen?.[treiber] || [] };
});
ipcMain.handle('ausgaenge-setzen', (e, treiber, liste) => {
  if (!vonSeite(e) || !treiberGueltig(treiber) || !Array.isArray(liste)) return null;
  const neu = [];
  for (const a of liste.slice(0, 16)) { const x = ausgangPruefen(a); if (x && !neu.some((y) => y.id === x.id)) neu.push(x); }
  if (!neu.length) neu.push(ausgangPruefen(STANDARD_AUSGANG()));
  const g = String(einst.ausgabe.geraet || '');
  const vorher = engineGeraet(g);   // Kanalkarte vor dem Speichern
  einst.asio_ausgaenge = { ...(einst.asio_ausgaenge || {}), [treiber]: neu };
  // gewählter Ausgang dieses Treibers: neue Kanalkarte gleich an die Engine (gelöscht → erster Ausgang)
  if (treiberVon(g) === treiber) {
    const bus = g.split('#')[1];
    if (!neu.some((x) => x.id === bus)) einst.ausgabe = { ...einst.ausgabe, geraet: `${treiber}#${neu[0].id}` };
    einstSpeichern();
    // nur Sub-Werte geändert (gleiche Kanalkarte): Gerät nicht neu öffnen, nur die Weiche nachstellen
    if (engineGeraet(einst.ausgabe.geraet) === vorher) bassAnEngine(einst.ausgabe.geraet); else ausgabeAnEngine();
  } else einstSpeichern();
  return { ausgaenge: neu, geraet: einst.ausgabe.geraet };
});
// Subwoofer-Werte eines Ausgangs live ändern (Space-Menü im Player): Trennfrequenz, Delay, Phase – ohne Neuöffnen
ipcMain.handle('ausgang-bass', (e, treiber, id, werte) => {
  if (!vonSeite(e) || !treiberGueltig(treiber) || !werte || typeof werte !== 'object') return null;
  const l = ausgaengeFuer(treiber);
  const i = l.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const x = ausgangPruefen({ ...l[i], ...Object.fromEntries(['trenn', 'delay', 'phase', 'einheit'].filter((k) => k in werte).map((k) => [k, werte[k]])) });
  l[i] = x;
  einst.asio_ausgaenge = { ...(einst.asio_ausgaenge || {}), [treiber]: l };
  einstSpeichern();
  if (treiberVon(einst.ausgabe.geraet) === treiber) bassAnEngine(einst.ausgabe.geraet);
  return x;
});
// Vorschau aus dem Lautsprecher-Manager: Delay/Pegel/Kopfhörer-Klang des gerade bearbeiteten Ausgangs live hören, ohne zu
// speichern (nur wenn er gerade spielt). ausgang = null → wieder die gespeicherten Werte. neutral = A/B-Vergleich „Original“.
ipcMain.handle('ausgang-vorschau', (e, treiber, id, ausgang, neutral) => {
  if (!vonSeite(e) || !treiberGueltig(treiber)) return null;
  const g = String(einst.ausgabe.geraet || '');
  if (treiberVon(g) !== treiber || (g.split('#')[1] || ausgaengeFuer(treiber)[0]?.id) !== id) return { aktiv: false };
  if (!ausgang) { korrAnEngine(g); return { aktiv: true }; }
  const a = ausgangPruefen({ ...ausgang, id });
  // Kanalkarte oder Art geändert: das hört man erst nach dem Übernehmen (Gerät wird neu geöffnet)
  const gespeichert = ausgangVon(g);
  if (!a || !gespeichert || a.art !== gespeichert.art) return { aktiv: true, vorschau: false };
  korrSenden(a, !!neutral);
  return { aktiv: true, vorschau: true };
});
// EQ-Presets (Lautsprecher-Manager): Name → 8 Bänder, im Client gemerkt
ipcMain.handle('eq-presets', (e) => (vonSeite(e) ? Object.entries(einst.eq_presets || {}).map(([name, baender]) => ({ name, baender })) : []));
ipcMain.handle('eq-preset-setzen', (e, name, baender) => {
  if (!vonSeite(e) || typeof name !== 'string') return null;
  const n = name.trim().slice(0, 60);
  if (!n || /^(__proto__|constructor|prototype)$/.test(n)) return null;
  const p = { ...(einst.eq_presets || {}) };
  if (baender == null) delete p[n];
  else if (Array.isArray(baender)) { if (Object.keys(p).length >= 100 && !(n in p)) return null; p[n] = Array.from({ length: EQ_BAENDER }, (_, i) => eqBand(baender[i], i)); }
  else return null;
  einst.eq_presets = p;
  einstSpeichern();
  return Object.entries(p).map(([name2, b]) => ({ name: name2, baender: b }));
});
// Namen der Treiber-Ausgänge (Engine lädt den Treiber dafür kurz, wenn er nicht offen ist) – gemerkt für später
ipcMain.handle('asio-kanaele', async (e, treiber) => {
  if (!vonSeite(e) || !treiberGueltig(treiber)) return null;
  const m = await engineFragen({ c: 'asio_kanaele', geraet: treiber }, (x) => x.e === 'asio_kanaele' && treiberVon(x.geraet) === treiber, 8000);
  if (m?.namen?.length) {
    einst.asio_namen = { ...(einst.asio_namen || {}), [treiber]: m.namen.map((n) => String(n).slice(0, 40)) };
    einstSpeichern();
    return { namen: einst.asio_namen[treiber] };
  }
  return { namen: einst.asio_namen?.[treiber] || [], fehler: tm(m?.fehler) || t('Der Treiber hat nicht geantwortet') };
});
// Testton auf einem Treiber-Ausgang (0 = erster)
ipcMain.handle('testton', async (e, treiber, ausgang) => {
  if (!vonSeite(e) || !treiberGueltig(treiber)) return null;
  const n = Math.max(0, Math.min(255, Math.round(Number(ausgang) || 0)));
  const geraet = `${treiber}#${n}`;
  const m = await engineFragen({ c: 'testton', geraet, 'w.ms': 2000 }, (x) => x.e === 'testton' && x.geraet === geraet, 15000);
  return m ? (m.ok ? { ok: true } : { fehler: tm(m.fehler) || t('Testton geht nicht') }) : { fehler: t('Keine Antwort von der Engine') };
});
ipcMain.on('server-wechseln', (e) => { if (vonSeite(e)) einrichtungZeigen(); });
ipcMain.handle('log-ordner-oeffnen', (e) => { if (vonSeite(e)) shell.openPath(log.ordner()); return true; });
ipcMain.handle('diagnose-erstellen', (e) => {
  if (!vonSeite(e)) return null;
  try {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = `Bluewave-Diagnose-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
    const ziel = log.diagnose(path.join(app.getPath('desktop'), name), `Client ${VERSION} · Electron ${process.versions.electron} · Server ${basis || '–'} · Ton ${einst.video.ton_weg}`);
    shell.showItemInFolder(ziel);
    return { ok: true, pfad: ziel };
  } catch (x) { log.schreiben('FEHLER', `Diagnosedatei: ${x.message}`); return { ok: false, text: x.message }; }
});
// Client-Einstellungen aus der Web-App: im Infobereich weiterlaufen, mit Windows starten
const clientEinst = () => {
  let autostart = false;
  try { autostart = !!app.getLoginItemSettings({ args: ['--versteckt'] }).openAtLogin; } catch (e) { /* Linux-Test */ }
  return { tray: einst.tray !== false, autostart, update_quelle: updateQuelle(), update_repo: UPDATE_REPO };
};
ipcMain.handle('client-einst', (e) => (vonSeite(e) ? clientEinst() : null));
ipcMain.handle('client-einst-setzen', (e, w) => {
  if (!vonSeite(e) || !w || typeof w !== 'object') return null;
  if (typeof w.tray === 'boolean') { einst.tray = w.tray; einstSpeichern(); }
  if (w.update_quelle === 'github' || w.update_quelle === 'server') { einst.update_quelle = w.update_quelle; einstSpeichern(); neueVersion = null; aufNeueVersionPruefen(true); }
  if (typeof w.autostart === 'boolean') {
    try { app.setLoginItemSettings({ openAtLogin: w.autostart, args: ['--versteckt'] }); } catch (x) { /* Linux-Test */ }
  }
  return clientEinst();
});
ipcMain.handle('update-info', (e) => (vonSeite(e) ? updateInfo() : null));
ipcMain.handle('update-suchen', (e) => (vonSeite(e) ? aufNeueVersionPruefen(true) : null));
ipcMain.handle('update-installieren', async (e) => {
  if (!vonSeite(e)) return false;
  // Aus der Web-Oberfläche (also vom Server) angestoßen: der Nutzer bestätigt am Client selbst, bevor sich dieser beendet
  const a = await dialog.showMessageBox(fenster || undefined, { type: 'question', title: 'Bluewave', message: `Neue Version ${neueVersion?.version || ''}`,
    detail: `Bluewave lädt die neue Version ${neueVersion?.quelle === 'github' ? 'von GitHub' : 'vom Server'}, schließt sich, installiert sie und startet von selbst wieder – deine Einstellungen bleiben.`,
    buttons: ['Jetzt aktualisieren', 'Später'], defaultId: 0, cancelId: 1 }).catch(() => ({ response: 1 }));
  return a.response === 0 ? updateInstallieren() : false;
});

/* ---------- Einrichtung (Server finden) ---------- */
const eigeneSeite = (e) => (e.senderFrame?.url || '').startsWith('file:');
ipcMain.handle('einrichtung-info', () => ({ version: VERSION, server: einst.server, port: einst.port || STANDARD_PORT, meldung: einrichtungMeldung, sprache: 'de', spracheEinst: 'de', woerterbuch: {} }));
ipcMain.handle('einrichtung-suchen', async (e, port) => {
  if (!eigeneSeite(e)) return null;
  if (port) { einst.port = Number(port) || STANDARD_PORT; einstSpeichern(); }
  return suchen(ports());
});
ipcMain.handle('einrichtung-pruefen', async (e, adresse, port) => {
  if (!eigeneSeite(e)) return null;
  const a = adresseNormal(adresse, Number(port) || einst.port || STANDARD_PORT);
  if (!a) return { fehler: 'Bitte eine Adresse wie 192.168.1.10 oder https://filme.example.de eingeben.' };
  const j = await pingen(a, 4000);
  if (!j) return { fehler: `Unter ${a} antwortet kein Bluewave-Server.` };
  const host = new URL(a).hostname;
  const lokal = /^http:\/\//.test(a) && (/^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(host) || !host.includes('.') || /\.(local|lan|home\.arpa|fritz\.box|internal)$/i.test(host));
  return { server: { lan: lokal ? a : '', url: j.url || (lokal ? '' : a), name: j.name || 'Bluewave', version: j.version || '', schluessel: j.schluessel || '', kennung: j.kennung || '' } };
});
ipcMain.handle('einrichtung-verbinden', async (e, s) => {
  if (!eigeneSeite(e)) return null;
  if (!s || (!s.lan && !s.url)) return false;
  einst.server = { lan: s.lan || '', url: s.url || '', name: s.name || 'Bluewave', version: s.version || '', schluessel: /^[0-9a-f]{64}$/.test(s.schluessel || '') ? s.schluessel : '', kennung: s.kennung || '' };
  einstSpeichern();
  const ziel = await erreichbar(einst.server);
  if (!ziel) return false;
  serverLaden(ziel);
  return true;
});

let einrichtungMeldung = '';
function einrichtungZeigen(meldung = '') {
  einrichtungMeldung = meldung;
  basis = '';
  if (spieler.offen) spieler.schliessen();
  engineSenden({ c: 'stopp' });
  fensterSicherstellen();
  fenster.show();
  fenster.loadFile(path.join(__dirname, 'einrichtung.html'));
}

/**
 * Server erreichbar? Zuerst direkt im Heimnetz, dann über die öffentliche Adresse. Ist sein Ausweis gemerkt, muss er ihn
 * belegen – sonst ist es ein anderer Bluewave (z. B. hat ein anderes Gerät die alte IP bekommen). Ohne gemerkten
 * Ausweis wird er beim ersten Erfolg übernommen.
 */
async function erreichbar(s) {
  if (!s) return '';
  for (const [adresse, ms] of [[s.lan, 1500], [s.url, 3500]]) {
    if (!adresse) continue;
    const j = await pingen(adresse, ms);
    if (!j) continue;
    if (s.schluessel) {
      if (j.schluessel !== s.schluessel || !await ausweisPruefen(adresse, s.schluessel)) { log.schreiben('WARN', `Unter ${adresse} antwortet ein anderer Bluewave (${j.kennung || '?'})`); continue; }
    } else if (j.schluessel && await ausweisPruefen(adresse, j.schluessel)) {
      einst.server = { ...s, schluessel: j.schluessel, kennung: j.kennung || '' };
      einstSpeichern();
    }
    return adresse;
  }
  return '';
}

function serverLaden(adresse) {
  basis = new URL(adresse).origin;
  fensterSicherstellen();
  fenster.loadURL(`${basis}/`);
  passtZumServer(basis);
  setTimeout(() => aufNeueVersionPruefen(), 8000);
}

/* ---------- Passt der Server? Neue Version? ---------- */
let protokollGewarnt = '';
async function passtZumServer(adresse) {
  const j = await pingen(adresse, 4000).catch(() => null);
  const sp = Number(j?.client_protokoll || 0);
  if (!sp || sp === PROTOKOLL || protokollGewarnt === adresse) return;
  protokollGewarnt = adresse;
  const serverNeuer = sp > PROTOKOLL;
  log.schreiben('WARN', `Schnittstelle passt nicht: Server ${j.version || '?'} (Protokoll ${sp}), Client ${VERSION} (Protokoll ${PROTOKOLL})`);
  const r = await dialog.showMessageBox(fenster || undefined, {
    type: 'warning', title: 'Bluewave',
    message: serverNeuer ? 'Der Server ist neuer als dieser Client.' : 'Dieser Client ist neuer als der Server.',
    detail: serverNeuer ? `Bitte den Windows-Client aktualisieren (Server ${j.version || '?'}, Client ${VERSION}). Bis dahin kann manches nicht funktionieren.`
      : `Bitte den Server aktualisieren (Server ${j.version || '?'}, Client ${VERSION}). Bis dahin kann manches nicht funktionieren.`,
    buttons: serverNeuer ? ['Jetzt aktualisieren', 'Später'] : ['OK'], defaultId: 0, cancelId: serverNeuer ? 1 : 0,
  }).catch(() => ({ response: -1 }));
  if (serverNeuer && r.response === 0) { await aufNeueVersionPruefen(true); if (neueVersion) updateInstallieren(); }
}

/** Versionen vergleichen (1.2.3, 0.9.0-beta.2): >0 wenn a neuer ist */
function versionVergleich(a, b) {
  const teil = (v) => { const [kern, vor = ''] = String(v).replace(/^v/i, '').split('-'); return [kern.split('.').map((x) => Number(x) || 0), vor]; };
  const [ka, va] = teil(a), [kb, vb] = teil(b);
  for (let i = 0; i < 3; i++) if ((ka[i] || 0) !== (kb[i] || 0)) return (ka[i] || 0) - (kb[i] || 0);
  if (va === vb) return 0;
  if (!va) return 1;   // 1.0.0 ist neuer als 1.0.0-beta.3
  if (!vb) return -1;
  return va.localeCompare(vb, undefined, { numeric: true });
}

let neueVersion = null;   // { version, installer, pruefsumme, groesse, quelle }
// Updates kommen von GitHub (Releases „client-v…“ im öffentlichen Repo) oder vom eigenen Server (Image bringt den Installer mit)
const UPDATE_REPO = /^[\w.-]+\/[\w.-]+$/.test(process.env.BW_UPDATE_REPO || '') ? process.env.BW_UPDATE_REPO : 'lfrank95/bluewave';
const updateQuelle = () => (einst.update_quelle === 'server' ? 'server' : 'github');
const VERSION_OK = /^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/;

/** Neueste Client-Version auf GitHub: { version, installer, pruefsumme, groesse } oder null */
async function vonGithub() {
  const kopf = { 'User-Agent': UA_ZUSATZ, Accept: 'application/vnd.github+json' };
  const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=20`, { headers: kopf, signal: AbortSignal.timeout(15000), cache: 'no-store' });
  if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`);
  let beste = null;
  for (const rel of await r.json()) {
    if (rel.draft || !/^client-v/.test(rel.tag_name || '')) continue;
    const v = rel.tag_name.replace(/^client-v/, '');
    if (!VERSION_OK.test(v) || (beste && versionVergleich(v, beste.version) <= 0)) continue;
    const exe = (rel.assets || []).find((a) => /^Bluewave-Windows-Client-.*\.exe$/.test(a.name));
    if (!exe) continue;
    beste = { version: v, exe, rel };
  }
  if (!beste) return null;
  // Prüfsumme: aus der GitHub-API (digest) oder aus version.json im selben Release
  let summe = /^sha256:[0-9a-f]{64}$/i.test(beste.exe.digest || '') ? beste.exe.digest.slice(7).toLowerCase() : '';
  if (!summe) {
    const vj = beste.rel.assets.find((a) => a.name === 'version.json');
    if (vj) {
      const j = await (await fetch(vj.browser_download_url, { headers: { 'User-Agent': UA_ZUSATZ }, signal: AbortSignal.timeout(15000) })).json().catch(() => null);
      if (j?.version === beste.version && /^[0-9a-f]{64}$/.test(String(j.sha256 || ''))) summe = j.sha256;
    }
  }
  if (!summe) throw new Error('GitHub: keine Prüfsumme zum Installer');
  const erg = { version: beste.version, installer: beste.exe.browser_download_url, pruefsumme: summe, groesse: beste.exe.size || 0, quelle: 'github' };
  // Kleines Update: passt die Basis (Electron, Programm-exe), werden nur die geänderten Teile (app, mpv) geladen
  try {
    const kj = beste.rel.assets.find((a) => a.name === 'komponenten.json');
    const lokal = teileLokal();
    if (kj && lokal) {
      const neu = await (await fetch(kj.browser_download_url, { headers: { 'User-Agent': UA_ZUSATZ }, signal: AbortSignal.timeout(15000) })).json();
      const teile = teilePlanen(lokal, neu, beste.rel.assets);
      if (teile) { erg.teile = teile; erg.komponenten = neu; erg.groesse = teile.reduce((x, t) => x + t.groesse, 0); }
    }
  } catch (e) { log.schreiben('INFO', `Kleines Update nicht möglich: ${e.message}`); }
  return erg;
}

/** Installierte Teile (komponenten.json im Programmordner, vom Installer bzw. letzten kleinen Update) */
function teileLokal() {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(process.execPath), 'komponenten.json'), 'utf8')); } catch (e) { return null; }
}
/** Welche Teile fehlen? null = volles Paket nötig (andere Basis, unbekannter Stand oder Teil fehlt im Release) */
function teilePlanen(lokal, neu, assets) {
  if (!lokal?.basis || lokal.basis !== neu?.basis || !neu.komponenten) return null;
  const teile = [];
  for (const [k, t] of Object.entries(neu.komponenten)) {
    if (!/^[a-z]+$/.test(k) || lokal.komponenten?.[k]?.id === t.id) continue;
    const a = assets.find((x) => x.name === t.datei);
    if (!a || !/^[0-9a-f]{64}$/.test(String(t.sha256 || ''))) return null;
    teile.push({ name: k, url: a.browser_download_url, sha256: t.sha256, groesse: t.groesse || a.size || 0 });
  }
  return teile;
}

/** Neueste Client-Version beim eigenen Server */
async function vomServer() {
  if (!basis) return null;
  const r = await fetch(`${basis}/api/v1/client/version`, { headers: { 'User-Agent': UA_ZUSATZ }, signal: AbortSignal.timeout(15000), cache: 'no-store' });
  if (!r.ok) throw new Error(`Server: HTTP ${r.status}`);
  const j = await r.json();
  const v = String(j?.version || '');
  if (!VERSION_OK.test(v) || !/^[0-9a-f]{64}$/.test(String(j.sha256 || ''))) return null;
  return { version: v, installer: `${basis}/api/v1/client/download`, pruefsumme: j.sha256, groesse: Number(j.groesse) || 0, quelle: 'server' };
}

/** Nach einer neueren Client-Version schauen – GitHub oder Server je nach Einstellung, die andere Quelle als Rückfall */
async function aufNeueVersionPruefen(vonHand = false) {
  const reihe = updateQuelle() === 'server' ? [vomServer, vonGithub] : [vonGithub, vomServer];
  let gefunden = null, erreicht = false;
  for (const f of reihe) {
    try { gefunden = await f(); erreicht = true; break; } catch (e) { log.schreiben('INFO', `Update-Prüfung: ${e.message}`); }
  }
  if (!erreicht) return { ok: false, version: VERSION };
  if (gefunden && versionVergleich(gefunden.version, VERSION) > 0) {
    if (gefunden.version !== neueVersion?.version || gefunden.quelle !== neueVersion?.quelle) {
      neueVersion = gefunden;
      log.schreiben('INFO', `Neue Version verfügbar: ${gefunden.version} (${gefunden.quelle === 'github' ? 'GitHub' : 'Server'})`);
      trayAktualisieren();
      senden('update', updateInfo());
      if (!vonHand) try { tray?.displayBalloon({ title: `Bluewave ${gefunden.version}`, content: 'Neue Version des Windows-Clients – Profil › Windows-Client › Jetzt aktualisieren.', iconType: 'info' }); } catch (e) { /* nur Windows */ }
    }
  } else neueVersion = null;
  return { ok: true, version: VERSION, update: updateInfo() };
}

/* ---------- Update in der App: vom Server laden, prüfen, still installieren, in der neuen Version weiter ---------- */
let updateLaeuft = null;   // { stand: 'laedt'|'startet'|'fehler', prozent, fehler }
function updateInfo() {
  if (!neueVersion) return null;
  return { version: neueVersion.version, quelle: neueVersion.quelle, installierbar: true, groesse: neueVersion.groesse || 0, klein: !!neueVersion.teile, ...(updateLaeuft || {}) };
}
function updateStand(w) {
  updateLaeuft = { ...(updateLaeuft || {}), ...w };
  senden('update', updateInfo());
}
/** Kleines Update: geänderte Teile laden und prüfen, auspacken, dann teilupdate.ps1 (ersetzt nach dem Beenden, startet neu) */
async function teilUpdate(nv) {
  const v = nv.version;
  const stufe = path.join(app.getPath('temp'), `bluewave-update-${v}`);
  log.schreiben('INFO', `Kleines Update auf ${v}: ${nv.teile.map((t) => `${t.name} (${(t.groesse / 1048576).toFixed(1)} MB)`).join(', ') || 'nur Stand'}`);
  updateStand({ stand: 'laedt', prozent: 0, fehler: '' });
  try {
    fs.rmSync(stufe, { recursive: true, force: true });
    fs.mkdirSync(stufe, { recursive: true });
    const gesamt = nv.teile.reduce((x, t) => x + t.groesse, 0) || 1;
    let vorher = 0;
    for (const t of nv.teile) {
      let quelle;
      if (t.lokal) quelle = fs.createReadStream(t.lokal);   // nur Selbsttest (BW_TEST_TEILUPDATE)
      else {
        const u = new URL(t.url);
        if (u.origin !== 'https://github.com' || !u.pathname.startsWith(`/${UPDATE_REPO}/releases/download/client-v`)) throw new Error('Unerwartete Download-Adresse.');
        const r = await fetch(u, { headers: { 'User-Agent': UA_ZUSATZ }, signal: AbortSignal.timeout(20 * 60 * 1000) });
        if (!r.ok || !r.body) throw new Error(`Download fehlgeschlagen (HTTP ${r.status}).`);
        quelle = r.body;
      }
      const zip = path.join(stufe, `${t.name}.zip`);
      const datei = fs.createWriteStream(zip);
      const hash = require('crypto').createHash('sha256');
      let geladen = 0, zuletzt = -1;
      for await (const stueck of quelle) {
        geladen += stueck.length;
        hash.update(stueck);
        if (!datei.write(stueck)) await new Promise((ok) => datei.once('drain', ok));
        const p = Math.floor(((vorher + geladen) / gesamt) * 100);
        if (p !== zuletzt) { zuletzt = p; updateStand({ prozent: Math.min(p, 99) }); }
      }
      await new Promise((ok, f) => datei.end((e) => (e ? f(e) : ok())));
      if (hash.digest('hex') !== t.sha256) throw new Error('Die Prüfsumme der geladenen Datei stimmt nicht.');
      vorher += t.groesse;
      const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
      await new Promise((ok, nein) => {
        const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(path.join(stufe, t.name))} -Force`], { windowsHide: true });
        p.on('error', nein);
        p.on('exit', (c) => (c === 0 ? ok() : nein(new Error(`Auspacken fehlgeschlagen (${c})`))));
      });
      fs.unlinkSync(zip);
    }
    fs.writeFileSync(path.join(stufe, 'komponenten.json'), JSON.stringify(nv.komponenten, null, 1));
  } catch (e) {
    log.schreiben('WARN', `Kleines Update fehlgeschlagen: ${e.message} – nächster Versuch mit dem vollen Paket`);
    try { fs.rmSync(stufe, { recursive: true, force: true }); } catch (x) { /* egal */ }
    delete nv.teile;
    updateStand({ stand: 'fehler', fehler: `${e.message} – bitte noch einmal versuchen (dann mit dem vollen Paket).` });
    return false;
  }
  updateStand({ stand: 'startet', prozent: 100 });
  log.schreiben('INFO', `Kleines Update auf ${v}: Teile bereit, Client beendet sich`);
  try {
    const skript = path.join(app.getPath('temp'), 'bluewave-teilupdate.ps1');
    fs.copyFileSync(path.join(__dirname, 'teilupdate.ps1'), skript);
    const ziel = path.dirname(process.execPath);
    const env = { ...process.env };
    delete env.BW_TEST_TEILUPDATE;
    log.schreiben('INFO', `Teilupdate-Skript: ${skript} -Ziel "${ziel}" -Stufe "${stufe}"`);
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', skript,
      '-Ziel', ziel, '-Stufe', stufe, '-Version', v, '-Warten', String(process.pid)],
    { cwd: app.getPath('temp'), detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
  } catch (e) {
    updateStand({ stand: 'fehler', fehler: e.message || String(e) });
    return false;
  }
  setTimeout(() => { beenden = true; app.quit(); }, 600);
  return true;
}

async function updateInstallieren() {
  if (!neueVersion?.installer || updateLaeuft?.stand === 'laedt' || updateLaeuft?.stand === 'startet') return false;
  const v = neueVersion.version;
  if (neueVersion.teile && process.platform === 'win32') return teilUpdate(neueVersion);
  const ziel = path.join(app.getPath('temp'), `Bluewave-Windows-Client-${v}.exe`);
  log.schreiben('INFO', `Update auf ${v}: lade ${neueVersion.installer}`);
  updateStand({ stand: 'laedt', prozent: 0, fehler: '' });
  try {
    const u = new URL(neueVersion.installer);
    const vomGithub = u.origin === 'https://github.com' && u.pathname.startsWith(`/${UPDATE_REPO}/releases/download/client-v`);
    if (!vomGithub && (u.origin !== basis || u.pathname !== '/api/v1/client/download')) throw new Error('Unerwartete Download-Adresse.');
    const r = await fetch(u, { headers: { 'User-Agent': UA_ZUSATZ }, signal: AbortSignal.timeout(10 * 60 * 1000), cache: 'no-store' });
    if (!r.ok || !r.body) throw new Error(`Download fehlgeschlagen (HTTP ${r.status}).`);
    const gesamt = Number(r.headers.get('content-length')) || neueVersion.groesse || 0;
    const datei = fs.createWriteStream(ziel);
    const hash = require('crypto').createHash('sha256');
    let geladen = 0, zuletzt = 0;
    for await (const stueck of r.body) {
      geladen += stueck.length;
      hash.update(stueck);
      if (!datei.write(stueck)) await new Promise((ok) => datei.once('drain', ok));
      const p = gesamt ? Math.floor((geladen / gesamt) * 100) : 0;
      if (p !== zuletzt) { zuletzt = p; updateStand({ prozent: p }); }
    }
    await new Promise((ok, f) => datei.end((e) => (e ? f(e) : ok())));
    const kopf = Buffer.alloc(2);
    const fd = fs.openSync(ziel, 'r'); fs.readSync(fd, kopf, 0, 2, 0); fs.closeSync(fd);
    if (kopf.toString('latin1') !== 'MZ' || (gesamt && geladen !== gesamt)) throw new Error('Die geladene Datei ist unvollständig.');
    // Prüfsumme aus version.json des Servers muss stimmen – sonst wird nichts installiert
    if (hash.digest('hex') !== neueVersion.pruefsumme) throw new Error('Die Prüfsumme der geladenen Datei stimmt nicht.');
  } catch (e) {
    log.schreiben('WARN', `Update-Download fehlgeschlagen: ${e.message}`);
    updateStand({ stand: 'fehler', fehler: e.message || String(e) });
    try { fs.unlinkSync(ziel); } catch (x) { /* egal */ }
    return false;
  }
  // Installer still starten (/aktualisieren: ohne Klicks über die vorhandene Installation, danach startet Bluewave neu)
  updateStand({ stand: 'startet', prozent: 100 });
  log.schreiben('INFO', `Update auf ${v}: Installer startet, Client beendet sich`);
  try {
    // eigenständiger Prozess außerhalb des Clients (über „start“ entkoppelt, Arbeitsordner Temp – sonst hielte er den
    // Programmordner offen): wartet, bis Client, Engine und mpv beendet sind, ersetzt dann den Programmordner
    const tmp = app.getPath('temp');
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" /d "${tmp}" "${ziel}" /aktualisieren`],
      { cwd: tmp, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  } catch (e) {
    updateStand({ stand: 'fehler', fehler: e.message || String(e) });
    return false;
  }
  setTimeout(() => { beenden = true; app.quit(); }, 600);
  return true;
}

async function ueberZeigen() {
  const ordner = path.dirname(process.execPath);
  const r = await dialog.showMessageBox(fenster || undefined, {
    type: 'info', title: 'Über Bluewave', message: `Bluewave Windows-Client ${VERSION}`,
    detail: `Privates Projekt. Enthält Electron/Chromium, mpv (GPL), FFmpeg (GPL/LGPL), dr_flac/dr_wav und die Schriften Space Grotesk und Manrope (OFL) – die Liste der Fremdkomponenten mit ihren Lizenzen liegt im Programmordner.\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    buttons: ['Lizenzen anzeigen', 'Schließen'], defaultId: 1, cancelId: 1,
  }).catch(() => ({ response: 1 }));
  if (r.response === 0) {
    const p = path.join(ordner, 'DRITTANBIETER.md');
    if (fs.existsSync(p)) shell.openPath(p);
  }
}

/* ---------- Fenster ---------- */
const TITEL_FARBE = '#070b12';
// Eigene Fensterknöpfe in der Kopfzeile der Web-App (statt der Windows-Leiste mit festem Hintergrund)
const fensterZustand = () => (fenster && !fenster.isDestroyed() ? { max: fenster.isMaximized(), voll: fenster.isFullScreen() } : null);
ipcMain.on('fenster-aktion', (e, aktion) => {
  if (!fenster || fenster.isDestroyed() || e.sender.id !== fenster.webContents.id) return;   // nur das Hauptfenster selbst (auch Einrichtung)
  if (aktion === 'min') fenster.minimize();
  else if (aktion === 'max') { if (fenster.isMaximized()) fenster.unmaximize(); else fenster.maximize(); }
  else if (aktion === 'zu') fenster.close();
});
ipcMain.handle('fenster-zustand', (e) => (fenster && !fenster.isDestroyed() && e.sender.id === fenster.webContents.id ? fensterZustand() : null));

function fensterSicherstellen() {
  if (fenster && !fenster.isDestroyed()) return;
  const f = einst.fenster || {};
  fenster = new BrowserWindow({
    width: f.width || 1360, height: f.height || 860, x: f.x, y: f.y,
    minWidth: 420, minHeight: 520,
    backgroundColor: TITEL_FARBE,
    title: 'Bluewave',
    icon: path.join(__dirname, 'bilder', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    // ohne Windows-Titelleiste: die Kopfzeile der Web-App ist die Titelleiste, mit eigenen Fensterknöpfen (Rand, Einrasten
    // und Schatten bleiben von Windows)
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  if (f.max) fenster.maximize();
  // Autostart mit Windows: unsichtbar im Infobereich starten
  const versteckt = process.argv.includes('--versteckt') && !fensterGezeigt && tray;
  fenster.once('ready-to-show', () => { if (!versteckt) { fenster.show(); fensterGezeigt = true; } });
  fenster.on('page-title-updated', (_e, x) => { titelText = String(x || '').slice(0, 120); trayAktualisieren(); });
  for (const ereignis of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) fenster.on(ereignis, () => senden('fenster-zustand', fensterZustand()));
  fenster.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  fenster.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    if (!erlaubt(url)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
  fenster.webContents.on('did-fail-load', (_e, code, text, url, haupt) => {
    if (!haupt || code === -3 || url.startsWith('file:')) return;
    einrichtungZeigen(`Der Server ist gerade nicht erreichbar (${text}).`);
  });
  // Kein Zoom: die Oberfläche sitzt immer passend im Fenster
  try { Promise.resolve(fenster.webContents.setVisualZoomLevelLimits(1, 1)).catch(() => {}); } catch { /* ältere Electron */ }
  fenster.webContents.on('did-finish-load', () => fenster.webContents.setZoomFactor(1));
  fenster.webContents.on('zoom-changed', () => fenster.webContents.setZoomFactor(1));
  fenster.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.control && !input.alt && ['+', '-', '=', '0'].includes(input.key)) { e.preventDefault(); return; }
    if (input.key === 'F5') { fenster.webContents.reload(); e.preventDefault(); }
    if (input.key === 'F11') { fenster.setFullScreen(!fenster.isFullScreen()); e.preventDefault(); }
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) { fenster.webContents.toggleDevTools(); e.preventDefault(); }
  });
  const merken = () => {
    if (!fenster || fenster.isDestroyed() || !fenster.isVisible()) return;
    const max = fenster.isMaximized();
    einst.fenster = { ...(max || fenster.isFullScreen() ? einst.fenster || {} : fenster.getBounds()), max };
  };
  fenster.on('resize', merken);
  fenster.on('move', merken);
  fenster.on('close', (e) => {
    merken(); einstSpeichern();
    if (!beenden && einst.tray !== false && tray) {
      e.preventDefault();
      fenster.hide();
      if (!einst.tray_hinweis) {
        einst.tray_hinweis = true; einstSpeichern();
        try { tray.displayBalloon({ title: 'Bluewave läuft weiter', content: 'Im Infobereich. Beenden: Rechtsklick aufs Symbol.', iconType: 'info' }); } catch (x) { /* nur Windows */ }
      }
    }
  });
  fenster.on('closed', () => { fenster = null; });
}

function zeigen() {
  if (spieler.offen) { spieler.video.show(); spieler.video.focus(); return; }
  fensterSicherstellen(); fenster.show(); fenster.focus();
}

/* ---------- Infobereich (Tray) und Medientasten ---------- */
let trayStand = '';
function trayAktualisieren() {
  if (!tray) return;
  const stand = JSON.stringify([titelText, neueVersion?.version || '', spieler.offen]);
  if (stand === trayStand) return;
  trayStand = stand;
  tray.setToolTip(titelText ? `Bluewave – ${titelText}` : 'Bluewave');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Bluewave anzeigen', click: zeigen },
    ...(spieler.offen ? [{ type: 'separator' }, { label: 'Abspielen/Pause', click: () => spieler.senden('taste', 'playpause') }, { label: 'Wiedergabe beenden', click: () => spieler.senden('taste', 'schliessen') }] : []),
    { type: 'separator' },
    { label: 'Server wechseln …', click: () => einrichtungZeigen() },
    { label: 'Nach Updates suchen …', click: async () => {
      const r = await aufNeueVersionPruefen(true);
      if (!r?.ok) { dialog.showMessageBox(fenster || undefined, { type: 'warning', title: 'Bluewave', message: 'Der Server ist gerade nicht erreichbar.', buttons: ['OK'] }).catch(() => {}); return; }
      if (!r.update) { dialog.showMessageBox(fenster || undefined, { type: 'info', title: 'Bluewave', message: 'Bluewave ist auf dem neuesten Stand.', detail: `Installiert: ${VERSION}`, buttons: ['OK'] }).catch(() => {}); return; }
      updateInstallieren();
    } },
    ...(neueVersion ? [{ label: `Neue Version ${neueVersion.version} – jetzt aktualisieren`, click: () => updateInstallieren() }] : []),
    { label: 'Über Bluewave …', click: () => ueberZeigen() },
    { label: `Version ${VERSION}`, enabled: false },
    { label: 'Beenden', click: () => { beenden = true; app.quit(); } },
  ]));
}

function medientasten() {
  const tasten = { MediaPlayPause: 'playpause', MediaNextTrack: 'next', MediaPreviousTrack: 'prev', MediaStop: 'stop' };
  for (const [taste, art] of Object.entries(tasten)) {
    try { globalShortcut.register(taste, () => { if (spieler.offen) spieler.senden('taste', art); else senden('taste', art); }); } catch (e) { /* belegt */ }
  }
}

/* ---------- Start ---------- */
app.on('second-instance', () => zeigen());

/** Selbsttest (CI auf Windows): Videofenster mit mpv per --wid, Testbild abspielen, Ergebnis ins Log, beenden */
async function selbsttestVideo() {
  const ergebnis = (text) => { log.schreiben('INFO', `SELBSTTEST ${text}`); setTimeout(() => { beenden = true; app.quit(); }, 500); };
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));
  const schritt = (t) => log.schreiben('INFO', `SELBSTTEST-SCHRITT ${t}`);
  const melden = (art, f) => {
    const b = f.getContentBounds();
    const sk = screen.getDisplayMatching(b).scaleFactor || 1;
    log.schreiben('INFO', `SELBSTTEST-BEREIT ${art} ${Math.round(b.x * sk)} ${Math.round(b.y * sk)} ${Math.round(b.width * sk)} ${Math.round(b.height * sk)}`);
  };
  /** Wie im Betrieb: Bildfenster (mit mpv per --wid) und darüber die durchsichtige Bedienung */
  const lauf = async (Art, x, mitBedienung = true) => {
    schritt(`${Art}${mitBedienung ? '' : ' ohne Bedienung'}: Fenster`);
    const durch = Art.endsWith('Durch');
    const opt = { x, y: 100, width: 640, height: 360, frame: false, backgroundColor: durch ? '#00000000' : '#000000', transparent: durch, show: true };
    const video = Art.startsWith('Bildfenster') ? new BaseWindow(opt) : new BrowserWindow(opt);
    if (!Art.startsWith('Bildfenster')) await video.loadURL(durch ? 'about:blank' : 'data:text/html,<body style="margin:0;background:#000">').catch(() => {});
    spieler.video = video;
    schritt(`${Art}: Bedienung`);
    const over = mitBedienung ? new BrowserWindow({ ...video.getContentBounds(), parent: video, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, show: true, focusable: false }) : null;
    if (over) await over.loadURL('about:blank').catch((e) => schritt(`${Art}: Bedienung lädt nicht (${e.message})`));
    schritt(`${Art}: mpv`);
    await spieler.mpvStarten();
    const m = spieler.mpv;
    let geladen = false;
    m.on('ereignis', (e) => { if (e.event === 'file-loaded') geladen = true; });
    await m.befehl(['loadfile', process.env.BW_TEST_VIDEO, 'replace']);
    for (let i = 0; i < 100 && !geladen; i++) await warte(100);
    await warte(2000);
    const [pos, w, h, vo] = await Promise.all([m.lesen('time-pos'), m.lesen('width'), m.lesen('height'), m.lesen('current-vo')]);
    // das Prüfskript fotografiert jetzt den Bildschirm an dieser Stelle (Farben des Testbilds oder nur Schwarz?)
    melden(mitBedienung ? Art : `${Art}OhneBedienung`, video);
    await warte(5000);
    schritt(`${Art}: aufräumen`);
    spieler.mpv = null;
    await m.befehl(['quit']).catch(() => {});
    await warte(800);
    over?.destroy();
    video.destroy();
    spieler.video = null;
    await warte(500);
    return { geladen, pos, w, h, vo };
  };
  // unsichtbares Fenster hält die App am Leben, während die Prüffenster geschlossen und neu geöffnet werden
  const halter = new BrowserWindow({ width: 100, height: 100, show: false });
  void halter;
  try {
    // Gegenprobe fürs Bildschirmfoto: eine bunte Seite muss als bunt erkannt werden
    const probe = new BrowserWindow({ x: 100, y: 100, width: 640, height: 360, frame: false, show: true });
    await probe.loadURL('data:text/html,<body style="margin:0;background:linear-gradient(90deg,red,lime,blue,yellow,magenta,cyan)">');
    await warte(800);
    melden('Probe', probe);
    await warte(3000);
    probe.destroy();
    // mpv im eigenen Fenster (ohne --wid): zeigt, ob das Foto das Bild von mpv überhaupt sieht
    {
      const { Mpv } = require('./mpv');
      spieler.video = halter;
      const args = spieler.mpvArgs().filter((a) => !a.startsWith('--wid=')).concat(['--geometry=640x360+100+100', '--no-border', '--ontop']);
      spieler.video = null;
      const m = new Mpv(spieler.ctx.mpvExe, args, (st, t) => log.schreiben(st, t));
      await m.starten();
      await m.befehl(['loadfile', process.env.BW_TEST_VIDEO, 'replace']);
      await warte(2500);
      log.schreiben('INFO', 'SELBSTTEST-BEREIT MpvEigen 100 100 640 360');
      await warte(4000);
      await m.befehl(['quit']).catch(() => {});
      await warte(800);
    }
    // wie im Betrieb (durchsichtiges BaseWindow mit Bedienung darüber) und zum Vergleich der alte, deckende Aufbau
    const neu = await lauf('BildfensterDurch', 100);
    const alt = await lauf('BrowserWindow', 100);
    log.schreiben('INFO', `SELBSTTEST-VERGLEICH BrowserWindow: ${JSON.stringify(alt)}`);
    ergebnis(`${neu.geladen && neu.pos > 0.5 ? 'OK' : 'FEHLER'} Bildfenster: geladen=${neu.geladen} pos=${neu.pos} bild=${neu.w}x${neu.h} vo=${neu.vo}`);
  } catch (x) { ergebnis(`FEHLER ${x.stack || x.message}`); }
}

/** Selbsttest RIFE (CI ohne NVIDIA-Karte): Python + VapourSynth einrichten, Skript mit VSPipe, dann mpv mit
 *  --vf=vapoursynth (Bilder verdoppeln statt RIFE) – prüft Einrichtung, Einbindung und Takt (24 → 48 fps) */
async function selbsttestRife() {
  const ergebnis = (text) => { log.schreiben('INFO', `SELBSTTEST RIFE ${text}`); setTimeout(() => { beenden = true; app.quit(); }, 500); };
  try {
    rife.test = true;
    await rife.einrichten({ mlrt: false });
    await rife.vorbereiten({ ...einst.video, bewegung: 'rife' }, [[1280, 720]]);
    const z1 = rife.zustand();
    if (!z1?.aktiv) { ergebnis(`FEHLER VSPipe: ${JSON.stringify(z1)}`); return; }
    einst.video = { ...einst.video, bewegung: 'rife', rife_faktor: 2, ton_weg: 'engine' };
    spieler.video = new BaseWindow({ width: 640, height: 360, frame: false, transparent: true, backgroundColor: '#00000000', show: true });
    await spieler.mpvStarten();
    const m = spieler.mpv;
    await m.befehl(['loadfile', process.env.BW_TEST_RIFE, 'replace']);
    await new Promise((r) => setTimeout(r, 7000));
    const mon = await spieler.monitor();
    const z = rife.zustand();
    const ok = z?.aktiv && mon.filter_fps > 44 && mon.filter_fps < 52 && mon.quelle_fps > 23 && mon.quelle_fps < 25;
    ergebnis(`${ok ? 'OK' : 'FEHLER'} quelle=${mon.quelle_fps} gefiltert=${mon.filter_fps} vf=${JSON.stringify(mon.vf)} zustand=${JSON.stringify(z)}`);
  } catch (x) {
    // Diagnose für die Fehlersuche: Python, VapourSynth-Modul, Ordner
    const d = [];
    const pr = (exe, args) => rife.prozess(exe, args, { cwd: rife.vs, timeout: 60000, env: rife.pfadUmgebung() }).catch((y) => y.message);
    d.push('python: ' + await pr(path.join(rife.vs, 'python.exe'), ['-c', 'import sys;print(sys.version);print(sys.path);import vapoursynth as vs;print(vs.__file__);print(vs.core.version())']));
    try { d.push('vs: ' + fs.readdirSync(rife.vs).join(', ')); } catch (y) { /* fehlt */ }
    try { d.push('site-packages: ' + fs.readdirSync(path.join(rife.vs, 'Lib', 'site-packages')).join(', ')); } catch (y) { /* fehlt */ }
    try { const pth = fs.readdirSync(rife.vs).find((n) => /\._pth$/.test(n)); d.push(`${pth}: ` + fs.readFileSync(path.join(rife.vs, pth), 'utf8').replace(/\r?\n/g, ' | ')); } catch (y) { /* fehlt */ }
    try { d.push('portable.vs: ' + fs.readFileSync(path.join(rife.vs, 'portable.vs'), 'utf8').slice(0, 300)); } catch (y) { /* fehlt */ }
    for (const z of d) log.schreiben('INFO', `RIFE DIAGNOSE ${z.replace(/\s+/g, ' ').slice(0, 3000)}`);
    ergebnis(`FEHLER ${x.stack || x.message}`);
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  if (process.env.BW_TEST_VIDEO) { engineStarten(); selbsttestVideo(); return; }
  if (process.env.BW_TEST_RIFE) { selbsttestRife(); return; }
  if (process.env.BW_TEST_TEILUPDATE) {
    // Selbsttest: kleines Update aus einem Ordner (komponenten.json + bw-*.zip) wie aus einem GitHub-Release
    const ordner = process.env.BW_TEST_TEILUPDATE;
    const k = JSON.parse(fs.readFileSync(path.join(ordner, 'komponenten.json'), 'utf8'));
    const teile = teilePlanen(teileLokal(), k, Object.values(k.komponenten).map((t) => ({ name: t.datei, browser_download_url: path.join(ordner, t.datei), size: t.groesse })));
    log.schreiben('INFO', `SELBSTTEST TEILUPDATE plant: ${JSON.stringify(teile)}`);
    if (!teile) { log.schreiben('INFO', 'SELBSTTEST TEILUPDATE FEHLER: Basis passt nicht oder kein lokaler Stand'); app.quit(); return; }
    for (const t of teile) t.lokal = t.url;
    engineStarten();   // wie im Betrieb: die Engine läuft und muss vor dem Ersetzen weg sein
    neueVersion = { version: k.version, komponenten: k, teile, quelle: 'test' };
    teilUpdate(neueVersion).then((ok) => { if (!ok) { log.schreiben('INFO', `SELBSTTEST TEILUPDATE FEHLER ${JSON.stringify(updateLaeuft)}`); app.quit(); } });
    return;
  }
  // Die Web-App braucht im Client nur Zwischenablage und Vollbild – Kamera, Mikrofon, Standort, Benachrichtigungen usw.
  // bekommt keine Seite, auch nicht die des eigenen Servers
  const RECHTE = new Set(['clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((wc, recht, antwort, details) => antwort(RECHTE.has(recht) && erlaubt(details?.requestingUrl || wc?.getURL() || '')));
  session.defaultSession.setPermissionCheckHandler((wc, recht, herkunft) => RECHTE.has(recht) && erlaubt(herkunft || wc?.getURL() || ''));
  engineStarten();
  medientasten();
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'bilder', 'tray.png')));
    tray.on('click', zeigen);
    trayAktualisieren();
  } catch (e) { tray = null; }

  setInterval(() => aufNeueVersionPruefen(), 12 * 3600 * 1000);
  const s = einst.server;
  if (s) {
    const ziel = await erreichbar(s);
    if (ziel) { serverLaden(ziel); return; }
    // anderer Platz im Netz (neue IP)? Derselbe Server wird an seinem Ausweis erkannt
    const funde = await suchen(ports());
    let gleich = null;
    if (s.schluessel) {
      for (const f of funde.filter((x) => x.schluessel === s.schluessel)) if (await ausweisPruefen(f.lan, s.schluessel)) { gleich = f; break; }
    } else gleich = funde.find((f) => (s.url && f.url === s.url) || (f.name && f.name === s.name && funde.length === 1));
    if (gleich) {
      einst.server = { ...s, lan: gleich.lan, version: gleich.version };
      einstSpeichern();
      serverLaden(gleich.lan);
      return;
    }
    einrichtungZeigen(`„${s.name}“ ist gerade nicht erreichbar.`);
    return;
  }
  einrichtungZeigen();
});

app.on('before-quit', () => { beenden = true; if (spieler.offen) spieler.schliessen(); });
app.on('window-all-closed', () => { if (!spieler.offen) app.quit(); });
app.on('will-quit', () => {
  beenden = true;
  globalShortcut.unregisterAll();
  engineSenden({ c: 'beenden' });
  const e = engine;
  // Unter Windows überleben Kindprozesse den Client – Engine sofort beim Update, sonst nach 1,5 s beenden
  if (e) {
    if (updateLaeuft?.stand === 'startet') { try { e.kill(); } catch (x) { /* schon weg */ } }
    else setTimeout(() => { try { e.kill(); } catch (x) { /* schon weg */ } }, 1500);
  }
});
