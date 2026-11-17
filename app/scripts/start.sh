#!/bin/sh
# Start des App-Containers (liegt im Code-Ordner und kommt mit jedem Update).
# Webserver und Hintergrundjobs laufen NIE als root, sondern als PUID/PGID (Unraid: 99:100) – wie bei Amberwave.
set -u

CACHE_DIR="${PFAD_CACHE:-/cache}"
BACKUP_DIR="${PFAD_BACKUPS:-/backups}"
TRANS_DIR="${PFAD_TRANSKODIEREN:-/transkodieren}"
MERKDATEI="$CACHE_DIR/.laufbenutzer"
mkdir -p "$CACHE_DIR" 2>/dev/null

# ---- Wer bin ich? 1. PUID/PGID aus .env/Vorlage  2. beim ersten Start Gemerktes  3. Besitzer von Cache bzw. Filmordner  4. 99:100 ----
ist_zahl() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
HERKUNFT=""
if ist_zahl "${PUID:-}" && [ "$PUID" != "0" ]; then
    HERKUNFT="env"; ist_zahl "${PGID:-}" || PGID=""
else
    [ "${PUID:-}" = "0" ] && echo "Hinweis: PUID=0 (root) wird nicht verwendet – Bluewave läuft nie als root."
    PUID=""; PGID=""
fi
if [ -z "$HERKUNFT" ] && [ -s "$MERKDATEI" ]; then
    IFS=: read -r M_U M_G M_Q < "$MERKDATEI"
    if ist_zahl "$M_U" && ist_zahl "$M_G" && [ "$M_U" != "0" ]; then PUID="$M_U"; PGID="$M_G"; HERKUNFT="gemerkt"; fi
fi
if [ -z "$HERKUNFT" ]; then
    for d in "$CACHE_DIR" "${PFAD_FILME:-/filme}" "${PFAD_SERIEN:-/serien}"; do
        [ -d "$d" ] || continue
        B_U="$(stat -c %u "$d" 2>/dev/null)"; B_G="$(stat -c %g "$d" 2>/dev/null)"
        if ist_zahl "$B_U" && [ "$B_U" != "0" ]; then PUID="$B_U"; PGID="${B_G:-100}"; HERKUNFT="erkannt:$d"; break; fi
    done
    [ -z "$HERKUNFT" ] && { PUID=99; PGID=100; HERKUNFT="standard"; }
    [ -w "$CACHE_DIR" ] && printf '%s:%s:%s\n' "$PUID" "$PGID" "${HERKUNFT#erkannt:}" > "$MERKDATEI" 2>/dev/null
fi
[ -n "$PGID" ] || PGID=100
export PUID PGID
echo "Bluewave: UID $PUID / GID $PGID (Quelle: $HERKUNFT)"

if [ "$(id -u www-data)" != "$PUID" ] || [ "$(id -g www-data)" != "$PGID" ]; then
    if getent group "$PGID" >/dev/null 2>&1; then
        usermod -o -u "$PUID" -g "$PGID" www-data
    else
        groupmod -o -g "$PGID" www-data && usermod -o -u "$PUID" www-data
    fi
fi
WEB_GRUPPE="$(id -gn www-data)"
# Apache nimmt seine Gruppe aus envvars – ans Ende hängen, was zuletzt gesetzt wird, gewinnt
if [ -f /etc/apache2/envvars ] && ! grep -q "^export APACHE_RUN_GROUP=$WEB_GRUPPE\$" /etc/apache2/envvars; then
    printf '\n# von Bluewave gesetzt\nexport APACHE_RUN_USER=www-data\nexport APACHE_RUN_GROUP=%s\n' "$WEB_GRUPPE" >> /etc/apache2/envvars
fi

# ---- Grafik (QuickSync): Gruppe der Render-Geräte erkennen und www-data hinzufügen – kein group_add in der Vorlage nötig ----
for geraet in /dev/dri/renderD* /dev/dri/card*; do
    [ -e "$geraet" ] || continue
    G_ID="$(stat -c %g "$geraet" 2>/dev/null)"
    ist_zahl "$G_ID" || continue
    [ "$G_ID" = "0" ] && { echo "Grafik: $geraet gehört Gruppe root – Zugriff nur, wenn das Gerät für alle freigegeben ist"; continue; }
    G_NAME="$(getent group "$G_ID" | cut -d: -f1)"
    if [ -z "$G_NAME" ]; then
        G_NAME="bwgpu$G_ID"; groupadd -o -g "$G_ID" "$G_NAME" 2>/dev/null
    fi
    id -nG www-data | tr ' ' '\n' | grep -qx "$G_NAME" || usermod -aG "$G_NAME" www-data
done
ls /dev/dri/renderD* >/dev/null 2>&1 && echo "Grafik: $(ls /dev/dri/renderD* | tr '\n' ' ')gefunden" || echo "Grafik: kein /dev/dri – Transkodierung per Software"

# ---- Eigene Ordner ----
mkdir -p "$CACHE_DIR/bilder" "$CACHE_DIR/tmp" "$CACHE_DIR/geheimnisse" "$BACKUP_DIR" "$TRANS_DIR"
chmod 700 "$CACHE_DIR/geheimnisse"
rm -rf "$TRANS_DIR"/sitzung-* 2>/dev/null   # Reste abgebrochener Transkodierungen
find "$TRANS_DIR/teile" \( -name '*.part' -o -name '*.tmp' \) -delete 2>/dev/null   # halbe Teile (der Zwischenspeicher selbst bleibt)
for d in "$CACHE_DIR" "$BACKUP_DIR" "$TRANS_DIR" /var/www/html; do
    [ -d "$d" ] && find "$d" -not -path /var/www/html/scripts -not -path '/var/www/html/scripts/*.sh' \
        \( ! -user www-data -o ! -group "$WEB_GRUPPE" \) -exec chown www-data:"$WEB_GRUPPE" {} + 2>/dev/null
done
# Shell-Skripte laufen als root – sie dürfen dem Webserver-Benutzer nicht gehören
chown root:root /var/www/html/scripts /var/www/html/scripts/*.sh 2>/dev/null
chmod go-w /var/www/html/scripts /var/www/html/scripts/*.sh 2>/dev/null

# ---- Datenbank ----
if [ "${BLUEWAVE_AIO:-0}" = "1" ]; then
    . /var/www/html/scripts/aio.sh
    aio_datenbank_starten || echo "AIO: Die eingebaute Datenbank startet nicht – Details stehen oben im Log."
else
    runuser -u www-data -- php /var/www/html/scripts/db_einrichten.php
fi
runuser -u www-data -- php /var/www/html/scripts/migrate.php --start || true

# ---- Hardware erkennen (Ergebnis landet in <Cache>/hardware.json, die App zeigt es an) ----
runuser -u www-data -- php /var/www/html/scripts/hardware.php --start || true

# ---- Zeitplan: jede Minute Streams aufräumen und Ordner auf Neues prüfen (Intervall in der App einstellbar) ----
(while true; do sleep 60; [ "$(stat -c %s /tmp/zeitplan.log 2>/dev/null || echo 0)" -gt 2000000 ] && : > /tmp/zeitplan.log
    runuser -u www-data -- php /var/www/html/scripts/zeitplan.php >> /tmp/zeitplan.log 2>&1; done) &

if [ "${BLUEWAVE_AIO:-0}" = "1" ]; then
    aio_waechter &
    AIO_WACHE=$!
    apache2-foreground &
    AIO_WEB=$!
    trap 'aio_beenden' TERM INT
    wait "$AIO_WEB"
    aio_beenden
fi
exec apache2-foreground
