// Brücke für die Bluewave-Web-App im Client: Hauptfenster (Bibliothek, Einstellungen, Ausgabe der Engine) oder
// Spielerfenster (Bedienung über dem Bild von mpv). Nur für die Adresse des eingerichteten Servers – main.js prüft die
// Herkunft jeder Nachricht zusätzlich. Auf der eigenen Einrichtungsseite (file:) gibt es stattdessen die Server-Suche.
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('client-info');
const verteiler = (kanal) => {
  const hoerer = new Set();
  ipcRenderer.on(kanal, (_e, d) => { for (const f of hoerer) { try { f(d); } catch (x) { console.error(x); } } });
  return (f) => { hoerer.add(f); return () => hoerer.delete(f); };
};

if (info && info.erlaubt) {
  const aufEngine = verteiler('engine');
  const aufTaste = verteiler('taste');
  const aufUpdate = verteiler('update');
  const video = info.rolle === 'spieler'
    ? {
      // Spielerfenster: Auftrag (was abspielen), Laden und Steuern von mpv, Meldungen, Fenster
      auftrag: () => ipcRenderer.invoke('video-auftrag'),
      laden: (w) => ipcRenderer.send('video-laden', w),
      befehl: (b) => ipcRenderer.send('video-befehl', b),
      auf: verteiler('video'),
      aufFenster: verteiler('video-fenster'),
      aufTaste,
      tonWeg: () => '',
      vollbild: () => ipcRenderer.send('video-vollbild'),
      zu: () => ipcRenderer.send('video-zu'),
      // Überwachung (Taste B): Bildraten, Aussetzer, HDR, Grafikkarte, Smooth-Motion-Profil
      monitor: () => ipcRenderer.invoke('video-monitor'),
      // Mini-Wiedergabe (wie bei Plex): verkleinert in der Ecke des Hauptfensters weiterlaufen bzw. wieder groß
      mini: (an) => ipcRenderer.send('video-mini', !!an),
    }
    : {
      // Hauptfenster: Abspielen öffnet das Spielerfenster; danach meldet es sich zurück (Ansicht neu laden)
      oeffnen: (ziel) => ipcRenderer.send('video-oeffnen', ziel),
      aufEnde: verteiler('video-ende'),
      einst: () => ipcRenderer.invoke('video-einst'),
      einstSetzen: (w) => ipcRenderer.invoke('video-einst-setzen', w),
      // Flüssige Bewegung (Test): Treiber-Profil lesen bzw. (mit Admin-Bestätigung) schreiben
      bewegungStatus: (frisch) => ipcRenderer.invoke('bewegung-status', !!frisch),
      bewegungEintragen: () => ipcRenderer.invoke('bewegung-eintragen'),
      // RIFE (KI-Zwischenbilder): Einrichten lädt Python, VapourSynth, vs-mlrt/TensorRT und Modelle; Vorbereiten baut die Engines
      rife: {
        stand: () => ipcRenderer.invoke('rife-stand'),
        einrichten: () => ipcRenderer.invoke('rife-einrichten'),
        modell: (name) => ipcRenderer.invoke('rife-modell', name),
        vorbereiten: (groessen) => ipcRenderer.invoke('rife-vorbereiten', groessen),
        messen: (b, h) => ipcRenderer.invoke('rife-messen', b, h),
        entfernen: () => ipcRenderer.invoke('rife-entfernen'),
        auf: verteiler('rife'),
      },
    };
  contextBridge.exposeInMainWorld('bluewaveNativ', {
    version: info.version,
    plattform: info.plattform,
    rolle: info.rolle,
    video,
    senden: (befehl) => ipcRenderer.send('engine-senden', befehl),
    auf: aufEngine,
    aufTaste,
    // Ausgabe der Engine (übernommen aus Amberwave): Geräte, ASIO-Ausgänge, Lautsprecher-Manager, Kanal-EQ, Testton
    geraete: () => ipcRenderer.invoke('geraete'),
    ausgabeLesen: () => ipcRenderer.invoke('ausgabe-lesen'),
    ausgabeSetzen: (w) => ipcRenderer.send('ausgabe-setzen', w),
    ausgabeStatus: () => ipcRenderer.invoke('ausgabe-status'),
    geraetMerken: (w) => ipcRenderer.send('geraet-merken', w),
    ausgaengeLesen: (treiber) => ipcRenderer.invoke('ausgaenge-lesen', treiber),
    ausgaengeSetzen: (treiber, liste) => ipcRenderer.invoke('ausgaenge-setzen', treiber, liste),
    ausgangBass: (treiber, id, werte) => ipcRenderer.invoke('ausgang-bass', treiber, id, werte),
    ausgangVorschau: (treiber, id, ausgang, neutral) => ipcRenderer.invoke('ausgang-vorschau', treiber, id, ausgang, !!neutral),
    eqPresets: () => ipcRenderer.invoke('eq-presets'),
    eqPresetSetzen: (name, baender) => ipcRenderer.invoke('eq-preset-setzen', name, baender),
    asioKanaele: (treiber) => ipcRenderer.invoke('asio-kanaele', treiber),
    testton: (treiber, ausgang) => ipcRenderer.invoke('testton', treiber, ausgang),
    serverWechseln: () => ipcRenderer.send('server-wechseln'),
    // eigene Fensterknöpfe (nur Hauptfenster): min, max, zu; Zustand { max, voll }
    fenster: info.rolle === 'spieler' ? null : {
      aktion: (a) => ipcRenderer.send('fenster-aktion', a),
      zustand: () => ipcRenderer.invoke('fenster-zustand'),
      auf: verteiler('fenster-zustand'),
    },
    clientEinst: () => ipcRenderer.invoke('client-einst'),
    clientEinstSetzen: (w) => ipcRenderer.invoke('client-einst-setzen', w),
    logOeffnen: () => ipcRenderer.invoke('log-ordner-oeffnen'),
    diagnose: () => ipcRenderer.invoke('diagnose-erstellen'),
    // Update in der App: info() = { version, stand, prozent, fehler } oder null; installieren() lädt vom Server,
    // prüft die Prüfsumme, startet den Installer still und beendet den Client
    update: {
      info: () => ipcRenderer.invoke('update-info'),
      installieren: () => ipcRenderer.invoke('update-installieren'),
      suchen: () => ipcRenderer.invoke('update-suchen'),
      auf: aufUpdate,
    },
  });
}

/* Hauptfenster: eigene Fensterknöpfe (Minimieren, Maximieren, Schließen). Sie entstehen hier im Client und nicht in
   der Web-App, damit sie auch da sind, wenn der Server eine ältere Version der Oberfläche ausliefert. */
if (info && info.rolle !== 'spieler') {
  const PFAD = { min: '<path d="M2 7h10"/>', max: '<rect x="2.5" y="2.5" width="9" height="9" rx="1.2"/>',
    zurueck: '<rect x="2.5" y="4.5" width="7" height="7" rx="1"/><path d="M4.5 4.5V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1"/>', zu: '<path d="M3 3l8 8M11 3l-8 8"/>' };
  const STIL = `
.bw-fenster-knoepfe { position: fixed; z-index: 2147483000; top: 15px; right: 14px; display: flex; gap: 6px; -webkit-app-region: no-drag; app-region: no-drag; }
.bw-fenster-knoepfe button { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 999px; border: 1px solid transparent; padding: 0;
  background: transparent; color: #9fb3cf; cursor: pointer; transition: background .15s, color .15s, border-color .15s; -webkit-app-region: no-drag; app-region: no-drag; }
.bw-fenster-knoepfe button:hover { background: rgba(226, 238, 255, .1); border-color: rgba(214, 230, 255, .14); color: #eaf1fb; }
.bw-fenster-knoepfe button.zu:hover { background: #d9384a; border-color: transparent; color: #fff; }
.bw-fenster-knoepfe svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; }
html.bw-haupt .kopf { padding-right: calc(var(--seite-rand, 32px) + 128px) !important; }
.einrichtung-kopf, body > header:first-child { -webkit-app-region: drag; app-region: drag; }`;
  const svg = (pfad) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 14 14'); s.innerHTML = pfad; return s; };
  const bauen = () => {
    if (document.querySelector('.bw-fenster-knoepfe')) return;
    const stil = document.createElement('style'); stil.textContent = STIL; document.head.append(stil);
    const k = (name, titel, cls) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = cls || ''; b.title = titel; b.setAttribute('aria-label', titel);
      b.append(svg(PFAD[name])); b.addEventListener('click', () => ipcRenderer.send('fenster-aktion', name)); return b;
    };
    const max = k('max', 'Maximieren');
    const box = document.createElement('div');
    box.className = 'bw-fenster-knoepfe';
    box.append(k('min', 'Minimieren'), max, k('zu', 'Schließen', 'zu'));
    const zeigen = (z) => { if (!z) return; max.replaceChildren(svg(z.max ? PFAD.zurueck : PFAD.max)); max.title = z.max ? 'Wiederherstellen' : 'Maximieren'; box.style.display = z.voll ? 'none' : ''; };
    document.body.append(box);
    ipcRenderer.invoke('fenster-zustand').then(zeigen).catch(() => {});
    ipcRenderer.on('fenster-zustand', (_e, z) => zeigen(z));
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', bauen); else bauen();
}

if (info && info.einrichtung) {
  contextBridge.exposeInMainWorld('einrichtung', {
    sprache: 'de',
    spracheSetzen: () => {},
    info: () => ipcRenderer.invoke('einrichtung-info'),
    suchen: (port) => ipcRenderer.invoke('einrichtung-suchen', port),
    pruefen: (adresse, port) => ipcRenderer.invoke('einrichtung-pruefen', adresse, port),
    verbinden: (server) => ipcRenderer.invoke('einrichtung-verbinden', server),
  });
}
