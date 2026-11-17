#!/bin/bash
# Bluewave Windows-Client bauen: Ton-Engine cross-kompilieren, in Electron (win32-x64) einsetzen, mpv beilegen, Symbol und
# Versionsinfo eintragen, ungenutzte Teile entfernen und als selbstentpackende exe packen (LZMA2, Assistent wie Amberwave).
# Werkzeuge per Umgebung: LLVM_MINGW (llvm-mingw), ELECTRON_ZIP (electron-v…-win32-x64.zip), MPV_7Z (shinchiro-Build),
# GPL_TEXT (gpl-2.0.txt, optional), AUS (Ausgabeordner). In GitHub Actions: .github/workflows/docker.yml (Job „client“).
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd)"
LLVM_MINGW="${LLVM_MINGW:?LLVM_MINGW fehlt (llvm-mingw)}"
ELECTRON_ZIP="${ELECTRON_ZIP:?ELECTRON_ZIP fehlt}"
MPV_7Z="${MPV_7Z:?MPV_7Z fehlt (mpv-x86_64-…-git-….7z von shinchiro/mpv-winbuild-cmake)}"
AUS="${AUS:-$HIER/dist}"
VERSION="$(node -p "require('$HIER/client/package.json').version")"
CC="$LLVM_MINGW/bin/x86_64-w64-mingw32-clang"

VNUM="${VERSION%%-*}"   # Vorabversion (z. B. 0.2.0-beta.1): Windows-Versionsinfo kennt nur Zahlen
V1="$(echo "$VNUM" | cut -d. -f1)"; V2="$(echo "$VNUM" | cut -d. -f2)"; V3="$(echo "$VNUM" | cut -d. -f3)"
rc_bauen() {   # Ressourcen mit Versionsnummern: rc_bauen quelle.rc ziel.o (symbol.ico liegt in build/)
  sed "s/@V1@/$V1/g; s/@V2@/$V2/g; s/@V3@/$V3/g; s/@VERSION@/$VERSION/g" "$1" > "$HIER/build/$(basename "$1")"
  cp "$(dirname "$1")"/*.manifest "$HIER/build/" 2>/dev/null || true
  (cd "$HIER/build" && "$LLVM_MINGW/bin/x86_64-w64-mingw32-windres" --codepage=65001 "$(basename "$1")" -O coff -o "$2")
}
rm -rf "$HIER/build" && mkdir -p "$HIER/build"
# Symbol (bis 48 px als BMP, darüber PNG)
python3 "$HIER/werkzeug/assistent_bilder.py" "$HIER/client/bilder/icon-256.png" "$HIER/build"
# Schriften des Installers (feste Schnitte aus den App-Schriften) und Lizenzseite (Bluewave + Fremdkomponenten)
python3 "$HIER/werkzeug/schriften.py" "$HIER/../app/fonts" "$HIER/build"
cat "$HIER/LIZENZ.txt" - "$HIER/DRITTANBIETER.md" > "$HIER/build/lizenz.txt" <<< ""
cp "$HIER/build/lizenz.txt" "$HIER/build/lizenz_de.txt"

echo "Engine …"
rc_bauen "$HIER/engine/engine.rc" "$HIER/build/engine_res.o"
D="$HIER/dsp"
"$CC" -O2 -Wall -static -I"$D" -o "$HIER/build/bluewave-engine.exe" "$HIER/build/engine_res.o" \
  "$HIER/engine/engine.c" "$HIER/engine/klang.c" "$HIER/engine/ausgabe_wasapi.c" "$HIER/engine/ausgabe_asio.c" "$HIER/engine/geraet.c" "$HIER/engine/netz_win.c" \
  "$D/gemeinsam.c" "$D/glow.c" "$D/iron.c" "$D/silk.c" "$D/eq.c" "$D/schwerpunkt.c" "$D/upmix.c" "$D/faltung.c" "$D/raumgraph.c" "$D/umrechner.c" \
  -lpthread -lole32 -lwinhttp -lavrt -luuid -lksuser -luser32 -ladvapi32 2>&1 | grep -v "dr_flac.h\|dr_wav.h" | grep -E "warning|error" || true
[ -f "$HIER/build/bluewave-engine.exe" ] || { echo "FEHLER: Engine wurde nicht gebaut" >&2; exit 1; }

echo "NV-Profil …"
rc_bauen "$HIER/nvprofil/nvprofil.rc" "$HIER/build/nvprofil_res.o"
"$CC" -O2 -Wall -static -o "$HIER/build/bluewave-nvprofil.exe" "$HIER/build/nvprofil_res.o" "$HIER/nvprofil/nvprofil.c" 2>&1 | grep -E "warning|error" || true
[ -f "$HIER/build/bluewave-nvprofil.exe" ] || { echo "FEHLER: NV-Profil wurde nicht gebaut" >&2; exit 1; }

echo "Electron $VERSION …"
ZIEL="$AUS/Bluewave Windows Client"
rm -rf "$ZIEL" && mkdir -p "$ZIEL"
unzip -q "$ELECTRON_ZIP" -d "$ZIEL"
mv "$ZIEL/electron.exe" "$ZIEL/Bluewave Client.exe"
rm -f "$ZIEL/resources/default_app.asar"
# nur deutsche und englische Sprachdateien (spart rund 40 MB)
find "$ZIEL/locales" -name '*.pak' ! -name 'de.pak' ! -name 'en-US.pak' -delete
# ungenutzt: WebGPU-Shadercompiler, Software-Grafik (SwiftShader/Vulkan) – das Bild zeichnet mpv
rm -f "$ZIEL/dxcompiler.dll" "$ZIEL/dxil.dll" "$ZIEL/vk_swiftshader.dll" "$ZIEL/vk_swiftshader_icd.json" "$ZIEL/vulkan-1.dll"
# Bluewave-Symbol und Versionsinfo in die exe (Explorer, Taskleiste, Task-Manager)
python3 "$HIER/werkzeug/pe_symbol.py" "$ZIEL/Bluewave Client.exe" "$HIER/build/symbol.ico" "$VERSION" "Bluewave Windows-Client" "Bluewave Client.exe"
APPD="$ZIEL/resources/app"
mkdir -p "$APPD/engine" "$APPD/mpv"
cp "$HIER/client/"{main.js,preload.js,suche.js,log.js,i18n.js,mpv.js,spieler.js,rife.js,einrichtung.html,package.json} "$APPD/"
mkdir -p "$APPD/rife" && cp "$HIER/client/rife/bluewave_rife.vpy" "$APPD/rife/"
# 7-Zip (nur .7z) zum Auspacken von vs-mlrt bei der RIFE-Einrichtung
if [ -n "${SIEBEN_ZR:-}" ] && [ -f "$SIEBEN_ZR" ]; then cp "$SIEBEN_ZR" "$APPD/engine/7zr.exe"; else echo "WARNUNG: 7zr.exe fehlt (SIEBEN_ZR) – RIFE-Einrichtung geht dann nicht" >&2; fi
cp -r "$HIER/client/bilder" "$APPD/"
cp "$HIER/build/bluewave-engine.exe" "$HIER/build/bluewave-nvprofil.exe" "$APPD/engine/"

echo "mpv …"
# fertiger Windows-Build (GPL); nur das Programm und seine Begleitdateien, ohne Installer-Skripte
7z x -y -bd -o"$HIER/build/mpv" "$MPV_7Z" > /dev/null
[ -f "$HIER/build/mpv/mpv.exe" ] || { echo "FEHLER: mpv.exe nicht im Archiv" >&2; exit 1; }
# eigener Programmname: NVIDIA-Profile (Smooth Motion) gelten dann nur für Bluewave, nicht für ein anderes mpv
cp "$HIER/build/mpv/mpv.exe" "$APPD/mpv/bluewave-mpv.exe"
for f in "$HIER/build/mpv/"*.dll; do [ -f "$f" ] && cp "$f" "$APPD/mpv/"; done
[ -d "$HIER/build/mpv/mpv" ] && cp -r "$HIER/build/mpv/mpv" "$APPD/mpv/"
basename "$MPV_7Z" .7z > "$APPD/mpv/mpv-version.txt"
[ -n "${GPL_TEXT:-}" ] && [ -f "$GPL_TEXT" ] && cp "$GPL_TEXT" "$APPD/mpv/GPL-2.0.txt"

cp "$HIER/LIZENZ.txt" "$ZIEL/LIZENZ-Bluewave.txt"
cp "$HIER/DRITTANBIETER.md" "$ZIEL/DRITTANBIETER.md"
cat > "$ZIEL/LIESMICH.txt" <<TXT
Bluewave Windows-Client $VERSION

Installiert nach %LOCALAPPDATA%\\Programs\\Bluewave (nur für dich, ohne Admin-Rechte), mit Eintrag im Startmenü.
Deinstallieren: Einstellungen → Apps → Bluewave Windows-Client (oder „Bluewave deinstallieren.exe“ in diesem Ordner).
Ohne Installation: das Paket mit /portabel starten – dann landet der Ordner neben dem Paket.
Beim ersten Start sucht Bluewave den Server im Heimnetz (Port 9960). Wird nichts gefunden, lässt sich die Adresse
von Hand eingeben (z. B. 192.168.1.10).

Ton (Engine mit ASIO/WASAPI, mpv, Bitstream zum Receiver), Bild und Updates: Profil → Windows-Client.
Eigene mpv-Einstellungen: %APPDATA%\\bluewave-client\\mpv\\mpv.conf. Logs: %APPDATA%\\bluewave-client\\log\\.
Lizenzen: LIZENZ-Bluewave.txt, Fremdkomponenten: DRITTANBIETER.md, Chromium: LICENSES.chromium.html.
TXT
echo "Deinstallation …"
rc_bauen "$HIER/sfx/deinstallieren.rc" "$HIER/build/deinst_res.o"
rm -f "$ZIEL/Bluewave deinstallieren.exe" "$HIER/build/sfx.exe"   # ein fehlgeschlagener Build darf keine alte exe einpacken
"$CC" -O2 -Wall -static -municode -mwindows -o "$ZIEL/Bluewave deinstallieren.exe" "$HIER/build/deinst_res.o" \
  "$HIER/sfx/deinstallieren.c" -lshell32 -ladvapi32 2>&1 | grep -E "warning|error" || true
echo "Paket …"
rc_bauen "$HIER/sfx/sfx.rc" "$HIER/build/sfx_res.o"
SFX_O="$HIER/build/sfx_obj" && mkdir -p "$SFX_O"
for c in sfx_kern xz/xz_crc32 xz/xz_dec_lzma2 xz/xz_dec_stream xz/xz_dec_bcj; do
  "$CC" -O2 -Wall -c "$HIER/sfx/$c.c" -o "$SFX_O/$(basename "$c").o"
done
"$LLVM_MINGW/bin/x86_64-w64-mingw32-clang++" -O2 -Wall -std=c++17 -static -municode -mwindows -DAW_VERSION="L\"$VERSION\"" -o "$HIER/build/sfx.exe" "$HIER/build/sfx_res.o" \
  "$HIER/sfx/sfx.cpp" "$SFX_O"/*.o \
  -lgdiplus -ldwmapi -lcomctl32 -lshell32 -lole32 -luuid -ladvapi32 -lgdi32 -lpropsys 2>&1 | grep -E "warning|error" || true
for f in "$ZIEL/Bluewave deinstallieren.exe" "$HIER/build/sfx.exe"; do [ -f "$f" ] || { echo "FEHLER: $f wurde nicht gebaut" >&2; exit 1; }; done
rm -f "$AUS/Bluewave-Windows-Client-$VERSION.exe"
python3 "$HIER/sfx/packen.py" "$HIER/build/sfx.exe" "$ZIEL" "$AUS/Bluewave-Windows-Client-$VERSION.exe"
ls -la "$AUS/Bluewave-Windows-Client-$VERSION.exe"
