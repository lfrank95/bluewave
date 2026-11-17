// mpv als Kindprozess, gesteuert über seine JSON-Schnittstelle (Named Pipe unter Windows, Unix-Socket zum Testen).
// befehl([...]) → Promise mit data; beobachten(name) → Ereignis 'eigenschaft' (name, wert); alle mpv-Ereignisse als 'ereignis'.
const net = require('net');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const EventEmitter = require('events');

let zaehler = 0;

class Mpv extends EventEmitter {
  constructor(exe, args, log, env) {
    super();
    this.exe = exe;
    this.env = env || null;   // zusätzliche Umgebung (z. B. PATH zu VapourSynth für RIFE)
    this.args = args;
    this.log = log || (() => {});
    this.nr = 1;
    this.offen = new Map();
    this.beobachtet = new Map();
    this.sock = null;
    this.proc = null;
    this.zu = false;
    const name = `bluewave-mpv-${process.pid}-${++zaehler}`;
    this.pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
  }

  /** Startet mpv und verbindet sich (bis zu 10 s) */
  async starten() {
    const args = [...this.args, `--input-ipc-server=${this.pipe}`];
    this.log('INFO', `mpv startet: ${path.basename(this.exe)} ${args.filter((a) => !/^--http-header-fields/.test(a)).join(' ')}`);
    this.proc = spawn(this.exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: this.env ? { ...process.env, ...this.env } : process.env });
    const zeilen = (art) => (d) => { for (const z of String(d).split(/\r?\n/)) if (z.trim()) this.log(art, `[mpv] ${z.trim().slice(0, 500)}`); };
    this.proc.stdout.on('data', zeilen('INFO'));
    this.proc.stderr.on('data', zeilen('WARN'));
    this.proc.on('exit', (code) => {
      this.log(code ? 'WARN' : 'INFO', `mpv beendet (${code})`);
      this.zu = true;
      for (const [, w] of this.offen) w.nein(new Error('mpv beendet'));
      this.offen.clear();
      this.emit('beendet', code);
    });
    this.proc.on('error', (e) => { this.log('FEHLER', `mpv startet nicht: ${e.message}`); this.zu = true; this.emit('beendet', -1); });
    const bis = Date.now() + 10000;
    while (!this.zu && Date.now() < bis) {
      try { await this.verbinden(); return; } catch (e) { await new Promise((r) => setTimeout(r, 80)); }
    }
    throw new Error(this.zu ? 'mpv hat sich gleich wieder beendet' : 'mpv antwortet nicht');
  }

  verbinden() {
    return new Promise((ok, nein) => {
      const s = net.connect(this.pipe);
      s.once('error', nein);
      s.once('connect', () => {
        s.removeListener('error', nein);
        this.sock = s;
        let rest = '';
        s.setEncoding('utf8');
        s.on('data', (d) => {
          rest += d;
          let i;
          while ((i = rest.indexOf('\n')) >= 0) {
            const z = rest.slice(0, i);
            rest = rest.slice(i + 1);
            if (z.trim()) this.zeile(z);
          }
        });
        s.on('error', (e) => this.log('WARN', `mpv-Verbindung: ${e.message}`));
        s.on('close', () => { this.sock = null; });
        ok();
      });
    });
  }

  zeile(z) {
    let m;
    try { m = JSON.parse(z); } catch (e) { return; }
    if (m.request_id && this.offen.has(m.request_id)) {
      const w = this.offen.get(m.request_id);
      this.offen.delete(m.request_id);
      if (m.error === 'success') w.ok(m.data); else w.nein(new Error(`${w.text}: ${m.error}`));
      return;
    }
    if (m.event === 'property-change') { this.emit('eigenschaft', m.name, m.data); return; }
    if (m.event) this.emit('ereignis', m);
  }

  befehl(liste) {
    if (!this.sock || this.zu) return Promise.reject(new Error('mpv läuft nicht'));
    const id = this.nr++;
    return new Promise((ok, nein) => {
      this.offen.set(id, { ok, nein, text: String(liste[0]) });
      this.sock.write(JSON.stringify({ command: liste, request_id: id }) + '\n');
      setTimeout(() => { if (this.offen.has(id)) { this.offen.delete(id); nein(new Error(`${liste[0]}: keine Antwort`)); } }, 8000);
    });
  }

  /** wie befehl, aber Fehler nur ins Log (für Dinge, die schiefgehen dürfen) */
  leise(liste) { return this.befehl(liste).catch((e) => { this.log('INFO', `mpv: ${e.message}`); return null; }); }
  setzen(name, wert) { return this.leise(['set_property', name, wert]); }
  lesen(name) { return this.befehl(['get_property', name]).catch(() => null); }
  beobachten(name) {
    if (this.beobachtet.has(name)) return;
    const id = this.beobachtet.size + 1;
    this.beobachtet.set(name, id);
    this.leise(['observe_property', id, name]);
  }

  beenden() {
    if (this.zu) return;
    this.leise(['quit']);
    const p = this.proc;
    setTimeout(() => { try { if (p && p.exitCode === null) p.kill(); } catch (e) { /* schon weg */ } }, 1500);
  }
}

/** Ausgabegeräte, wie mpv sie kennt: [{id: 'wasapi/{…}', name}] */
function mpvGeraete(exe) {
  return new Promise((fertig) => {
    let aus = '';
    let p;
    try { p = spawn(exe, ['--no-config', '--audio-device=help', '--ao=wasapi'], { windowsHide: true }); } catch (e) { fertig([]); return; }
    p.stdout.on('data', (d) => { aus += d; });
    p.stderr.on('data', (d) => { aus += d; });
    const t = setTimeout(() => { try { p.kill(); } catch (e) { /* egal */ } }, 6000);
    p.on('error', () => { clearTimeout(t); fertig([]); });
    p.on('exit', () => {
      clearTimeout(t);
      const liste = [];
      for (const z of aus.split(/\r?\n/)) {
        const m = /^\s*'([^']+)'\s*\((.*)\)\s*$/.exec(z);
        if (m && m[1] !== 'auto') liste.push({ id: m[1], name: m[2].replace(/^wasapi\s*/i, '') || m[1] });
      }
      fertig(liste);
    });
  });
}

module.exports = { Mpv, mpvGeraete };
