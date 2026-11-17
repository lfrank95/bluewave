<?php
// Metadaten von Hand bearbeiten: jedes geänderte Feld wird gemerkt und „gesperrt“ – TMDB-Abgleiche überschreiben es
// nicht mehr. Zurücksetzen entfernt die Sperre und holt den TMDB-Wert neu.
declare(strict_types=1);
require_once __DIR__ . '/bibliothek.php';
require_once __DIR__ . '/scanner.php';

const BEARB_FELDER = [
    'film' => ['titel' => 'text', 'originaltitel' => 'text', 'sortiertitel' => 'text', 'jahr' => 'jahr', 'erscheinungsdatum' => 'datum',
        'laufzeit_min' => 'zahl', 'tagline' => 'text', 'beschreibung' => 'lang', 'regie' => 'text', 'freigabe' => 'fsk', 'bewertung' => 'note', 'genres' => 'liste'],
    'serie' => ['titel' => 'text', 'originaltitel' => 'text', 'sortiertitel' => 'text', 'jahr_von' => 'jahr', 'jahr_bis' => 'jahr', 'status' => 'status',
        'beschreibung' => 'lang', 'sender' => 'text', 'freigabe' => 'fsk', 'bewertung' => 'note', 'genres' => 'liste'],
];
const BEARB_STATUS = ['laufend', 'beendet', 'abgesetzt', 'geplant', 'unbekannt'];

function bearb_tabelle(string $art): string
{
    return $art === 'film' ? 'filme' : 'serien';
}

/** Aktuelle Werte, gesperrte Felder, Bilder und Genre-Auswahl für den Dialog */
function bearbeiten_daten(string $art, int $id): array
{
    $tab = bearb_tabelle($art);
    $spalten = array_diff(array_keys(BEARB_FELDER[$art]), ['genres']);
    $z = db_zeile('SELECT id, tmdb_id, poster, hintergrund, logo, ' . implode(', ', $spalten) . " FROM $tab WHERE id = :id", ['id' => $id]);
    if (!$z) {
        throw new RuntimeException('Nicht gefunden.', 404);
    }
    $gt = $art === 'film' ? ['film_genres', 'film_id'] : ['serie_genres', 'serie_id'];
    $werte = [];
    foreach ($spalten as $s) {
        $werte[$s] = $z[$s] === null ? null : (in_array(BEARB_FELDER[$art][$s], ['jahr', 'zahl'], true) ? (int) $z[$s] : (BEARB_FELDER[$art][$s] === 'note' ? (float) $z[$s] : (string) $z[$s]));
    }
    $werte['genres'] = array_column(db_alle("SELECT g.name FROM $gt[0] x JOIN genres g ON g.id = x.genre_id WHERE x.$gt[1] = :id ORDER BY g.name", ['id' => $id]), 'name');
    $gesperrt = array_column(db_alle('SELECT feld FROM metadaten_eigen WHERE art = :a AND ziel_id = :z', ['a' => $art, 'z' => $id]), 'feld');
    if (!in_array('sortiertitel', $gesperrt, true)) {
        $werte['sortiertitel'] = null; // automatisch – der interne Schlüssel ist kein schöner Text
    }
    $eigeneBilder = array_column(db_alle("SELECT typ FROM eigene_poster WHERE art = :a AND ziel_id = :z AND staffel = 0", ['a' => $art, 'z' => $id]), 'typ');
    return [
        'art' => $art, 'id' => $id, 'tmdb_id' => $z['tmdb_id'] ? (int) $z['tmdb_id'] : null,
        'werte' => $werte, 'gesperrt' => array_values($gesperrt),
        'bilder' => ['poster' => bild_url($z['poster']), 'hintergrund' => bild_url($z['hintergrund']), 'logo' => bild_url($z['logo']), 'eigen' => $eigeneBilder],
        'alle_genres' => array_column(db_alle('SELECT name FROM genres ORDER BY name'), 'name'),
        'status_werte' => $art === 'serie' ? BEARB_STATUS : null,
    ];
}

/** Eingabe prüfen und in Speicherform bringen (null = leeren) */
function bearb_wert(string $typ, mixed $v): mixed
{
    if ($typ === 'liste') {
        $l = [];
        foreach ((array) $v as $g) {
            $g = mb_substr(trim((string) $g), 0, 100);
            if ($g !== '' && !in_array($g, $l, true)) {
                $l[] = $g;
            }
        }
        return $l;
    }
    if ($v === null || (is_string($v) && trim($v) === '')) {
        return null;
    }
    return match ($typ) {
        'text' => mb_substr(trim((string) $v), 0, 255),
        'lang' => mb_substr(trim((string) $v), 0, 20000),
        'jahr' => (($j = (int) $v) >= 1870 && $j <= 2200) ? $j : throw new RuntimeException('Ungültiges Jahr: ' . $v),
        'zahl' => (($n = (int) $v) >= 0 && $n <= 2000) ? $n : throw new RuntimeException('Ungültige Zahl: ' . $v),
        'note' => (($n = round((float) str_replace(',', '.', (string) $v), 1)) >= 0 && $n <= 10) ? $n : throw new RuntimeException('Bewertung 0–10'),
        'datum' => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $v) && checkdate((int) substr((string) $v, 5, 2), (int) substr((string) $v, 8, 2), (int) substr((string) $v, 0, 4))
            ? (string) $v : throw new RuntimeException('Datum als JJJJ-MM-TT'),
        'fsk' => in_array((string) $v, ['0', '6', '12', '16', '18'], true) ? (string) $v : throw new RuntimeException('FSK 0, 6, 12, 16 oder 18'),
        'status' => in_array((string) $v, BEARB_STATUS, true) ? (string) $v : throw new RuntimeException('Unbekannter Status'),
        default => throw new RuntimeException('Unbekannter Feldtyp'),
    };
}

/**
 * Speichern: {felder: {name: wert}} sperrt und setzt; {zuruecksetzen: [name…]} entfernt die Sperre und holt TMDB neu.
 * „titel“ ist Pflicht; „sortiertitel“ leer = automatisch aus dem Titel.
 */
function bearbeiten_speichern(string $art, int $id, array $felder, array $zurueck): array
{
    if (!isset(BEARB_FELDER[$art])) {
        throw new RuntimeException('Unbekannte Art.');
    }
    $zeile = db_zeile('SELECT tmdb_id FROM ' . bearb_tabelle($art) . ' WHERE id = :id', ['id' => $id]);
    if (!$zeile) {
        throw new RuntimeException('Nicht gefunden.', 404);
    }
    $tmdb = $zeile['tmdb_id'];
    foreach ($felder as $f => $v) {
        $typ = BEARB_FELDER[$art][$f] ?? null;
        if (!$typ) {
            throw new RuntimeException('Unbekanntes Feld: ' . $f);
        }
        $w = bearb_wert($typ, $v);
        if ($f === 'titel' && $w === null) {
            throw new RuntimeException('Der Titel darf nicht leer sein.');
        }
        if ($f === 'sortiertitel' && $w === null) {
            $zurueck[] = 'sortiertitel'; // leer = wieder automatisch
            continue;
        }
        db_tun('INSERT INTO metadaten_eigen (art, ziel_id, feld, wert) VALUES (:a, :z, :f, :w) ON DUPLICATE KEY UPDATE wert = VALUES(wert)',
            ['a' => $art, 'z' => $id, 'f' => $f, 'w' => json_encode($w, JSON_UNESCAPED_UNICODE)]);
    }
    $zurueck = array_values(array_intersect(array_unique($zurueck), array_keys(BEARB_FELDER[$art])));
    if ($zurueck) {
        db_tun('DELETE FROM metadaten_eigen WHERE art = :a AND ziel_id = :z AND feld IN (' . implode(',', array_map(static fn($f) => db()->quote($f), $zurueck)) . ')',
            ['a' => $art, 'z' => $id]);
        // TMDB-Werte für die freigegebenen Felder neu holen (wendet die übrigen Sperren danach wieder an)
        if ($tmdb) {
            require_once __DIR__ . '/tmdb.php';
            $id = $art === 'film' ? tmdb_film_uebernehmen($id, (int) $tmdb, true) : tmdb_serie_uebernehmen($id, (int) $tmdb, true);
        } elseif (in_array('sortiertitel', $zurueck, true)) {
            $t = db_wert('SELECT titel FROM ' . bearb_tabelle($art) . ' WHERE id = :id', ['id' => $id]);
            db_tun('UPDATE ' . bearb_tabelle($art) . ' SET sortiertitel = :s WHERE id = :id', ['s' => sortiertitel((string) $t), 'id' => $id]);
        }
    }
    eigenes_anwenden($art, $id);
    return bearbeiten_daten($art, $id);
}

/** Gesperrte Felder und eigene Bilder auf einen Titel anwenden (nach jedem TMDB-Abgleich) */
function eigenes_anwenden(string $art, int $id): void
{
    $tab = bearb_tabelle($art);
    $eigen = [];
    foreach (db_alle('SELECT feld, wert FROM metadaten_eigen WHERE art = :a AND ziel_id = :z', ['a' => $art, 'z' => $id]) as $z) {
        $eigen[$z['feld']] = json_decode((string) $z['wert'], true);
    }
    $setzen = [];
    foreach ($eigen as $f => $w) {
        if ($f !== 'genres' && isset(BEARB_FELDER[$art][$f])) {
            $setzen[$f] = $w;
        }
    }
    if (isset($setzen['sortiertitel'])) {
        $setzen['sortiertitel'] = sortiertitel((string) $setzen['sortiertitel']);
    }
    if (isset($setzen['titel']) && !array_key_exists('sortiertitel', $setzen)) {
        $setzen['sortiertitel'] = sortiertitel((string) $setzen['titel']);
    }
    if ($art === 'film' && array_key_exists('erscheinungsdatum', $setzen) && !array_key_exists('jahr', $setzen) && $setzen['erscheinungsdatum']) {
        $setzen['jahr'] = (int) substr((string) $setzen['erscheinungsdatum'], 0, 4);
    }
    if ($setzen) {
        $teile = implode(', ', array_map(static fn($k) => "$k = :$k", array_keys($setzen)));
        db_tun("UPDATE $tab SET $teile WHERE id = :id", $setzen + ['id' => $id]);
    }
    if (isset($eigen['genres'])) {
        [$gt, $sp] = $art === 'film' ? ['film_genres', 'film_id'] : ['serie_genres', 'serie_id'];
        db_tun("DELETE FROM $gt WHERE $sp = :id", ['id' => $id]);
        foreach ((array) $eigen['genres'] as $name) {
            $gid = db_wert('SELECT id FROM genres WHERE name = :n', ['n' => $name]);
            if (!$gid) {
                $gid = db_einfuegen('INSERT INTO genres (tmdb_id, name) VALUES (NULL, :n)', ['n' => $name]);
            }
            db_tun("INSERT IGNORE INTO $gt ($sp, genre_id) VALUES (:id, :g)", ['id' => $id, 'g' => $gid]);
        }
    }
    require_once __DIR__ . '/poster.php';
    eigene_poster_anwenden($art, $id);
}

/** Bildauswahl von TMDB (Poster, Hintergründe, Logos) für den Dialog */
function tmdb_bildauswahl(string $art, int $id, ?int $staffel = null): array
{
    require_once __DIR__ . '/tmdb.php';
    $tmdb = (int) db_wert('SELECT tmdb_id FROM ' . bearb_tabelle($art) . ' WHERE id = :id', ['id' => $id]);
    if (!$tmdb || !tmdb_bereit()) {
        return ['poster' => [], 'hintergrund' => [], 'logo' => []];
    }
    $pfad = $art === 'film' ? "movie/$tmdb/images" : ($staffel !== null ? "tv/$tmdb/season/$staffel/images" : "tv/$tmdb/images");
    $spr = substr(tmdb_sprache(), 0, 2);
    $d = tmdb_get($pfad, ['include_image_language' => "$spr,en,null"]) ?? [];
    $basis = tmdb_bild_url();
    $liste = static function (array $l, string $klein) use ($basis, $spr) {
        usort($l, static fn($a, $b) => [($b['iso_639_1'] ?? null) === $spr, $b['vote_average'] ?? 0] <=> [($a['iso_639_1'] ?? null) === $spr, $a['vote_average'] ?? 0]);
        return array_map(static fn($b) => ['klein' => $basis . '/' . $klein . $b['file_path'], 'gross' => $basis . '/original' . $b['file_path'],
            'sprache' => $b['iso_639_1'] ?? null, 'breite' => $b['width'] ?? null, 'hoehe' => $b['height'] ?? null], array_slice($l, 0, 60));
    };
    return ['poster' => $liste($d['posters'] ?? [], 'w342'), 'hintergrund' => $liste($d['backdrops'] ?? [], 'w780'), 'logo' => $liste($d['logos'] ?? [], 'w300')];
}

/** API: {film|serie}/{id}/bearbeiten (GET/PUT), {film|serie}/{id}/bilder (GET ?staffel=) – nur Admin */
function bearbeiten_api(string $art, int $id, string $teil, string $methode): void
{
    if (!in_array($teil, ['bearbeiten', 'bilder'], true)) {
        return;
    }
    admin_noetig();
    try {
        if ($teil === 'bearbeiten' && $methode === 'GET') {
            bw_json(bearbeiten_daten($art, $id));
        }
        if ($teil === 'bearbeiten' && $methode === 'PUT') {
            $e = eingabe();
            bw_json(bearbeiten_speichern($art, $id, (array) ($e['felder'] ?? []), (array) ($e['zuruecksetzen'] ?? [])));
        }
        if ($teil === 'bilder' && $methode === 'GET') {
            bw_json(tmdb_bildauswahl($art, $id, isset($_GET['staffel']) && $_GET['staffel'] !== '' ? (int) $_GET['staffel'] : null));
        }
    } catch (RuntimeException $x) {
        fehler($x->getMessage(), $x->getCode() === 404 ? 404 : 400);
    }
}
