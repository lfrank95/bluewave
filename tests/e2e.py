#!/usr/bin/env python3
"""Ende-zu-Ende-Test gegen einen laufenden Bluewave-Stack (Ersatz-TMDB, Testmedien).
   python3 tests/e2e.py http://127.0.0.1:19960 <medienordner>"""
import json, sys, time, os, http.cookiejar, urllib.request, urllib.error, urllib.parse

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

schritt('Universum: Reihen werden aufgelöst, Abschnitte, Sortierung, Position, Vorschläge')
uid = admin.api('POST', 'universen', {'name': 'Marvel Cinematic Universe'})['id']
r = admin.api('POST', f'universum/{uid}/eintraege', {'art': 'reihe', 'id': avd['reihe']['id']})
pruefe(r['hinzugefuegt'] == 2, f'Reihe sollte 2 Filme einzeln hinzufügen: {r}')
admin.api('POST', f'universum/{uid}/eintraege', {'art': 'serie', 'id': serie['id']})
admin.api('POST', f'universum/{uid}/eintraege', {'art': 'film', 'id': test['id']})
pruefe(admin.api('POST', f'universum/{uid}/eintraege', {'art': 'film', 'id': test['id']})['hinzugefuegt'] == 0, 'kein Doppel')
u = admin.api('GET', f'universum/{uid}')
alle = [t for a in u['abschnitte'] for t in a['titel']]
pruefe([t['art'] for t in alle] == ['film', 'film', 'serie', 'film'], f'Universum: {[t["titel"] for t in alle]}')
pruefe([t['nr'] for t in alle] == [1, 2, 3, 4] and u['zahlen']['filme'] == 3 and u['zahlen']['serien'] == 1, f'Zahlen: {u["zahlen"]}')
pruefe(u['naechstes'] and u['naechstes']['titel'] == "Marvel's The Avengers", f'Als Nächstes: {u["naechstes"]}')
eids = [t['eintrag_id'] for t in alle]
admin.api('PUT', f'universum/{uid}/ordnung', {'ohne': [eids[3]], 'abschnitte': [{'id': None, 'name': 'Phase 1', 'eintraege': eids[:2]}, {'id': None, 'name': 'Phase 2', 'eintraege': [eids[2]]}]})
u = admin.api('GET', f'universum/{uid}')
pruefe([(a['name'], len(a['titel'])) for a in u['abschnitte']] == [(None, 1), ('Phase 1', 2), ('Phase 2', 1)], f'Abschnitte: {[(a["name"], len(a["titel"])) for a in u["abschnitte"]]}')
# verschachtelt: Saga › Phase 1 (2 Titel), Saga › Phase 2 (1 Titel); Titel ohne Abschnitt bleibt vorn
admin.api('PUT', f'universum/{uid}/ordnung', {'ohne': [eids[3]], 'abschnitte': [{'id': None, 'name': 'Saga', 'eintraege': [], 'unter': [
    {'id': None, 'name': 'Phase 1', 'eintraege': eids[:2]}, {'id': None, 'name': 'Phase 2', 'eintraege': [eids[2]]}]}]})
u = admin.api('GET', f'universum/{uid}')
pruefe([(a['name'], a.get('tiefe'), len(a['titel'])) for a in u['abschnitte']] == [(None, 0, 1), ('Saga', 0, 0), ('Phase 1', 1, 2), ('Phase 2', 1, 1)],
       f'verschachtelt: {[(a["name"], a.get("tiefe"), len(a["titel"])) for a in u["abschnitte"]]}')
pruefe(next(a for a in u['abschnitte'] if a['name'] == 'Saga')['gesamt'] == 3, 'Saga zählt die Titel der Unterabschnitte')
pruefe([t['nr'] for a in u['abschnitte'] for t in a['titel']] == [1, 2, 3, 4], 'Nummern in Baum-Reihenfolge')
# nach Erscheinung: Abschnitte bleiben, sortiert wird innerhalb (Phase 1 dafür kurz verkehrt herum)
ph1 = next(a for a in u['abschnitte'] if a['name'] == 'Phase 1')
admin.api('PUT', f'universum/{uid}/ordnung', {'ohne': [eids[3]], 'abschnitte': [{'id': next(a['id'] for a in u['abschnitte'] if a['name'] == 'Saga'), 'name': 'Saga', 'eintraege': [], 'unter': [
    {'id': ph1['id'], 'name': 'Phase 1', 'eintraege': [eids[1], eids[0]]}, {'id': None, 'name': 'Phase 2', 'eintraege': [eids[2]]}]}]})
ue = admin.api('GET', f'universum/{uid}?sort=erscheinung')
pruefe([(a['name'], len(a['titel'])) for a in ue['abschnitte']] == [(None, 1), ('Saga', 0), ('Phase 1', 2), ('Phase 2', 1)], f'Abschnitte bleiben: {[(a["name"], len(a["titel"])) for a in ue["abschnitte"]]}')
pruefe([t['titel'] for t in next(a for a in ue['abschnitte'] if a['name'] == 'Phase 1')['titel']] == ["Marvel's The Avengers", 'Avengers: Age of Ultron'], 'innerhalb nach Erscheinung')
pruefe([t['nr'] for a in ue['abschnitte'] for t in a['titel']] == [1, 2, 3, 4], 'Nummern in Anzeige-Reihenfolge')
admin.api('PUT', f'universum/{uid}/ordnung', {'ohne': [eids[3]], 'abschnitte': [{'id': None, 'name': 'Saga', 'eintraege': [], 'unter': [
    {'id': None, 'name': 'Phase 1', 'eintraege': eids[:2]}, {'id': None, 'name': 'Phase 2', 'eintraege': [eids[2]]}]}]})
pos = admin.api('GET', f'film/{av["id"]}')['universen']
pruefe(pos and pos[0]['gesamt'] == 4 and pos[0]['nr'] == 2 and len(pos[0]['nachbarn']) >= 2, f'Position auf der Filmseite: {pos}')
pruefe(admin.api('GET', f'serie/{serie["id"]}')['universen'][0]['name'] == 'Marvel Cinematic Universe', 'Serienseite kennt das Universum')
uid2 = admin.api('POST', 'universen', {'name': 'Nur Avengers'})['id']
admin.api('PUT', f'film/{av["id"]}/universen', {'ids': [uid, uid2]})
v = admin.api('GET', f'universum/{uid2}/vorschlaege')['vorschlaege']
pruefe(any(x['titel'] == 'Avengers: Age of Ultron' for x in v), f'Vorschlag aus Reihe/Stichwort: {v}')
pruefe(len(admin.api('GET', 'universen')['universen']) == 2, 'zwei Universen')
uid3 = admin.api('POST', 'universen', {'name': '„Die Zebras“'})['id']
namen = [x['name'] for x in admin.api('GET', 'universen')['universen']]
pruefe(namen == ['Marvel Cinematic Universe', 'Nur Avengers', '„Die Zebras“'], f'Sortierung ohne Artikel und Anführungszeichen: {namen}')
admin.api('DELETE', f'universum/{uid3}')
# Mehrfachauswahl: mehrere auf einmal in einen Abschnitt, mehrere entfernen, mehrere als gesehen
e0 = [t['eintrag_id'] for a in admin.api('GET', f'universum/{uid2}')['abschnitte'] for t in a['titel']]
admin.api('PUT', f'universum/{uid2}/ordnung', {'ohne': e0, 'abschnitte': [{'id': None, 'name': 'Sammlung', 'eintraege': []}]})
abid = next(a['id'] for a in admin.api('GET', f'universum/{uid2}')['abschnitte'] if a['name'] == 'Sammlung')
r = admin.api('POST', f'universum/{uid2}/liste', {'titel': [{'art': 'film', 'id': test['id']}, {'art': 'serie', 'id': serie['id']}, {'art': 'film', 'id': av['id']}], 'abschnitt_id': abid})
pruefe(r['hinzugefuegt'] == 2, f'Mehrfach hinzufügen (eins schon drin): {r}')
samml = next(a for a in admin.api('GET', f'universum/{uid2}')['abschnitte'] if a['name'] == 'Sammlung')
pruefe(len(samml['titel']) == 2, f'in den gewählten Abschnitt: {samml}')
r = admin.api('DELETE', f'universum/{uid2}/eintraege', {'ids': [t['eintrag_id'] for t in samml['titel']]})
pruefe(r['entfernt'] == 2, f'Mehrfach entfernen: {r}')
admin.api('POST', 'wiedergabe/gesehen_mehrere', {'titel': [{'art': 'film', 'id': test['id']}, {'art': 'film', 'id': av['id']}], 'gesehen': True})
pruefe(admin.api('GET', f'film/{test["id"]}')['fortschritt']['gesehen'], 'Mehrfach als gesehen')
admin.api('POST', 'wiedergabe/gesehen_mehrere', {'titel': [{'art': 'film', 'id': test['id']}, {'art': 'film', 'id': av['id']}], 'gesehen': False})
pruefe(not admin.api('GET', f'film/{test["id"]}')['fortschritt'], 'Mehrfach als ungesehen')
se = next(t for a in admin.api('GET', f'universum/{uid}')['abschnitte'] for t in a['titel'] if t['art'] == 'serie')
r = admin.api('POST', f'universum/{uid}/eintrag/{se["eintrag_id"]}/staffeln', {'teilen': True}, erwartet=400)
pruefe('nur eine Staffel' in r.get('fehler', ''), f'Staffeln teilen bei einer Staffel: {r}')
admin.api('DELETE', f'universum/{uid2}')
st = admin.api('GET', 'start')
pruefe(st['universum_band'] and st['universum_band']['id'] == uid, 'Universums-Band auf der Startseite')

schritt('Lokale Bilder aus den Medienordnern haben Vorrang')
avf = admin.api('GET', f'film/{av["id"]}')
pruefe('/bild/lokal/' in (avf['poster'] or '') and '/bild/lokal/' in (avf['hintergrund'] or ''), f'Film-Poster/Hintergrund lokal: {avf["poster"]} {avf["hintergrund"]}')
code, body, _ = admin.roh('GET', avf['poster'])
pruefe(code == 200 and body[:2] == b'\xff\xd8', f'lokales Poster wird ausgeliefert: {code}')
pruefe('/bild/lokal/' in (admin.api('GET', f'serie/{serie["id"]}')['poster'] or ''), 'Serien-Poster lokal')
pruefe(admin.api('PUT', 'einstellungen', {'lokale_bilder': True}) is not None, 'Einstellung lokale_bilder')

schritt('Reihen-Übersicht, gemerkte Sortierung')
rl = admin.api('GET', 'filme?filter=reihen')['filme']
pruefe(rl and all(x['art'] == 'reihe' for x in rl) and any('2 Filme' in x['zusatz'] for x in rl), f'Reihen statt Filme: {rl}')
admin.api('PUT', 'ich/einstellungen', {'sortierung': {'filme': 'neu', 'universum:1': 'erscheinung', 'böse!': 'x'}})
so = admin.api('GET', 'ich')['einstellungen']['sortierung']
pruefe(so == {'filme': 'neu', 'universum:1': 'erscheinung'}, f'Sortierung gemerkt (und bereinigt): {so}')

schritt('Poster per Link: in den Ordner mit passendem Namen, fest gegen TMDB')
import os
r = admin.api('POST', 'poster', {'art': 'film', 'id': test['id'], 'url': 'http://tmdbfake/t/p/w780/eigen-film.jpg'})
pruefe(r['datei'] and r['datei'].endswith('-poster.jpg') and not r.get('hinweis'), f'Film-Poster im Ordner: {r}')
pruefe(os.path.isfile(os.path.join(MEDIEN, 'filme', os.path.basename(os.path.dirname(r['datei'])), os.path.basename(r['datei']))), f'Datei liegt neben dem Film: {r["datei"]}')
r = admin.api('POST', 'poster', {'art': 'staffel', 'id': serie['id'], 'staffel': 1, 'url': 'http://tmdbfake/t/p/w780/eigen-staffel.jpg'})
pruefe(r['datei'] and r['datei'].endswith('/season01-poster.jpg'), f'Staffel-Poster: {r}')
r = admin.api('POST', 'poster', {'art': 'serie', 'id': serie['id'], 'url': 'http://tmdbfake/t/p/w780/eigen-serie.jpg'})
pruefe(r['datei'] and r['datei'].endswith('/poster.jpg'), f'Serien-Poster: {r}')
gesicherte = [os.path.join(w, n) for w, _, ns in os.walk(MEDIEN) for n in ns if n == 'folder.jpg']
pruefe(gesicherte, 'folder.jpg (anderer Name) bleibt unangetastet')
neu_poster = admin.api('GET', f'film/{test["id"]}')['poster']
code, body, _ = admin.roh('POST', '/api/v1/bibliothek/auftrag', {'art': 'metadaten_alle'})
pruefe(code == 200, f'Metadaten-Abgleich starten: {code} {body[:200]}')
time.sleep(1)
for _ in range(90):
    st = admin.api('GET', 'bibliothek/status')
    if not st['auftrag'].get('laeuft') and st['auftrag'].get('ende'):
        break
    time.sleep(2)
pruefe(admin.api('GET', f'film/{test["id"]}')['poster'] == neu_poster, 'Poster bleibt nach TMDB-Abgleich')
pruefe(admin.api('POST', 'poster', {'art': 'film', 'id': test['id'], 'url': 'http://tmdbfake/gibtsnicht'}, erwartet=400).get('fehler'), 'kein Bild → verständlicher Fehler')
pruefe(admin.api('POST', 'poster', {'art': 'film', 'id': test['id'], 'url': 'file:///etc/passwd'}, erwartet=400).get('fehler'), 'nur http(s)')

schritt('Bearbeiten: Felder sperren, TMDB-Abgleich respektiert sie, Zurücksetzen, Bilder')
bd = admin.api('GET', f'film/{test["id"]}/bearbeiten')
pruefe(bd['werte']['titel'] and bd['gesperrt'] == [] and bd['werte']['sortiertitel'] is None, f'Bearbeiten-Daten: {bd["werte"]} {bd["gesperrt"]}')
tmdb_titel = bd['werte']['titel']
bd = admin.api('PUT', f'film/{test["id"]}/bearbeiten', {'felder': {'titel': 'Der eigene Titel', 'freigabe': '16', 'genres': ['Heimkino', 'Drama'], 'tagline': None}})
pruefe(sorted(bd['gesperrt']) == ['freigabe', 'genres', 'tagline', 'titel'] and sorted(bd['werte']['genres']) == ['Drama', 'Heimkino'], f'gesperrt: {bd["gesperrt"]} {bd["werte"]["genres"]}')
pruefe(admin.api('PUT', f'film/{test["id"]}/bearbeiten', {'felder': {'freigabe': '15'}}, erwartet=400).get('fehler'), 'FSK 15 abgelehnt')
pruefe(admin.api('PUT', f'film/{test["id"]}/bearbeiten', {'felder': {'titel': ' '}}, erwartet=400).get('fehler'), 'leerer Titel abgelehnt')
code, body, _ = admin.roh('POST', '/api/v1/bibliothek/auftrag', {'art': 'metadaten_alle'})
time.sleep(1)
for _ in range(90):
    st = admin.api('GET', 'bibliothek/status')
    if not st['auftrag'].get('laeuft') and st['auftrag'].get('ende'):
        break
    time.sleep(2)
fd = admin.api('GET', f'film/{test["id"]}')
pruefe(fd['titel'] == 'Der eigene Titel' and fd['freigabe'] == '16' and not fd['tagline'], f'nach Abgleich gesperrt geblieben: {fd["titel"]} {fd["freigabe"]} {fd["tagline"]}')
pruefe(any(x['titel'] == 'Der eigene Titel' for x in admin.api('GET', 'filme?sort=titel')['filme']), 'eigener Titel in der Liste')
bd = admin.api('PUT', f'film/{test["id"]}/bearbeiten', {'zuruecksetzen': ['titel', 'freigabe', 'genres', 'tagline']})
pruefe(bd['werte']['titel'] == tmdb_titel and bd['gesperrt'] == [], f'zurückgesetzt: {bd["werte"]["titel"]} {bd["gesperrt"]}')
wahl = admin.api('GET', f'film/{test["id"]}/bilder')
pruefe(len(wahl['poster']) == 2 and len(wahl['hintergrund']) == 1, f'TMDB-Bildauswahl: {wahl}')
r = admin.api('POST', 'poster', {'art': 'film', 'id': test['id'], 'typ': 'hintergrund', 'url': wahl['hintergrund'][0]['gross']})
pruefe(r['datei'] and r['datei'].endswith('-fanart.jpg'), f'Hintergrund als -fanart.jpg: {r}')
pruefe('hintergrund' in admin.api('GET', f'film/{test["id"]}/bearbeiten')['bilder']['eigen'], 'Hintergrund als eigenes Bild markiert')
admin.api('DELETE', 'poster', {'art': 'film', 'id': test['id'], 'typ': 'hintergrund'})
pruefe(not os.path.exists(os.path.join(MEDIEN, 'filme', os.path.basename(os.path.dirname(r['datei'])), os.path.basename(r['datei']))), 'eigenes Bild entfernt (in die Sicherungen)')
pruefe(admin.api('GET', f'serie/{serie["id"]}/bilder?staffel=1')['poster'], 'Staffel-Bildauswahl')

schritt('Specials ausblenden (Serie und Nutzer)')
admin.api('PUT', f'serie/{serie["id"]}/bearbeiten', {'specials': 'ausblenden'})
sd = admin.api('GET', f'serie/{serie["id"]}')
pruefe(sd['specials_einstellung'] == 1 and all(st['nummer'] != 0 for st in sd['staffeln']), f'Serie: Specials aus: {sd["specials_einstellung"]}')
pruefe(admin.api('GET', f'serie/{serie["id"]}/bearbeiten')['specials'] == 'ausblenden', 'im Dialog sichtbar')
admin.api('PUT', f'serie/{serie["id"]}/bearbeiten', {'specials': 'standard'})
admin.api('PUT', 'ich/einstellungen', {'specials': 'ausblenden'})
pruefe(admin.api('GET', 'ich')['einstellungen']['specials'] == 'ausblenden', 'Nutzereinstellung')
admin.api('PUT', 'ich/einstellungen', {'specials': 'zeigen'})

schritt('Reihen umbenennen und Poster, Universums-Poster')
rid = avd['reihe']['id']
rb = admin.api('GET', f'reihe/{rid}/bearbeiten')
tmdb_name = rb['werte']['name']
rb = admin.api('PUT', f'reihe/{rid}/bearbeiten', {'felder': {'name': 'Meine Avengers'}})
pruefe(rb['gesperrt'] == ['name'] and admin.api('GET', f'reihe/{rid}')['name'] == 'Meine Avengers', f'Reihe umbenannt: {rb["gesperrt"]}')
pruefe(admin.api('GET', f'film/{av["id"]}')['reihe']['name'] == 'Meine Avengers', 'neuer Name auf der Filmseite')
pruefe(len(admin.api('GET', f'reihe/{rid}/bilder')['poster']) == 2, 'TMDB-Auswahl für die Reihe')
r = admin.api('POST', 'poster', {'art': 'reihe', 'id': rid, 'url': 'http://tmdbfake/t/p/w780/eigene-reihe.jpg'})
pruefe(r['datei'] is None and not r.get('hinweis') and r['poster'] == admin.api('GET', f'reihe/{rid}')['poster'], f'Reihen-Poster: {r}')
rb = admin.api('PUT', f'reihe/{rid}/bearbeiten', {'zuruecksetzen': ['name']})
pruefe(rb['werte']['name'] == tmdb_name and admin.api('GET', f'reihe/{rid}')['poster'] == r['poster'], f'Name zurück, eigenes Poster bleibt: {rb["werte"]["name"]}')
uidp = admin.api('POST', 'universen', {'name': 'Poster-Test'})['id']
r = admin.api('POST', 'poster', {'art': 'universum', 'id': uidp, 'url': 'http://tmdbfake/t/p/w780/eigenes-universum.jpg'})
pruefe(next(u for u in admin.api('GET', 'universen')['universen'] if u['id'] == uidp)['eigenes_poster'] == r['poster'], 'Universums-Poster')
admin.api('POST', 'poster', {'art': 'universum', 'id': uidp, 'typ': 'hintergrund', 'url': 'http://tmdbfake/t/p/original/eigener-hg.jpg'})
pruefe(admin.api('GET', f'universum/{uidp}')['eigener_hintergrund'], 'Universums-Hintergrund')
admin.api('DELETE', 'poster', {'art': 'universum', 'id': uidp, 'typ': 'poster'})
pruefe(next(u for u in admin.api('GET', 'universen')['universen'] if u['id'] == uidp)['eigenes_poster'] is None, 'Universums-Poster entfernt')
admin.api('DELETE', f'universum/{uidp}')

schritt('Suche: tolerant (Tippfehler, Satzzeichen, Wortreihenfolge), Bester Treffer, Editor-Auswahl')
for q, erwartet in [('avengers', "Marvel's The Avengers"), ('avengrs ultron', 'Avengers: Age of Ultron'), ('ultron age', 'Avengers: Age of Ultron'), ('marvels avengers', "Marvel's The Avengers")]:
    d = admin.api('GET', 'suche?q=' + urllib.parse.quote(q))
    titel = [f['titel'] for f in d['filme']]
    pruefe(erwartet in titel, f'Suche „{q}“: {titel}')
d = admin.api('GET', 'suche?q=' + urllib.parse.quote('Age of Ultron'))
pruefe(d['beste'] and d['beste']['titel'] == 'Avengers: Age of Ultron', f'Bester Treffer: {d["beste"]}')
pruefe(admin.api('GET', 'suche?q=x')['filme'] == [], 'zu kurz → leer')
pruefe(any(t['art'] == 'reihe' for t in admin.api('GET', 'auswahl?q=Avengers')['treffer']), 'Editor-Auswahl findet die Reihe')

FAEHIG = {'video': {'h264': True, 'hevc': False, 'av1': False, 'vp9': False}, 'audio': {'aac': True, 'mp3': True},
          'container': {'mp4': True, 'webm': False, 'mkv': False}, 'hdr': False, 'hls': 'mse', 'max_hoehe': 1080}

schritt('Direct Play (MP4)')
w = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': av['id'], 'faehigkeiten': FAEHIG})
pruefe(w['modus'] == 'direkt', f'direkt erwartet: {w.get("grund")}')
code, body, h = admin.roh('GET', w['url'], kopf={'Range': 'bytes=0-1023'})
pruefe(code == 206 and len(body) == 1024 and 'bytes 0-1023/' in h.get('Content-Range', ''), f'Range: {code} {h.get("Content-Range")}')

schritt('Direct Stream (MKV: Video unverändert, nur Container) und Qualitätswahl')
ultron = next(f for f in filme if f['titel'] == 'Avengers: Age of Ultron')
w = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': ultron['id'], 'faehigkeiten': {**FAEHIG, 'remux': True}})
pruefe(w['modus'] == 'remux' and w['remux']['audio'] == 'copy' and 'mkv' in w.get('grund', ''), f'Direct Stream erwartet: {w.get("modus")} {w.get("grund")} {w.get("remux")}')
k = admin.api('GET', f'remux/{w["datei_id"]}/position?start=12.5')['start']
pruefe(0 <= k <= 12.5, f'Schlüsselbild vor 12,5 s: {k}')
code, body, h = admin.roh('GET', f'/api/v1/remux/{w["datei_id"]}/strom?start={k}&ton=0&audio=copy&kanaele=2')
pruefe(code == 200 and body[4:8] == b'ftyp' and b'moof' in body[:400000] and len(body) > 20000, f'fragmentiertes MP4: {code} {body[:16]} {len(body)}')
# MSE-Player: echte Zeitstempel (Strom ab 12 s beginnt beim Schlüsselbild davor, nicht bei 0)
import struct
code, body, _ = admin.roh('GET', f'/api/v1/remux/{w["datei_id"]}/strom?start=12&ton=0&audio=copy&kanaele=2&absolut=1&token=e2etest12345')
i = body.find(b'tfdt')
tfdt = struct.unpack('>Q', body[i + 8:i + 16])[0] if body[i + 4] == 1 else struct.unpack('>I', body[i + 8:i + 12])[0]
mdhd = body.find(b'mdhd')
skala = struct.unpack('>I', body[mdhd + 24:mdhd + 28] if body[mdhd + 4] == 1 else body[mdhd + 16:mdhd + 20])[0]
pruefe(code == 200 and 0 < tfdt / skala <= 12.1, f'absolute Zeitstempel: {tfdt}/{skala}')
w2 = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': ultron['id'], 'faehigkeiten': FAEHIG})
pruefe(w2['modus'] == 'hls', 'ohne remux-Fähigkeit (alte App) wie bisher umwandeln')
admin.api('DELETE', 'stream/' + w2['sitzung'])
w3 = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': test['id'], 'faehigkeiten': {**FAEHIG, 'remux': True}, 'qualitaet': '480', 'datei_id': None})
pruefe(w3['qualitaet'] == '480' and 'original' in w3['qualitaeten'], f'Qualitätswahl: {w3.get("qualitaet")} {w3.get("qualitaeten")}')
if w3.get('sitzung'):
    admin.api('DELETE', 'stream/' + w3['sitzung'])
w4 = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': ultron['id'], 'faehigkeiten': {**FAEHIG, 'remux': True}, 'erzwinge_transkodieren': True})
pruefe(w4['modus'] == 'hls', 'Umwandeln erzwingen schlägt Direct Stream')
admin.api('DELETE', 'stream/' + w4['sitzung'])

schritt('Fernseher ohne DTS: passende Tonspur, E-AC3 statt AAC, volle Auflösung')
td = admin.api('GET', f'film/{test["id"]}')
ext = next(f for f in td['fassungen'] if f['name'] == 'Extended Edition')
TV = {**FAEHIG, 'remux': True, 'audio': {'aac': True, 'mp3': True, 'ac3': True, 'eac3': True}}
w = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': test['id'], 'fassung_id': ext['id'], 'faehigkeiten': TV})
pruefe(w['modus'] == 'remux' and w['ton'] == 1 and w['remux']['audio'] == 'copy', f'deutsche E-AC3-Spur statt DTS, unverändert: {w.get("modus")} ton={w.get("ton")} {w.get("remux")}')
w = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': test['id'], 'fassung_id': ext['id'], 'faehigkeiten': TV, 'ton': 0})
pruefe(w['modus'] == 'remux' and w['remux']['audio'] == 'eac3' and w['remux']['kanaele'] == 6, f'DTS gewählt → Dolby Digital Plus 5.1: {w.get("remux")}')
code, body, _ = admin.roh('GET', f'/api/v1/remux/{w["datei_id"]}/strom?start=0&ton=0&audio=eac3&kanaele=6')
pruefe(code == 200 and body[4:8] == b'ftyp' and b'ec-3' in body[:4000], f'Strom mit E-AC3: {code} {len(body)}')
w = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': test['id'], 'fassung_id': ext['id'], 'faehigkeiten': {**FAEHIG, 'remux': True}})
pruefe(w['remux']['audio'] == 'aac', f'ohne E-AC3 → AAC: {w.get("remux")}')
klein = {**FAEHIG, 'remux': True, 'max_hoehe': 400}
w = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': test['id'], 'faehigkeiten': klein})
w2 = admin.api('POST', 'wiedergabe/start', {'art': 'film', 'id': test['id'], 'faehigkeiten': {**klein, 'fernseher': True}})
pruefe(w['quelle']['hoehe'] < 400 and w2['quelle']['hoehe'] == 720, f'Fernseher nicht auf gemeldete Höhe begrenzt: {w["quelle"]["hoehe"]} / {w2["quelle"]["hoehe"]}')
for x in (w, w2):
    if x.get('sitzung'):
        admin.api('DELETE', 'stream/' + x['sitzung'])

schritt('Wiedergabe-Diagnose (Player und Server in einer Zeitleiste)')
import time as _zeit
jetzt = int(_zeit.time() * 1000)
admin.api('POST', 'diagnose', {'k': 'e2ediag01', 'start': {'art': 'film', 'id': ultron['id']}, 'ereignisse': [{'t': jetzt, 'e': 'beginn', 'd': {}}, {'t': jetzt + 50, 'e': 'video_playing', 'd': {}}]})
w = admin.api('POST', 'wiedergabe/start?diag=e2ediag01', {'art': 'film', 'id': ultron['id'], 'faehigkeiten': {**FAEHIG, 'remux': True}})
code, body, _ = admin.roh('GET', f'/api/v1/remux/{w["datei_id"]}/strom?start=0&ton=0&audio=copy&kanaele=2&absolut=1&token=e2ediag12345&diag=e2ediag01')
pruefe(code == 200, f'Strom mit Diagnose: {code}')
_zeit.sleep(1)
d = admin.api('GET', 'diagnose?anzahl=5')
x = next((x for x in d['wiedergaben'] if x['k'] == 'e2ediag01'), None)
namen = [e['e'] for e in (x or {}).get('ereignisse', [])]
pruefe(x and 'beginn' in namen and 'start_entscheidung' in namen and 'remux_erste_bytes' in namen and 'remux_ende' in namen,
       f'Zeitleiste enthält Player- und Server-Ereignisse: {namen}')
anna_los = Client()
code, _, _ = anna_los.roh('GET', '/api/v1/diagnose')
pruefe(code in (401, 403), f'Diagnose lesen nur mit Anmeldung/Admin: {code}')

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

schritt('Aufräumen: Vorschau (Medien hier beschreibbar, gelöscht wird nichts)')
a = admin.api('GET', 'aufraeumen/vorschau')
pruefe(a['moeglich']['filme'] and len(a['liste']) > 0, f'Vorschau: {a["moeglich"]}, {len(a["liste"])}')
print('  z. B.', a['liste'][0]['alt'], '→', a['liste'][0]['neu'])

schritt('Oberfläche ausgeliefert')
code, body, _ = admin.roh('GET', '/')
pruefe(code == 200 and b'/js/app.js' in body, 'index.php')
for datei in ['/js/app.js', '/js/player.js', '/js/vendor/hls.min.js', '/css/app.css', '/manifest.webmanifest']:
    code, body, _ = admin.roh('GET', datei)
    pruefe(code == 200 and len(body) > 100, f'{datei}: {code}')

print('E2E: alles in Ordnung.')
