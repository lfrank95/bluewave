// Einrichtung/Einbindung von RIFE (client/rife.js) ohne Netz und ohne Windows: Stand, Konfiguration, mpv-Argumente,
// Einsortieren der Modelle
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ORDNER = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrife-'));
process.env.BW_RIFE_ORDNER = ORDNER;
const { Rife } = require('../client/rife');

let fehler = 0;
const pruefe = (bed, text) => { console.log(`  ${bed ? 'ok' : 'FEHLER'}: ${text}`); if (!bed) fehler++; };
const leer = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); };

const r = new Rife({ log: () => {}, appOrdner: path.join(__dirname, '..', 'client'), siebenZip: '' });
const e = { bewegung: 'rife', rife_faktor: 3, rife_modell: 'v4_6', rife_v2: true, rife_skala: 0.5, rife_szene: 0.08, rife_max_fps: 61 };
console.log('== nicht eingerichtet');
pruefe(r.basis === ORDNER && !r.bereit(e) && r.mpvZusatz(e) === null, 'ohne Einrichtung: mpv ohne RIFE');
pruefe(r.stand().vs === false && r.stand().mlrt === false, 'Stand: nichts da');

console.log('== eingerichtet (Dateien vorhanden)');
for (const d of ['python.exe', 'VSScript.dll', 'VSPipe.exe', 'vsmlrt.py', 'vs-plugins/vstrt.dll', 'vs-plugins/models/rife/rife_v4.6.onnx']) leer(path.join(r.vs, d));
pruefe(r.bereit(e), 'bereit mit Modell 4.6');
pruefe(!r.bereit({ ...e, rife_modell: 'v4_25' }), '4.25 fehlt → nicht bereit');
const z = r.mpvZusatz(e);
const datei = path.join(ORDNER, 'bluewave_rife.vpy');
pruefe(z && z.args[0] === `--vf=vapoursynth=file=%${Buffer.byteLength(datei)}%${datei}:buffered-frames=8`, `mpv-Filter mit Längenangabe: ${z && z.args[0]}`);
pruefe(fs.existsSync(datei) && fs.readFileSync(datei, 'utf8').includes('vsmlrt.RIFE'), 'Skript in den RIFE-Ordner kopiert');
const pfad = Object.keys(z.env).find((k) => k.toUpperCase() === 'PATH');
pruefe(z.env[pfad].startsWith(r.vs + ';') && z.env.BW_RIFE_CFG === r.cfgDatei, 'PATH beginnt mit VapourSynth, Konfiguration über BW_RIFE_CFG');
const cfg = JSON.parse(fs.readFileSync(r.cfgDatei, 'utf8'));
pruefe(cfg.faktor === 3 && cfg.modell === 'v4_6' && cfg.v2 && cfg.skala === 0.5 && cfg.szene === 0.08 && cfg.max_fps === 61 && cfg.engines === r.engines && !cfg.test, `Konfiguration: ${JSON.stringify(cfg)}`);
const c2 = r.cfgSchreiben({ rife_faktor: 9, rife_modell: 'quatsch', rife_szene: 3 });
pruefe(c2.faktor === 5 && c2.modell === 'v4_6' && c2.szene === 0.5 && c2.skala === 1, 'unsinnige Werte begrenzt');
pruefe(r.mpvZusatz({ ...e, bewegung: 'smooth' }) === null, 'nur bei Modus RIFE');

console.log('== Modelle einsortieren');
const tmp = path.join(ORDNER, 'auspack');
leer(path.join(tmp, 'models', 'rife', 'rife_v4.25.onnx'));
leer(path.join(tmp, 'irgendwas', 'rife_v2', 'rife_v4.25.onnx'));
leer(path.join(tmp, 'liesmich.txt'));
r.onnxEinsortieren(tmp);
pruefe(r.modellDa('v4_25') && r.v2Da('v4_25'), '4.25 nach models/rife und models/rife_v2');
pruefe(r.stand().modelle.v4_25.da && r.stand().modelle.v4_26.da === false, 'Stand zeigt die Modelle');

console.log('== Wheel-Daten wie pip verteilen');
const sp = path.join(r.vs, 'Lib', 'site-packages');
leer(path.join(sp, 'vapoursynth-73.data', 'data', 'VapourSynth.dll'));
leer(path.join(sp, 'vapoursynth-73.data', 'data', 'vs-coreplugins', 'x.dll'));
leer(path.join(sp, 'vapoursynth-73.data', 'purelib', 'vsscript', '__init__.py'));
r.radDatenVerteilen(sp);
pruefe(fs.existsSync(path.join(r.vs, 'VapourSynth.dll')) && fs.existsSync(path.join(r.vs, 'vs-coreplugins', 'x.dll')) && fs.existsSync(path.join(sp, 'vsscript', '__init__.py')) && !fs.existsSync(path.join(sp, 'vapoursynth-73.data')), 'data → Python-Ordner, purelib → site-packages');

console.log('== Zustand vom Skript');
fs.writeFileSync(r.statusDatei, JSON.stringify({ aktiv: true, faktor: 3 }));
pruefe(r.zustand().aktiv && r.stand().zustand.faktor === 3, 'Zustand gelesen');
r.entfernen();
pruefe(!fs.existsSync(ORDNER), 'Entfernen löscht den Ordner');

console.log(fehler ? `${fehler} Fehler` : 'RIFE-Einbindung: alles in Ordnung.');
process.exit(fehler ? 1 : 0);
