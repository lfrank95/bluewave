#!/usr/bin/env python3
"""Teile des Windows-Clients für kleine Updates: „app“ (Oberfläche, Engine, Hilfsprogramme, Texte – ändert sich mit jeder
Version, wenige MB) und „mpv“ (ändert sich nur mit einem neuen mpv-Build). Alles andere (Electron, Programm-exe,
Deinstallation) ist die „basis“: ändert sie sich, gibt es das volle Paket.

komponenten.py <ordner> <ausgabe> <version> <basis-id>
  schreibt <ordner>/komponenten.json (kommt mit ins Paket) und <ausgabe>/komponenten.json, bw-app-<id>.zip, bw-mpv-<id>.zip.
Die IDs sind Prüfsummen über Pfade und Inhalte – gleicher Inhalt, gleiche ID, unabhängig vom Packen."""
import hashlib, json, os, sys, zipfile

ordner, ausgabe, version, basis = sys.argv[1:5]
APP = 'resources/app/'
MPV = 'resources/app/mpv/'
WURZEL_TEXTE = ('LIZENZ-Bluewave.txt', 'DRITTANBIETER.md', 'LIESMICH.txt')


def dateien():
    for wurzel, _, namen in os.walk(ordner):
        for n in namen:
            p = os.path.join(wurzel, n)
            yield os.path.relpath(p, ordner).replace(os.sep, '/'), p


def teil(rel):
    if rel.startswith(MPV):
        return 'mpv'
    if rel.startswith(APP) or rel in WURZEL_TEXTE:
        return 'app'
    return None


gruppen = {'app': [], 'mpv': []}
for rel, p in sorted(dateien()):
    k = teil(rel)
    if k:
        gruppen[k].append((rel, p))

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

komponenten = {}
for k, liste in gruppen.items():
    baum = hashlib.sha256()
    for rel, p in liste:
        baum.update(f'{rel}\0{sha(p)}\n'.encode())
    kid = baum.hexdigest()[:16]
    datei = f'bw-{k}-{kid}.zip'
    ziel = os.path.join(ausgabe, datei)
    with zipfile.ZipFile(ziel, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel, p in liste:
            z.write(p, rel)
    komponenten[k] = {'id': kid, 'datei': datei, 'groesse': os.path.getsize(ziel), 'sha256': sha(ziel), 'dateien': len(liste)}
    print(f'{k}: {len(liste)} Dateien, {os.path.getsize(ziel) / 1048576:.1f} MB, {kid}')

j = {'version': version, 'basis': basis, 'komponenten': komponenten}
for z in (os.path.join(ordner, 'komponenten.json'), os.path.join(ausgabe, 'komponenten.json')):
    with open(z, 'w', encoding='utf-8') as f:
        json.dump(j, f, indent=1)
