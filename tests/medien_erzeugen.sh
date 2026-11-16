#!/usr/bin/env bash
# Kleine Testmedien erzeugen: Filme (Fassungen, zwei Ordner desselben Films, MP4 für Direct Play, externer Untertitel)
# und eine Serie mit 3 Folgen, die dasselbe Intro und denselben Abspann haben (für die Intro-Erkennung).
#   bash tests/medien_erzeugen.sh <ziel> <ffmpeg>
set -euo pipefail
ZIEL="$1"; FF="${2:-ffmpeg}"
F="$ZIEL/filme"; S="$ZIEL/serien"
mkdir -p "$F/Avengers (2012)" "$F/Avengers - Age of Ultron (2015)" "$F/Testfilm (2024)" "$F/Testfilm (2024) 720p" "$S/Haus des Geldes (2017)/Season 01"
q() { "$FF" -hide_banner -loglevel error -y "$@"; }

film() { # ziel breite hoehe dauer
    q -f lavfi -i "testsrc2=size=${2}x${3}:rate=24" -f lavfi -i "sine=frequency=330:sample_rate=48000" -t "$4" \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 96k "$1"
}
film "$F/Avengers (2012)/The Avengers (2012).mp4" 320 180 30
film "$F/Avengers - Age of Ultron (2015)/Avengers.Age.of.Ultron.2015.1080p.mkv" 320 180 30
film "$F/Testfilm (2024)/Testfilm (2024).mkv" 480 270 40
film "$F/Testfilm (2024)/Testfilm (2024) {edition-Extended}.mkv" 480 270 45
film "$F/Testfilm (2024) 720p/Testfilm (2024).mkv" 1280 720 40
printf '1\n00:00:01,000 --> 00:00:04,000\nHallo Welt – äöü\n\n2\n00:00:05,000 --> 00:00:08,000\nZweiter Untertitel\n' > "$F/Testfilm (2024)/Testfilm (2024).de.srt"
# ein Trailer, der übergangen werden muss
cp "$F/Avengers (2012)/The Avengers (2012).mp4" "$F/Avengers (2012)/The Avengers (2012)-trailer.mp4"

# Serie: Vorspann / Intro / Hauptteil / Abspann
T="$(mktemp -d)"
q -f lavfi -i "aevalsrc=0.5*sin(2*PI*t*(300+200*sin(t*1.3)))+0.3*sin(2*PI*t*(500+150*sin(t*0.7))):s=44100:d=32" "$T/intro.wav"
q -f lavfi -i "aevalsrc=0.4*sin(2*PI*t*(200+300*abs(sin(t*0.5))))+0.4*sin(2*PI*t*660*(1+0.1*sin(t*3))):s=44100:d=40" "$T/abspann.wav"
for k in 1 2 3; do
    pre=$((k * 8 - 3))
    q -f lavfi -i "aevalsrc=0.3*sin(2*PI*t*(150+${k}37*sin(t*0.${k}3)))+0.2*random(${k}):s=44100:d=$pre" "$T/pre$k.wav"
    q -f lavfi -i "aevalsrc=0.3*sin(2*PI*t*(180+${k}53*sin(t*0.${k}7)))+0.2*random(1${k}):s=44100:d=90" "$T/main$k.wav"
    q -i "$T/pre$k.wav" -i "$T/intro.wav" -i "$T/main$k.wav" -i "$T/abspann.wav" -f lavfi -i "color=c=0x223355:s=320x180:r=10" \
      -filter_complex "[0][1][2][3]concat=n=4:v=0:a=1[a]" -map "[a]" -map 4:v -shortest -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac \
      "$S/Haus des Geldes (2017)/Season 01/Haus des Geldes - S01E0$k.mkv"
done
rm -rf "$T"
# lokale Bilder (Kodi/Plex-Namen): Film-Poster, Serien-Poster und Staffel-Poster
q -f lavfi -i "color=c=0xaa3355:s=200x300" -frames:v 1 "$F/Avengers (2012)/poster.jpg"
q -f lavfi -i "color=c=0x33aa55:s=400x225" -frames:v 1 "$F/Avengers (2012)/fanart.jpg"
q -f lavfi -i "color=c=0x3355aa:s=200x300" -frames:v 1 "$S/Haus des Geldes (2017)/folder.jpg"
q -f lavfi -i "color=c=0x55aa33:s=200x300" -frames:v 1 "$S/Haus des Geldes (2017)/season01-poster.jpg"
echo "Testmedien in $ZIEL"
