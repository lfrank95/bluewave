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
  const v = { ton_weg: 'engine', mpv_geraet: 'auto', mpv_exklusiv: false, spdif: ['ac3', 'dts'], versatz_ms: 0, hwdec: 'auto-safe', vollbild: false };
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
      aufFenster: () => () => {}, aufTaste: () => () => {}, tonWeg: () => '',
      vollbild: () => { window.__voll++; }, zu: () => { window.__zu = true; },
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
            await page.goto(BASIS + '/#/profil')
            await page.wait_for_selector('.client-karte', timeout=10000)
            klassen = await page.evaluate('document.documentElement.className')
            pruefe('bw-nativ' in klassen and 'bw-haupt' in klassen, f'Client-Klassen am Dokument: {klassen}')
            pruefe(await page.evaluate("!!document.querySelector('link[href=\"/css/client.css\"]')"), 'client.css geladen')
            titel = await page.evaluate("[...document.querySelectorAll('.client-karte h2')].map(h => h.textContent)")
            pruefe(titel == ['Ton im Windows-Client', 'Bild', 'Windows-Client'], f'Abschnitte: {titel}')
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
