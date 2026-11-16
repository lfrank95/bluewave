# Bluewave

Eigener Film- und Serienserver aus der Amberwave-Familie – als Ersatz für Plex, ohne Abo.

**Stand:** Docker-Grundgerüst. Datenbank, Schema der Bibliothek, Hardware-Erkennung und Transkodier-Motor laufen; Bibliothek, Konten und Apps folgen.

## Was schon drin ist

- **Docker-Stack** (App + MariaDB) und **All-in-One-Image** mit eingebauter Datenbank für die Unraid-Vorlage
- **Datenbank richtet sich selbst ein** – keine Passwörter in der `.env`; Zugang liegt in `appdata/cache/geheimnisse/`
- **Schema der Bibliothek:** Universen (enthalten Reihen, Filme und Serien), Reihen, Filme, Fassungen (Kino/Extended …) getrennt von der Qualität (Dateien), Serien mit mehreren Episodenreihenfolgen (Ausstrahlung, DVD, Streaming-Schnitt), Ton- und Untertitelspuren, Intro/Abspann-Marker (erkannt oder manuell)
- **Transkodieren mit jellyfin-ffmpeg:** Encoder-Profile *Intel QuickSync* (Hauptweg) und *Software* (Fallback), NVENC/VA-API vorgesehen. HLS-Ausgabe, HDR-Tone-Mapping, Ton wird nur neutral umgewandelt (keine Kompression)
- **Hardware-Erkennung beim Start:** Was kann die Intel-Grafik (HEVC 10-Bit, AV1, Tone-Mapping), funktionieren die Encoder wirklich – und welches Profil läuft tatsächlich. Knopf „Transkodierung testen“ misst die Geschwindigkeit

## Installation (Unraid, Compose-Stack)

1. `docker-compose.yml` als Stack anlegen, `.env.example` als `.env` daneben und die Pfade anpassen
2. Starten und `http://<server>:9960` öffnen

Die Grafik wird über `/dev/dri` durchgereicht; die passende Gruppe erkennt Bluewave selbst. Server ohne Grafik: die `devices`-Zeilen auskommentieren.

**Hardware-Beschleunigung:** `HWACCEL=auto` (Standard), `quicksync` oder `software` – in der `.env` bzw. in der Unraid-Vorlage. Die Startseite zeigt, was wirklich läuft.

Zum Nachsehen im Terminal: `docker exec bluewave_app php /var/www/html/scripts/hardware.php --test`

## Hinweise

- Filme und Serien sind standardmäßig **nur lesend** eingebunden (`MEDIEN_MOUNT_MODUS=ro`), damit Plex parallel weiterlaufen kann
- Bis die Anmeldung fertig ist, ist die Verwaltung **nur direkt im Heimnetz** erreichbar – über den Cloudflare Tunnel oder einen Proxy nicht
- Das Repository ist privat, daher auch die Images in der GitHub Container Registry: auf dem Server einmal `docker login ghcr.io` mit einem Token (Recht `read:packages`)
