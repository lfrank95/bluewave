#!/usr/bin/env bash
# Stack-Test: Compose-Stack (App + MariaDB) und All-in-One-Image starten und prüfen, ob alles zusammenspielt.
#   bash tests/stack_test.sh <app-image> [<aio-image>]
set -euo pipefail
APP_IMAGE="${1:?App-Image fehlt}"
AIO_IMAGE="${2:-}"
cd "$(dirname "$0")/.."

ARBEIT="$(mktemp -d)"
mkdir -p "$ARBEIT/filme/Testfilm (2024)" "$ARBEIT/serien" "$ARBEIT/appdata"
trap 'docker compose -p bwtest -f docker-compose.yml -f tests/compose.test.yml down -v >/dev/null 2>&1 || true; docker rm -f bwtest_aio >/dev/null 2>&1 || true; sudo rm -rf "$ARBEIT"' EXIT

cat > .env <<ENV
FILME_PFAD=$ARBEIT/filme
SERIEN_PFAD=$ARBEIT/serien
APPDATA_PFAD=$ARBEIT/appdata
APP_PORT=19960
BLUEWAVE_IMAGE=$APP_IMAGE
STACK_NAME=bwtest
ENV

warte_auf_ping() {
    local port="$1"
    for i in $(seq 1 90); do
        if curl -fsS "http://127.0.0.1:$port/api/v1/ping" 2>/dev/null | grep -q bluewave; then return 0; fi
        sleep 2
    done
    return 1
}

pruefe_system() {
    local port="$1"
    local json
    json="$(curl -fsS "http://127.0.0.1:$port/api/v1/system")"
    echo "$json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
db = d["datenbank"]
assert db["ok"], "Datenbank nicht verbunden: %s" % db.get("fehler")
assert db["schema"] >= 1, "Schema fehlt"
hw = d["hardware"]
assert hw and hw["ffmpeg"]["ok"], "ffmpeg fehlt"
assert hw["ffmpeg"]["jellyfin"], "nicht jellyfin-ffmpeg"
assert hw["aktiv"] == "software", "ohne GPU muss Software laufen"
print("  Datenbank:", db["version"], "Schema", db["schema"], "| ffmpeg", hw["ffmpeg"]["version"], "| Profil", hw["aktiv"])
'
}

echo "== Compose-Stack =="
docker compose -p bwtest -f docker-compose.yml -f tests/compose.test.yml up -d
if ! warte_auf_ping 19960; then docker logs bwtest_app; exit 1; fi
sleep 3
docker logs bwtest_app 2>&1 | tail -n 20
pruefe_system 19960

echo "== Tunnel/Proxy darf nicht an die Verwaltung =="
code="$(curl -s -o /dev/null -w '%{http_code}' -H 'CF-Connecting-IP: 203.0.113.9' http://127.0.0.1:19960/api/v1/system)"
[ "$code" = "403" ] || { echo "erwartet 403, bekommen $code"; exit 1; }

echo "== Transkodiertest (Software) =="
curl -fsS -X POST -H 'X-Bluewave: 1' --max-time 240 http://127.0.0.1:19960/api/v1/system/hardware/test | python3 -c '
import json, sys
t = json.load(sys.stdin)["test"]
for l in t["laeufe"]:
    assert l["ok"], l
    print("  ", l["name"], l["echtzeit"], "x Echtzeit")
'

echo "== Neustart: Zugang bleibt, Root ist abgesichert =="
test -s "$ARBEIT/appdata/cache/geheimnisse/db_root_passwort" || sudo test -s "$ARBEIT/appdata/cache/geheimnisse/db_root_passwort"
docker compose -p bwtest -f docker-compose.yml -f tests/compose.test.yml restart app
warte_auf_ping 19960 || { docker logs bwtest_app; exit 1; }
sleep 3
pruefe_system 19960
docker compose -p bwtest -f docker-compose.yml -f tests/compose.test.yml down -v

if [ -n "$AIO_IMAGE" ]; then
    echo "== All-in-One =="
    mkdir -p "$ARBEIT/aio"
    docker run -d --name bwtest_aio -p 19961:80 -e PUID=1000 -e PGID=1000 \
        -v "$ARBEIT/filme:/filme:ro" -v "$ARBEIT/serien:/serien:ro" -v "$ARBEIT/aio:/appdata" "$AIO_IMAGE"
    warte_auf_ping 19961 || { docker logs bwtest_aio; exit 1; }
    sleep 3
    docker logs bwtest_aio 2>&1 | tail -n 15
    pruefe_system 19961
    docker restart -t 60 bwtest_aio
    warte_auf_ping 19961 || { docker logs bwtest_aio; exit 1; }
    sleep 3
    pruefe_system 19961
fi
rm -f .env
echo "Alles in Ordnung."
