# Komponenten anderer Hersteller im Bluewave Windows-Client

| Komponente | Zweck | Lizenz | Quelle |
|---|---|---|---|
| Electron (mit Chromium, Node.js) | Programmfenster, Web-App | MIT; Chromium: BSD und weitere (LICENSES.chromium.html) | https://www.electronjs.org |
| mpv | Videowiedergabe | GPL-2.0-or-later (Windows-Build mit GPL-Teilen) | https://mpv.io, Quellcode: https://github.com/mpv-player/mpv |
| FFmpeg und Bibliotheken im mpv-Build (libass, libplacebo, dav1d, …) | Dekodieren, Untertitel, Bildaufbereitung | GPL/LGPL, jeweilige Lizenzen | https://github.com/shinchiro/mpv-winbuild-cmake (Bauanleitung und Quellen) |
| dr_flac, dr_wav (David Reid) | Ton-Engine: FLAC/WAV lesen | Public Domain / MIT-0 | https://github.com/mackron/dr_libs |
| XZ Embedded | Entpacken im Installer | Public Domain (0BSD) | https://tukaani.org/xz/embedded.html |
| ASIO-Schnittstelle | Ton-Engine: ASIO-Treiber ansprechen | ASIO ist eine Marke der Steinberg Media Technologies GmbH; nur die Schnittstellen-Definition | https://www.steinberg.net |
| Space Grotesk, Manrope | Schriften im Installer | SIL Open Font License 1.1 | https://fonts.google.com |

mpv und FFmpeg werden unverändert als fertige Programme mitgeliefert (mpv.exe im Ordner resources\app\mpv). Den
Quellcode genau dieser Fassung gibt es beim Projekt mpv-winbuild-cmake (Build-Nummer in mpv-version.txt); auf Anfrage
stellt der Rechteinhaber ihn auch selbst bereit (GPL, Abschnitt 3).

## GNU General Public License, Version 2

Der vollständige Text liegt bei (GPL-2.0.txt im Ordner resources\app\mpv) und steht unter https://www.gnu.org/licenses/old-licenses/gpl-2.0.html.
