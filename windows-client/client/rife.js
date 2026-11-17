// RIFE (KI-Zwischenbilder) für den Windows-Client: Einrichtung in einen eigenen Ordner – Python (embeddable),
// VapourSynth (portable), vs-mlrt mit TensorRT und die RIFE-Modelle, alles direkt von den Projektseiten geladen –,
// Vorbereiten der TensorRT-Engines (VSPipe), Argumente/Umgebung für mpv und der Zustand für den Bildmonitor.
// Ohne Pfad mit Leerzeichen (TensorRT-Werkzeuge mögen keine): %LOCALAPPDATA%\Bluewave\rife, sonst C:\ProgramData\Bluewave\rife.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VS_TAG = 'R73';
const PY_URL = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip';
const MLRT_TAG = 'v15.16';
const UA = 'Bluewave-Client';
// Modelle: im Paket von vs-mlrt (4.6) oder einzeln aus dem Release „external-models“
const MODELLE = {
  v4_6: { datei: 'rife_v4.6.onnx', paket: true },
  v4_25_lite: { datei: 'rife_v4.25_lite.onnx', extern: 'rife_v4.25_lite.7z' },
  v4_25: { datei: 'rife_v4.25.onnx', extern: 'rife_v4.25.7z' },
  v4_26: { datei: 'rife_v4.26.onnx', extern: 'rife_v4.26.7z' },
};

function basisOrdner() {
  if (process.env.BW_RIFE_ORDNER) return process.env.BW_RIFE_ORDNER;
  const lokal = process.env.LOCALAPPDATA;
  if (lokal && !/\s/.test(lokal)) return path.join(lokal, 'Bluewave', 'rife');
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Bluewave', 'rife');
}

class Rife {
  constructor(ctx) {
    this.ctx = ctx;            // { log, appOrdner, siebenZip }
    this.basis = basisOrdner();
    this.vs = path.join(this.basis, 'vs');
    this.plugins = path.join(this.vs, 'vs-plugins');
    this.engines = path.join(this.basis, 'engines');
    this.laden_ = path.join(this.basis, 'download');
    this.statusDatei = path.join(this.basis, 'zustand.json');
    this.cfgDatei = path.join(this.basis, 'rife.json');
    this.skript = path.join(this.basis, 'bluewave_rife.vpy');
    this.arbeit = null;        // laufende Einrichtung/Vorbereitung: { art, schritt, text, prozent, fehler }
  }

  log(s, t) { this.ctx.log(s, `RIFE: ${t}`); }

  /* ---------- Stand ---------- */
  vsBereit() { return ['python.exe', 'VSScript.dll', 'VSPipe.exe'].every((d) => fs.existsSync(path.join(this.vs, d))); }
  mlrtBereit() { return fs.existsSync(path.join(this.plugins, 'vstrt.dll')) && fs.existsSync(path.join(this.vs, 'vsmlrt.py')); }
  modellDa(name) {
    const m = MODELLE[name];
    return !!m && fs.existsSync(path.join(this.plugins, 'models', 'rife', m.datei));
  }
  v2Da(name) {
    const m = MODELLE[name];
    return !!m && fs.existsSync(path.join(this.plugins, 'models', 'rife_v2', m.datei));
  }
  bereit(e) { return this.vsBereit() && (this.mlrtBereit() || !!this.test) && (this.test || this.modellDa(e?.rife_modell || 'v4_6')); }

  stand() {
    let groesse = 0;
    const zaehlen = (d) => { try { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) zaehlen(p); else groesse += fs.statSync(p).size; } } catch (x) { /* fehlt */ } };
    if (fs.existsSync(this.basis)) zaehlen(this.basis);
    let engines = [];
    try { engines = fs.readdirSync(this.engines).filter((n) => /\.engine$/i.test(n)); } catch (x) { /* keine */ }
    return {
      ordner: this.basis, vs: this.vsBereit(), mlrt: this.mlrtBereit(), groesse,
      modelle: Object.fromEntries(Object.keys(MODELLE).map((k) => [k, { da: this.modellDa(k), v2: this.v2Da(k) }])),
      engines: engines.length, arbeit: this.arbeit, zustand: this.zustand(),
    };
  }

  /** Was das Skript zuletzt gemeldet hat (aktiv, Art, Faktor, Fehler …) */
  zustand() { try { return JSON.parse(fs.readFileSync(this.statusDatei, 'utf8')); } catch (x) { return null; } }

  /* ---------- Hilfen ---------- */
  async json(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  async release(repo, tag) {
    try { return await this.json(`https://api.github.com/repos/${repo}/releases/tags/${tag}`); } catch (x) {
      this.log('WARN', `${repo} ${tag} nicht gefunden (${x.message}), nehme die neueste Version`);
      return this.json(`https://api.github.com/repos/${repo}/releases/latest`);
    }
  }

  /** Datei laden (Weiterleitungen folgen), mit Fortschritt und – wenn bekannt – SHA-256-Prüfung */
  async laden(url, ziel, { groesse = 0, sha256 = '', fortschritt } = {}) {
    if (fs.existsSync(ziel) && groesse && fs.statSync(ziel).size === groesse && !sha256) return ziel;
    fs.mkdirSync(path.dirname(ziel), { recursive: true });
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(3 * 60 * 60 * 1000) });
    if (!r.ok || !r.body) throw new Error(`Download fehlgeschlagen (HTTP ${r.status}): ${path.basename(ziel)}`);
    const gesamt = Number(r.headers.get('content-length')) || groesse;
    const tmp = ziel + '.teil';
    const datei = fs.createWriteStream(tmp);
    const hash = crypto.createHash('sha256');
    let geladen = 0, zuletzt = -1;
    for await (const stueck of r.body) {
      geladen += stueck.length;
      hash.update(stueck);
      if (!datei.write(stueck)) await new Promise((ok) => datei.once('drain', ok));
      const p = gesamt ? Math.floor((geladen / gesamt) * 100) : 0;
      if (p !== zuletzt) { zuletzt = p; fortschritt?.(p, geladen, gesamt); }
    }
    await new Promise((ok, f) => datei.end((e) => (e ? f(e) : ok())));
    if (gesamt && geladen !== gesamt) throw new Error(`${path.basename(ziel)} ist unvollständig`);
    if (sha256 && hash.digest('hex') !== sha256) throw new Error(`Prüfsumme von ${path.basename(ziel)} stimmt nicht`);
    fs.renameSync(tmp, ziel);
    return ziel;
  }

  prozess(exe, args, { cwd, timeout = 10 * 60 * 1000, env, zeile } = {}) {
    return new Promise((ok, nein) => {
      let aus = '';
      const p = spawn(exe, args, { cwd, windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
      const lesen = (d) => { const t = String(d); aus = (aus + t).slice(-20000); if (zeile) for (const z of t.split(/\r?\n/)) if (z.trim()) zeile(z.trim()); };
      p.stdout.on('data', lesen);
      p.stderr.on('data', lesen);
      const t = setTimeout(() => { try { p.kill(); } catch (x) { /* weg */ } }, timeout);
      p.on('error', (e) => { clearTimeout(t); nein(e); });
      p.on('exit', (code) => { clearTimeout(t); if (code === 0) ok(aus); else nein(new Error(`${path.basename(exe)} beendet mit ${code}: ${aus.trim().split(/\r?\n/).slice(-4).join(' | ')}`)); });
    });
  }

  zipAuspacken(zip, ziel) {
    // Expand-Archive verlangt die Endung .zip (Python-Wheels sind auch ZIP-Dateien)
    let quelle = zip;
    if (!/\.zip$/i.test(zip)) { quelle = zip + '.zip'; fs.copyFileSync(zip, quelle); }
    const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
    return this.prozess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath ${q(quelle)} -DestinationPath ${q(ziel)} -Force`])
      .finally(() => { if (quelle !== zip) try { fs.unlinkSync(quelle); } catch (x) { /* egal */ } });
  }

  siebenAuspacken(archiv, ziel, muster = []) {
    if (!this.ctx.siebenZip || !fs.existsSync(this.ctx.siebenZip)) throw new Error('7zr.exe fehlt im Programmordner');
    return this.prozess(this.ctx.siebenZip, ['x', '-y', '-bd', `-o${ziel}`, archiv, ...muster], { timeout: 60 * 60 * 1000 });
  }

  melden(w) { this.arbeit = { ...(this.arbeit || {}), ...w }; this.ctx.melden?.(this.stand()); }

  /* ---------- Einrichtung ---------- */
  /** Lädt und richtet ein, was fehlt. teile: { mlrt: true } (ohne mlrt: nur Python + VapourSynth, z. B. Prüflauf) */
  async einrichten(teile = { mlrt: true }) {
    if (this.arbeit && !this.arbeit.fertig) throw new Error('Läuft bereits');
    this.arbeit = { art: 'einrichten', schritt: '', text: 'Starte …', prozent: 0, fehler: '' };
    try {
      fs.mkdirSync(this.vs, { recursive: true });
      fs.mkdirSync(this.engines, { recursive: true });
      if (!fs.existsSync(path.join(this.vs, 'python.exe'))) await this.pythonEinrichten();
      if (!this.vsBereit()) await this.vapoursynthEinrichten();
      if (teile.mlrt && !this.mlrtBereit()) await this.mlrtEinrichten();
      if (teile.mlrt && !this.modellDa('v4_6')) await this.modelleEinrichten();
      this.skriptKopieren();
      try { fs.rmSync(this.laden_, { recursive: true, force: true }); } catch (x) { /* egal */ }
      this.melden({ text: 'Fertig eingerichtet.', prozent: 100, fertig: true });
      this.log('INFO', 'eingerichtet');
      return this.stand();
    } catch (e) {
      this.log('WARN', `Einrichtung fehlgeschlagen: ${e.stack || e.message}`);
      this.melden({ fehler: e.message || String(e), fertig: true });
      throw e;
    }
  }

  async pythonEinrichten() {
    this.melden({ schritt: 'python', text: 'Lade Python …', prozent: 0 });
    const zip = await this.laden(PY_URL, path.join(this.laden_, path.basename(PY_URL)), { fortschritt: (p) => this.melden({ prozent: p }) });
    await this.zipAuspacken(zip, this.vs);
    // eingebettetes Python: site-packages einschalten (für das VapourSynth-Modul)
    const pth = fs.readdirSync(this.vs).find((n) => /^python3\d+\._pth$/.test(n));
    if (!pth) throw new Error('python3xx._pth fehlt');
    const zeilen = fs.readFileSync(path.join(this.vs, pth), 'utf8').split(/\r?\n/).map((z) => (z.trim() === '#import site' ? 'import site' : z));
    if (!zeilen.includes('Lib/site-packages')) zeilen.splice(2, 0, 'Lib/site-packages');
    if (!zeilen.includes('import site')) zeilen.push('import site');
    fs.writeFileSync(path.join(this.vs, pth), zeilen.join('\r\n'));
    fs.mkdirSync(path.join(this.vs, 'Lib', 'site-packages'), { recursive: true });
  }

  async vapoursynthEinrichten() {
    this.melden({ schritt: 'vapoursynth', text: 'Lade VapourSynth …', prozent: 0 });
    const rel = await this.release('vapoursynth/vapoursynth', VS_TAG);
    const a = rel.assets.find((x) => /^VapourSynth64-Portable-R\d+\.zip$/i.test(x.name));
    if (!a) throw new Error(`VapourSynth ${rel.tag_name}: kein Portable-Paket gefunden`);
    const zip = await this.laden(a.browser_download_url, path.join(this.laden_, a.name), { groesse: a.size, sha256: digest(a), fortschritt: (p) => this.melden({ prozent: p }) });
    await this.zipAuspacken(zip, this.vs);
    // Python-Modul aus dem beiliegenden Wheel nach site-packages (ein Wheel ist ein ZIP)
    const radOrdner = path.join(this.vs, 'wheel');
    const rad = fs.existsSync(radOrdner) ? fs.readdirSync(radOrdner).find((n) => /^vapoursynth-.*\.whl$/i.test(n)) : null;
    if (rad) {
      const sp = path.join(this.vs, 'Lib', 'site-packages');
      await this.zipAuspacken(path.join(radOrdner, rad), sp);
      this.radDatenVerteilen(sp);
    } else this.log('WARN', 'kein VapourSynth-Wheel im Paket gefunden');
    if (!fs.existsSync(path.join(this.vs, 'vs-plugins'))) fs.mkdirSync(path.join(this.vs, 'vs-plugins'));
    if (!fs.existsSync(path.join(this.vs, 'portable.vs'))) fs.writeFileSync(path.join(this.vs, 'portable.vs'), '');
    this.log('INFO', `VapourSynth ${rel.tag_name} eingerichtet (${rad || 'ohne Wheel'})`);
  }

  /** Wie pip: <name>.data/data → Python-Ordner (dort liegt z. B. VapourSynth.dll), purelib/platlib → site-packages, scripts → Scripts */
  radDatenVerteilen(sp) {
    const verschieben = (von, nach) => {
      for (const n of fs.readdirSync(von, { withFileTypes: true })) {
        const q = path.join(von, n.name), z = path.join(nach, n.name);
        if (n.isDirectory()) { fs.mkdirSync(z, { recursive: true }); verschieben(q, z); } else { fs.mkdirSync(nach, { recursive: true }); fs.copyFileSync(q, z); }
      }
    };
    for (const d of fs.readdirSync(sp).filter((n) => /\.data$/i.test(n))) {
      const basis = path.join(sp, d);
      for (const [art, ziel] of [['data', this.vs], ['purelib', sp], ['platlib', sp], ['scripts', path.join(this.vs, 'Scripts')], ['headers', path.join(this.vs, 'include')]]) {
        const q = path.join(basis, art);
        if (fs.existsSync(q)) verschieben(q, ziel);
      }
      fs.rmSync(basis, { recursive: true, force: true });
      this.log('INFO', `Wheel-Daten aus ${d} verteilt`);
    }
  }

  async mlrtEinrichten() {
    const rel = await this.release('AmusementClub/vs-mlrt', MLRT_TAG);
    let teile = rel.assets.filter((x) => /^vsmlrt-windows-x64-tensorrt\.v[\d.]+\.7z(\.\d{3})?$/i.test(x.name));
    if (!teile.length) teile = rel.assets.filter((x) => /^vsmlrt-windows-x64-cuda\.v[\d.]+\.7z(\.\d{3})?$/i.test(x.name));
    if (!teile.length) throw new Error(`vs-mlrt ${rel.tag_name}: kein TensorRT-Paket gefunden`);
    teile.sort((a, b) => a.name.localeCompare(b.name));
    const gesamt = teile.reduce((s, x) => s + x.size, 0);
    let vorher = 0;
    for (const a of teile) {
      this.melden({ schritt: 'mlrt', text: `Lade vs-mlrt mit TensorRT (${(gesamt / 1073741824).toFixed(1).replace('.', ',')} GB) …` });
      await this.laden(a.browser_download_url, path.join(this.laden_, a.name), { groesse: a.size, sha256: digest(a), fortschritt: (p, g) => this.melden({ prozent: Math.floor(((vorher + g) / gesamt) * 100) }) });
      vorher += a.size;
    }
    this.melden({ schritt: 'mlrt', text: 'Packe vs-mlrt aus (dauert ein paar Minuten) …', prozent: 100 });
    await this.siebenAuspacken(path.join(this.laden_, teile[0].name), this.plugins);
    // vsmlrt.py muss neben Python liegen, damit es importiert werden kann
    const py = path.join(this.plugins, 'vsmlrt.py');
    if (fs.existsSync(py)) fs.renameSync(py, path.join(this.vs, 'vsmlrt.py'));
    for (const a of teile) try { fs.unlinkSync(path.join(this.laden_, a.name)); } catch (x) { /* egal */ }
    if (!this.mlrtBereit()) throw new Error('vs-mlrt ist ausgepackt, aber vstrt.dll oder vsmlrt.py fehlen');
    this.log('INFO', `vs-mlrt ${rel.tag_name} eingerichtet (${teile.map((x) => x.name).join(', ')})`);
  }

  /** RIFE 4.6 (und dessen v2-Fassung) aus dem Modellpaket von vs-mlrt, falls das TensorRT-Paket sie nicht enthält */
  async modelleEinrichten() {
    const rel = await this.release('AmusementClub/vs-mlrt', MLRT_TAG);
    const a = rel.assets.find((x) => /^models\.v[\d.]+\.7z$/i.test(x.name));
    if (!a) throw new Error('Modellpaket von vs-mlrt nicht gefunden');
    this.melden({ schritt: 'modelle', text: `Lade RIFE-Modelle (${Math.round(a.size / 1048576)} MB) …`, prozent: 0 });
    const datei = await this.laden(a.browser_download_url, path.join(this.laden_, a.name), { groesse: a.size, sha256: digest(a), fortschritt: (p) => this.melden({ prozent: p }) });
    this.melden({ text: 'Packe die RIFE-Modelle aus …' });
    await this.siebenAuspacken(datei, this.plugins, ['-ir!rife*.onnx']);
    this.onnxEinsortieren(this.plugins);
    if (!this.modellDa('v4_6')) throw new Error('RIFE 4.6 fehlt nach dem Auspacken');
  }

  /** Weitere Modelle (4.25, 4.26 …) einzeln aus dem Release „external-models“ */
  async modellLaden(name) {
    const m = MODELLE[name];
    if (!m) throw new Error('Unbekanntes Modell');
    if (this.modellDa(name)) return this.stand();
    if (this.arbeit && !this.arbeit.fertig) throw new Error('Läuft bereits');
    this.arbeit = { art: 'modell', schritt: name, text: `Lade ${m.datei} …`, prozent: 0, fehler: '' };
    try {
      if (m.paket) await this.modelleEinrichten();
      else {
        const rel = await this.json('https://api.github.com/repos/AmusementClub/vs-mlrt/releases/tags/external-models');
        const a = rel.assets.find((x) => x.name === m.extern);
        if (!a) throw new Error(`${m.extern} gibt es bei vs-mlrt nicht`);
        const datei = await this.laden(a.browser_download_url, path.join(this.laden_, a.name), { groesse: a.size, sha256: digest(a), fortschritt: (p) => this.melden({ prozent: p }) });
        const tmp = path.join(this.laden_, 'modell');
        fs.rmSync(tmp, { recursive: true, force: true });
        await this.siebenAuspacken(datei, tmp);
        this.onnxEinsortieren(tmp);
      }
      if (!this.modellDa(name)) throw new Error(`${m.datei} fehlt nach dem Auspacken`);
      this.melden({ text: `${m.datei} geladen.`, prozent: 100, fertig: true });
      return this.stand();
    } catch (e) {
      this.melden({ fehler: e.message, fertig: true });
      throw e;
    }
  }

  /** Alle rife*.onnx unterhalb von quelle nach vs-plugins/models/rife bzw. rife_v2 */
  onnxEinsortieren(quelle) {
    const ziel = path.join(this.plugins, 'models');
    const gehen = (d) => {
      for (const n of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, n.name);
        if (n.isDirectory()) { gehen(p); continue; }
        if (!/^rife.*\.onnx$/i.test(n.name)) continue;
        const art = /rife_v2/i.test(path.relative(quelle, p)) ? 'rife_v2' : 'rife';
        const z = path.join(ziel, art, n.name);
        if (path.resolve(z) === path.resolve(p)) continue;
        fs.mkdirSync(path.dirname(z), { recursive: true });
        fs.renameSync(p, z);
      }
    };
    gehen(quelle);
  }

  skriptKopieren() {
    fs.mkdirSync(this.basis, { recursive: true });
    fs.copyFileSync(path.join(this.ctx.appOrdner, 'rife', 'bluewave_rife.vpy'), this.skript);
  }

  cfgSchreiben(e) {
    const cfg = {
      vs: this.vs, engines: this.engines, status: this.statusDatei, test: !!this.test,
      faktor: Math.max(2, Math.min(5, Number(e.rife_faktor) || 2)), modell: MODELLE[e.rife_modell] ? e.rife_modell : 'v4_6',
      v2: !!e.rife_v2, skala: e.rife_skala === 0.5 ? 0.5 : 1.0, szene: Math.max(0, Math.min(0.5, Number(e.rife_szene ?? 0.12))),
      max_fps: Number(e.rife_max_fps) || 31, streams: 2,
    };
    fs.writeFileSync(this.cfgDatei, JSON.stringify(cfg, null, 1));
    return cfg;
  }

  pfadUmgebung() {
    const schluessel = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    return { [schluessel]: `${this.vs};${process.env[schluessel] || ''}`, BW_RIFE_CFG: this.cfgDatei };
  }

  /** Für mpv: zusätzliche Argumente und Umgebung, oder null (nicht eingerichtet → ohne RIFE) */
  mpvZusatz(e) {
    if (e.bewegung !== 'rife' || !this.bereit(e)) return null;
    try {
      this.skriptKopieren();
      this.cfgSchreiben(e);
      try { fs.unlinkSync(this.statusDatei); } catch (x) { /* keiner */ }
    } catch (x) { this.log('WARN', `Vorbereitung für mpv: ${x.message}`); return null; }
    const datei = this.skript;
    return {
      args: [`--vf=vapoursynth=file=%${Buffer.byteLength(datei)}%${datei}:buffered-frames=8`],
      env: this.pfadUmgebung(),
    };
  }

  /** TensorRT-Engines für typische Auflösungen bauen (VSPipe mit derselben Kette wie in mpv) */
  async vorbereiten(e, groessen) {
    if (this.arbeit && !this.arbeit.fertig) throw new Error('Läuft bereits');
    if (!this.bereit(e)) throw new Error('RIFE ist noch nicht eingerichtet');
    this.arbeit = { art: 'vorbereiten', schritt: '', text: 'Starte …', prozent: 0, fehler: '' };
    const ergebnisse = [];
    try {
      this.skriptKopieren();
      this.cfgSchreiben(e);
      for (let i = 0; i < groessen.length; i++) {
        const [b, h] = groessen[i];
        const t0 = Date.now();
        this.melden({ schritt: `${b}x${h}`, text: `Optimiere für ${b}×${h} (${i + 1}/${groessen.length}) – TensorRT braucht dafür ein paar Minuten …`, prozent: Math.floor((i / groessen.length) * 100) });
        await this.prozess(path.join(this.vs, 'VSPipe.exe'), ['--arg', `cfg=${this.cfgDatei}`, '--arg', 'modus=vorbereiten', '--arg', `breite=${b}`, '--arg', `hoehe=${h}`, '--end', '23', this.skript, '.'],
          { cwd: this.vs, timeout: 30 * 60 * 1000, env: this.pfadUmgebung() });
        const z = this.zustand();
        const sek = (Date.now() - t0) / 1000;
        if (z?.fehler) throw new Error(z.fehler);
        ergebnisse.push({ groesse: `${b}x${h}`, sekunden: Math.round(sek), art: z?.art || '' });
        this.log('INFO', `vorbereitet ${b}x${h} in ${sek.toFixed(0)} s (${z?.art || '?'})`);
      }
      this.melden({ text: 'Fertig vorbereitet.', prozent: 100, fertig: true, ergebnisse });
      return this.stand();
    } catch (x) {
      this.log('WARN', `Vorbereiten fehlgeschlagen: ${x.message}`);
      this.melden({ fehler: x.message, fertig: true, ergebnisse });
      throw x;
    }
  }

  /** Messung: wie viele Bilder pro Sekunde schafft RIFE bei dieser Auflösung (ohne mpv, nur Rechnen)? */
  async messen(e, b, h) {
    if (!this.bereit(e)) throw new Error('RIFE ist noch nicht eingerichtet');
    this.skriptKopieren();
    const cfg = this.cfgSchreiben(e);
    const n = 240 * cfg.faktor;
    const t0 = Date.now();
    const aus = await this.prozess(path.join(this.vs, 'VSPipe.exe'), ['--arg', `cfg=${this.cfgDatei}`, '--arg', 'modus=vorbereiten', '--arg', `breite=${b}`, '--arg', `hoehe=${h}`, '--arg', 'laenge=240', '-p', this.skript, '.'],
      { cwd: this.vs, timeout: 30 * 60 * 1000, env: this.pfadUmgebung() });
    const fps = Number((aus.match(/([\d.]+)\s*fps/i) || [])[1]) || (n / ((Date.now() - t0) / 1000));
    return { breite: b, hoehe: h, bilder: n, fps: Math.round(fps * 10) / 10, ziel: Math.round(cfg.faktor * 23.976 * 10) / 10, zustand: this.zustand() };
  }

  entfernen() {
    if (this.arbeit && !this.arbeit.fertig) throw new Error('Läuft gerade');
    fs.rmSync(this.basis, { recursive: true, force: true });
    this.arbeit = null;
    return this.stand();
  }
}

/** SHA-256 aus der GitHub-API („sha256:…“), sonst leer */
function digest(a) { return /^sha256:([0-9a-f]{64})$/i.test(a?.digest || '') ? a.digest.slice(7).toLowerCase() : ''; }

module.exports = { Rife, MODELLE };
