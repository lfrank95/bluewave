#!/usr/bin/env python3
"""Übernimmt die Ausgabe-Sektion (Ausgänge, Lautsprecher-Manager, Kanal-EQ) aus Amberwave in den Bluewave-Client.
Aufruf: werkzeug/amberwave_ausgabe_port.py <amberwave-repo> <bluewave-repo>
Kopiert die vier Module mit angepassten Importen, benennt Klassen um, die in Bluewave anders belegt sind (dialog,
segment, breit), färbt Bernstein in Blau um und zieht die passenden CSS-Regeln nach app/css/client.css."""
import re, sys, pathlib

aw, bw = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
quelle, ziel = aw / 'app/js', bw / 'app/js/client'
ziel.mkdir(parents=True, exist_ok=True)

FARBEN = [('rgba(255,181,71', 'rgba(92,200,255'), ('rgba(255, 181, 71', 'rgba(92, 200, 255'), ('#ffb547', '#5cc8ff'), ('#FFB547', '#5cc8ff'),
          ('#ff7a3d', '#3d63ff'), ('rgba(255,122,61', 'rgba(61,99,255'), ('rgba(255, 122, 61', 'rgba(61, 99, 255'), ('#ffc976', '#8fd6ff'),
          ('rgba(255,244,230', 'rgba(226,238,255'), ('rgba(255, 244, 230', 'rgba(226, 238, 255'), ('rgba(255,236,214', 'rgba(214,230,255'),
          ('rgba(255, 236, 214', 'rgba(214, 230, 255'), ('rgba(255, 240, 222', 'rgba(222, 236, 255'), ('#120d0a', '#070b12'), ('#f6efe7', '#eaf1fb'),
          ('#bcae9f', '#a3b3c9'), ('#1d1208', '#050b18'), ('rgba(40, 28, 18', 'rgba(14, 22, 38'), ('rgba(58, 24, 22', 'rgba(52, 22, 28'),
          ('rgba(18, 13, 10', 'rgba(7, 11, 18'), ('rgba(18,13,10', 'rgba(7,11,18'), ('#1a120c', '#0a1220'), ('#1d1511', '#0d1420')]

def _warm(r, g, b):
    """Bernstein/Braun (Rot > Grün > Blau)? Rot- und Grüntöne (Gefahr, Erfolg) bleiben"""
    return r > b + 8 and g > b + 4 and r >= g

def faerben(s):
    for a, b in FARBEN:
        s = s.replace(a, b)
    # alles übrige Warme: Rot und Blau tauschen – gleiche Helligkeit, Bernstein wird Blau, Braun wird Nachtblau
    def hex6(m):
        r, g, b = (int(m.group(1)[i:i + 2], 16) for i in (0, 2, 4))
        return '#%02x%02x%02x' % (b, g, r) if _warm(r, g, b) else m.group(0)
    def hex3(m):
        r, g, b = (int(c * 2, 16) for c in m.group(1))
        return '#%s%s%s' % (m.group(1)[2], m.group(1)[1], m.group(1)[0]) if _warm(r, g, b) else m.group(0)
    def rgb(m):
        r, g, b = int(m.group(2)), int(m.group(4)), int(m.group(6))
        return f'{m.group(1)}{b}{m.group(3)}{g}{m.group(5)}{r}' if _warm(r, g, b) else m.group(0)
    s = re.sub(r'#([0-9a-fA-F]{6})\b', hex6, s)
    s = re.sub(r'#([0-9a-fA-F]{3})\b(?![0-9a-fA-F])', hex3, s)
    s = re.sub(r'(rgba?\(\s*)(\d+)(\s*,\s*)(\d+)(\s*,\s*)(\d+)', rgb, s)
    return s

for name in ['ausgaenge.js', 'ausgaenge_fenster.js', 'kanal_eq.js', 'kanal_eq_fenster.js']:
    s = (quelle / name).read_text()
    s = s.replace("from './ui.js'", "from './aw_ui.js'").replace("from './i18n.js'", "from './aw_i18n.js'")
    s = s.replace("'dialog lm'", "'aw-dialog lm'").replace("'dialog eqf'", "'aw-dialog eqf'")
    s = s.replace('class="segment', 'class="aw-segment').replace('lm-zeile breit', 'lm-zeile aw-breit')
    s = s.replace('Amberwave', 'Bluewave')
    s = faerben(s)
    (ziel / name).write_text('// Übernommen aus Amberwave (werkzeug/amberwave_ausgabe_port.py) – Änderungen dort mitpflegen.\n' + s)

# ---------- CSS ----------
css = (aw / 'app/css/app.css').read_text()
css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
PRAEFIXE = r'\.(lm|eqf|keq|aus|einst|segment|dialog|btn|toast|lade|stift)(?![A-Za-z0-9_])|\.(lm|eqf|keq|aus|einst|btn|toast|dialog)-[a-z0-9-]+'

def bloecke(text):
    """Top-Level-Regeln und @-Blöcke in Reihenfolge"""
    i, n = 0, len(text)
    while i < n:
        j = text.find('{', i)
        if j < 0:
            return
        sel = text[i:j].strip()
        tiefe, k = 1, j + 1
        while k < n and tiefe:
            if text[k] == '{': tiefe += 1
            elif text[k] == '}': tiefe -= 1
            k += 1
        yield sel, text[j + 1:k - 1]
        i = k

def teile(sel):
    """Selektorliste an den Kommas der obersten Ebene teilen"""
    t, tiefe, akt = [], 0, ''
    for z in sel:
        if z in '([': tiefe += 1
        elif z in ')]': tiefe -= 1
        if z == ',' and tiefe == 0:
            t.append(akt.strip()); akt = ''
        else:
            akt += z
    t.append(akt.strip())
    return [x for x in t if x]

def passend(sel):
    """nur die Teile einer Selektorliste, die zur Ausgabe-Sektion gehören (sonst ''), ohne Amberwave-eigene Seitenzustände"""
    gut = [x for x in teile(sel) if re.search(PRAEFIXE, x) and not re.search(r'\.(player|rack|nerd|leiste|vollplayer|pl-)', x)]
    return ', '.join(gut)

def umbenennen(s):
    s = re.sub(r'\.dialog(?![A-Za-z0-9_-])', '.aw-dialog', s)
    s = re.sub(r'\.dialog-', '.aw-dialog-', s)
    s = re.sub(r'\.segment(?![A-Za-z0-9_-])', '.aw-segment', s)
    s = re.sub(r'\.breit(?![A-Za-z0-9_-])', '.aw-breit', s)
    return s

aus = []
for sel, inhalt in bloecke(css):
    if sel.startswith('@font-face') or sel.startswith(':root') or sel.startswith('@import'):
        continue
    if sel.startswith('@keyframes'):
        aus.append(f'{sel} {{{inhalt}}}')   # Animationen kosten nichts, werden von den Regeln gebraucht
        continue
    if sel.startswith('@media') or sel.startswith('@supports') or sel.startswith('@container'):
        innen = [f'  {umbenennen(passend(s2))} {{{i2}}}' for s2, i2 in bloecke(inhalt) if passend(s2)]
        if innen:
            aus.append(sel + ' {\n' + '\n'.join(innen) + '\n}')
        continue
    if passend(sel):
        aus.append(f'{umbenennen(passend(sel))} {{{inhalt}}}')

# Animationen mit eigenem Präfix (Bluewave hat teils gleichnamige)
namen = set(re.findall(r'@keyframes\s+([A-Za-z0-9_-]+)', '\n'.join(aus)))
text = '\n'.join(aus)
for n in sorted(namen, key=len, reverse=True):
    text = re.sub(r'@keyframes\s+%s(?![A-Za-z0-9_-])' % re.escape(n), '@keyframes aw-' + n, text)
    text = re.sub(r'(animation(?:-name)?\s*:[^;}]*?)(?<![A-Za-z0-9_-])%s(?![A-Za-z0-9_-])' % re.escape(n), lambda m: m.group(1) + 'aw-' + n, text)
aus = [text]

kopf = ('/* Windows-Client: Ausgabe-Sektion aus Amberwave (Ausgänge, Lautsprecher-Manager, Kanal-EQ, Dialoge, Hinweise).\n'
        '   Erzeugt von werkzeug/amberwave_ausgabe_port.py – nicht von Hand ändern. Nur im Client geladen. */\n'
        ':root { --nerd-h: 0px; --aw-player-hoehe: 0px; --font-mono: ui-monospace, "Cascadia Mono", Consolas, monospace; --warning: var(--warnung); }\n')
(bw / 'app/css/client.css').write_text(kopf + faerben('\n'.join(aus)).replace('--player-hoehe', '--aw-player-hoehe') + '\n')
print('ok', len(aus), 'Regeln')

# ---------- Einstellungen › Ausgabe (Signalweg, Geräte, Modus/Rate/Pause) ----------
e = (quelle / 'einstellungen.js').read_text()
def zeile_von(muster):
    m = re.search(muster, e, flags=re.M)
    if not m:
        raise SystemExit('nicht gefunden: ' + muster)
    return m
helfer = '\n'.join(zeile_von(r'^const %s = .*$' % n).group(0) for n in ['segment', 'zeile', 'karte', 'AUFSCHLAG_STUFEN'])
a = e.index('// ---------- Windows-Ausgabe')
b = e.index('function ausgabeZeichnen(app, inhalt, signal) {')
ende = e.index('\n}\n', b) + 3
teil = e[a:b] + e[b:ende]
teil = teil.replace('function ausgabeZeichnen(app, inhalt, signal) {', 'export function ausgabeZeichnen(inhalt, signal, pl) {')
teil = teil.replace('  const pl = app.player;\n', '')
teil = teil.replace("app.leiste?.bewertung?.()", "pl.bewertung()")
teil = teil.replace('  vstKarte(inhalt, signal);\n', '')
teil = teil.replace('class="segment', 'class="aw-segment')
teil = teil.replace('Amberwave Windows Client', 'Bluewave Windows-Client').replace('Amberwave', 'Bluewave')
kopf = """// Übernommen aus Amberwave (Einstellungen › Ausgabe) von werkzeug/amberwave_ausgabe_port.py – Änderungen dort mitpflegen.
// pl: Zustand der Ausgabe im Bluewave-Client (client/ausgabe.js) – Format, Anlauf und Aussetzer aus den Engine-Meldungen.
import { h, icon, toast } from './aw_ui.js';
import { t, tn, zahl, locale } from './aw_i18n.js';
import { nativ, istAsio } from './nativ.js';
import { symbolSvg, symbolVon, ausgangName, ausgangUnter } from './ausgaenge.js';
import { ausgaengeFenster } from './ausgaenge_fenster.js';

"""
(ziel / 'ausgabe_amberwave.js').write_text(kopf + faerben(helfer) + '\n\n' + faerben(teil))
print('ausgabe ok')
