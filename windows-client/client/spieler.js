// Videowiedergabe im Windows-Client: mpv zeigt das Bild in einem eigenen Fenster (--wid), darüber liegt ein
// durchsichtiges Fenster mit der Bluewave-Bedienung (dieselbe Web-App, Rolle „spieler“). Den Ton spielt je nach Einstellung
// mpv selbst (WASAPI, auf Wunsch exklusiv bzw. als Bitstream) oder die Bluewave-Engine (WASAPI/ASIO mit Lautsprecher-
// Manager): dann holt sie die Tonspur verlustfrei als FLAC vom Server, und das Bild folgt ihrer Uhr (sanft über die
// Abspielgeschwindigkeit von mpv, bei großen Abweichungen mit einem Sprung).
const path = require('path');
const crypto = require('crypto');
const { Mpv } = require('./mpv');

const SPDIF_ERLAUBT = ['ac3', 'eac3', 'dts', 'dts-hd', 'truehd'];

/** dieselbe Filterkette wie der Server (includes/remux.php: ton_filter) – für mpv als lavfi */
function tonFilter(nacht, dialogDb) {
  const teile = [];
  const db = Math.max(0, Math.min(12, Number(dialogDb) || 0));
  if (db > 0) {
    const g = 10 ** (db / 20), a = ((g + 1) / 2).toFixed(4), b = ((g - 1) / 2).toFixed(4);
    teile.push('aformat=channel_layouts=stereo', `pan=stereo|c0=${a}*c0+${b}*c1|c1=${b}*c0+${a}*c1`);
  }
  if (nacht === 'stark') teile.push('acompressor=threshold=-34dB:ratio=6:knee=2.8:attack=8:release=300:makeup=2.818');
  else if (nacht === 'leicht') teile.push('acompressor=threshold=-26dB:ratio=3:knee=4:attack=8:release=300:makeup=1.778');
  return teile.length ? `lavfi=[${teile.join(',')}]` : '';
}

class Spieler {
  constructor(ctx) {
    this.ctx = ctx;
    this.video = null;      // Fenster mit dem Bild
    this.overlay = null;    // Bedienung
    this.mpv = null;
    this.ziel = null;
    this.datei = null;      // aktuelle Ladeanfrage der Bedienung
    this.zustand = {};
    this.zuGeht = false;
    this.eng = null;        // Ton über die Engine: { quelle, ton, offset, id, halt, latenz }
    this.engGen = 0;
    this.token = crypto.randomBytes(6).toString('hex');
    this.nutzerPause = false;
    this.lautstaerke = { wert: 1, stumm: false };
    this.filter = { nacht: 'aus', dialog: 0 };
    this.zeitMerk = { t: 0, am: 0, laeuft: false, speed: 1 };
    this.sprungEigen = 0;
    this.korrekturBis = 0;
    this.speed = 1;
    this.diffs = [];
  }

  get offen() { return !!(this.video && !this.video.isDestroyed()); }
  istOverlay(wc) { return !!(this.overlay && !this.overlay.isDestroyed() && wc && wc.id === this.overlay.webContents.id); }

  /* ---------------- Fenster ---------------- */
  async oeffnen(ziel) {
    const { BrowserWindow } = this.ctx.electron;
    this.ziel = ziel;
    if (this.offen) {
      // läuft schon: neuen Titel in der Bedienung starten (aus der Mini-Wiedergabe wieder groß)
      if (this.istMini) this.mini(false);
      this.overlay.webContents.reload();
      this.video.show(); this.video.focus();
      return;
    }
    const haupt = this.ctx.hauptfenster();
    const b = haupt && !haupt.isDestroyed() ? haupt.getBounds() : { width: 1360, height: 860 };
    const e = this.ctx.einst();
    this.zuGeht = false;
    this.video = new BrowserWindow({
      ...b, minWidth: 480, minHeight: 270, frame: false, backgroundColor: '#000000', show: false, title: 'Bluewave',
      icon: this.ctx.icon, autoHideMenuBar: true, fullscreenable: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
    });
    this.video.loadURL('data:text/html,<html><body style="margin:0;background:#000"></body></html>');
    this.overlay = new BrowserWindow({
      ...b, parent: this.video, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false,
      movable: false, minimizable: false, maximizable: false, skipTaskbar: true, show: false, focusable: true, title: 'Bluewave',
      webPreferences: { preload: this.ctx.preload, contextIsolation: true, sandbox: true, backgroundThrottling: false, spellcheck: false },
    });
    this.overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.overlay.webContents.on('will-navigate', (ev, url) => { if (!this.ctx.erlaubt(url)) ev.preventDefault(); });
    this.overlay.webContents.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F11') { ev.preventDefault(); this.vollbild(); }
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) { this.overlay.webContents.toggleDevTools(); ev.preventDefault(); }
      if (input.control && !input.alt && ['+', '-', '=', '0'].includes(input.key)) ev.preventDefault();
    });
    const folgen = () => {
      if (!this.offen || !this.overlay || this.overlay.isDestroyed()) return;
      this.overlay.setBounds(this.video.getContentBounds());
    };
    for (const ereignis of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) this.video.on(ereignis, folgen);
    this.video.on('enter-full-screen', () => this.fensterMelden());
    this.video.on('leave-full-screen', () => this.fensterMelden());
    this.video.on('focus', () => { if (this.overlay && !this.overlay.isDestroyed()) this.overlay.focus(); });
    this.video.on('close', (ev) => {
      if (this.zuGeht) return;
      // Alt+F4, Taskleiste: erst die Bedienung schließen lassen (Fortschritt speichern), spätestens nach 3 s hart
      ev.preventDefault();
      this.zuGeht = true;
      this.senden('taste', 'schliessen');
      setTimeout(() => this.schliessen(), 3000);
    });
    this.video.on('closed', () => { this.video = null; this.aufraeumen(); });
    if (haupt && !haupt.isDestroyed() && haupt.isMaximized()) this.video.maximize();
    this.video.once('ready-to-show', async () => {
      if (e.vollbild || (haupt && !haupt.isDestroyed() && haupt.isFullScreen())) this.video.setFullScreen(true);
      this.video.show();
      folgen();
      try { await this.mpvStarten(); } catch (x) {
        this.ctx.log('FEHLER', `mpv: ${x.message}`);
        this.melden({ e: 'fehler', text: `mpv startet nicht (${x.message}).` });
      }
      this.overlay.loadURL(`${this.ctx.basis()}/`);
      this.overlay.once('ready-to-show', () => { folgen(); this.overlay.show(); this.overlay.focus(); if (haupt && !haupt.isDestroyed()) haupt.hide(); });
    });
  }

  fensterMelden() {
    this.senden('video-fenster', { vollbild: !!(this.offen && this.video.isFullScreen()), mini: !!this.istMini });
  }

  /** Mini-Wiedergabe wie bei Plex: Film läuft klein in der Ecke des Hauptfensters weiter, die Bibliothek ist bedienbar */
  mini(an) {
    an = !!an;
    const haupt = this.ctx.hauptfenster();
    if (!this.offen || !haupt || haupt.isDestroyed() || an === !!this.istMini) return;
    if (an) {
      const anwenden = () => {
        if (!this.offen) return;
        const v = this.vorMini;
        if (this.video.isMaximized()) this.video.unmaximize();
        if (v.max) haupt.maximize(); else haupt.setBounds(v.bounds);
        haupt.show();
        this.istMini = true;
        this.video.setMinimumSize(200, 112);
        this.video.setParentWindow(haupt);   // bleibt über dem Hauptfenster und wandert mit ihm
        this.miniPlatzieren();
        haupt.focus();
        if (!this.hauptFolgen) {
          this.hauptFolgen = () => { if (this.istMini) this.miniPlatzieren(); };
          this.hauptZu = () => { if (this.istMini) this.senden('taste', 'schliessen'); };
          for (const ereignis of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) haupt.on(ereignis, this.hauptFolgen);
          haupt.on('hide', this.hauptZu);
          this.hauptRef = haupt;
        }
        this.fensterMelden();
      };
      this.vorMini = { bounds: this.video.getBounds(), max: this.video.isMaximized(), voll: this.video.isFullScreen() };
      if (this.vorMini.voll) {
        this.vorMini.bounds = haupt.getBounds();
        this.video.once('leave-full-screen', () => setTimeout(anwenden, 120));
        this.video.setFullScreen(false);
      } else anwenden();
    } else {
      this.istMini = false;
      this.video.setParentWindow(null);
      this.video.setMinimumSize(480, 270);
      const max = haupt.isMaximized();
      this.video.setBounds(haupt.getBounds());
      if (max) this.video.maximize();
      this.video.show();
      this.video.focus();
      haupt.hide();
      this.fensterMelden();
    }
  }

  miniPlatzieren() {
    const haupt = this.ctx.hauptfenster();
    if (!this.offen || !haupt || haupt.isDestroyed()) return;
    const c = haupt.getContentBounds();
    const w = Math.round(Math.max(260, Math.min(440, c.width * 0.3)));
    const h = Math.round((w * 9) / 16);
    this.video.setBounds({ x: c.x + c.width - w - 24, y: c.y + c.height - h - 24, width: w, height: h });
  }

  miniLoesen() {
    const h = this.hauptRef;
    if (h && !h.isDestroyed() && this.hauptFolgen) {
      for (const ereignis of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) h.removeListener(ereignis, this.hauptFolgen);
      h.removeListener('hide', this.hauptZu);
    }
    this.hauptFolgen = null; this.hauptZu = null; this.hauptRef = null;
  }

  vollbild() {
    if (!this.offen) return;
    this.video.setFullScreen(!this.video.isFullScreen());
  }

  /** Bedienung meldet „fertig“ (Player geschlossen) */
  schliessen() {
    if (this.zuGeht === 'fertig') return;
    this.zuGeht = 'fertig';
    const haupt = this.ctx.hauptfenster();
    const warMini = !!this.istMini;
    this.miniLoesen();
    this.istMini = false;
    if (haupt && !haupt.isDestroyed()) {
      if (this.offen && !warMini && !this.video.isFullScreen() && !this.video.isMaximized()) haupt.setBounds(this.video.getBounds());
      haupt.show();
      haupt.focus();
      haupt.webContents.send('video-ende');
    }
    this.aufraeumen();
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
    if (this.offen) this.video.destroy();
    this.overlay = null;
    this.video = null;
  }

  aufraeumen() {
    this.engineAus();
    if (this.mpv) { this.mpv.beenden(); this.mpv = null; }
    this.datei = null;
  }

  senden(kanal, daten) {
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.webContents.send(kanal, daten);
  }
  melden(m) { this.senden('video', m); }

  /* ---------------- mpv ---------------- */
  tonWeg() {
    const e = this.ctx.einst();
    return ['engine', 'mpv', 'bitstream'].includes(e.ton_weg) ? e.ton_weg : 'engine';
  }

  mpvArgs() {
    const e = this.ctx.einst();
    const weg = this.tonWeg();
    const hwnd = this.video.getNativeWindowHandle();
    const wid = process.platform === 'win32' ? (hwnd.length >= 8 ? hwnd.readBigUInt64LE(0) : BigInt(hwnd.readUInt32LE(0))).toString() : String(hwnd.readUInt32LE(0));
    const konf = path.join(this.ctx.userData, 'mpv');
    const a = [
      `--wid=${wid}`, '--idle=yes', '--force-window=yes', '--keep-open=yes', '--osc=no', '--osd-level=0', '--osd-bar=no',
      '--input-default-bindings=no', '--input-vo-keyboard=no', '--input-cursor=no', '--cursor-autohide=no', '--terminal=no',
      '--load-scripts=no', '--ytdl=no', '--sub-auto=no', '--audio-file-auto=no', '--save-position-on-quit=no', '--resume-playback=no',
      `--config-dir=${konf}`, '--config=yes', `--log-file=${path.join(this.ctx.logOrdner, 'mpv.log')}`, '--msg-level=all=warn',
      `--hwdec=${e.hwdec === 'no' ? 'no' : 'auto-safe'}`, '--vo=gpu-next', `--gpu-api=${e.renderer === 'vulkan' ? 'vulkan' : 'd3d11'}`, '--target-colorspace-hint=yes',
      '--cache=yes', '--demuxer-max-bytes=800MiB', '--demuxer-max-back-bytes=200MiB', '--demuxer-readahead-secs=120', '--network-timeout=30',
      `--user-agent=${this.ctx.userAgent}`, '--sub-font=Manrope', '--sub-font-size=44', '--sub-border-size=2.6', '--sub-shadow-offset=1', '--sub-margin-y=48',
      '--background-color=#000000', '--keep-open-pause=no', '--hr-seek=yes', '--media-controls=no',
    ];
    if (process.platform !== 'win32') a.splice(a.findIndex((x) => x.startsWith('--gpu-api=')), 1);
    // Takt: „audio" (Standard) oder „display-resample" (Bild an die Bildwiederholrate gekoppelt, Ton minimal angepasst)
    a.push(`--video-sync=${e.mpv_sync === 'display-resample' ? 'display-resample' : 'audio'}`);
    if (e.mpv_interpolation && e.mpv_sync === 'display-resample') a.push('--interpolation=yes', '--tscale=oversample');
    // Ohne VSync: Smooth Motion halbiert sonst unter Umständen die Bildrate (Empfehlung aus der NVIDIA-FAQ)
    if (e.vsync === false) a.push(e.renderer === 'vulkan' ? '--vulkan-swap-mode=immediate' : '--d3d11-sync-interval=0');
    if (weg === 'engine') {
      a.push('--ao=null');   // Ton kommt von der Engine; mpv läuft mit Systemuhr, die Bluewave an die Engine anlehnt
    } else {
      a.push('--ao=wasapi', `--audio-device=${e.mpv_geraet && e.mpv_geraet !== 'auto' ? e.mpv_geraet : 'auto'}`, `--audio-delay=${((Number(e.versatz_ms) || 0) / 1000).toFixed(3)}`);
      if (weg === 'bitstream') {
        const f = (e.spdif || []).filter((x) => SPDIF_ERLAUBT.includes(x));
        a.push(`--audio-spdif=${f.join(',') || 'ac3,dts'}`, '--audio-exclusive=yes');
      } else a.push(`--audio-exclusive=${e.mpv_exklusiv ? 'yes' : 'no'}`);
      // LFE ohne Subwoofer auf die Front (beim Heruntermischen, z. B. 5.1 auf Quadro oder Stereo) – wie in der Engine
      if (e.lfe_front && weg !== 'bitstream') a.push(`--audio-swresample-o=lfe_mix_level=${(10 ** ((4 + (Number(e.lfe_db) || 0)) / 20)).toFixed(3)}`);
    }
    return a;
  }

  async mpvStarten() {
    if (this.mpv && !this.mpv.zu) return;
    this.weg = this.tonWeg();
    const args = this.mpvArgs();
    // RIFE: Bilder laufen durch VapourSynth (CPU-Speicher) → Dekodieren mit Rückkopie, Skript und Umgebung dazu
    let env = null;
    const e = this.ctx.einst();
    const rz = e.bewegung === 'rife' ? this.ctx.rife?.mpvZusatz(e) : null;
    this.rifeAn = !!rz;
    if (rz) {
      const i = args.findIndex((x) => x.startsWith('--hwdec='));
      if (i >= 0 && args[i] !== '--hwdec=no') args[i] = '--hwdec=auto-copy-safe';
      args.push(...rz.args);
      env = rz.env;
      this.ctx.log('INFO', `RIFE an: ${e.rife_faktor}× ${e.rife_modell}${e.rife_v2 ? ' v2' : ''}, Bewegung ${e.rife_skala === 0.5 ? 'halbe' : 'volle'} Auflösung`);
    } else if (e.bewegung === 'rife') {
      this.ctx.log('WARN', 'RIFE gewählt, aber nicht eingerichtet – spiele ohne');
      this.melden({ e: 'hinweis', text: 'RIFE ist gewählt, aber noch nicht eingerichtet – der Film läuft ohne Zwischenbilder.' });
    }
    const m = new Mpv(this.ctx.mpvExe, args, this.ctx.log, env);
    this.mpv = m;
    m.on('eigenschaft', (n, w) => { if (this.mpv === m) this.eigenschaft(n, w); });
    m.on('ereignis', (x) => { if (this.mpv === m) this.ereignis(x); });
    m.on('beendet', () => { if (this.mpv === m && this.offen && this.zuGeht === false) this.melden({ e: 'fehler', text: 'mpv wurde unerwartet beendet.' }); });
    await m.starten();
    for (const n of ['time-pos', 'duration', 'pause', 'paused-for-cache', 'seeking', 'eof-reached', 'demuxer-cache-duration', 'frame-drop-count', 'estimated-frame-number', 'speed']) m.beobachten(n);
  }

  /** Ladeanfrage der Bedienung: { url, start, ton, untertitel, modus, ton_quelle, tonspuren, dauer, titel } */
  async laden(w) {
    if (!w || typeof w.url !== 'string' || !this.ctx.erlaubt(w.url)) return;
    if (!this.mpv || this.mpv.zu) { try { await this.mpvStarten(); } catch (x) { this.melden({ e: 'fehler', text: x.message }); return; } }
    this.datei = w;
    this.fensterMelden();   // die Bedienung kennt so den Vollbild-Stand, auch wenn das Fenster schon im Vollbild startete
    this.engineAus();
    this.zustand = { dauer: Number(w.dauer) || 0, ende: false };
    this.nutzerPause = false;
    if (this.offen && w.titel) this.video.setTitle(`${String(w.titel).slice(0, 120)} – Bluewave`);
    const m = this.mpv;
    // Anmeldung der Web-App gilt auch für mpv (Datei, Untertitel, HLS)
    const kopf = (await this.ctx.cookieKopf(w.url)).replace(/\r\n$/, '');
    await m.leise(['change-list', 'http-header-fields', 'clr', '']);
    if (kopf) await m.leise(['change-list', 'http-header-fields', 'append', kopf]);
    // Ton über die Engine nur bei der unveränderten Datei (beim Umwandeln steckt der Ton im HLS-Strom)
    const engine = this.weg === 'engine' && w.modus === 'direkt' && /^o?\d+$/.test(String(w.ton_quelle || ''));
    this.engPlan = engine ? { quelle: String(w.ton_quelle), ton: Math.max(0, Number(w.ton) || 0) } : null;
    await m.setzen('start', String(Math.max(0, Number(w.start) || 0)));
    await m.setzen('aid', engine ? 'no' : (Number.isInteger(w.ton) && w.modus === 'direkt' ? String(w.ton + 1) : 'auto'));
    await m.setzen('sid', 'no');
    this.halt = engine;                // mit Engine: erst loslaufen, wenn der Ton da ist (das Anhalten zeigt „lädt“)
    await m.setzen('pause', engine);
    await m.setzen('speed', 1);
    this.speed = 1;
    await m.setzen('af', this.weg === 'bitstream' || engine ? '' : tonFilter(this.filter.nacht, this.filter.dialog));
    this.lautSetzen();
    this.untertitelWunsch = w.untertitel || null;
    await m.leise(['loadfile', w.url, 'replace']);
  }

  eigenschaft(n, w) {
    const z = this.zustand;
    switch (n) {
      case 'time-pos':
        if (typeof w !== 'number') return;
        this.zeitMerk = { t: w, am: Date.now(), laeuft: this.zeitMerk.laeuft, speed: this.speed };
        if (!z.zeitGesendet || Date.now() - z.zeitGesendet > 240) {
          z.zeitGesendet = Date.now();
          this.melden({ e: 'zeit', pos: w, dauer: z.dauer || undefined, puffer: z.puffer, verworfen: z.verworfen, bilder: z.bilder });
        }
        break;
      case 'duration': if (typeof w === 'number' && w > 0) z.dauer = w; break;
      case 'demuxer-cache-duration': if (typeof w === 'number') z.puffer = w; break;
      case 'frame-drop-count': z.verworfen = w || 0; break;
      case 'estimated-frame-number': z.bilder = w || 0; break;
      case 'pause':
        this.zeitMerk.laeuft = !w;
        if (this.eng?.halt || this.halt) return;    // eigenes Anhalten (Warten auf den Ton) zeigt die Bedienung als „lädt“
        this.nutzerPause = !!w;
        this.melden({ e: 'pause', an: !!w });
        if (this.eng && !this.eng.halt) this.engineSenden({ c: w ? 'pause' : 'spielen', 'w.fade': w ? 15 : 0 });
        break;
      case 'paused-for-cache':
        this.melden({ e: 'warten', an: !!w });
        if (this.eng && !this.eng.halt) this.engineSenden({ c: w ? 'pause' : (this.nutzerPause ? 'pause' : 'spielen') });
        break;
      case 'seeking': this.melden({ e: 'spult', an: !!w }); break;
      case 'eof-reached':
        if (w && !z.ende) { z.ende = true; this.engineSenden({ c: 'pause' }); this.melden({ e: 'ende' }); }
        break;
      default:
    }
  }

  async ereignis(x) {
    const m = this.mpv;
    if (!m) return;
    if (x.event === 'file-loaded') {
      const [dauer, br, ho] = await Promise.all([m.lesen('duration'), m.lesen('width'), m.lesen('height')]);
      if (dauer) this.zustand.dauer = dauer;
      this.melden({ e: 'geladen', dauer: dauer || this.zustand.dauer, breite: br || 0, hoehe: ho || 0, ton_weg: this.engPlan ? 'engine' : this.weg });
      if (this.untertitelWunsch) this.untertitel(this.untertitelWunsch);
      if (this.engPlan) {
        const pos = (await m.lesen('time-pos')) ?? (Number(this.datei?.start) || 0);
        this.engineStarten(pos);
      }
    } else if (x.event === 'end-file') {
      if (x.reason === 'error') {
        this.ctx.log('WARN', `mpv: Datei lässt sich nicht abspielen (${x.file_error || '?'})`);
        this.melden({ e: 'fehler', text: `mpv kann die Datei nicht abspielen (${x.file_error || 'Fehler'}).` });
      }
    } else if (x.event === 'playback-restart') {
      // nach einem Sprung: mit Engine den Ton an der neuen Stelle neu holen (eigene Korrektursprünge ausgenommen)
      if (this.sprungEigen > 0) { this.sprungEigen--; return; }
      if (this.eng && this.eng.bereit) {
        const pos = await m.lesen('time-pos');
        if (typeof pos === 'number' && Math.abs(pos - this.engZeit()) > 0.25) this.engineStarten(pos);
      }
    }
  }

  /** Befehle der Bedienung */
  async befehl(b) {
    const m = this.mpv;
    if (!b || typeof b.c !== 'string' || !m) return;
    switch (b.c) {
      case 'spielen':
        this.nutzerPause = false;
        if (this.zustand.ende) { this.zustand.ende = false; await m.leise(['seek', 0, 'absolute']); }
        if (this.eng?.halt) { this.melden({ e: 'pause', an: false }); return; }
        m.setzen('pause', false);
        break;
      case 'pause':
        this.nutzerPause = true;
        if (this.eng?.halt) { this.melden({ e: 'pause', an: true }); return; }
        m.setzen('pause', true);
        break;
      case 'springen': {
        const pos = Math.max(0, Number(b.pos) || 0);
        this.zustand.ende = false;
        if (this.eng) {
          // Bild und Ton gemeinsam: Bild hinspringen und anhalten, Ton dort neu holen, dann zusammen weiter
          await m.leise(['seek', pos, 'absolute+exact']);
          this.engineStarten(pos);
        } else await m.leise(['seek', pos, 'absolute+exact']);
        break;
      }
      case 'lautstaerke':
        this.lautstaerke = { wert: Math.max(0, Math.min(1, Number(b.wert) || 0)), stumm: !!b.stumm };
        this.lautSetzen();
        this.melden({ e: 'lautstaerke', wert: this.lautstaerke.wert, stumm: this.lautstaerke.stumm });
        break;
      case 'ton': {
        const i = Math.max(0, Math.round(Number(b.index) || 0));
        if (this.eng) { this.eng.ton = i; this.engPlan = { ...this.engPlan, ton: i }; this.engineStarten(this.mpvZeit()); } else await m.setzen('aid', String(i + 1));
        break;
      }
      case 'untertitel': this.untertitel(b.aus ? null : b); break;
      case 'tonfilter':
        this.filter = { nacht: ['leicht', 'stark'].includes(b.nacht) ? b.nacht : 'aus', dialog: Math.max(0, Math.min(12, Number(b.dialog) || 0)) };
        if (this.eng) this.engineStarten(this.mpvZeit());
        else if (this.weg !== 'bitstream') m.setzen('af', tonFilter(this.filter.nacht, this.filter.dialog));
        else if (this.filter.nacht !== 'aus' || this.filter.dialog) this.melden({ e: 'hinweis', text: 'Bei Bitstream regelt der Receiver den Klang – Nachtmodus dort einschalten.' });
        break;
      case 'stopp':
        this.engineAus();
        m.leise(['stop']);
        break;
      default:
    }
  }

  async untertitel(u) {
    const m = this.mpv;
    if (!m) return;
    if (!u) { await m.setzen('sid', 'no'); return; }
    if (u.eingebettet && Number.isInteger(u.index)) { await m.setzen('sid', String(u.index + 1)); return; }
    if (typeof u.url === 'string' && this.ctx.erlaubt(u.url)) {
      // schon geladen? Dann nur umschalten
      const spuren = (await m.lesen('track-list')) || [];
      const da = spuren.find((t) => t.type === 'sub' && t.external && t['external-filename'] === u.url);
      if (da) await m.setzen('sid', String(da.id));
      else await m.leise(['sub-add', u.url, 'select']);
    }
  }

  lautSetzen() {
    const { wert, stumm } = this.lautstaerke;
    if (this.eng) this.engineSenden({ c: 'lautstaerke', wert: stumm ? 0 : wert });
    if (this.mpv) { this.mpv.setzen('volume', Math.round(wert * 100)); this.mpv.setzen('mute', stumm); }
  }

  /* ---------------- Ton über die Engine ---------------- */
  engineSenden(b) { if (this.eng || b.c === 'stopp') this.ctx.engineSenden(b); }

  /** mpv-Zeit jetzt (letzter Wert, fortgeschrieben) */
  mpvZeit() {
    const z = this.zeitMerk;
    return z.t + (z.laeuft ? ((Date.now() - z.am) / 1000) * (z.speed || 1) : 0);
  }
  engZeit() { return this.eng?.zeit ?? 0; }

  /** Momentaufnahme für das Überwachungs-Panel (Bildraten, Aussetzer, Renderer, HDR) */
  async monitor() {
    const m = this.mpv;
    if (!m || m.zu) return { laeuft: false };
    const namen = ['container-fps', 'estimated-vf-fps', 'display-fps', 'estimated-display-fps', 'frame-drop-count', 'decoder-frame-drop-count',
      'vo-delayed-frame-count', 'mistimed-frame-count', 'hwdec-current', 'current-gpu-context', 'video-params', 'video-out-params', 'speed', 'video-sync', 'interpolation', 'width', 'height', 'vf'];
    const w = await Promise.all(namen.map((n) => m.lesen(n)));
    const x = Object.fromEntries(namen.map((n, i) => [n, w[i]]));
    const vp = x['video-params'] || {};
    const op = x['video-out-params'] || {};
    const diff = this.diffs.length ? this.diffs.reduce((a, b) => a + b, 0) / this.diffs.length : null;
    return {
      laeuft: true,
      quelle_fps: x['container-fps'], filter_fps: x['estimated-vf-fps'],
      anzeige_hz: x['display-fps'] || x['estimated-display-fps'],
      verworfen: x['frame-drop-count'] || 0, dec_verworfen: x['decoder-frame-drop-count'] || 0,
      verspaetet: x['vo-delayed-frame-count'] || 0, falsch_getaktet: x['mistimed-frame-count'] || 0,
      hwdec: x['hwdec-current'] || 'no', gpu: x['current-gpu-context'] || '', sync: x['video-sync'], interpolation: x.interpolation,
      breite: vp.w || x.width, hoehe: vp.h || x.height, pixel: vp.hw_pixelformat || vp.pixelformat || '',
      gamma: vp.gamma || '', primaer: vp.primaries || '', spitze: vp['sig-peak'] || null, ausgabe_gamma: op.gamma || '',
      tempo: x.speed, weg: this.weg, engine_diff: diff, rife: !!this.rifeAn, vf: x.vf,
    };
  }

  async engineStarten(pos) {
    if (!this.engPlan || !this.mpv) return;
    const gen = ++this.engGen;
    const id = `bw${gen}`;
    const p = new URLSearchParams({ start: Math.max(0, pos).toFixed(3), ton: String(this.engPlan.ton), token: this.token });
    if (this.filter.nacht !== 'aus') p.set('nacht', this.filter.nacht);
    if (this.filter.dialog) p.set('dialog', String(this.filter.dialog));
    const url = `${this.ctx.basis()}/api/v1/remux/${this.engPlan.quelle}/ton?${p}`;
    this.eng = { ...this.engPlan, id, offset: pos, halt: true, bereit: false, zeit: pos, latenz: this.eng?.latenz ?? this.ctx.engineLatenz() };
    this.halt = true;
    this.melden({ e: 'warten', an: true });
    await this.mpv.setzen('pause', true);
    await this.mpv.setzen('speed', 1);
    this.speed = 1;
    this.diffs = [];
    const kopf = await this.ctx.cookieKopf(url);
    if (gen !== this.engGen) return;
    const { wert, stumm } = this.lautstaerke;
    this.ctx.engineSenden({ c: 'lautstaerke', wert: stumm ? 0 : wert });
    this.ctx.engineSenden({ c: 'laden', id, url, kopf, spielen: true });
    // Kommt kein Ton (Server, Netz), nicht ewig warten: nach 12 s mit dem Ton von mpv weiter
    clearTimeout(this.engUhr);
    this.engUhr = setTimeout(() => { if (this.eng && this.eng.id === id && this.eng.halt) this.engineScheitert('Der Ton kam nicht rechtzeitig vom Server.'); }, 12000);
  }

  engineAus() {
    clearTimeout(this.engUhr);
    if (this.eng) this.ctx.engineSenden({ c: 'stopp' });
    this.eng = null;
    this.halt = false;
  }

  /** Engine geht nicht → mpv spielt den Ton selbst (WASAPI), damit der Film weiterläuft */
  async engineScheitert(grund) {
    if (!this.eng || !this.mpv) return;
    const ton = this.eng.ton;
    this.ctx.log('WARN', `Engine-Ton: ${grund} – weiter mit mpv`);
    this.engineAus();
    this.engPlan = null;
    const pos = this.mpvZeit();
    await this.mpv.setzen('ao', 'wasapi');
    await this.mpv.setzen('aid', String(ton + 1));
    await this.mpv.setzen('af', tonFilter(this.filter.nacht, this.filter.dialog));
    this.mpv.setzen('speed', 1);
    this.lautSetzen();
    await this.mpv.leise(['seek', pos, 'absolute+exact']);
    this.melden({ e: 'warten', an: false });
    this.melden({ e: 'ton_weg', weg: 'mpv' });
    this.melden({ e: 'hinweis', text: `Ton über die Engine geht gerade nicht (${grund}) – mpv spielt ihn.`, fehler: true });
    if (!this.nutzerPause) this.mpv.setzen('pause', false);
  }

  /** Meldungen der Engine (alle; main.js reicht sie durch) */
  engineMeldung(m) {
    const e = this.eng;
    if (m.e === 'format') { const r = m.geraet_rate || m.aus_rate || 48000; this.latenzLetzt = (m.latenz || 0) / r; if (e) e.latenz = this.latenzLetzt; return; }
    if (!e || (m.id && m.id !== e.id)) return;
    if (m.e === 'fehler') { this.engineScheitert(m.text || 'Fehler'); return; }
    if (m.e === 'start' || (m.e === 'zeit' && e.halt && m.pos > 0)) {
      if (!e.halt) return;
      clearTimeout(this.engUhr);
      e.halt = false;
      this.halt = false;
      e.bereit = true;
      this.melden({ e: 'warten', an: false });
      if (this.nutzerPause) { this.ctx.engineSenden({ c: 'pause', 'w.fade': 0 }); this.melden({ e: 'pause', an: true }); }
      else { this.mpv?.setzen('pause', false); this.melden({ e: 'pause', an: false }); }
      return;
    }
    if (m.e === 'zeit' && !e.halt) this.nachfuehren(m);
  }

  /** Bild an die Uhr der Engine anlehnen: kleine Abweichungen über die Geschwindigkeit, große mit einem Sprung */
  nachfuehren(m) {
    const e = this.eng;
    if (!this.mpv || this.nutzerPause || !this.zeitMerk.laeuft) return;
    const versatz = (Number(this.ctx.einst().versatz_ms) || 0) / 1000;
    e.zeit = e.offset + m.pos - (e.latenz || 0);
    const soll = e.zeit + versatz;
    const diff = this.mpvZeit() - soll;   // > 0: Bild ist voraus
    if (Date.now() < this.korrekturBis) return;
    if (Math.abs(diff) > 0.4) {
      this.sprungEigen++;
      this.korrekturBis = Date.now() + 1500;
      this.diffs = [];
      this.mpv.leise(['seek', soll + 0.05, 'absolute+exact']);
      return;
    }
    this.diffs.push(diff);
    if (this.diffs.length > 5) this.diffs.shift();
    const mittel = this.diffs.reduce((a, b) => a + b, 0) / this.diffs.length;
    let speed = Math.abs(mittel) < 0.012 ? 1 : 1 - Math.max(-0.04, Math.min(0.04, mittel * 0.8));
    speed = Math.round(speed * 1000) / 1000;
    if (Math.abs(speed - this.speed) >= 0.002) {
      this.speed = speed;
      this.zeitMerk = { t: this.mpvZeit(), am: Date.now(), laeuft: true, speed };
      this.mpv.setzen('speed', speed);
    }
  }
}

module.exports = { Spieler, tonFilter };
