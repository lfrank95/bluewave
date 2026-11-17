#!/usr/bin/env bash
# Ton-Engine unter Linux (Testgerät statt WASAPI/ASIO) mit dem Tonstrom, wie ihn der Server für den Windows-Client
# liefert (ton_befehl aus app/includes/remux.php: FLAC 24 Bit, unbekannte Länge, über HTTP mit Cookie).
# Geprüft: 5.1 aus AC3 kommt mit 6 Kanälen an, die Uhr der Engine läuft ab dem Startpunkt, das Ende wird erkannt,
# Stereo-Quelle und Nachtmodus. Braucht gcc, php und ffmpeg.
#   bash windows-client/tests/engine_test.sh
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd)"
WC="$HIER/.."
ARBEIT="$(mktemp -d)"
trap 'kill $(cat "$ARBEIT/php.pid" 2>/dev/null) 2>/dev/null || true; rm -rf "$ARBEIT"' EXIT
command -v ffmpeg >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg >/dev/null; }

echo "== Engine (Linux, Testgerät) bauen"
gcc -O2 -I"$WC/dsp" -o "$ARBEIT/engine" "$WC/engine/engine.c" "$WC/engine/geraet.c" "$WC/engine/klang.c" "$WC/engine/ausgabe_test.c" \
  "$WC/engine/ausgabe_asio.c" "$WC/engine/asio_attrappe.c" "$WC/engine/netz_posix.c" "$WC/engine/vstanbindung.c" "$WC"/dsp/*.c -lpthread -lm 2>&1 | grep -E "error" && exit 1 || true

echo "== Testmedien"
ffmpeg -loglevel error -y -f lavfi -i testsrc=size=320x240:rate=25 -f lavfi -i "sine=f=440:r=48000" -t 20 \
  -filter_complex "[1:a]asplit=2[x][y];[x]pan=5.1(side)|c0=c0|c1=0.5*c0|c2=c0|c3=0.2*c0|c4=c0|c5=c0[a];[y]pan=stereo|c0=c0|c1=0.7*c0[s]" -map 0:v -map "[a]" -map "[s]" \
  -c:v libx264 -preset ultrafast -c:a:0 ac3 -b:a:0 384k -c:a:1 aac -b:a:1 128k "$ARBEIT/film.mkv"

cat > "$ARBEIT/ton.php" <<PHP
<?php
// wie /api/v1/remux/{datei}/ton – Befehl aus dem Server, Anmeldung per Cookie
require '$WC/../app/includes/remux.php';
if ((\$_COOKIE['bw_sitzung'] ?? '') !== 'test') { http_response_code(401); exit; }
header('Content-Type: audio/flac');
\$p = proc_open(ton_befehl('$ARBEIT/film.mkv', (float) (\$_GET['start'] ?? 0), (int) (\$_GET['ton'] ?? 0), (string) (\$_GET['nacht'] ?? 'aus'), (int) (\$_GET['dialog'] ?? 0)),
    [1 => ['pipe', 'w'], 2 => ['file', '$ARBEIT/ffmpeg.log', 'a']], \$r);
while (!feof(\$r[1])) { \$x = fread(\$r[1], 65536); if (\$x === '' || \$x === false) continue; echo \$x; flush(); }
PHP
php -S 127.0.0.1:18765 -t "$ARBEIT" >/dev/null 2>&1 &
echo $! > "$ARBEIT/php.pid"
sleep 1

spielen() {   # spielen <name> <url> <sekunden>
  (echo '{"c":"ausgabe","geraet":"test","exklusiv":true}'
   echo "{\"c\":\"laden\",\"id\":\"$1\",\"url\":\"$2\",\"kopf\":\"Cookie: bw_sitzung=test\\r\\n\",\"spielen\":true}"
   sleep "$3"; echo '{"c":"beenden"}') | AW_TESTDATEI="$ARBEIT/$1.raw" AW_TEMPO=4 timeout 30 "$ARBEIT/engine" > "$ARBEIT/$1.txt" 2>&1 || true
}
pruefen() { python3 - "$@" <<'PY'
import json, sys
datei, name, kan, start, ende = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), sys.argv[5] == 'ja'
m = [json.loads(z) for z in open(datei) if z.startswith('{')]
geladen = next((x for x in m if x['e'] == 'geladen'), None)
assert geladen, f'{name}: nicht geladen: {m[:5]}'
assert geladen['kanaele'] == kan and geladen['rate'] == 48000 and geladen['bits'] == 24, f'{name}: Format {geladen}'
zeiten = [x['pos'] for x in m if x['e'] == 'zeit']
assert zeiten and zeiten[-1] > 1, f'{name}: Uhr läuft nicht: {zeiten[-3:]}'
assert not any(x['e'] == 'fehler' for x in m), f'{name}: Fehler: {[x for x in m if x["e"] == "fehler"]}'
if ende:
    assert any(x['e'] == 'ende' for x in m), f'{name}: Ende nicht erkannt'
    assert abs(zeiten[-1] - (20 - start)) < 0.6, f'{name}: bis zum Ende {20 - start} s erwartet, Uhr bei {zeiten[-1]}'
print(f'  ok: {name}: {kan} Kanäle, Uhr bis {zeiten[-1]:.2f} s' + (', Ende erkannt' if ende else ''))
PY
}
echo "== 5.1 (AC3) ab 12 s bis zum Ende"
spielen ac3 "http://127.0.0.1:18765/ton.php?start=12&ton=0" 5
pruefen "$ARBEIT/ac3.txt" "AC3 5.1" 6 12 ja
echo "== Stereo (AAC), zweite Spur"
spielen aac "http://127.0.0.1:18765/ton.php?start=0&ton=1" 2
pruefen "$ARBEIT/aac.txt" "AAC Stereo" 2 0 nein
echo "== Nachtmodus + Dialog → Stereo"
spielen nacht "http://127.0.0.1:18765/ton.php?start=0&ton=0&nacht=stark&dialog=6" 2
pruefen "$ARBEIT/nacht.txt" "Nachtmodus" 2 0 nein
python3 - "$ARBEIT/ac3.raw" <<'PY'
import sys, struct
d = open(sys.argv[1], 'rb').read()
assert len(d) > 100000, f'kaum Daten gespielt: {len(d)}'
print(f'  ok: {len(d) // 1024} KB am Testgerät angekommen')
PY
[ -s "$ARBEIT/ffmpeg.log" ] && { echo "ffmpeg meldet:"; cat "$ARBEIT/ffmpeg.log"; exit 1; }
echo "Engine: alles in Ordnung."
