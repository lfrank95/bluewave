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
    }
    : {
      // Hauptfenster: Abspielen öffnet das Spielerfenster; danach meldet es sich zurück (Ansicht neu laden)
      oeffnen: (ziel) => ipcRenderer.send('video-oeffnen', ziel),
      aufEnde: verteiler('video-ende'),
      einst: () => ipcRenderer.invoke('video-einst'),
      einstSetzen: (w) => ipcRenderer.invoke('video-einst-setzen', w),
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
