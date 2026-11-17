// Test des Spielers (client/spieler.js) ohne Windows: mpv-Attrappe (tests/mpv_attrappe.js) und eine nachgebaute
// Engine-Uhr, die absichtlich 2 % zu schnell läuft. Geprüft: Laden, Anhalten bis der Ton da ist, Gleichlauf von Bild und
// Ton über die Geschwindigkeit, Springen, Pause, Tonspur, Rückfall auf mpv-Ton, Weg ohne Engine.
//   node windows-client/tests/spieler_test.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Spieler, tonFilter } = require('../client/spieler');

const ARBEIT = fs.mkdtempSync(path.join(os.tmpdir(), 'bwspieler-'));
const PROTOKOLL = path.join(ARBEIT, 'mpv.txt');
process.env.MPV_PROTOKOLL = PROTOKOLL;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
let fehler = 0;
const pruefe = (bed, text) => { if (bed) console.log('  ok:', text); else { console.log('  FEHLER:', text); fehler++; } };
const mpvBefehle = () => fs.readFileSync(PROTOKOLL, 'utf8').trim().split('\n').map((z) => JSON.parse(z));
const gesetzt = (name) => mpvBefehle().filter((b) => b[0] === 'set_property' && b[1] === name).map((b) => b[2]);

/** nachgebaute Engine: spielt nach 300 ms los, Uhr läuft mit „rate“ (1.02 = 2 % zu schnell), meldet alle 100 ms */
class EngineAttrappe {
  constructor(spieler) { this.sp = spieler; this.befehle = []; this.rate = 1.02; this.uhr = null; this.pos = 0; this.laeuft = false; this.scheitern = false; }
  senden(b) {
    this.befehle.push(b);
    if (b.c === 'laden') {
      clearInterval(this.uhr);
      this.id = b.id; this.pos = 0; this.laeuft = false;
      if (this.scheitern) { setTimeout(() => this.sp.engineMeldung({ e: 'fehler', id: b.id, text: 'Server antwortet nicht' }), 100); return; }
      setTimeout(() => {
        this.laeuft = true;
        this.sp.engineMeldung({ e: 'format', rate: 48000, aus_rate: 48000, geraet_rate: 48000, latenz: 0, kanaele: 6 });
        this.sp.engineMeldung({ e: 'start', id: b.id });
        let t = Date.now();
        this.uhr = setInterval(() => {
          const n = Date.now();
          if (this.laeuft) this.pos += ((n - t) / 1000) * this.rate;
          t = n;
          if (this.laeuft) this.sp.engineMeldung({ e: 'zeit', id: this.id, pos: this.pos });
        }, 100);
      }, 300);
    } else if (b.c === 'pause') this.laeuft = false;
    else if (b.c === 'spielen') this.laeuft = true;
    else if (b.c === 'stopp') { clearInterval(this.uhr); this.laeuft = false; }
  }
  stopp() { clearInterval(this.uhr); }
}

function neuerSpieler(weg) {
  const meldungen = [];
  const einst = { ton_weg: weg, mpv_geraet: 'auto', mpv_exklusiv: false, spdif: ['ac3'], versatz_ms: 0, hwdec: 'auto-safe', vollbild: false };
  let eng = null;
  const sp = new Spieler({
    electron: {}, mpvExe: path.join(__dirname, 'mpv_attrappe.js'), userData: ARBEIT, logOrdner: ARBEIT,
    log: (s, t) => { if (s !== 'INFO') console.log(`    [${s}] ${t}`); }, preload: '', icon: '',
    basis: () => 'http://bluewave.test:9960', hauptfenster: () => null, erlaubt: (u) => String(u).startsWith('http://bluewave.test:9960/'),
    cookieKopf: async () => 'Cookie: bw_sitzung=abc\r\n', engineSenden: (b) => eng.senden(b), engineLatenz: () => 0,
    einst: () => einst, userAgent: 'test',
  });
  eng = new EngineAttrappe(sp);
  sp.video = { isDestroyed: () => false, isFullScreen: () => false, getNativeWindowHandle: () => Buffer.alloc(8), setTitle() {} };
  sp.overlay = { isDestroyed: () => false, webContents: { id: 1, send: (k, d) => meldungen.push([k, d]) } };
  return { sp, eng, meldungen, einst };
}

(async () => {
  console.log('== Filter wie auf dem Server');
  pruefe(tonFilter('aus', 0) === '', 'aus = kein Filter');
  pruefe(tonFilter('stark', 6) === 'lavfi=[aformat=channel_layouts=stereo,pan=stereo|c0=1.4976*c0+0.4976*c1|c1=0.4976*c0+1.4976*c1,acompressor=threshold=-34dB:ratio=6:knee=2.8:attack=8:release=300:makeup=2.818]', 'Nacht + Dialog');

  console.log('== Ton über die Engine');
  fs.writeFileSync(PROTOKOLL, '');
  const { sp, eng, meldungen } = neuerSpieler('engine');
  await sp.laden({ url: 'http://bluewave.test:9960/api/v1/datei/12/inhalt', start: 10, ton: 1, modus: 'direkt', ton_quelle: '12', dauer: 120 });
  await warte(150);
  const args = sp.mpv.args;
  pruefe(args.includes('--ao=null') && args.some((a) => a.startsWith('--wid=')), 'mpv ohne eigenen Ton, im Fenster');
  pruefe(gesetzt('aid').includes('no') && gesetzt('pause')[0] === true, 'Tonspur in mpv aus, Bild wartet');
  const header = mpvBefehle().find((b) => b[0] === 'change-list' && b[2] === 'append');
  pruefe(header && header[3] === 'Cookie: bw_sitzung=abc', 'Anmeldung als Kopfzeile an mpv');
  const laden = eng.befehle.find((b) => b.c === 'laden');
  pruefe(laden && /\/api\/v1\/remux\/12\/ton\?start=10\.000&ton=1&token=[0-9a-f]+$/.test(laden.url) && laden.kopf.startsWith('Cookie:'), `Engine holt Spur 2 ab 10 s: ${laden?.url}`);
  pruefe(meldungen.some(([k, d]) => k === 'video' && d.e === 'warten' && d.an === true), 'Bedienung zeigt „lädt“');
  pruefe(!meldungen.some(([k, d]) => k === 'video' && d.e === 'pause' && d.an === true), 'internes Anhalten erscheint nicht als Pause');
  await warte(500);
  pruefe(gesetzt('pause').at(-1) === false, 'Ton da → Bild läuft los');
  pruefe(meldungen.some(([k, d]) => k === 'video' && d.e === 'geladen' && d.ton_weg === 'engine'), 'geladen mit Tonweg Engine');
  await warte(5000);
  const abw = sp.mpvZeit() - sp.engZeit();
  const speeds = gesetzt('speed').filter((x) => x !== 1);
  pruefe(speeds.length > 0 && Math.max(...speeds) > 1.005, `Bild holt die 2 % schnellere Engine über die Geschwindigkeit ein (max ${Math.max(...speeds, 1)})`);
  pruefe(Math.abs(abw) < 0.08, `Bild und Ton gleichauf: ${(abw * 1000).toFixed(0)} ms`);

  console.log('== Springen');
  const vorher = eng.befehle.filter((b) => b.c === 'laden').length;
  await sp.befehl({ c: 'springen', pos: 60 });
  await warte(80);
  const neu = eng.befehle.filter((b) => b.c === 'laden');
  pruefe(neu.length === vorher + 1 && /start=60\.000/.test(neu.at(-1).url), 'Sprung: Ton ab 60 s neu');
  pruefe(mpvBefehle().some((b) => b[0] === 'seek' && b[1] === 60), 'Bild springt auf 60 s');
  await warte(900);
  pruefe(Math.abs(sp.mpvZeit() - 60.6) < 0.4 && gesetzt('pause').at(-1) === false, `läuft nach dem Sprung gemeinsam weiter (${sp.mpvZeit().toFixed(2)} s)`);
  pruefe(eng.befehle.filter((b) => b.c === 'laden').length === vorher + 1, 'kein doppeltes Nachladen nach dem Sprung');

  console.log('== Pause');
  await sp.befehl({ c: 'pause' });
  await warte(100);
  pruefe(gesetzt('pause').at(-1) === true && eng.befehle.at(-1).c === 'pause', 'Pause: Bild und Engine halten an');
  pruefe(meldungen.some(([k, d]) => k === 'video' && d.e === 'pause' && d.an === true), 'Bedienung bekommt die Pause');
  await sp.befehl({ c: 'spielen' });
  await warte(100);
  pruefe(gesetzt('pause').at(-1) === false && eng.befehle.at(-1).c === 'spielen', 'weiter: beide laufen');

  console.log('== Tonspur und Lautstärke');
  await sp.befehl({ c: 'ton', index: 0 });
  await warte(50);
  pruefe(/ton=0&/.test(eng.befehle.filter((b) => b.c === 'laden').at(-1).url), 'andere Tonspur: Engine holt Spur 1');
  await sp.befehl({ c: 'lautstaerke', wert: 0.5, stumm: false });
  pruefe(eng.befehle.some((b) => b.c === 'lautstaerke' && b.wert === 0.5), 'Lautstärke an die Engine');
  await warte(600);

  console.log('== Engine scheitert → mpv spielt den Ton');
  eng.scheitern = true;
  await sp.befehl({ c: 'springen', pos: 30 });
  await warte(600);
  pruefe(sp.eng === null && gesetzt('ao').at(-1) === 'wasapi' && gesetzt('aid').at(-1) === '1', 'Rückfall: mpv-Ton über WASAPI, Spur 1');
  pruefe(meldungen.some(([k, d]) => k === 'video' && d.e === 'hinweis' && d.fehler), 'Hinweis in der Bedienung');
  pruefe(gesetzt('pause').at(-1) === false, 'Film läuft weiter');
  eng.stopp();
  sp.aufraeumen();

  console.log('== Ton über mpv (ohne Engine)');
  fs.writeFileSync(PROTOKOLL, '');
  const b = neuerSpieler('mpv');
  b.einst.lfe_front = true; b.einst.lfe_db = -4;
  await b.sp.laden({ url: 'http://bluewave.test:9960/api/v1/datei/12/inhalt', start: 0, ton: 2, modus: 'direkt', ton_quelle: '12', dauer: 120 });
  await warte(200);
  pruefe(b.sp.mpv.args.includes('--ao=wasapi') && b.sp.mpv.args.includes('--audio-exclusive=no'), 'mpv mit WASAPI geteilt');
  pruefe(b.sp.mpv.args.includes('--audio-swresample-o=lfe_mix_level=1.000'), 'LFE auf die Front auch in mpv (−4 dB + 4 dB Norm = ×1)');
  pruefe(gesetzt('aid').at(-1) === '3' && b.eng.befehle.length === 0, 'mpv spielt Spur 3, Engine bleibt still');
  await b.sp.befehl({ c: 'tonfilter', nacht: 'leicht', dialog: 0 });
  await warte(50);
  pruefe(/acompressor/.test(gesetzt('af').at(-1)), 'Nachtmodus als mpv-Filter');
  await b.sp.befehl({ c: 'untertitel', url: 'http://bluewave.test:9960/api/v1/untertitel/5/datei' });
  await warte(50);
  pruefe(mpvBefehle().some((x) => x[0] === 'sub-add' && x[1].endsWith('/untertitel/5/datei')), 'externer Untertitel per sub-add');
  await b.sp.befehl({ c: 'untertitel', url: 'http://fremd.example/x.srt' });
  await warte(50);
  pruefe(!mpvBefehle().some((x) => x[0] === 'sub-add' && x[1].includes('fremd')), 'fremde Adressen werden nicht geladen');
  b.sp.aufraeumen();

  console.log('== Bitstream');
  const c = neuerSpieler('bitstream');
  c.einst.spdif = ['ac3', 'truehd', 'quatsch'];
  await c.sp.laden({ url: 'http://bluewave.test:9960/api/v1/datei/12/inhalt', start: 0, ton: 0, modus: 'direkt', ton_quelle: '12', dauer: 120 });
  await warte(100);
  pruefe(c.sp.mpv.args.includes('--audio-spdif=ac3,truehd') && c.sp.mpv.args.includes('--audio-exclusive=yes'), 'Bitstream: nur erlaubte Formate, exklusiv');
  c.sp.aufraeumen();

  await warte(300);
  fs.rmSync(ARBEIT, { recursive: true, force: true });
  console.log(fehler ? `${fehler} Fehler` : 'Spieler: alles in Ordnung.');
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
