# Bluewave

Eigener Film- und Serienserver aus der Amberwave-Familie – als Ersatz für Plex, ohne Abo.

**Stand: erster Prototyp** (Server + Web-App/PWA). Die Android-App für Handy, Fire TV und Android TV folgt.

## Was drin ist

**Bibliothek**
- Filme und Serien aus zwei Ordnern; Namen wie „Titel (Jahr)“, Release-Namen, `{tmdb-123}`, `{edition-Extended}`, `S01E02`, `1x02`
- Fassung (Kino, Extended, Director's Cut, IMAX …) getrennt von der Qualität (4K/1080p-Dateien) – auch über mehrere Ordner
- Metadaten von TMDB: deutsche Texte mit englischem Ersatz, Poster, Hintergründe, Logos, Besetzung, Genres, FSK
- Reihen (TMDB-Collections) in Erscheinungsreihenfolge; **Universen** legst du selbst an – sie enthalten Reihen, Filme und Serien
- Mehrere **Episodenreihenfolgen** (z. B. Ausstrahlung vs. Netflix-Schnitt bei „Haus des Geldes“), Standard pro Serie wählbar
- Extras werden übergangen; Ordner werden regelmäßig auf Neues geprüft (Intervall in der App)

**Wiedergabe**
- Direct Play, wenn das Gerät die Datei kann – sonst Direct Stream (Bild unverändert, nur Ton/Container neu) – sonst HLS-Umwandlung mit Intel QuickSync (Software als Fallback)
- Umwandeln mit kurzer Wartezeit: Teile werden schon ausgeliefert, während sie entstehen (Fragmente von 0,5 s), die ersten Teile sind nur 2 s lang
- Spulen überall hin: der Encoder startet sofort am Ziel (der Player meldet die Stelle schon beim Loslassen), Drosselung, damit nicht der ganze Film vorab umgewandelt wird
- Gemeinsamer Zwischenspeicher der umgewandelten Teile: Zurückspringen, Weiterschauen und ein zweiter Zuschauer brauchen nichts neu zu berechnen (Obergrenze automatisch oder in den Einstellungen)
- Geräte ohne MediaSource (iPhone, manche Fernseher): Direct Stream als HLS, Teile an den Schlüsselbildern der Quelle (aus dem MKV-/MP4-Inhaltsverzeichnis)
- **Vorschaubilder** auf der Zeitleiste (im Hintergrund erzeugt) und **optimierte Fassungen** (1080p/720p H.264 vorab, für unterwegs: spielen direkt, Spulen sofort)
- HDR → SDR (Tone-Mapping), Bild-Untertitel (PGS) werden eingebrannt, Text-Untertitel als WebVTT
- Ton- und Untertitelsprache pro Nutzer; fehlende Untertitel automatisch von OpenSubtitles (optional)
- **Intro & Abspann** per Audio-Fingerabdruck erkannt, im Player von Hand setz-/korrigierbar; Intro überspringen (Knopf oder automatisch)
- Nächste Folge mit Countdown oder sofort; Weiterschauen/Gesehen pro Nutzer
- Nachtmodus und Dialog-Anhebung – **standardmäßig aus, dann bleibt der Ton unangetastet**

**Familie**
- Konten ohne Registrierung (Admin legt an), Fernseher per 6-stelligem Code oder fest angemeldet
- Bis zur Anmeldung kommt über den Tunnel niemand an die Verwaltung; die Einrichtung geht nur im Heimnetz

**Verwaltung**: Bibliothek (Scan, Metadaten, Intro-Erkennung, Untertitel, Zuordnen von Hand), Universen, Aufräumen mit Vorschau, Nutzer, Einstellungen, Hintergrund (optimierte Fassungen, Vorschaubilder), Diagnose (Zeitleiste jeder Wiedergabe), System (QuickSync-Status, Transkodiertest)

**Windows-Client** (`windows-client/`, Installer im Server-Image: Profil › Windows-Client › Herunterladen)
- Electron-Hülle um die Web-App; Filme und Serien spielt **mpv** – jede Datei unverändert (MKV, HEVC/AV1, HDR, alle Ton- und Untertitelspuren inkl. PGS), kein Umwandeln
- Ton wahlweise über die **Bluewave-Engine** (aus Amberwave: WASAPI geteilt/exklusiv, ASIO, Lautsprecher-Manager mit Abständen, Pegeln, Subwoofer-Weiche und Kanal-EQ; der Server liefert die Spur verlustfrei als FLAC, das Bild folgt der Uhr der Engine), über **mpv** (WASAPI, auf Wunsch exklusiv) oder als **Bitstream** zum AV-Receiver (Dolby Digital/TrueHD/Atmos, DTS/DTS-HD)
- findet den Server im Heimnetz von selbst (Ausweis per Ed25519), Updates kommen vom eigenen Server; eigene mpv-Einstellungen in `%APPDATA%\bluewave-client\mpv\mpv.conf`

## Installation (Unraid, Compose-Stack)

1. `docker-compose.yml` als Stack anlegen, `.env.example` als `.env` daneben, Pfade anpassen
2. Starten, `http://<server>:9960` im Heimnetz öffnen und das Admin-Konto anlegen
3. Verwaltung › Einstellungen: TMDB-Schlüssel eintragen (kostenlos bei themoviedb.org), dann Verwaltung › Bibliothek › „Alles prüfen“

Die Grafik wird über `/dev/dri` durchgereicht, die Gruppe erkennt Bluewave selbst. `HWACCEL=auto|quicksync|software` in der `.env` bzw. Unraid-Vorlage.

**Schneller umwandeln:** Den Ordner für Zwischendateien in den Arbeitsspeicher legen – `TRANSKODIER_PFAD=/dev/shm/bluewave` in der `.env` (Bluewave hält den Zwischenspeicher dann automatisch klein). Optimierte Fassungen landen in `OPTIMIERT_PFAD` (Standard: im Appdata-Ordner; besser aufs Array, mehrere GB je Film).

**Hinter einem Reverse-Proxy** (Nginx Proxy Manager, SWAG, Caddy …) mit HTTPS spricht der Browser HTTP/2 – dann teilen sich Bilder und Videoteile nicht mehr die sechs Verbindungen, die ein Browser je Server öffnet. Für die Wiedergabe beim Proxy die Pufferung abschalten (`proxy_buffering off;` bzw. „X-Accel-Buffering: no“ wird schon gesendet), sonst kommen wachsende Teile erst am Stück.

Filme und Serien sind **nur lesend** eingebunden (`MEDIEN_MOUNT_MODUS=ro`), solange Plex parallel läuft. Fürs Aufräumen auf `rw` stellen.

Privates Repository → die Images sind privat: einmal `docker login ghcr.io` mit einem Token (`read:packages`).

## Entwicklung

Jeder Push auf `main` baut die Images, startet Stack und All-in-One, erzeugt Testmedien und prüft mit einer Ersatz-TMDB den ganzen Ablauf (`tests/e2e.py`) und den Player in echtem Chrome (`tests/browser.py`) – erst dann wird nach `ghcr.io` gepusht. Der Zweig `entwicklung` wird nur gebaut und getestet.

Der Windows-Client wird im selben Lauf gebaut (llvm-mingw, Electron, mpv von shinchiro) und vorher geprüft: Ton-Engine unter Linux mit dem FLAC-Strom des Servers (`windows-client/tests/engine_test.sh`), Gleichlauf von Bild und Ton mit einer mpv-Attrappe (`spieler_test.js`), die Oberfläche in Chrome (`oberflaeche_test.py`) und auf echtem Windows Dateiangaben, mpv, Engine, Videofenster und stilles Update (`windows_pruefen.ps1`). Vorabversionen zählen mit jedem Lauf hoch (`0.2.0-beta.<lauf>`).
