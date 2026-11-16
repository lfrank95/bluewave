#!/usr/bin/env python3
"""Ende-zu-Ende-Test gegen einen laufenden Bluewave-Stack (Ersatz-TMDB, Testmedien).
   python3 tests/e2e.py http://127.0.0.1:19960 <medienordner>"""
import json, sys, time, os, http.cookiejar, urllib.request, urllib.error

BASIS = sys.argv[1].rstrip('/')
MEDIEN = sys.argv[2]


class Client:
    def __init__(self, token=None):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.token = token

    def roh(self, methode, pfad, daten=None, kopf=None):
        h = {'Accept': 'application/json', 'X-Bluewave': '1'}
        if self.token:
            h['Authorization'] = 'Bearer ' + self.token
        h.update(kopf or {})
        body = None
        if daten is not None:
            body = json.dumps(daten).encode()
            h['Content-Type'] = 'application/json'
        req = urllib.request.Request(BASIS + pfad, data=body, method=methode, headers=h)
        try:
            with self.op.open(req, timeout=120) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def api(self, methode, pfad, daten=None, erwartet=200):
        code, body, _ = self.roh(methode, '/api/v1/' + pfad, daten)
        try:
            j = json.loads(body or b'{}')
        except ValueError:
            j = {'_roh': body[:300]}
        if code != erwartet:
            raise AssertionError(f'{methode} {pfad}: {code} statt {erwartet}: {j}')
        return j


def schritt(t):
    print('==', t, flush=True)


def pruefe(bed, text):
    if not bed:
        raise AssertionError(text)


admin = Client()
schritt('Einrichtung: erster Admin')
pruefe(admin.api('GET', 'einrichtung')['noetig'], 'Einrichtung sollte nötig sein')
admin.api('GET', 'ich', erwartet=401)
admin.api('POST', 'einrichtung', {'benutzername': 'lorenzo', 'anzeigename': 'Lorenzo', 'passwort': 'geheim123'})
ich = admin.api('GET', 'ich')
pruefe(ich['rolle'] == 'admin', 'Admin erwartet')
admin.api('POST', 'einrichtung', {'benutzername': 'x', 'passwort': 'geheim123'}, erwartet=409)

schritt('Einstellungen: TMDB-Schlüssel')
admin.api('PUT', 'einstellungen', {'tmdb_schluessel': 'testschluessel', 'scan_minuten': 0})

schritt('Scan + Metadaten + Intro-Erkennung')
code, body, _ = admin.roh('POST', '/api/v1/bibliothek/auftrag', {'art': 'alles'})
pruefe(code in (200, 409), f'Auftrag starten: {code} {body[:200]}')
time.sleep(1)
for _ in range(180):
    st = admin.api('GET', 'bibliothek/status')
    if not st['auftrag'].get('laeuft') and st['auftrag'].get('ende'):
        break
    time.sleep(2)
print(json.dumps(st['auftrag'].get('ergebnis'), ensure_ascii=False)[:1500])
z = st['zahlen']
pruefe(z['filme'] == 3, f'3 Filme erwartet, {z}')
pruefe(z['serien'] == 1 and z['folgen'] == 3, f'1 Serie mit 3 Folgen erwartet, {z}')
pruefe(z['intros'] >= 2, f'Intros erkannt erwartet, {z}')
pruefe(not st['offen']['filme'] and not st['offen']['serien'], f'alles zugeordnet erwartet: {st["offen"]}')

schritt('Filme, Fassungen, Reihe')
filme = admin.api('GET', 'filme')['filme']
titel = sorted(f['titel'] for f in filme)
print(titel)
pruefe(titel == ['Avengers: Age of Ultron', "Marvel's The Avengers", 'Testfilm'], f'Filmtitel: {titel}')
test = next(f for f in filme if f['titel'] == 'Testfilm')
d = admin.api('GET', f'film/{test["id"]}')
fass = {f['name']: f for f in d['fassungen']}
pruefe(set(fass) == {'Kinofassung', 'Extended Edition'}, f'Fassungen: {list(fass)}')
pruefe(len(fass['Kinofassung']['dateien']) == 2, 'Kinofassung sollte 2 Qualitäten haben')
pruefe(d['beschreibung'] == 'An English fallback overview.', 'Englischer Ersatztext erwartet')
pruefe(any(u['sprache'] == 'deu' for u in fass['Kinofassung']['dateien'][1]['untertitel'] + fass['Kinofassung']['dateien'][0]['untertitel']), 'deutscher Untertitel erwartet')
av = next(f for f in filme if f['titel'] == "Marvel's The Avengers")
avd = admin.api('GET', f'film/{av["id"]}')
pruefe(avd['reihe'] and len(avd['reihe']['filme']) == 2, 'Reihe mit 2 Filmen erwartet')
pruefe([f['titel'] for f in avd['reihe']['filme']] == ["Marvel's The Avengers", 'Avengers: Age of Ultron'], 'Reihenfolge nach Erscheinen')
pruefe(avd['freigabe'] == '12' and avd['regie'] == 'Joss Whedon' and avd['logo'], 'Freigabe, Regie, Logo erwartet')
code, body, h = admin.roh('GET', avd['poster'])
pruefe(code == 200 and h.get('Content-Type', '').startswith('image/'), f'Poster abrufbar: {code}')

schritt('Serie und Episodenreihenfolgen')
serie = admin.api('GET', 'serien')['serien'][0]
sd = admin.api('GET', f'serie/{serie["id"]}')
pruefe(sd['titel'] == 'Haus des Geldes' and len(sd['reihenfolgen']) == 2, f'Reihenfolgen: {sd["reihenfolgen"]}')
pruefe(len(sd['staffeln']) == 1 and len(sd['staffeln'][0]['folgen']) == 3, 'Ausstrahlung: 1 Staffel, 3 Folgen')
netflix = sd['reihenfolgen'][1]['id']
sn = admin.api('GET', f'serie/{serie["id"]}?reihenfolge={netflix}')
pruefe([len(s['folgen']) for s in sn['staffeln']] == [2, 1], f'Netflix: 2 Teile erwartet, {[s["name"] for s in sn["staffeln"]]}')
admin.api('PUT', f'serie/{serie["id"]}/reihenfolge', {'reihenfolge_id': netflix})
pruefe(admin.api('GET', f'serie/{serie["id"]}')['reihenfolge'] == netflix, 'Standard-Reihenfolge gesetzt')
f1 = sd['staffeln'][0]['folgen'][0]
pruefe(f1['titel'] == 'Der Plan' and f1['vorhanden'], 'Folgentitel aus TMDB')

schritt('Universum')
uid = admin.api('POST', 'universen', {'name': 'Marvel Cinematic Universe'})['id']
admin.api('POST', f'universum/{uid}/eintraege', {'art': 'reihe', 'id': avd['reihe']['id']})
admin.api('POST', f'universum/{uid}/eintraege', {'art': 'serie', 'id': serie['id']})
admin.api('POST', f'universum/{uid}/eintraege', {'art': 'film', 'id': test['id']})
u = admin.api('GET', f'universum/{uid}')
pruefe([e['art'] for e in u['eintraege']] == ['reihe', 'serie', 'film'], f'Universum: {u["eintraege"]}')
admin.api('PUT', f'universum/{uid}/eintraege', {'ids': [e['eintrag_id'] for e in reversed(u['eintraege'])]})
pruefe([e['art'] for e in admin.api('GET', f'universum/{uid}')['eintraege']] == ['film', 'serie', 'reihe'], 'Neue Reihenfolge')
pruefe(any(x['id'] == uid for x in admin.api('GET', f'film/{av["id"]}')['universen']), 'Film kennt sein Universum über die Reihe')

FAEHIG = {'video': {'h264': True, 'hevc': False, 'av1': False, 'vp9': False}, 'audio': {'aac': True, 'mp3': True},
          'container': {'mp4': True, 'webm': False, 'mkv': False}, 'hdr': False, 'hls': 'mse', 'max_hoehe': 1080}

schritt('Direct Play (MP4)')
w = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': av['id'], 'faehigkeiten': FAEHIG})
pruefe(w['modus'] == 'direkt', f'direkt erwartet: {w.get("grund")}')
code, body, h = admin.roh('GET', w['url'], kopf={'Range': 'bytes=0-1023'})
pruefe(code == 206 and len(body) == 1024 and 'bytes 0-1023/' in h.get('Content-Range', ''), f'Range: {code} {h.get("Content-Range")}')

schritt('Transkodieren (HLS) mit Spulen')
# kleine Bildschirmhöhe → die 270p-Datei (die mit dem externen Untertitel) wird gewählt
w = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': test['id'], 'faehigkeiten': {**FAEHIG, 'max_hoehe': 400}, 'start_ms': 0})
pruefe(w['modus'] == 'hls', f'hls erwartet: {w}')
code, body, _ = admin.roh('GET', w['url'])
pl = body.decode()
pruefe(code == 200 and '#EXT-X-ENDLIST' in pl and 'teil/0.m4s' in pl, 'Playlist')
basis = w['url'].rsplit('/', 1)[0]
for teil in ['init.mp4', 'teil/0.m4s', 'teil/1.m4s', 'teil/5.m4s', 'teil/6.m4s', 'teil/2.m4s']:
    t0 = time.time()
    code, body, _ = admin.roh('GET', f'{basis}/{teil}')
    pruefe(code == 200 and len(body) > 200, f'{teil}: {code} {body[:200]}')
    print(f'  {teil}: {len(body)} Bytes in {time.time() - t0:.1f} s')
pruefe(any(x['url'] for x in w['untertitel']), 'Untertitel-Spur angeboten')
ut = next(x for x in w['untertitel'] if x['url'])
code, body, _ = admin.roh('GET', ut['url'])
pruefe(code == 200 and body.startswith(b'WEBVTT') and 'Hallo Welt – äöü'.encode() in body, f'WebVTT: {body[:120]}')

schritt('Fortschritt und Weiterschauen')
admin.api('POST', 'wiedergabe/fortschritt', {'art': 'film', 'id': test['id'], 'datei_id': w['datei_id'], 'position_ms': 32000, 'dauer_ms': 40000, 'sitzung': w['sitzung']})
start = admin.api('GET', 'start')
pruefe(any(x['art'] == 'film' and x['id'] == test['id'] for x in start['weiterschauen']), 'Weiterschauen enthält den Film')
admin.api('DELETE', 'stream/' + w['sitzung'])

schritt('Folge: Marker, nächste Folge, Gesehen')
fw = admin.api('POST', 'wiedergabe/start', {'art': 'folge', 'id': f1['id'], 'faehigkeiten': FAEHIG})
pruefe('intro' in fw['marker'], f'Intro-Marker erwartet: {fw["marker"]}')
intro = fw['marker']['intro']
pruefe(intro['start_ms'] <= 7000 and 33000 <= intro['ende_ms'] <= 40000, f'Intro bei ~5–37 s erwartet: {intro}')
pruefe(fw['naechste'] and fw['naechste']['kennung'] == 'S01E02', f'nächste Folge: {fw["naechste"]}')
admin.api('PUT', 'marker', {'datei_id': fw['datei_id'], 'art': 'intro', 'start_ms': 5000, 'ende_ms': 37000})
admin.api('POST', 'wiedergabe/fortschritt', {'art': 'folge', 'id': f1['id'], 'datei_id': fw['datei_id'], 'position_ms': fw['dauer_ms'] - 1000, 'dauer_ms': fw['dauer_ms']})
sd2 = admin.api('GET', f'serie/{serie["id"]}')
pruefe(sd2['naechste'] and sd2['naechste']['kennung'] == 'S01E02' and sd2['naechste']['modus'] == 'naechste', f'Als Nächstes: {sd2["naechste"]}')
if fw.get('sitzung'):
    admin.api('DELETE', 'stream/' + fw['sitzung'])

schritt('Familie: Nutzer anlegen, Rechte')
admin.api('POST', 'nutzer', {'benutzername': 'anna', 'anzeigename': 'Anna', 'passwort': 'annapass1'})
anna = Client()
anna.api('POST', 'auth/login', {'benutzername': 'anna', 'passwort': 'falsch'}, erwartet=400)
anna.api('POST', 'auth/login', {'benutzername': 'anna', 'passwort': 'annapass1', 'merken': True})
pruefe(len(anna.api('GET', 'filme')['filme']) == 3, 'Anna sieht die Filme')
anna.api('GET', 'nutzer', erwartet=403)
pruefe(not any(x['id'] == test['id'] for x in anna.api('GET', 'start')['weiterschauen']), 'Fortschritt ist pro Nutzer')
anna.api('PUT', 'ich/einstellungen', {'autoplay': 'sofort', 'untertitel': 'immer'})
pruefe(anna.api('GET', 'ich')['einstellungen']['autoplay'] == 'sofort', 'Nutzereinstellung gespeichert')

schritt('Fernseher koppeln')
tv = Client()
k = tv.api('POST', 'kopplung/start', {'geraetename': 'Fire TV Wohnzimmer'})
pruefe(not tv.api('POST', 'kopplung/status', {'code': k['code'], 'geheimnis': k['geheimnis']})['bestaetigt'], 'noch nicht bestätigt')
anna.api('POST', 'kopplung/bestaetigen', {'code': k['code']})
s = tv.api('POST', 'kopplung/status', {'code': k['code'], 'geheimnis': k['geheimnis']})
pruefe(s['bestaetigt'] and s['token'], 'Token nach Bestätigung')
tv2 = Client(token=s['token'])
pruefe(tv2.api('GET', 'ich')['anzeigename'] == 'Anna', 'Fernseher ist als Anna angemeldet')
code, _, _ = tv2.roh('POST', '/api/v1/wiedergabe/gesehen', {'art': 'film', 'id': test['id'], 'gesehen': True}, kopf={'X-Bluewave': ''})
pruefe(code == 200, 'Geräte brauchen keine X-Bluewave-Kopfzeile')

schritt('Aufräumen: Vorschau (Medien nur lesend)')
a = admin.api('GET', 'aufraeumen/vorschau')
pruefe(not a['moeglich']['filme'] and len(a['liste']) > 0, f'Vorschau: {a["moeglich"]}, {len(a["liste"])}')
print('  z. B.', a['liste'][0]['alt'], '→', a['liste'][0]['neu'])

schritt('Oberfläche ausgeliefert')
code, body, _ = admin.roh('GET', '/')
pruefe(code == 200 and b'/js/app.js' in body, 'index.php')
for datei in ['/js/app.js', '/js/player.js', '/js/vendor/hls.min.js', '/css/app.css', '/manifest.webmanifest']:
    code, body, _ = admin.roh('GET', datei)
    pruefe(code == 200 and len(body) > 100, f'{datei}: {code}')

print('E2E: alles in Ordnung.')
