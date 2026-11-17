#!/usr/bin/env bash
# Kanalzuordnung der Ton-Engine (alles über einen ASIO-Ausgang mit Kanalkarte, gemessen an allen 8 Ausgängen des Testinterfaces): 5.1 und 7.1 auf Quadro (4 Ausgänge), 7.1 auf 5.1, Quadro auf 5.1, 5.1 auf Stereo.
# Jeder Quellkanal bekommt eine eigene Frequenz; am ASIO-Testinterface wird je Ausgang gemessen, welche ankommen.
#   bash windows-client/tests/lage_test.sh   (braucht gcc, ffmpeg, python3)
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd)"
WC="$HIER/.."
A="$(mktemp -d)"
trap 'kill $(cat "$A/srv.pid" 2>/dev/null) 2>/dev/null || true; [ -n "${BEHALTEN:-}" ] || rm -rf "$A"' EXIT
gcc -O2 -I"$WC/dsp" -o "$A/engine" "$WC/engine/engine.c" "$WC/engine/geraet.c" "$WC/engine/klang.c" "$WC/engine/ausgabe_test.c" \
  "$WC/engine/ausgabe_asio.c" "$WC/engine/asio_attrappe.c" "$WC/engine/netz_posix.c" "$WC"/dsp/*.c -lpthread -lm 2>/dev/null
# Frequenzen je Quellkanal (FLAC-Folge): FL FR FC LFE BL BR SL SR
F=(200 300 500 70 700 1100 1300 1700)
quelle() {   # quelle <name> <anzahl> <layout>
  local args=() n="$2" i
  for ((i = 0; i < n; i++)); do args+=(-f lavfi -t 3 -i "sine=f=${F[$i]}:r=48000"); done
  local ein="" karte="" namen=(FL FR FC LFE BL BR SL SR)
  for ((i = 0; i < n; i++)); do ein+="[$i]"; karte+="${karte:+|}$i.0-${namen[$i]}"; done
  ffmpeg -loglevel error -y "${args[@]}" -filter_complex "${ein}join=inputs=$n:channel_layout=$3:map=$karte[a]" -map "[a]" -c:a flac "$A/$1.flac"
}
quelle s51 6 5.1
# laut: alle Kanäle fast Vollaussteuerung (für den Begrenzer)
ffmpeg -loglevel error -y -i "$A/s51.flac" -af "volume=7.2" -c:a flac "$A/laut.flac"
quelle s71 8 7.1
# Quadro-Quelle: FL FR BL BR mit den Frequenzen von FL FR SL SR
ffmpeg -loglevel error -y -f lavfi -t 3 -i sine=f=200:r=48000 -f lavfi -t 3 -i sine=f=300:r=48000 -f lavfi -t 3 -i sine=f=1300:r=48000 -f lavfi -t 3 -i sine=f=1700:r=48000 \
  -filter_complex "[0][1][2][3]join=inputs=4:channel_layout=quad:map=0.0-FL|1.0-FR|2.0-BL|3.0-BR[a]" -map "[a]" -c:a flac "$A/s40.flac"
(cd "$A" && exec python3 -m http.server 18791 --bind 127.0.0.1 >/dev/null 2>&1) & echo $! > "$A/srv.pid"
sleep 0.7
BASS_AUS='{"c":"bass","w.an":0}'
messen() {   # messen <quelle> <ausgänge> [bass-befehl]  → Pegel je Ausgang und Frequenz
  rm -f "$A/aus.raw"
  local bass="${3:-$BASS_AUS}"
  (echo "$bass"
   echo "{\"c\":\"ausgabe\",\"geraet\":\"asio:{TEST-ASIO}#$2\",\"exklusiv\":true}"
   echo "{\"c\":\"laden\",\"id\":\"x\",\"url\":\"http://127.0.0.1:18791/$1.flac\",\"spielen\":true}"
   sleep 1.5; echo '{"c":"beenden"}') | AW_TESTASIO=1 AW_ASIOVOLL=1 AW_TESTDATEI="$A/aus.raw" AW_TEMPO=4 timeout 10 "$A/engine" > "$A/log.txt" 2>&1 || true
  python3 - "$A/aus.raw" "$2" <<'PY'
import sys, struct, math, json
d = open(sys.argv[1], 'rb').read(); kanaele = [int(k) for k in sys.argv[2].split(',')]; nk = 8   # AW_ASIOVOLL: immer alle 8 Ausgänge
n = len(d) // 4 // nk
w = struct.unpack('<%di' % (n * nk), d[:n * nk * 4])
anf = n // 3; laenge = min(9600, n - anf)   # Mitte des Gespielten, 0,2 s
erg = []
for k in kanaele:
    x = [w[(anf + i) * nk + k] / 2147483648.0 for i in range(laenge)]
    pegel = {}
    for f in (200, 300, 500, 70, 700, 1100, 1300, 1700):
        c = 2 * math.cos(2 * math.pi * f / 48000); s1 = s2 = 0.0
        for v in x: s1, s2 = v + c * s1 - s2, s1
        a = math.sqrt(max(0.0, s1 * s1 + s2 * s2 - c * s1 * s2)) * 2 / laenge
        if a > 0.01: pegel[f] = round(a, 3)
    erg.append(pegel)
spitze = max(abs(v) for v in w[anf * nk:(anf + laenge) * nk]) / 2147483648.0
open(sys.argv[1] + '.spitze', 'w').write('%.4f' % spitze)
print(json.dumps(erg))
PY
}
pruefen() {   # pruefen <name> <json> <erwartet: je Ausgang Liste der Frequenzen>
  python3 - "$1" "$2" "$3" <<'PY'
import sys, json
name, ist, soll = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
ok = len(ist) == len(soll) and all(sorted(int(f) for f in a) == sorted(b) for a, b in zip(ist, soll))
print(('  ok: ' if ok else '  FEHLER: ') + name + ' – ' + ' | '.join(','.join(str(f) for f in sorted(int(k) for k in a)) or 'still' for a in ist))
sys.exit(0 if ok else 1)
PY
}
fehler=0
echo "== 5.1 auf Quadro: Mitte in die Front, Surrounds hinten, LFE ohne Sub weg"
pruefen "5.1 → 4.0" "$(messen s51 0,1,2,3)" '[[200,500],[300,500],[700],[1100]]' || fehler=1
echo "== 7.1 auf Quadro: Seite und hinten zusammen"
pruefen "7.1 → 4.0" "$(messen s71 0,1,2,3)" '[[200,500],[300,500],[700,1300],[1100,1700]]' || fehler=1
echo "== 7.1 auf 5.1"
pruefen "7.1 → 5.1" "$(messen s71 0,1,2,3,4,5)" '[[200],[300],[500],[70],[700,1300],[1100,1700]]' || fehler=1
echo "== Quadro auf 5.1: hinten bleibt hinten, Mitte und LFE still"
pruefen "4.0 → 5.1" "$(messen s40 0,1,2,3,4,5)" '[[200],[300],[],[],[1300],[1700]]' || fehler=1
echo "== 5.1 auf Quadro mit Subwoofer (80 Hz): LFE der Quelle zum Sub"
pruefen "5.1 → 4.1" "$(messen s51 0,1,2,3,4 '{"c":"bass","w.an":1,"w.hz":80,"w.delay":0,"w.layout":4,"w.phase":0,"w.lfe":10}')" '[[200,500],[300,500],[700],[1100],[70]]' || fehler=1
echo "== LFE ohne Sub auf die Front (Norm: je +4 dB), mit Begrenzer"
pruefen "5.1 → 4.0, LFE vorn" "$(messen s51 0,1,2,3 '{"c":"lfe","w.an":1,"w.db":0}')" '[[70,200,500],[70,300,500],[700],[1100]]' || fehler=1
pruefen "5.1 → 2.0, LFE vorn" "$(messen s51 0,1 '{"c":"lfe","w.an":1,"w.db":6}')" '[[70,200,500,700],[70,300,500,1100]]' || fehler=1
messen laut 0,1 '{"c":"lfe","w.an":1,"w.db":6}' > /dev/null
sp="$(cat "$A/aus.raw.spitze")"
python3 -c "import sys; s = float('$sp'); print(('  ok' if s <= 0.981 else '  FEHLER') + ': Spitze %.3f – nichts übersteuert' % s); sys.exit(0 if s <= 0.981 else 1)" || fehler=1
echo "== 5.1 auf Stereo"
pruefen "5.1 → 2.0" "$(messen s51 0,1)" '[[200,500,700],[300,500,1100]]' || fehler=1
[ "$fehler" = 0 ] && echo "Kanalzuordnung: alles in Ordnung." || exit 1
