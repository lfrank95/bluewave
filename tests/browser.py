#!/usr/bin/env python3
"""Browser-Test mit echtem Chrome: Player mit hls.js (progressiv), Sprünge beim Umwandeln, Direct Stream, Vorschaubilder.
   python3 tests/browser.py <basis-url> [chrome-pfad]
Läuft nach e2e.py gegen denselben Stack (Konto „lorenzo“, Vorschaubilder sind dann schon erzeugt)."""
import asyncio
import sys
import time

from playwright.async_api import async_playwright

BASIS = sys.argv[1].rstrip('/')
CHROME = sys.argv[2] if len(sys.argv) > 2 else '/usr/bin/google-chrome'
fehler_gesamt = []


def pruefe(bed, text):
    print(('  ok   ' if bed else '  FEHLER ') + text)
    if not bed:
        fehler_gesamt.append(text)


async def warte(page, ausdruck, sekunden, schritt=0.1):
    """Wartet, bis der JS-Ausdruck wahr ist; liefert die Wartezeit oder None"""
    t0 = time.time()
    while time.time() - t0 < sekunden:
        try:
            if await page.evaluate(ausdruck):
                return time.time() - t0
        except Exception:
            pass
        await asyncio.sleep(schritt)
    return None


async def spieler_zustand(page):
    return await page.evaluate("""() => { const s = window.__bluewaveSpieler; const v = s && s.video;
        return v ? { modus: s.daten && s.daten.modus, zeit: v.currentTime, pause: v.paused, bereit: v.readyState, hls: !!s.hls,
                     fehler: v.error && v.error.message, puffer: [...Array(v.buffered.length).keys()].map(i => [v.buffered.start(i), v.buffered.end(i)]) } : null; }""")


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'])
        ctx = await browser.new_context(viewport={'width': 1280, 'height': 720})
        r = await ctx.request.post(BASIS + '/api/v1/auth/login', data={'benutzername': 'lorenzo', 'passwort': 'geheim123'},
                                   headers={'X-Bluewave': '1', 'Content-Type': 'application/json'})
        pruefe(r.ok, f'Anmeldung: {r.status}')
        page = await ctx.new_page()
        seitenfehler = []
        page.on('pageerror', lambda e: seitenfehler.append(str(e)))
        await page.goto(BASIS + '/#/')
        await page.wait_for_timeout(1500)
        filme = await page.evaluate("fetch('/api/v1/filme', {headers: {Accept: 'application/json'}}).then(r => r.json())")
        ultron = next(f for f in filme['filme'] if f['titel'] == 'Avengers: Age of Ultron')

        print('== Umwandeln (hls.js, progressiv)')
        await page.evaluate(f"window.__bluewave.abspielen({{art: 'film', id: {ultron['id']}, erzwinge_transkodieren: true, start_ms: 0}})")
        t = await warte(page, "(() => { const v = window.__bluewaveSpieler?.video; return v && v.currentTime > 0.5 && !v.paused; })()", 30)
        z = await spieler_zustand(page)
        pruefe(t is not None and z['modus'] == 'hls' and z['hls'], f'Start: läuft nach {t and round(t, 2)} s, {z}')
        for ziel in (400, 120, 540):
            await page.evaluate(f'window.__bluewaveSpieler.gehe({ziel})')
            t = await warte(page, f"(() => {{ const v = window.__bluewaveSpieler.video; return v.currentTime >= {ziel} && v.currentTime < {ziel + 20} && !v.paused && v.readyState >= 3; }})()", 30)
            await page.wait_for_timeout(1500)
            z = await spieler_zustand(page)
            laeuft_weiter = z['zeit'] > ziel + 0.5
            pruefe(t is not None and laeuft_weiter, f'Sprung auf {ziel} s: spielt nach {t and round(t, 2)} s, läuft weiter ({z["zeit"]:.1f} s)')
        # Vorschaubild beim Darüberfahren
        leiste = await page.query_selector('.player .zeitleiste')
        box = await leiste.bounding_box()
        await page.mouse.move(box['x'] + box['width'] * 0.3, box['y'] + box['height'] / 2)
        await page.wait_for_timeout(300)
        bild = await page.evaluate("(() => { const b = document.querySelector('.player .vorschau-bild'); return b && !b.hidden ? b.style.backgroundImage : null; })()")
        pruefe(bool(bild) and '/vorschau/' in bild, f'Vorschaubild über der Zeitleiste: {bild}')
        await page.evaluate('window.__bluewaveSpieler.schliessen()')
        await page.wait_for_timeout(800)

        print('== Direct Stream (MSE)')
        await page.evaluate(f"window.__bluewave.abspielen({{art: 'film', id: {ultron['id']}, start_ms: 0}})")
        t = await warte(page, "(() => { const v = window.__bluewaveSpieler?.video; return v && v.currentTime > 0.5 && !v.paused; })()", 30)
        z = await spieler_zustand(page)
        pruefe(t is not None and z['modus'] == 'remux', f'Start: läuft nach {t and round(t, 2)} s, {z["modus"]}')
        await page.evaluate('window.__bluewaveSpieler.gehe(300)')
        t = await warte(page, "(() => { const s = window.__bluewaveSpieler; return s.pos() >= 300 && s.pos() < 320 && !s.video.paused && s.video.readyState >= 3; })()", 30)
        pruefe(t is not None, f'Sprung auf 300 s: spielt nach {t and round(t, 2)} s')
        await page.evaluate('window.__bluewaveSpieler.schliessen()')
        await page.wait_for_timeout(500)

        pruefe(not seitenfehler, f'keine JavaScript-Fehler: {seitenfehler[:3]}')
        await page.screenshot(path='/tmp/bluewave_browser.png')
        await browser.close()
    if fehler_gesamt:
        print('Browser-Test: FEHLER')
        sys.exit(1)
    print('Browser-Test: alles in Ordnung.')


asyncio.run(main())
