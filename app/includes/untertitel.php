<?php
// Fehlende Untertitel automatisch von OpenSubtitles holen (REST-API, eigener API-Schlüssel nötig; Anmeldung erhöht das Tageslimit).
// Heruntergeladene Untertitel liegen im Cache (die Medienordner bleiben unangetastet).
declare(strict_types=1);
require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/hilfen.php';

const OS_SPRACHEN = ['deu' => 'de', 'eng' => 'en', 'fra' => 'fr', 'spa' => 'es', 'ita' => 'it', 'nld' => 'nl', 'pol' => 'pl', 'tur' => 'tr'];

function os_url(): string
{
    return rtrim((string) (getenv('OPENSUBTITLES_URL') ?: 'https://api.opensubtitles.com/api/v1'), '/');
}

function os_anfrage(string $methode, string $pfad, ?array $daten = null, ?string $token = null): array
{
    $e = server_einstellungen();
    $kopf = ['Api-Key: ' . $e['opensubtitles_schluessel'], 'User-Agent: Bluewave v' . konfig()['version'], 'Accept: application/json', 'Content-Type: application/json'];
    if ($token) {
        $kopf[] = 'Authorization: Bearer ' . $token;
    }
    $c = curl_init(str_starts_with($pfad, 'http') ? $pfad : os_url() . $pfad);
    curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 25, CURLOPT_HTTPHEADER => $kopf, CURLOPT_CUSTOMREQUEST => $methode]);
    if ($daten !== null) {
        curl_setopt($c, CURLOPT_POSTFIELDS, json_encode($daten));
    }
    $body = (string) curl_exec($c);
    $code = (int) curl_getinfo($c, CURLINFO_RESPONSE_CODE);
    curl_close($c);
    $j = json_decode($body, true);
    if ($code >= 400 || !is_array($j)) {
        throw new RuntimeException('OpenSubtitles: ' . ($j['message'] ?? ('Fehler ' . $code)));
    }
    return $j;
}

function os_token(): ?string
{
    static $token = false;
    if ($token !== false) {
        return $token;
    }
    $e = server_einstellungen();
    $token = null;
    if ($e['opensubtitles_benutzer'] !== '' && $e['opensubtitles_passwort'] !== '') {
        try {
            $token = (string) (os_anfrage('POST', '/login', ['username' => $e['opensubtitles_benutzer'], 'password' => $e['opensubtitles_passwort']])['token'] ?? '') ?: null;
        } catch (Throwable $x) {
            $token = null;
        }
    }
    return $token;
}

/** Untertitel für eine Datei suchen und den besten herunterladen. true = gefunden */
function untertitel_holen(int $dateiId, string $sprache3): bool
{
    $d = db_zeile('SELECT d.id, d.pfad, d.fassung_id, d.folge_id FROM dateien d WHERE d.id = :id', ['id' => $dateiId]);
    if (!$d || !isset(OS_SPRACHEN[$sprache3])) {
        return false;
    }
    $param = ['languages' => OS_SPRACHEN[$sprache3], 'order_by' => 'download_count'];
    if ($d['fassung_id']) {
        $f = db_zeile('SELECT f.tmdb_id, f.imdb_id FROM fassungen fa JOIN filme f ON f.id = fa.film_id WHERE fa.id = :fa', ['fa' => $d['fassung_id']]);
        if (!$f || !$f['tmdb_id']) {
            return false;
        }
        $param['tmdb_id'] = $f['tmdb_id'];
        $param['type'] = 'movie';
    } else {
        $f = db_zeile('SELECT s.tmdb_id, fo.staffel_nr, fo.folge_nr FROM folgen fo JOIN serien s ON s.id = fo.serie_id WHERE fo.id = :f', ['f' => $d['folge_id']]);
        if (!$f || !$f['tmdb_id']) {
            return false;
        }
        $param += ['parent_tmdb_id' => $f['tmdb_id'], 'season_number' => $f['staffel_nr'], 'episode_number' => $f['folge_nr'], 'type' => 'episode'];
    }
    // Dateiname hilft beim Treffer (gleiche Release-Gruppe = passende Zeiten)
    $param['query'] = pathinfo((string) $d['pfad'], PATHINFO_FILENAME);
    $treffer = os_anfrage('GET', '/subtitles?' . http_build_query($param))['data'] ?? [];
    if (!$treffer) {
        unset($param['query']);
        $treffer = os_anfrage('GET', '/subtitles?' . http_build_query($param))['data'] ?? [];
    }
    // ohne erzwungene, ohne maschinell übersetzte; Release-Name möglichst ähnlich
    $basis = strtolower(pathinfo((string) $d['pfad'], PATHINFO_FILENAME));
    $kand = [];
    foreach ($treffer as $t) {
        $a = $t['attributes'] ?? [];
        if (!empty($a['foreign_parts_only']) || !empty($a['machine_translated']) || empty($a['files'][0]['file_id'])) {
            continue;
        }
        similar_text($basis, strtolower((string) ($a['release'] ?? '')), $prozent);
        $kand[] = ['id' => (int) $a['files'][0]['file_id'], 'wert' => $prozent * 10 + min(500, (int) ($a['download_count'] ?? 0) / 100), 'sdh' => !empty($a['hearing_impaired'])];
    }
    if (!$kand) {
        return false;
    }
    usort($kand, static fn($x, $y) => ($y['wert'] - ($y['sdh'] ? 50 : 0)) <=> ($x['wert'] - ($x['sdh'] ? 50 : 0)));
    $dl = os_anfrage('POST', '/download', ['file_id' => $kand[0]['id'], 'sub_format' => 'srt'], os_token());
    if (empty($dl['link'])) {
        return false;
    }
    $c = curl_init($dl['link']);
    curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 25, CURLOPT_FOLLOWLOCATION => true]);
    $srt = (string) curl_exec($c);
    curl_close($c);
    if (strlen($srt) < 50) {
        return false;
    }
    $ziel = konfig()['pfade']['cache'] . '/untertitel/os-' . $dateiId . '-' . $sprache3 . '.srt';
    @mkdir(dirname($ziel), 0775, true);
    bw_schreiben($ziel, $srt);
    db_tun("DELETE FROM untertitel WHERE datei_id = :d AND quelle = 'opensubtitles' AND sprache = :s", ['d' => $dateiId, 's' => $sprache3]);
    db_tun("INSERT INTO untertitel (datei_id, quelle, pfad, format, sprache, titel, hoergeschaedigt) VALUES (:d, 'opensubtitles', :p, 'srt', :s, 'OpenSubtitles', :h)",
        ['d' => $dateiId, 'p' => $ziel, 's' => $sprache3, 'h' => (int) $kand[0]['sdh']]);
    return true;
}

/** Alle Dateien ohne (volle) Untertitel in den gewünschten Sprachen – höchstens $max Downloads je Lauf */
function untertitel_alle_holen(int $max = 20): array
{
    $e = server_einstellungen();
    $stat = ['geholt' => 0, 'nicht_gefunden' => 0, 'fehler' => null];
    if (!$e['untertitel_auto'] || $e['opensubtitles_schluessel'] === '') {
        return $stat + ['aus' => true];
    }
    $sprachen = array_filter(array_map('trim', explode(',', $e['untertitel_sprachen'])));
    foreach ($sprachen as $s) {
        $offen = db_alle("SELECT d.id FROM dateien d WHERE d.fehlt_seit IS NULL AND d.analysiert_am IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM untertitel u WHERE u.datei_id = d.id AND u.sprache = :s AND u.erzwungen = 0)
            AND NOT EXISTS (SELECT 1 FROM tonspuren t WHERE t.datei_id = d.id AND t.sprache = :s2 AND t.strom_index = 0)
            AND NOT EXISTS (SELECT 1 FROM system_werte w WHERE w.schluessel = CONCAT('os_versucht_', d.id, '_', :s3) AND w.geaendert_am > NOW() - INTERVAL 7 DAY)
            ORDER BY d.hinzugefuegt_am DESC LIMIT 200", ['s' => $s, 's2' => $s, 's3' => $s]);
        foreach ($offen as $o) {
            if ($stat['geholt'] >= $max) {
                break 2;
            }
            try {
                untertitel_holen((int) $o['id'], $s) ? $stat['geholt']++ : $stat['nicht_gefunden']++;
            } catch (Throwable $x) {
                $stat['fehler'] = $x->getMessage();
                break 2; // Limit erreicht oder Schlüssel falsch – nächster Lauf versucht es wieder
            }
            db_tun("INSERT INTO system_werte (schluessel, wert) VALUES (:k, '1') ON DUPLICATE KEY UPDATE wert = '1', geaendert_am = NOW()", ['k' => 'os_versucht_' . $o['id'] . '_' . $s]);
        }
    }
    return $stat;
}
