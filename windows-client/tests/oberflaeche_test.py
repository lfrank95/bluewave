#!/usr/bin/env python3
"""Oberfläche des Windows-Clients im echten Chrome, ohne Windows: die Web-App mit nachgebauter Client-Brücke
(window.bluewaveNativ) gegen einen API-Ersatz (oberflaeche_router.php, ohne Datenbank).
  Hauptfenster: Abspielen geht an den Client, Profil zeigt Tonweg, Bild, Updates und die Ausgabe-Sektion aus Amberwave
                (Geräte, ASIO-Treiber mit Ausgängen, Lautsprecher-Manager, Kanal-EQ).
  Spielerfenster: durchsichtige Bedienung, Laden über mpv, Zeit, Tonspur, Untertitel, Tasten, Schließen.
  python3 windows-client/tests/oberflaeche_test.py [chrome-pfad]"""
import asyncio, json, os, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright

HIER = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HIER, '..', '..', 'app'))
CHROME = sys.argv[1] if len(sys.argv) > 1 else '/usr/bin/google-chrome'
PORT = 18766
BASIS = f'http://127.0.0.1:{PORT}'
LOG = os.path.join(tempfile.gettempdir(), 'bwtest-api.log')
fehler = []


def pruefe(bed, text):
    print(('  ok   ' if bed else '  FEHLER ') + text, flush=True)
    if not bed:
        fehler.append(text)


def ausgang_von_main():
    """Ausgang so, wie ihn main.js (ausgangPruefen) normalisiert – aus dem echten Code gerechnet"""
    main = open(os.path.join(HIER, '..', 'client', 'main.js'), encoding='utf-8').read()
    a = main.index('const LAYOUT_KANAELE')
    b = main.index('function ausgaengeFuer')
    js = main[a:b] + "\nconsole.log(JSON.stringify([ausgangPruefen({id:'std', name:'', layout:'stereo', sub:true, karte:[0,1,2]}), ausgangPruefen({id:'kh1', name:'Kopfhörer', art:'kh', layout:'stereo', karte:[4,5]})]));"
    return json.loads(subprocess.run(['node', '-e', js], capture_output=True, text=True, check=True).stdout)


HAUPT = """
(() => {
  const AUSGAENGE = %s;
  const v = { ton_weg: 'engine', mpv_geraet: 'auto', mpv_exklusiv: false, spdif: ['ac3', 'dts'], versatz_ms: 0, hwdec: 'auto-safe', vollbild: false,
    bewegung: 'aus', renderer: 'd3d11', vsync: true, mpv_sync: 'audio', mpv_interpolation: false, sm_balken: false, sm_log: 0 };
  let nv = { nvidia: true, profil: false, an: false, balken: false, log: 0 };
  const GPU = { name: 'NVIDIA GeForce RTX 5080', last: 31, watt: 112, grad: 54, takt: 2610, vram: 3120, vram_gesamt: 16303, treiber: '591.44' };
  const MPV = [{ id: 'wasapi/{1}', name: 'Lautsprecher (Realtek)' }, { id: 'wasapi/{2}', name: 'LG TV (NVIDIA High Definition Audio)' }];
  window.__aufrufe = [];
  const merk = (n, x) => { window.__aufrufe.push([n, x]); };
  let ausgabe = { geraet: '', exklusiv: false, rate: 0, aufschlag: 250 };
  window.bluewaveNativ = {
    version: '0.2.0-beta.1', plattform: 'win32', rolle: 'haupt',
    video: {
      oeffnen: (z) => merk('oeffnen', z), aufEnde: () => () => {},
      einst: async () => ({ ...v, mpv_geraete: MPV }),
      einstSetzen: async (w) => { merk('einstSetzen', w); Object.assign(v, w); return { ...v, mpv_geraete: MPV }; },
      bewegungStatus: async () => ({ nv, gpu: GPU }),
      rife: (() => {
        const hoerer = new Set();
        let st = { ordner: 'C:/x', vs: false, mlrt: false, groesse: 0, engines: 0, modelle: { v4_6: { da: false }, v4_25: { da: false } }, arbeit: null };
        const senden = () => hoerer.forEach((f) => f(st));
        return {
          stand: async () => ({ ok: true, stand: st }),
          einrichten: async () => {
            merk('rifeEinrichten');
            st = { ...st, arbeit: { art: 'einrichten', text: 'Lade vs-mlrt mit TensorRT (2,4 GB) …', prozent: 40 } }; senden();
            await new Promise((r) => setTimeout(r, 150));
            st = { ...st, vs: true, mlrt: true, groesse: 4.2 * 1073741824, modelle: { v4_6: { da: true }, v4_25: { da: false } }, arbeit: { art: 'einrichten', text: 'Fertig eingerichtet.', prozent: 100, fertig: true } };
            return { ok: true, stand: st };
          },
          vorbereiten: async (g) => { merk('rifeVorbereiten', g); st = { ...st, engines: g.length, arbeit: { art: 'vorbereiten', fertig: true, ergebnisse: g.map(([b, h]) => ({ groesse: `${b}x${h}`, sekunden: 190 })) } }; return { ok: true, stand: st }; },
          messen: async (b, h) => ({ ok: true, stand: { breite: b, hoehe: h, fps: 61.3, ziel: 48 } }),
          modell: async (n) => { merk('rifeModell', n); st = { ...st, modelle: { ...st.modelle, [n]: { da: true } } }; return { ok: true, stand: st }; },
          entfernen: async () => ({ ok: true, stand: st }),
          auf: (f) => { hoerer.add(f); return () => hoerer.delete(f); },
        };
      })(),
      bewegungEintragen: async () => { merk('bewegungEintragen', { ...v }); nv = { nvidia: true, profil: true, an: v.bewegung === 'smooth', balken: v.sm_balken, log: v.sm_log }; return { ok: true, nv, gpu: GPU }; },
    },
    senden: (b) => merk('senden', b), auf: () => () => {}, aufTaste: () => () => {},
    geraete: async () => [
      { id: 'wasapi:{a}', name: 'Lautsprecher (Realtek Audio)', standard: true, kanaele: 2, eigener_name: '', aus: false },
      ...AUSGAENGE.map((a) => ({ id: 'asio:{RME}#' + a.id, name: 'ASIO · Fireface UCX II', asio: true, treiber: 'asio:{RME}', ausgang: a, kanaele: 2, eigener_name: '', aus: false })),
    ],
    ausgabeLesen: async () => ausgabe,
    ausgabeSetzen: (w) => { merk('ausgabeSetzen', w); ausgabe = { ...ausgabe, ...w }; },
    ausgabeStatus: async () => ({ format: { rate: 48000, bits: 24, kanaele: 6, aus_rate: 48000, geraet_rate: 48000, aus_kanaele: 6, geraet_kanaele: 8, aus_format: '24 Bit (in 32)', exklusiv: true, asio: true, umgerechnet: false, latenz: 96, geraet: 'Fireface' }, anlauf: null, aussetzer: 0 }),
    geraetMerken: (w) => merk('geraetMerken', w),
    ausgaengeLesen: async () => ({ ausgaenge: AUSGAENGE, namen: ['Analog 1', 'Analog 2', 'Analog 3', 'Analog 4', 'Phones 1', 'Phones 2'] }),
    ausgaengeSetzen: async (t, l) => { merk('ausgaengeSetzen', l); return { ausgaenge: l, geraet: ausgabe.geraet }; },
    ausgangBass: async () => null, ausgangVorschau: async () => ({ aktiv: false }),
    eqPresets: async () => [], eqPresetSetzen: async () => [],
    asioKanaele: async () => ({ namen: ['Analog 1', 'Analog 2', 'Analog 3', 'Analog 4', 'Phones 1', 'Phones 2'] }),
    testton: async () => ({ ok: true }),
    fenster: { aktion: (a) => merk('fenster', a), zustand: async () => ({ max: false, voll: false }), auf: () => () => {} },
    serverWechseln: () => merk('serverWechseln'), clientEinst: async () => ({ tray: true, autostart: false }), clientEinstSetzen: async (w) => w,
    logOeffnen: async () => true, diagnose: async () => ({ ok: true }),
    update: { info: async () => ({ version: '0.2.0-beta.7', installierbar: true }), installieren: async () => merk('installieren'), suchen: async () => ({ ok: true }), auf: () => () => {} },
  };
})();
"""

SPIELER = """
(() => {
  const hoerer = new Set();
  window.__laden = []; window.__befehle = []; window.__voll = 0; window.__zu = false;
  window.__emit = (m) => hoerer.forEach((f) => f(m));
  window.bluewaveNativ = {
    version: '0.2.0-beta.1', plattform: 'win32', rolle: 'spieler', auf: () => () => {}, aufTaste: () => () => {},
    video: {
      auftrag: async () => ({ art: 'film', id: 7 }),
      laden: (w) => { window.__laden.push(w); setTimeout(() => window.__emit({ e: 'geladen', dauer: 7200, breite: 3840, hoehe: 2160, ton_weg: 'engine' }), 50); setTimeout(() => window.__emit({ e: 'pause', an: false }), 80); },
      befehl: (b) => window.__befehle.push(b),
      auf: (f) => { hoerer.add(f); return () => hoerer.delete(f); },
      aufFenster: (f) => { window.__fensterHoerer = f; return () => {}; }, aufTaste: () => () => {}, tonWeg: () => '',
      mini: (an) => { (window.__mini = window.__mini || []).push(an); setTimeout(() => window.__fensterHoerer?.({ vollbild: false, mini: an }), 30); },
      vollbild: () => { window.__voll++; }, zu: () => { window.__zu = true; },
      monitor: async () => ({
        mpv: { laeuft: true, quelle_fps: 23.976, anzeige_hz: 120, verworfen: 2, verspaetet: 0, dec_verworfen: 0, hwdec: 'd3d11va', gpu: 'd3d11', sync: 'audio',
          breite: 3840, hoehe: 2160, gamma: 'pq', primaer: 'bt.2020', spitze: 4.926, weg: 'engine', engine_diff: 0.004 },
        gpu: { name: 'NVIDIA GeForce RTX 5080', last: 38, watt: 131, grad: 56, takt: 2700, vram: 3500, vram_gesamt: 16303, treiber: '591.44' },
        nv: { nvidia: true, profil: true, an: true, balken: true, log: 2 },
        log: ['[SM] present 47.95 fps generated'], einst: { bewegung: 'smooth', renderer: 'd3d11', vsync: true, sm_balken: true, sm_log: 2 },
      }),
    },
  };
})();
"""


async def main():
    ausgaenge = ausgang_von_main()
    pruefe(ausgaenge[0]['sub'] and ausgaenge[0]['eq']['L']['baender'] and ausgaenge[1]['art'] == 'kh', 'Ausgänge aus main.js normalisiert')
    open(LOG, 'w').close()
    php = subprocess.Popen(['php', '-S', f'127.0.0.1:{PORT}', '-t', APP, os.path.join(HIER, 'oberflaeche_router.php')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1)
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
            ctx = await browser.new_context(viewport={'width': 1400, 'height': 900})

            print('== Hauptfenster')
            page = await ctx.new_page()
            seitenfehler = []
            page.on('pageerror', lambda e: seitenfehler.append(str(e)))
            page.on('console', lambda m: seitenfehler.append(m.text) if m.type == 'error' else None)
            await page.add_init_script(HAUPT % json.dumps(ausgaenge))
            # echtes preload.js mit nachgebautem Electron: baut die Fensterknöpfe selbst (unabhängig von der Web-App)
            preload = open(os.path.join(HIER, '..', 'client', 'preload.js'), encoding='utf-8').read()
            await page.add_init_script("""(() => { window.__ipc = []; const require = () => ({ contextBridge: { exposeInMainWorld() {} },
              ipcRenderer: { sendSync: () => ({ erlaubt: true, rolle: 'haupt', version: 'x' }), send: (k, d) => window.__ipc.push([k, d]), invoke: async () => ({ max: false, voll: false }), on() {} } });
              """ + preload + """
            })();""")
            await page.goto(BASIS + '/#/profil')
            await page.wait_for_selector('.client-karte', timeout=10000)
            klassen = await page.evaluate('document.documentElement.className')
            pruefe('bw-nativ' in klassen and 'bw-haupt' in klassen, f'Client-Klassen am Dokument: {klassen}')
            pruefe(await page.evaluate("!!document.querySelector('link[href=\"/css/client.css\"]')"), 'client.css geladen')
            await page.locator('.bw-fenster-knoepfe button[aria-label="Minimieren"]').click()
            await page.locator('.bw-fenster-knoepfe button.zu').click()
            fk = [x[1] for x in await page.evaluate('window.__ipc') if x[0] == 'fenster-aktion']
            kb = await page.evaluate("(() => { const k = document.querySelector('.kopf'), r = k.getBoundingClientRect(), f = document.querySelector('.bw-fenster-knoepfe').getBoundingClientRect(); return { kopfRechts: Math.round(r.right - parseFloat(getComputedStyle(k).paddingRight)), knoepfeLinks: Math.round(f.left) }; })()")
            pruefe(fk == ['min', 'zu'] and kb['kopfRechts'] <= kb['knoepfeLinks'], f'Fensterknöpfe aus preload.js, Kopfzeile lässt Platz: {fk} {kb}')
            titel = await page.evaluate("[...document.querySelectorAll('.client-karte h2')].map(h => h.textContent)")
            pruefe(titel == ['Ton im Windows-Client', 'Bild', 'Flüssige Bewegung (Test)', 'Windows-Client'], f'Abschnitte: {titel}')
            await page.wait_for_selector('.aus-buehne .aus-kette', timeout=8000)
            pruefe(await page.locator('.aus-treiber').count() == 1 and await page.locator('.aus-bus').count() == 2, 'ASIO-Treiber mit zwei Ausgängen')
            stufe = await page.evaluate("document.querySelector('.aus-buehne').className")
            pruefe('asio' in stufe, f'Signalweg zeigt ASIO: {stufe}')
            # Akzent blau statt Bernstein
            farbe = await page.evaluate("getComputedStyle(document.querySelector('.aus-marke.asio')).color")
            pruefe('255, 181' not in farbe, f'keine Bernsteinfarbe: {farbe}')
            await page.locator('.aus-bus [data-waehlen]').first.click()
            await page.wait_for_timeout(400)
            gesetzt = [x for x in await page.evaluate('window.__aufrufe') if x[0] == 'ausgabeSetzen']
            pruefe(gesetzt and gesetzt[-1][1]['geraet'] == 'asio:{RME}#std', f'ASIO-Ausgang gewählt: {gesetzt[-1:]}')
            await page.locator('[data-routing]').click()
            await page.wait_for_selector('dialog.aw-dialog.lm[open]', timeout=5000)
            box = await page.locator('dialog.aw-dialog.lm').bounding_box()
            pruefe(box and box['width'] > 500 and box['height'] > 300, f'Lautsprecher-Manager offen: {box}')
            inhalt = await page.locator('dialog.aw-dialog.lm').inner_text()
            pruefe('Kopfhörer' in inhalt, 'beide Ausgänge im Manager')
            await page.screenshot(path=os.path.join(tempfile.gettempdir(), 'bw_lautsprecher_manager.png'))
            await page.keyboard.press('Escape')
            await page.wait_for_timeout(500)
            # Tonweg wechseln
            await page.locator('.client-weg', has_text='Bitstream').click()
            await page.wait_for_timeout(300)
            weg = [x for x in await page.evaluate('window.__aufrufe') if x[0] == 'einstSetzen']
            pruefe(weg and weg[-1][1] == {'ton_weg': 'bitstream'}, f'Tonweg Bitstream gespeichert: {weg[-1:]}')
            pruefe(await page.locator('.client-zeile', has_text='Formate, die der Receiver kann').is_visible(), 'Formate für den Receiver sichtbar')
            pruefe(not await page.locator('.client-ausgabe .aus-buehne').is_visible(), 'Ausgabe der Engine bei Bitstream ausgeblendet')
            opts = await page.evaluate("[...document.querySelectorAll('.client-karte select')[0].options].map(o => o.textContent)")
            pruefe('LG TV (NVIDIA High Definition Audio)' in opts, f'Tongeräte von mpv: {opts}')
            await page.locator('.client-weg', has_text='Bluewave-Engine').click()
            await page.wait_for_timeout(200)
            # LFE ohne Subwoofer auf die Front
            lfe = page.locator('.client-zeile', has_text='LFE ohne Subwoofer')
            pruefe(await lfe.is_visible(), 'Einstellung „LFE ohne Subwoofer“ sichtbar')
            await lfe.locator('select').select_option('an')
            await lfe.locator('input').fill('-3')
            await lfe.locator('input').dispatch_event('change')
            await page.wait_for_timeout(300)
            lfew = [x for x in await page.evaluate('window.__aufrufe') if x[0] == 'einstSetzen' and 'lfe_front' in x[1]]
            pruefe(lfew and lfew[-1][1] == {'lfe_front': True, 'lfe_db': -3}, f'LFE auf die Front, -3 dB gespeichert: {lfew[-1:]}')
            # Flüssige Bewegung (Test): Smooth Motion wählen, Faktor fest 2×, im Treiber eintragen
            bw = page.locator('.client-karte', has_text='Flüssige Bewegung (Test)')
            await page.wait_for_function("document.body.innerText.includes('Treiber-Profil: noch nicht angelegt')", timeout=5000)
            pruefe('RTX 5080' in await bw.inner_text(), 'Grafikkarte und Profilstand angezeigt')
            pruefe(not await bw.locator('.client-zeile', has_text='Smooth Motion erzeugt').is_visible(), 'Optionen erst mit Smooth Motion sichtbar')
            await bw.locator('.client-zeile', has_text='Modus').locator('select').select_option('smooth')
            await page.wait_for_timeout(200)
            faktor = await bw.locator('.client-zeile', has_text='Smooth Motion erzeugt').inner_text()
            pruefe('2× (fest)' in faktor and '3×' in faktor, f'Faktor 2× fest, mit Erklärung zu 3×/4×')
            await bw.locator('.client-zeile', has_text='Testbalken').locator('input').check()
            await bw.locator('.client-zeile', has_text='Treiber-Log').locator('select').select_option('2')
            await page.wait_for_timeout(200)
            pruefe('weicht ab' in await bw.inner_text(), 'Abweichung zum Treiber-Profil erkannt')
            await bw.get_by_role('button', name='Im Treiber eintragen').click()
            await page.wait_for_timeout(300)
            ein = [x for x in await page.evaluate('window.__aufrufe') if x[0] == 'bewegungEintragen']
            pruefe(ein and ein[-1][1]['bewegung'] == 'smooth' and ein[-1][1]['sm_balken'] and ein[-1][1]['sm_log'] == 2, f'Eintragen mit Testbalken und Log: {ein[-1:]}')
            pruefe('Smooth Motion an' in await bw.inner_text() and 'weicht ab' not in await bw.inner_text(), 'Profil danach aktuell')
            # RIFE: einrichten, vorbereiten, messen, Faktor, Modell nachladen
            await bw.locator('.client-zeile', has_text='Modus').first.locator('select').select_option('rife')
            await page.wait_for_timeout(200)
            rb = bw.locator('.rife-box')
            pruefe(await rb.is_visible() and not await bw.locator('.client-zeile', has_text='Testbalken').is_visible(), 'RIFE-Bereich statt Smooth-Motion-Optionen')
            pruefe('Nicht eingerichtet' in await rb.inner_text(), 'Stand: nicht eingerichtet')
            await rb.get_by_role('button', name='RIFE einrichten (ca. 3 GB)').click()
            await page.wait_for_timeout(60)
            pruefe('2,4 GB' in await rb.inner_text(), 'Fortschritt der Einrichtung sichtbar')
            await page.wait_for_function("document.querySelector('.rife-box').innerText.includes('Eingerichtet')", timeout=3000)
            await rb.get_by_role('button', name='Vorbereiten').click()
            await page.wait_for_timeout(200)
            vb = [x for x in await page.evaluate('window.__aufrufe') if x[0] == 'rifeVorbereiten']
            pruefe(vb and [3840, 2160] in vb[-1][1] and [1920, 800] in vb[-1][1], f'Vorbereiten für 4K und 1080p: {vb[-1:]}')
            pruefe('3840×2160 in 190 s' in await rb.inner_text() and '4 Engines' in await rb.inner_text(), 'Ergebnis des Vorbereitens angezeigt')
            await rb.get_by_role('button', name='Messen (4K)').click()
            await page.wait_for_timeout(200)
            pruefe('61,3 fps gerechnet' in await rb.inner_text() and 'reicht' in await rb.inner_text(), 'Messung angezeigt')
            await rb.locator('.client-zeile', has_text='240-Hz').locator('select').select_option('5')
            await rb.locator('.client-zeile', has_text='Neuere Modelle').locator('select').select_option('v4_25')
            await page.wait_for_timeout(200)
            await rb.get_by_role('button', name='Modell laden').click()
            await page.wait_for_timeout(200)
            gs = [x for x in await page.evaluate('window.__aufrufe') if x[0] in ('einstSetzen', 'rifeModell')]
            pruefe(['einstSetzen', {'rife_faktor': 5}] in gs and ['rifeModell', 'v4_25'] in gs, 'Faktor 5× gespeichert, Modell 4.25 geladen')
            pruefe(not await rb.get_by_role('button', name='Modell laden').is_visible(), 'Modell danach vorhanden')
            await page.wait_for_timeout(300)
            await page.screenshot(path=os.path.join(tempfile.gettempdir(), 'bw_client_profil.png'), full_page=True)
            # Abspielen geht an den Client
            await page.evaluate("window.__bluewave.abspielen({art: 'film', id: 7, start_ms: 0})")
            auf = [x for x in await page.evaluate('window.__aufrufe') if x[0] == 'oeffnen']
            pruefe(auf and auf[-1][1] == {'art': 'film', 'id': 7, 'start_ms': 0}, f'Abspielen öffnet das Spielerfenster: {auf}')
            pruefe(not await page.locator('.player').count(), 'kein Browser-Player im Hauptfenster')
            pruefe(not seitenfehler, f'keine Fehler im Hauptfenster: {seitenfehler[:3]}')
            await page.close()

            print('== Spielerfenster')
            page = await ctx.new_page()
            seitenfehler = []
            page.on('pageerror', lambda e: seitenfehler.append(str(e)))
            await page.add_init_script(SPIELER)
            await page.goto(BASIS + '/')
            await page.wait_for_selector('.player.nativ', timeout=10000)
            await page.wait_for_function('window.__laden.length > 0', timeout=5000)
            w = (await page.evaluate('window.__laden'))[0]
            pruefe(w['url'] == BASIS + '/api/v1/datei/12/inhalt' and w['start'] == 600 and w['ton'] == 0 and w['modus'] == 'direkt' and w['ton_quelle'] == '12',
                   f'mpv lädt die Datei unverändert ab 10:00: {w}')
            hg = await page.evaluate("[getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.player')).backgroundColor]")
            pruefe(hg[0] == 'rgba(0, 0, 0, 0.004)' and hg[1] in ('rgba(0, 0, 0, 0)', 'transparent'), f'durchsichtig über dem Bild: {hg}')
            pruefe(not await page.locator('.kopf').count(), 'nur der Player, ohne Kopfzeile der App')
            await page.evaluate("window.__emit({e: 'zeit', pos: 605, dauer: 7200, puffer: 30})")
            await page.wait_for_timeout(100)
            pruefe(await page.locator('.zeit').first.inner_text() == '10:05', 'Zeit aus mpv in der Zeitleiste')
            await page.mouse.move(700, 450)
            await page.keyboard.press('Space')
            await page.wait_for_timeout(100)
            pruefe({'c': 'pause'} in await page.evaluate('window.__befehle'), 'Leertaste: Pause an mpv')
            await page.keyboard.press('ArrowRight')
            await page.wait_for_timeout(100)
            spr = [b for b in await page.evaluate('window.__befehle') if b['c'] == 'springen']
            pruefe(spr and abs(spr[-1]['pos'] - 615) < 0.5, f'Pfeil rechts: +10 s ({spr[-1:]})')
            await page.keyboard.press('f')
            pruefe(await page.evaluate('window.__voll') == 1, 'F: Fenster auf Vollbild')
            # Bildmonitor (Taste B)
            await page.keyboard.press('b')
            await page.wait_for_selector('.bildmonitor .bm-block', timeout=5000)
            mon = await page.locator('.bildmonitor').inner_text()
            pruefe('23,976 fps' in mon and '47,95 fps' in mon and '120,00 Hz' in mon and 'jedes Bild' not in mon, f'Bildmonitor: Quelle, Ziel 2×, Bildschirm')
            pruefe('Ungleichmäßig' in mon, '48 fps auf 120 Hz als ungleichmäßig erkannt')
            pruefe('HDR10 (PQ)' in mon and 'RTX 5080' in mon and 'Im Treiber aktiv' in mon and 'nvpresent' in mon.lower(), 'HDR, Grafikkarte, Smooth-Motion-Stand und Treiber-Log')
            await page.screenshot(path=os.path.join(tempfile.gettempdir(), 'bw_bildmonitor.png'))
            await page.keyboard.press('b')
            await page.wait_for_timeout(100)
            pruefe(not await page.locator('.bildmonitor').count(), 'B schließt den Bildmonitor')
            await page.locator('button[title="Ton und Untertitel"]').click()
            await page.locator('.panel .wahl', has_text='Englisch').first.click()
            ton = [b for b in await page.evaluate('window.__befehle') if b['c'] == 'ton']
            pruefe(ton and ton[-1]['index'] == 1, f'Tonspur in mpv/Engine gewechselt, ohne Neustart: {ton}')
            await page.locator('button[title="Ton und Untertitel"]').click()
            texte = await page.locator('.panel').inner_text()
            pruefe('wird eingebrannt' not in texte, 'Bild-Untertitel zeigt mpv selbst (nichts einbrennen)')
            await page.locator('.panel .wahl', has_text='Deutsch (erzwungen)').click()
            await page.locator('button[title="Ton und Untertitel"]').click()
            await page.locator('.panel .wahl', has_text='Englisch').nth(1).click()
            ut = [b for b in await page.evaluate('window.__befehle') if b['c'] == 'untertitel']
            pruefe(len(ut) >= 2 and ut[-2].get('eingebettet') and ut[-2]['index'] == 1 and ut[-1]['url'] == BASIS + '/api/v1/untertitel/4/datei',
                   f'Untertitel: eingebettet per Spur, extern als Originaldatei: {ut[-2:]}')
            pruefe(len([x for x in await page.evaluate('window.__laden')]) == 1, 'kein Neuladen bei Ton/Untertitel')
            await page.screenshot(path=os.path.join(tempfile.gettempdir(), 'bw_spieler_bedienung.png'))
            await page.keyboard.press('Escape')
            await page.keyboard.press('Escape')
            # Esc verkleinert (Mini-Wiedergabe wie bei Plex), Klick macht wieder groß, ✕ schließt
            await page.wait_for_function("document.querySelector('.player.mini')", timeout=3000)
            m1 = await page.evaluate('window.__mini'); pruefe(m1 == [True], f'Esc: Mini-Wiedergabe statt Schließen {m1}')
            pruefe(await page.locator('.mini-ebene').is_visible() and not await page.locator('.player .ebene').is_visible(), 'Mini-Bedienung statt der großen')
            await page.mouse.move(700, 450)
            await page.screenshot(path=os.path.join(tempfile.gettempdir(), 'bw_spieler_mini.png'))
            await page.mouse.click(300, 450)
            await page.wait_for_function("!document.querySelector('.player.mini')", timeout=3000)
            m2 = await page.evaluate('window.__mini'); pruefe(m2 == [True, False], f'Klick: wieder groß {m2}')
            await page.keyboard.press('Escape')
            await page.wait_for_function("document.querySelector('.player.mini')", timeout=3000)
            await page.mouse.move(700, 300)
            await page.locator('.mini-oben button[aria-label="Schließen"]').click()
            await page.wait_for_function('window.__zu === true', timeout=5000)
            befehle = await page.evaluate('window.__befehle')
            pruefe(befehle[-1] == {'c': 'stopp'}, 'Schließen: mpv hält an, Fenster zu')
            api = open(LOG).read()
            pruefe('POST wiedergabe/fortschritt' in api and '"position_ms":615000' in api, 'Fortschritt beim Schließen gespeichert')
            pruefe(not seitenfehler, f'keine Fehler im Spielerfenster: {seitenfehler[:3]}')
            await browser.close()
    finally:
        php.terminate()
    print('Bilder:', os.path.join(tempfile.gettempdir(), 'bw_*.png'))
    if fehler:
        print(f'{len(fehler)} Fehler')
        sys.exit(1)
    print('Oberfläche: alles in Ordnung.')


asyncio.run(main())
