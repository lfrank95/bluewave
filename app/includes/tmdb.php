<?php
// TMDB: Metadaten für Filme, Reihen (Collections), Serien, Staffeln, Folgen und Episodenreihenfolgen (Episode Groups).
// Texte auf Deutsch (Einstellung metadaten_sprache), fehlt ein Text, wird Englisch genommen. Bilder landen im Cache.
// Adresse über TMDB_URL / TMDB_BILD_URL änderbar (Tests nutzen einen Ersatz-Server).
declare(strict_types=1);
require_once __DIR__ . '/scanner.php';

function tmdb_url(): string
{
    return rtrim((string) (getenv('TMDB_URL') ?: 'https://api.themoviedb.org/3'), '/');
}

function tmdb_bild_url(): string
{
    return rtrim((string) (getenv('TMDB_BILD_URL') ?: 'https://image.tmdb.org/t/p'), '/');
}

function tmdb_bereit(): bool
{
    return server_einstellungen()['tmdb_schluessel'] !== '';
}

/** GET an TMDB (v3-Schlüssel oder v4-Lesetoken). Wiederholt bei 429/5xx. */
function tmdb_get(string $pfad, array $param = []): ?array
{
    $schluessel = server_einstellungen()['tmdb_schluessel'];
    if ($schluessel === '') {
        throw new RuntimeException('Kein TMDB-Schlüssel eingetragen (Verwaltung › Einstellungen).');
    }
    $kopf = ['Accept: application/json', 'User-Agent: Bluewave/' . konfig()['version']];
    if (strlen($schluessel) > 40) {
        $kopf[] = 'Authorization: Bearer ' . $schluessel;
    } else {
        $param['api_key'] = $schluessel;
    }
    $url = tmdb_url() . '/' . ltrim($pfad, '/') . '?' . http_build_query($param);
    for ($versuch = 0; $versuch < 4; $versuch++) {
        $c = curl_init($url);
        curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_HTTPHEADER => $kopf]);
        $body = curl_exec($c);
        $code = (int) curl_getinfo($c, CURLINFO_RESPONSE_CODE);
        $fehler = curl_error($c);
        curl_close($c);
        if ($code === 200) {
            $j = json_decode((string) $body, true);
            return is_array($j) ? $j : null;
        }
        if ($code === 404) {
            return null;
        }
        if ($code === 401) {
            throw new RuntimeException('TMDB lehnt den Schlüssel ab (401) – bitte in den Einstellungen prüfen.');
        }
        if ($code === 429 || $code >= 500 || $code === 0) {
            usleep((int) (500000 * ($versuch + 1)));
            continue;
        }
        throw new RuntimeException("TMDB antwortet mit $code" . ($fehler ? " ($fehler)" : ''));
    }
    throw new RuntimeException('TMDB nicht erreichbar.');
}

function tmdb_sprache(): string
{
    return server_einstellungen()['metadaten_sprache'];
}

/** Bild herunterladen und relativen Cache-Pfad liefern (vorhandene Dateien werden nicht erneut geladen) */
function tmdb_bild(?string $tmdbPfad, string $groesse, string $art): ?string
{
    if (!$tmdbPfad || !preg_match('#^/[A-Za-z0-9_.-]+\.(jpg|jpeg|png|svg|webp)$#i', $tmdbPfad)) {
        return null;
    }
    $rel = $art . '/' . $groesse . '/' . ltrim($tmdbPfad, '/');
    $ziel = konfig()['pfade']['cache'] . '/bilder/' . $rel;
    if (is_file($ziel) && filesize($ziel) > 0) {
        return $rel;
    }
    @mkdir(dirname($ziel), 0775, true);
    $c = curl_init(tmdb_bild_url() . '/' . $groesse . $tmdbPfad);
    $tmp = $ziel . '.' . bin2hex(random_bytes(3)) . '.tmp';
    $fh = fopen($tmp, 'wb');
    curl_setopt_array($c, [CURLOPT_FILE => $fh, CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_FOLLOWLOCATION => true]);
    $ok = curl_exec($c) && (int) curl_getinfo($c, CURLINFO_RESPONSE_CODE) === 200;
    curl_close($c);
    fclose($fh);
    if (!$ok || filesize($tmp) === 0) {
        @unlink($tmp);
        return null;
    }
    rename($tmp, $ziel);
    return $rel;
}

/** Bestes Bild aus einer Bilderliste: bevorzugte Sprache, dann Englisch, dann ohne Text, sonst Ersatz */
function tmdb_bild_waehlen(array $liste, array $sprachen, ?string $ersatz): ?string
{
    foreach ($sprachen as $s) {
        $kand = array_values(array_filter($liste, static fn($b) => ($b['iso_639_1'] ?? null) === $s));
        if ($kand) {
            usort($kand, static fn($a, $b) => ($b['vote_average'] ?? 0) <=> ($a['vote_average'] ?? 0));
            return $kand[0]['file_path'];
        }
    }
    return $ersatz;
}

function genres_merken(string $tabelle, string $spalte, int $id, array $genres): void
{
    db_tun("DELETE FROM $tabelle WHERE $spalte = :id", ['id' => $id]);
    foreach ($genres as $g) {
        if (empty($g['id']) || empty($g['name'])) {
            continue;
        }
        db_tun('INSERT INTO genres (tmdb_id, name) VALUES (:t, :n) ON DUPLICATE KEY UPDATE name = VALUES(name)', ['t' => $g['id'], 'n' => $g['name']]);
        $gid = db_wert('SELECT id FROM genres WHERE tmdb_id = :t', ['t' => $g['id']]);
        db_tun("INSERT IGNORE INTO $tabelle ($spalte, genre_id) VALUES (:id, :g)", ['id' => $id, 'g' => $gid]);
    }
}

/** TMDB-Stichwörter (für Universums-Vorschläge) als JSON-Liste kleingeschriebener Namen */
function stichwoerter_json(array $liste): ?string
{
    $w = array_values(array_unique(array_filter(array_map(static fn($k) => mb_strtolower(trim((string) ($k['name'] ?? ''))), $liste))));
    return $w ? json_encode($w, JSON_UNESCAPED_UNICODE) : null;
}

function besetzung_aus(array $credits, int $max = 20): array
{
    $aus = [];
    foreach (array_slice($credits['cast'] ?? [], 0, $max) as $p) {
        $aus[] = ['name' => $p['name'] ?? '', 'rolle' => $p['character'] ?? '', 'bild' => tmdb_bild($p['profile_path'] ?? null, 'w185', 'personen')];
    }
    return $aus;
}

// ---------- Filme ----------

function tmdb_film_suchen(string $titel, ?int $jahr): array
{
    $param = ['query' => $titel, 'language' => tmdb_sprache(), 'include_adult' => 'false'];
    if ($jahr) {
        $param['year'] = $jahr;
    }
    $r = tmdb_get('search/movie', $param)['results'] ?? [];
    if (!$r && $jahr) { // Jahr weicht manchmal um eins ab
        unset($param['year']);
        $r = tmdb_get('search/movie', $param)['results'] ?? [];
        if ($jahr) {
            $r = array_values(array_filter($r, static fn($x) => abs((int) substr((string) ($x['release_date'] ?? ''), 0, 4) - $jahr) <= 1)) ?: $r;
        }
    }
    return $r;
}

/** Film mit TMDB verknüpfen und alle Angaben übernehmen. Liefert die (evtl. zusammengeführte) Film-ID. */
function tmdb_film_uebernehmen(int $filmId, int $tmdbId, bool $manuell = false): int
{
    $spr = tmdb_sprache();
    $kurz = substr($spr, 0, 2);
    $d = tmdb_get("movie/$tmdbId", ['language' => $spr, 'append_to_response' => 'credits,images,release_dates,keywords', 'include_image_language' => "$kurz,en,null"]);
    if (!$d) {
        throw new RuntimeException("TMDB kennt den Film $tmdbId nicht.");
    }
    // Gibt es den Film schon (z. B. 4K-Ordner und 1080p-Ordner)? Dann zusammenführen.
    $anderer = db_wert('SELECT id FROM filme WHERE tmdb_id = :t AND id <> :id', ['t' => $tmdbId, 'id' => $filmId]);
    if ($anderer) {
        filme_zusammenfuehren($filmId, (int) $anderer);
        $filmId = (int) $anderer;
    }
    $beschreibung = trim((string) ($d['overview'] ?? ''));
    $tagline = trim((string) ($d['tagline'] ?? ''));
    if ($beschreibung === '' && $kurz !== 'en') {
        $en = tmdb_get("movie/$tmdbId", ['language' => 'en-US']);
        $beschreibung = trim((string) ($en['overview'] ?? ''));
        $tagline = $tagline ?: trim((string) ($en['tagline'] ?? ''));
    }
    $bilder = $d['images'] ?? [];
    $poster = tmdb_bild(tmdb_bild_waehlen($bilder['posters'] ?? [], [$kurz], $d['poster_path'] ?? null), 'w500', 'poster');
    $hintergrund = tmdb_bild(tmdb_bild_waehlen($bilder['backdrops'] ?? [], [null], $d['backdrop_path'] ?? null), 'w1280', 'hintergrund');
    $logo = tmdb_bild(tmdb_bild_waehlen($bilder['logos'] ?? [], [$kurz, 'en', null], null), 'w500', 'logo');
    $regie = implode(', ', array_column(array_filter($d['credits']['crew'] ?? [], static fn($c) => ($c['job'] ?? '') === 'Director'), 'name'));
    $freigabe = null;
    foreach ($d['release_dates']['results'] ?? [] as $land) {
        if (($land['iso_3166_1'] ?? '') === strtoupper(substr($spr, 3, 2))) {
            foreach ($land['release_dates'] ?? [] as $rd) {
                if (($rd['certification'] ?? '') !== '') {
                    $freigabe = (string) $rd['certification'];
                    break 2;
                }
            }
        }
    }
    $reiheId = null;
    if (!empty($d['belongs_to_collection']['id'])) {
        $reiheId = tmdb_reihe_uebernehmen((int) $d['belongs_to_collection']['id']);
    }
    $titel = trim((string) ($d['title'] ?? '')) ?: (string) db_wert('SELECT titel FROM filme WHERE id = :id', ['id' => $filmId]);
    db_tun('UPDATE filme SET tmdb_id = :t, imdb_id = :im, titel = :ti, originaltitel = :ot, sortiertitel = :st, jahr = :j, erscheinungsdatum = :ed,
        laufzeit_min = :lz, tagline = :tg, beschreibung = :b, poster = COALESCE(:p, poster), hintergrund = COALESCE(:h, hintergrund), logo = COALESCE(:l, logo),
        reihe_id = :r, besetzung = :bs, regie = :rg, freigabe = :fr, bewertung = :bw, stichwoerter = :sw, metadaten_am = NOW(), metadaten_status = :ms WHERE id = :id', [
        't' => $tmdbId, 'im' => $d['imdb_id'] ?? null, 'ti' => $titel, 'ot' => $d['original_title'] ?? null, 'st' => sortiertitel($titel),
        'j' => !empty($d['release_date']) ? (int) substr($d['release_date'], 0, 4) : null, 'ed' => !empty($d['release_date']) ? $d['release_date'] : null,
        'lz' => !empty($d['runtime']) ? (int) $d['runtime'] : null, 'tg' => $tagline ?: null, 'b' => $beschreibung ?: null,
        'p' => $poster, 'h' => $hintergrund, 'l' => $logo, 'r' => $reiheId, 'bs' => json_encode(besetzung_aus($d['credits'] ?? []), JSON_UNESCAPED_UNICODE),
        'rg' => $regie ?: null, 'fr' => $freigabe, 'bw' => isset($d['vote_average']) ? round((float) $d['vote_average'], 1) : null,
        'ms' => $manuell ? 'manuell' : 'gefunden', 'id' => $filmId, 'sw' => stichwoerter_json($d['keywords']['keywords'] ?? []),
    ]);
    genres_merken('film_genres', 'film_id', $filmId, $d['genres'] ?? []);
    if ($reiheId) {
        reihe_positionen($reiheId);
    }
    require_once __DIR__ . '/bearbeiten.php';
    eigenes_anwenden('film', $filmId); // von Hand gesetzte Felder und Bilder gewinnen
    return $filmId;
}

/** Film $von in Film $nach aufgehen lassen: Fassungen (gleiche Art zusammen), Universen, Fortschritt */
function filme_zusammenfuehren(int $von, int $nach): void
{
    foreach (db_alle('SELECT * FROM fassungen WHERE film_id = :f', ['f' => $von]) as $fa) {
        $ziel = db_wert('SELECT id FROM fassungen WHERE film_id = :f AND art = :a AND (art <> \'sonstige\' OR name = :n) LIMIT 1', ['f' => $nach, 'a' => $fa['art'], 'n' => $fa['name']]);
        if ($ziel) {
            db_tun('UPDATE dateien SET fassung_id = :z WHERE fassung_id = :a', ['z' => $ziel, 'a' => $fa['id']]);
            db_tun('DELETE FROM fassungen WHERE id = :id', ['id' => $fa['id']]);
        } else {
            db_tun('UPDATE fassungen SET film_id = :n, standard = 0 WHERE id = :id', ['n' => $nach, 'id' => $fa['id']]);
        }
    }
    db_tun('UPDATE IGNORE universum_eintraege SET film_id = :n WHERE film_id = :v', ['n' => $nach, 'v' => $von]);
    db_tun("UPDATE IGNORE wiedergabe SET ziel_id = :n WHERE art = 'film' AND ziel_id = :v", ['n' => $nach, 'v' => $von]);
    db_tun('DELETE FROM filme WHERE id = :v', ['v' => $von]);
}

function tmdb_reihe_uebernehmen(int $tmdbId): ?int
{
    $vorhanden = db_zeile('SELECT id, geaendert_am, beschreibung FROM reihen WHERE tmdb_id = :t', ['t' => $tmdbId]);
    // höchstens einmal pro Tag neu holen
    if ($vorhanden && strtotime((string) $vorhanden['geaendert_am']) > time() - 86400 && $vorhanden['beschreibung'] !== null) {
        return (int) $vorhanden['id'];
    }
    $spr = tmdb_sprache();
    $d = tmdb_get("collection/$tmdbId", ['language' => $spr]);
    if (!$d) {
        return $vorhanden ? (int) $vorhanden['id'] : null;
    }
    $name = trim((string) ($d['name'] ?? ''));
    $beschreibung = trim((string) ($d['overview'] ?? ''));
    if ($beschreibung === '' && substr($spr, 0, 2) !== 'en') {
        $beschreibung = trim((string) (tmdb_get("collection/$tmdbId", ['language' => 'en-US'])['overview'] ?? ''));
    }
    $poster = tmdb_bild($d['poster_path'] ?? null, 'w500', 'poster');
    $hg = tmdb_bild($d['backdrop_path'] ?? null, 'w1280', 'hintergrund');
    // Reihenfolge der Teile (Erscheinungsdatum) merken – für die Positionen der Filme
    $teile = [];
    foreach ($d['parts'] ?? [] as $p) {
        $teile[(int) $p['id']] = (string) ($p['release_date'] ?? '9999');
    }
    asort($teile);
    if ($vorhanden) {
        db_tun('UPDATE reihen SET name = :n, sortname = :s, beschreibung = :b, poster = COALESCE(:p, poster), hintergrund = COALESCE(:h, hintergrund), geaendert_am = NOW() WHERE id = :id',
            ['n' => $name, 's' => sortiertitel($name), 'b' => $beschreibung ?: null, 'p' => $poster, 'h' => $hg, 'id' => $vorhanden['id']]);
        $id = (int) $vorhanden['id'];
    } else {
        $id = db_einfuegen('INSERT INTO reihen (tmdb_id, name, sortname, beschreibung, poster, hintergrund) VALUES (:t, :n, :s, :b, :p, :h)',
            ['t' => $tmdbId, 'n' => $name, 's' => sortiertitel($name), 'b' => $beschreibung ?: null, 'p' => $poster, 'h' => $hg]);
    }
    system_wert_setzen('reihe_teile_' . $id, (string) json_encode(array_keys($teile)));
    return $id;
}

function reihe_positionen(int $reiheId): void
{
    $teile = json_decode((string) system_wert('reihe_teile_' . $reiheId), true) ?: [];
    $pos = array_flip(array_map('intval', $teile));
    foreach (db_alle('SELECT id, tmdb_id, erscheinungsdatum FROM filme WHERE reihe_id = :r', ['r' => $reiheId]) as $f) {
        $p = isset($pos[(int) $f['tmdb_id']]) ? $pos[(int) $f['tmdb_id']] + 1 : null;
        db_tun('UPDATE filme SET reihe_position = :p WHERE id = :id', ['p' => $p, 'id' => $f['id']]);
    }
}

// ---------- Serien ----------

function tmdb_serie_suchen(string $titel, ?int $jahr): array
{
    $param = ['query' => $titel, 'language' => tmdb_sprache()];
    if ($jahr) {
        $param['first_air_date_year'] = $jahr;
    }
    $r = tmdb_get('search/tv', $param)['results'] ?? [];
    if (!$r && $jahr) {
        unset($param['first_air_date_year']);
        $r = tmdb_get('search/tv', $param)['results'] ?? [];
    }
    return $r;
}

const REIHENFOLGE_ARTEN = [1 => 'ausstrahlung', 2 => 'absolut', 3 => 'dvd', 4 => 'streaming', 5 => 'sonstige', 6 => 'sonstige', 7 => 'sonstige'];

function tmdb_serie_uebernehmen(int $serieId, int $tmdbId, bool $manuell = false): int
{
    $spr = tmdb_sprache();
    $kurz = substr($spr, 0, 2);
    $d = tmdb_get("tv/$tmdbId", ['language' => $spr, 'append_to_response' => 'aggregate_credits,images,external_ids,episode_groups,content_ratings,keywords',
        'include_image_language' => "$kurz,en,null"]);
    if (!$d) {
        throw new RuntimeException("TMDB kennt die Serie $tmdbId nicht.");
    }
    $anderer = db_wert('SELECT id FROM serien WHERE tmdb_id = :t AND id <> :id', ['t' => $tmdbId, 'id' => $serieId]);
    if ($anderer) {
        // zwei Ordner derselben Serie: Folgen und Dateien zusammenlegen
        foreach (db_alle('SELECT id, staffel_nr, folge_nr FROM folgen WHERE serie_id = :s', ['s' => $serieId]) as $f) {
            $ziel = db_wert('SELECT id FROM folgen WHERE serie_id = :s AND staffel_nr = :st AND folge_nr = :f', ['s' => $anderer, 'st' => $f['staffel_nr'], 'f' => $f['folge_nr']]);
            if ($ziel) {
                db_tun('UPDATE dateien SET folge_id = :z WHERE folge_id = :a', ['z' => $ziel, 'a' => $f['id']]);
                db_tun('DELETE FROM folgen WHERE id = :id', ['id' => $f['id']]);
            } else {
                db_tun('UPDATE folgen SET serie_id = :s WHERE id = :id', ['s' => $anderer, 'id' => $f['id']]);
            }
        }
        db_tun('DELETE FROM serien WHERE id = :id', ['id' => $serieId]);
        $serieId = (int) $anderer;
    }
    $beschreibung = trim((string) ($d['overview'] ?? ''));
    if ($beschreibung === '' && $kurz !== 'en') {
        $beschreibung = trim((string) (tmdb_get("tv/$tmdbId", ['language' => 'en-US'])['overview'] ?? ''));
    }
    $bilder = $d['images'] ?? [];
    $poster = tmdb_bild(tmdb_bild_waehlen($bilder['posters'] ?? [], [$kurz], $d['poster_path'] ?? null), 'w500', 'poster');
    $hg = tmdb_bild(tmdb_bild_waehlen($bilder['backdrops'] ?? [], [null], $d['backdrop_path'] ?? null), 'w1280', 'hintergrund');
    $logo = tmdb_bild(tmdb_bild_waehlen($bilder['logos'] ?? [], [$kurz, 'en', null], null), 'w500', 'logo');
    $status = match ((string) ($d['status'] ?? '')) {
        'Returning Series', 'In Production' => 'laufend', 'Ended' => 'beendet', 'Canceled' => 'abgesetzt', 'Planned' => 'geplant', default => 'unbekannt',
    };
    $freigabe = null;
    foreach ($d['content_ratings']['results'] ?? [] as $cr) {
        if (($cr['iso_3166_1'] ?? '') === strtoupper(substr($spr, 3, 2)) && ($cr['rating'] ?? '') !== '') {
            $freigabe = (string) $cr['rating'];
        }
    }
    $besetzung = [];
    foreach (array_slice($d['aggregate_credits']['cast'] ?? [], 0, 20) as $p) {
        $besetzung[] = ['name' => $p['name'] ?? '', 'rolle' => $p['roles'][0]['character'] ?? '', 'bild' => tmdb_bild($p['profile_path'] ?? null, 'w185', 'personen')];
    }
    $titel = trim((string) ($d['name'] ?? '')) ?: (string) db_wert('SELECT titel FROM serien WHERE id = :id', ['id' => $serieId]);
    db_tun('UPDATE serien SET tmdb_id = :t, tvdb_id = COALESCE(:tv, tvdb_id), imdb_id = :im, titel = :ti, originaltitel = :ot, sortiertitel = :st,
        jahr_von = :jv, jahr_bis = :jb, status = :ss, beschreibung = :b, poster = COALESCE(:p, poster), hintergrund = COALESCE(:h, hintergrund),
        logo = COALESCE(:l, logo), besetzung = :bs, sender = :se, freigabe = :fr, bewertung = :bw, stichwoerter = :sw, metadaten_am = NOW(), metadaten_status = :ms WHERE id = :id', [
        't' => $tmdbId, 'tv' => $d['external_ids']['tvdb_id'] ?? null, 'im' => $d['external_ids']['imdb_id'] ?? null, 'ti' => $titel,
        'ot' => $d['original_name'] ?? null, 'st' => sortiertitel($titel),
        'jv' => !empty($d['first_air_date']) ? (int) substr($d['first_air_date'], 0, 4) : null,
        'jb' => $status !== 'laufend' && !empty($d['last_air_date']) ? (int) substr($d['last_air_date'], 0, 4) : null,
        'ss' => $status, 'b' => $beschreibung ?: null, 'p' => $poster, 'h' => $hg, 'l' => $logo,
        'bs' => json_encode($besetzung, JSON_UNESCAPED_UNICODE), 'se' => isset($d['networks'][0]['name']) ? $d['networks'][0]['name'] : null,
        'fr' => $freigabe, 'bw' => isset($d['vote_average']) ? round((float) $d['vote_average'], 1) : null, 'ms' => $manuell ? 'manuell' : 'gefunden', 'id' => $serieId,
        'sw' => stichwoerter_json($d['keywords']['results'] ?? []),
    ]);
    genres_merken('serie_genres', 'serie_id', $serieId, $d['genres'] ?? []);

    // Staffeln und Folgen (Ausstrahlungsreihenfolge)
    foreach ($d['seasons'] ?? [] as $st) {
        $nr = (int) ($st['season_number'] ?? -1);
        if ($nr < 0) {
            continue;
        }
        $s = tmdb_get("tv/$tmdbId/season/$nr", ['language' => $spr]);
        if (!$s) {
            continue;
        }
        $sPoster = tmdb_bild($s['poster_path'] ?? $st['poster_path'] ?? null, 'w342', 'poster');
        db_tun('INSERT INTO serien_staffeln (serie_id, nummer, name, beschreibung, poster) VALUES (:s, :n, :na, :b, :p)
            ON DUPLICATE KEY UPDATE name = VALUES(name), beschreibung = VALUES(beschreibung), poster = COALESCE(VALUES(poster), poster)',
            ['s' => $serieId, 'n' => $nr, 'na' => $s['name'] ?? null, 'b' => trim((string) ($s['overview'] ?? '')) ?: null, 'p' => $sPoster]);
        foreach ($s['episodes'] ?? [] as $e) {
            $enr = (int) ($e['episode_number'] ?? 0);
            if ($enr <= 0) {
                continue;
            }
            $still = tmdb_bild($e['still_path'] ?? null, 'w300', 'standbild');
            $vorhanden = db_wert('SELECT id FROM folgen WHERE serie_id = :s AND staffel_nr = :st AND folge_nr = :f', ['s' => $serieId, 'st' => $nr, 'f' => $enr]);
            $werte = ['tm' => $e['id'] ?? null, 'ti' => trim((string) ($e['name'] ?? '')) ?: null, 'b' => trim((string) ($e['overview'] ?? '')) ?: null,
                'ea' => !empty($e['air_date']) ? $e['air_date'] : null, 'lz' => !empty($e['runtime']) ? (int) $e['runtime'] : null, 'sb' => $still];
            // gleiche TMDB-ID schon bei einer anderen Folge? (Umnummerierung bei TMDB) – dort lösen
            if ($werte['tm']) {
                db_tun('UPDATE folgen SET tmdb_id = NULL WHERE tmdb_id = :t AND NOT (serie_id = :s AND staffel_nr = :st AND folge_nr = :f)',
                    ['t' => $werte['tm'], 's' => $serieId, 'st' => $nr, 'f' => $enr]);
            }
            if ($vorhanden) {
                db_tun('UPDATE folgen SET tmdb_id = :tm, titel = :ti, beschreibung = :b, erstausstrahlung = :ea, laufzeit_min = :lz, standbild = COALESCE(:sb, standbild) WHERE id = :id',
                    $werte + ['id' => $vorhanden]);
            } else {
                db_tun('INSERT INTO folgen (serie_id, staffel_nr, folge_nr, tmdb_id, titel, beschreibung, erstausstrahlung, laufzeit_min, standbild)
                    VALUES (:s, :st, :f, :tm, :ti, :b, :ea, :lz, :sb)', $werte + ['s' => $serieId, 'st' => $nr, 'f' => $enr]);
            }
        }
    }

    // Andere Reihenfolgen (Episode Groups): DVD, Streaming-Schnitt, absolut …
    $gruppen = $d['episode_groups']['results'] ?? [];
    $behalten = [];
    foreach ($gruppen as $g) {
        if (empty($g['id'])) {
            continue;
        }
        $gd = tmdb_get('tv/episode_group/' . $g['id'], ['language' => $spr]);
        if (!$gd || empty($gd['groups'])) {
            continue;
        }
        $art = REIHENFOLGE_ARTEN[(int) ($gd['type'] ?? 5)] ?? 'sonstige';
        $rid = db_wert("SELECT id FROM reihenfolgen WHERE serie_id = :s AND quelle = 'tmdb' AND quelle_id = :q", ['s' => $serieId, 'q' => $g['id']]);
        if ($rid) {
            db_tun('UPDATE reihenfolgen SET art = :a, name = :n, beschreibung = :b WHERE id = :id',
                ['a' => $art, 'n' => (string) ($gd['name'] ?? 'Reihenfolge'), 'b' => trim((string) ($gd['description'] ?? '')) ?: null, 'id' => $rid]);
        } else {
            $rid = db_einfuegen("INSERT INTO reihenfolgen (serie_id, art, quelle, quelle_id, name, beschreibung) VALUES (:s, :a, 'tmdb', :q, :n, :b)",
                ['s' => $serieId, 'a' => $art, 'q' => $g['id'], 'n' => (string) ($gd['name'] ?? 'Reihenfolge'), 'b' => trim((string) ($gd['description'] ?? '')) ?: null]);
        }
        $behalten[] = (int) $rid;
        db_tun('DELETE FROM reihenfolge_folgen WHERE reihenfolge_id = :r', ['r' => $rid]);
        db_tun('DELETE FROM staffeln WHERE reihenfolge_id = :r', ['r' => $rid]);
        $gs = $gd['groups'];
        usort($gs, static fn($a, $b) => ($a['order'] ?? 0) <=> ($b['order'] ?? 0));
        $lfd = 0;
        foreach ($gs as $teil) {
            // „Specials“-Gruppen bekommen Nummer 0, alle anderen fortlaufend ab 1
            $nr = preg_match('/special/i', (string) ($teil['name'] ?? '')) ? 0 : ++$lfd;
            $sid = db_einfuegen('INSERT INTO staffeln (reihenfolge_id, nummer, name) VALUES (:r, :n, :na) ON DUPLICATE KEY UPDATE name = VALUES(name), id = LAST_INSERT_ID(id)',
                ['r' => $rid, 'n' => $nr, 'na' => $teil['name'] ?? null]);
            $eps = $teil['episodes'] ?? [];
            usort($eps, static fn($a, $b) => ($a['order'] ?? 0) <=> ($b['order'] ?? 0));
            foreach ($eps as $j => $e) {
                $fid = db_wert('SELECT id FROM folgen WHERE serie_id = :s AND staffel_nr = :st AND folge_nr = :f',
                    ['s' => $serieId, 'st' => (int) ($e['season_number'] ?? -1), 'f' => (int) ($e['episode_number'] ?? -1)]);
                if ($fid) {
                    db_tun('INSERT IGNORE INTO reihenfolge_folgen (reihenfolge_id, folge_id, staffel_id, nummer) VALUES (:r, :f, :s, :n)',
                        ['r' => $rid, 'f' => $fid, 's' => $sid, 'n' => (int) ($e['order'] ?? $j) + 1]);
                }
            }
        }
    }
    // Reihenfolgen, die TMDB nicht mehr kennt, entfernen (gewählte zurück auf Ausstrahlung)
    foreach (db_alle("SELECT id FROM reihenfolgen WHERE serie_id = :s AND quelle = 'tmdb'", ['s' => $serieId]) as $r) {
        if (!in_array((int) $r['id'], $behalten, true)) {
            db_tun('UPDATE serien SET reihenfolge_id = NULL WHERE reihenfolge_id = :r', ['r' => $r['id']]);
            db_tun('DELETE FROM reihenfolgen WHERE id = :r', ['r' => $r['id']]);
        }
    }
    require_once __DIR__ . '/bearbeiten.php';
    eigenes_anwenden('serie', $serieId); // von Hand gesetzte Felder und Bilder gewinnen
    return $serieId;
}

// ---------- Abgleich im Hintergrund ----------

/** Alle offenen (oder mit $alle: alle) Filme und Serien abgleichen */
function metadaten_abgleichen(bool $alle = false): array
{
    if (!tmdb_bereit()) {
        return ['fehler' => 'Kein TMDB-Schlüssel eingetragen.'];
    }
    $stat = ['filme' => 0, 'serien' => 0, 'nicht_gefunden' => 0, 'fehler' => []];
    $filme = db_alle('SELECT id, titel, jahr, tmdb_id FROM filme WHERE ' . ($alle ? '1=1' : "metadaten_status = 'offen'"));
    foreach ($filme as $i => $f) {
        auftrag_stand('Filme abgleichen', $i, count($filme), (string) $f['titel']);
        try {
            $tmdb = (int) $f['tmdb_id'];
            if (!$tmdb) {
                $treffer = tmdb_film_suchen((string) $f['titel'], $f['jahr'] ? (int) $f['jahr'] : null);
                $tmdb = (int) ($treffer[0]['id'] ?? 0);
            }
            if (!$tmdb) {
                db_tun("UPDATE filme SET metadaten_status = 'nicht_gefunden' WHERE id = :id", ['id' => $f['id']]);
                $stat['nicht_gefunden']++;
                continue;
            }
            tmdb_film_uebernehmen((int) $f['id'], $tmdb);
            $stat['filme']++;
        } catch (Throwable $e) {
            $stat['fehler'][] = $f['titel'] . ': ' . $e->getMessage();
            if (str_contains($e->getMessage(), '401')) {
                break;
            }
        }
    }
    $serien = db_alle('SELECT id, titel, jahr_von, tmdb_id FROM serien WHERE ' . ($alle ? '1=1' : "metadaten_status = 'offen'"));
    foreach ($serien as $i => $s) {
        auftrag_stand('Serien abgleichen', $i, count($serien), (string) $s['titel']);
        try {
            $tmdb = (int) $s['tmdb_id'];
            if (!$tmdb) {
                $treffer = tmdb_serie_suchen((string) $s['titel'], $s['jahr_von'] ? (int) $s['jahr_von'] : null);
                $tmdb = (int) ($treffer[0]['id'] ?? 0);
            }
            if (!$tmdb) {
                db_tun("UPDATE serien SET metadaten_status = 'nicht_gefunden' WHERE id = :id", ['id' => $s['id']]);
                $stat['nicht_gefunden']++;
                continue;
            }
            tmdb_serie_uebernehmen((int) $s['id'], $tmdb);
            $stat['serien']++;
        } catch (Throwable $e) {
            $stat['fehler'][] = $s['titel'] . ': ' . $e->getMessage();
        }
    }
    // Neue Folgen bei bekannten Serien (Folgen ohne Titel) nachholen
    if (!$alle) {
        foreach (db_alle("SELECT DISTINCT s.id, s.tmdb_id FROM serien s JOIN folgen f ON f.serie_id = s.id WHERE s.tmdb_id IS NOT NULL AND f.tmdb_id IS NULL AND s.metadaten_status IN ('gefunden','manuell')") as $s) {
            try {
                tmdb_serie_uebernehmen((int) $s['id'], (int) $s['tmdb_id']);
            } catch (Throwable $e) {
                $stat['fehler'][] = $e->getMessage();
            }
        }
    }
    $stat['fehler'] = array_slice($stat['fehler'], 0, 20);
    return $stat;
}
