<?php
// Lesende Abfragen für die Oberfläche: Listen, Detailseiten, Universen, Reihen, Weiterschauen, nächste Folge.
declare(strict_types=1);
require_once __DIR__ . '/db.php';

function bild_url(?string $rel): ?string
{
    return $rel ? '/api/v1/bild/' . $rel : null;
}

function qualitaet_text(?int $hoehe, ?int $breite = null): ?string
{
    if (!$hoehe) {
        return null;
    }
    $b = (int) $breite;
    return match (true) {
        $hoehe >= 1700 || $b >= 3200 => '4K',
        $hoehe >= 1000 || $b >= 1800 => '1080p',
        $hoehe >= 700 || $b >= 1200 => '720p',
        default => 'SD',
    };
}

function hdr_text(?string $hdr): ?string
{
    return ['hdr10' => 'HDR10', 'hdr10plus' => 'HDR10+', 'hlg' => 'HLG', 'dolby_vision' => 'Dolby Vision'][$hdr ?? ''] ?? null;
}

function ton_text(array $t): string
{
    $codec = strtolower((string) $t['codec']);
    $profil = (string) ($t['profil'] ?? '');
    $name = match (true) {
        $codec === 'truehd' => str_contains(strtolower((string) $t['titel']), 'atmos') ? 'Dolby TrueHD Atmos' : 'Dolby TrueHD',
        $codec === 'eac3' => 'Dolby Digital Plus',
        $codec === 'ac3' => 'Dolby Digital',
        $codec === 'dts' => stripos($profil, 'MA') !== false ? 'DTS-HD MA' : (stripos($profil, 'X') !== false ? 'DTS:X' : 'DTS'),
        $codec === 'aac' => 'AAC', $codec === 'flac' => 'FLAC', $codec === 'opus' => 'Opus', $codec === 'mp3' => 'MP3',
        str_starts_with($codec, 'pcm') => 'PCM',
        default => strtoupper($codec),
    };
    $k = (int) $t['kanaele'];
    $kan = match ($k) { 1 => '1.0', 2 => '2.0', 6 => '5.1', 7 => '6.1', 8 => '7.1', default => $k > 0 ? $k . ' Kan.' : '' };
    return trim($name . ' ' . $kan);
}

const SPRACH_NAMEN = ['deu' => 'Deutsch', 'eng' => 'Englisch', 'fra' => 'Französisch', 'spa' => 'Spanisch', 'ita' => 'Italienisch', 'jpn' => 'Japanisch',
    'nld' => 'Niederländisch', 'pol' => 'Polnisch', 'tur' => 'Türkisch', 'rus' => 'Russisch', 'por' => 'Portugiesisch', 'swe' => 'Schwedisch', 'dan' => 'Dänisch',
    'nor' => 'Norwegisch', 'kor' => 'Koreanisch', 'zho' => 'Chinesisch', 'ces' => 'Tschechisch', 'hun' => 'Ungarisch', 'fin' => 'Finnisch', 'ell' => 'Griechisch'];

function sprache_name(?string $s): string
{
    return SPRACH_NAMEN[$s ?? ''] ?? ($s ? strtoupper($s) : 'Unbekannt');
}

/** Fortschritt eines Nutzers für mehrere Ziele: [ziel_id => zeile] */
function fortschritt_map(int $konto, string $art, array $ids): array
{
    $ids = array_values(array_unique(array_map('intval', $ids)));
    if (!$ids) {
        return [];
    }
    $aus = [];
    foreach (db_alle('SELECT ziel_id, position_ms, dauer_ms, gesehen FROM wiedergabe WHERE konto_id = :k AND art = :a AND ziel_id IN (' . implode(',', $ids) . ')',
        ['k' => $konto, 'a' => $art]) as $z) {
        $aus[(int) $z['ziel_id']] = ['position_ms' => (int) $z['position_ms'], 'dauer_ms' => (int) $z['dauer_ms'], 'gesehen' => (bool) $z['gesehen'],
            'prozent' => $z['dauer_ms'] > 0 ? min(100, (int) round($z['position_ms'] * 100 / $z['dauer_ms'])) : 0];
    }
    return $aus;
}

// ---------- Filme ----------

const FILM_KACHEL_SQL = "SELECT f.id, f.titel, f.jahr, f.poster, f.laufzeit_min, f.bewertung, f.hinzugefuegt_am, f.sortiertitel,
    MAX(d.hoehe) AS hoehe, MAX(d.breite) AS breite, MAX(d.hdr <> 'sdr') AS hdr
    FROM filme f JOIN fassungen fa ON fa.film_id = f.id JOIN dateien d ON d.fassung_id = fa.id AND d.fehlt_seit IS NULL";

function film_kacheln(array $zeilen, int $konto): array
{
    $fs = fortschritt_map($konto, 'film', array_column($zeilen, 'id'));
    return array_map(static fn($f) => [
        'art' => 'film', 'id' => (int) $f['id'], 'titel' => $f['titel'], 'jahr' => $f['jahr'] ? (int) $f['jahr'] : null,
        'poster' => bild_url($f['poster']), 'laufzeit_min' => $f['laufzeit_min'] ? (int) $f['laufzeit_min'] : null,
        'qualitaet' => qualitaet_text($f['hoehe'] ? (int) $f['hoehe'] : null, $f['breite'] ? (int) $f['breite'] : null), 'hdr' => (bool) $f['hdr'],
        'fortschritt' => $fs[(int) $f['id']] ?? null,
    ], $zeilen);
}

function filme_liste(int $konto, string $sort = 'titel', ?int $genre = null, string $suche = '', string $filter = ''): array
{
    $wo = [];
    $p = [];
    $having = '';
    if ($filter === '4k') {
        $having = ' HAVING MAX(d.hoehe) >= 1700 OR MAX(d.breite) >= 3200';
    } elseif ($filter === 'ungesehen') {
        $wo[] = 'NOT EXISTS (SELECT 1 FROM wiedergabe w WHERE w.konto_id = :k AND w.art = \'film\' AND w.ziel_id = f.id AND w.gesehen = 1)';
        $p['k'] = $konto;
    } elseif ($filter === 'reihen') {
        $wo[] = 'f.reihe_id IS NOT NULL';
    }
    if ($genre) {
        $wo[] = 'f.id IN (SELECT film_id FROM film_genres WHERE genre_id = :g)';
        $p['g'] = $genre;
    }
    if (trim($suche) !== '') {
        $wo[] = '(f.titel LIKE :q1 OR f.originaltitel LIKE :q2)';
        $p['q1'] = $p['q2'] = '%' . str_replace(['%', '_'], ['\%', '\_'], trim($suche)) . '%';
    }
    $ordnung = match ($sort) {
        'neu' => 'f.hinzugefuegt_am DESC', 'jahr' => 'f.jahr DESC, f.sortiertitel', 'bewertung' => 'f.bewertung DESC, f.sortiertitel', default => 'f.sortiertitel',
    };
    $sql = FILM_KACHEL_SQL . ($wo ? ' WHERE ' . implode(' AND ', $wo) : '') . ' GROUP BY f.id' . $having . ' ORDER BY ' . $ordnung;
    return film_kacheln(db_alle($sql, $p), $konto);
}

function film_detail(int $id, int $konto): ?array
{
    $f = db_zeile('SELECT * FROM filme WHERE id = :id', ['id' => $id]);
    if (!$f) {
        return null;
    }
    $fassungen = [];
    foreach (db_alle('SELECT * FROM fassungen WHERE film_id = :f ORDER BY standard DESC, FIELD(art, "kino","extended","directors_cut","unrated","imax","remastered","sonstige"), id', ['f' => $id]) as $fa) {
        $dateien = dateien_info(db_alle('SELECT * FROM dateien WHERE fassung_id = :fa AND fehlt_seit IS NULL ORDER BY hoehe DESC', ['fa' => $fa['id']]));
        if (!$dateien) {
            continue;
        }
        $fassungen[] = ['id' => (int) $fa['id'], 'name' => $fa['name'], 'art' => $fa['art'], 'standard' => (bool) $fa['standard'], 'dateien' => $dateien];
    }
    $reihe = null;
    if ($f['reihe_id']) {
        $r = db_zeile('SELECT id, name FROM reihen WHERE id = :r', ['r' => $f['reihe_id']]);
        $teile = film_kacheln(db_alle(FILM_KACHEL_SQL . ' WHERE f.reihe_id = :r GROUP BY f.id ORDER BY f.reihe_position IS NULL, f.reihe_position, f.jahr', ['r' => $f['reihe_id']]), $konto);
        $reihe = $r ? ['id' => (int) $r['id'], 'name' => $r['name'], 'filme' => $teile] : null;
    }
    $fs = fortschritt_map($konto, 'film', [$id]);
    return [
        'art' => 'film', 'id' => $id, 'titel' => $f['titel'], 'originaltitel' => $f['originaltitel'], 'jahr' => $f['jahr'] ? (int) $f['jahr'] : null,
        'laufzeit_min' => $f['laufzeit_min'] ? (int) $f['laufzeit_min'] : null, 'tagline' => $f['tagline'], 'beschreibung' => $f['beschreibung'],
        'poster' => bild_url($f['poster']), 'hintergrund' => bild_url($f['hintergrund']), 'logo' => bild_url($f['logo']),
        'regie' => $f['regie'], 'freigabe' => $f['freigabe'], 'bewertung' => $f['bewertung'] !== null ? (float) $f['bewertung'] : null,
        'besetzung' => array_map(static fn($b) => $b + ['bild_url' => bild_url($b['bild'] ?? null)], json_decode((string) $f['besetzung'], true) ?: []),
        'genres' => db_alle('SELECT g.id, g.name FROM genres g JOIN film_genres fg ON fg.genre_id = g.id WHERE fg.film_id = :f ORDER BY g.name', ['f' => $id]),
        'fassungen' => $fassungen, 'reihe' => $reihe, 'universen' => universum_positionen('film', $id, $konto),
        'technik' => technik_marken($fassungen),
        'fortschritt' => $fs[$id] ?? null, 'tmdb_id' => $f['tmdb_id'] ? (int) $f['tmdb_id'] : null, 'metadaten_status' => $f['metadaten_status'],
    ];
}

function dateien_info(array $dateien): array
{
    $aus = [];
    foreach ($dateien as $d) {
        $ton = db_alle('SELECT strom_index, codec, profil, sprache, kanaele, titel, standard, kommentar FROM tonspuren WHERE datei_id = :d ORDER BY strom_index', ['d' => $d['id']]);
        $ut = db_alle('SELECT id, quelle, format, sprache, titel, erzwungen, hoergeschaedigt FROM untertitel WHERE datei_id = :d ORDER BY quelle, strom_index', ['d' => $d['id']]);
        $aus[] = [
            'id' => (int) $d['id'], 'qualitaet' => qualitaet_text($d['hoehe'] ? (int) $d['hoehe'] : null, $d['breite'] ? (int) $d['breite'] : null),
            'breite' => (int) $d['breite'], 'hoehe' => (int) $d['hoehe'], 'hdr' => hdr_text($d['hdr']), 'video_codec' => strtoupper((string) $d['video_codec']),
            'dauer_ms' => (int) $d['dauer_ms'], 'groesse' => (int) $d['groesse'], 'container' => $d['container'], 'dateiname' => basename((string) $d['pfad']),
            'ton' => array_map(static fn($t) => ['index' => (int) $t['strom_index'], 'text' => ton_text($t), 'sprache' => $t['sprache'],
                'sprache_name' => sprache_name($t['sprache']), 'kommentar' => (bool) $t['kommentar']], $ton),
            'untertitel' => array_map(static fn($u) => ['id' => (int) $u['id'], 'sprache' => $u['sprache'], 'sprache_name' => sprache_name($u['sprache']),
                'erzwungen' => (bool) $u['erzwungen'], 'sdh' => (bool) $u['hoergeschaedigt'], 'bild' => untertitel_ist_bild((string) $u['format']),
                'quelle' => $u['quelle'], 'titel' => $u['titel']], $ut),
        ];
    }
    return $aus;
}

function untertitel_ist_bild(string $format): bool
{
    return in_array($format, ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'pgssub', 'sup'], true);
}

// ---------- Serien ----------

const SERIE_KACHEL_SQL = "SELECT s.id, s.titel, s.jahr_von, s.jahr_bis, s.poster, s.status, s.sortiertitel, s.hinzugefuegt_am,
    COUNT(DISTINCT fo.id) AS folgen, MAX(d.hinzugefuegt_am) AS neueste
    FROM serien s JOIN folgen fo ON fo.serie_id = s.id JOIN dateien d ON d.folge_id = fo.id AND d.fehlt_seit IS NULL";

function serie_kacheln(array $zeilen, int $konto): array
{
    return array_map(static fn($s) => [
        'art' => 'serie', 'id' => (int) $s['id'], 'titel' => $s['titel'], 'jahr' => $s['jahr_von'] ? (int) $s['jahr_von'] : null,
        'poster' => bild_url($s['poster']), 'folgen' => (int) $s['folgen'],
        'zeitraum' => $s['jahr_von'] ? $s['jahr_von'] . ($s['status'] === 'laufend' ? '–' : ($s['jahr_bis'] && $s['jahr_bis'] != $s['jahr_von'] ? '–' . $s['jahr_bis'] : '')) : null,
    ], $zeilen);
}

function serien_liste(int $konto, string $sort = 'titel', ?int $genre = null, string $suche = ''): array
{
    $wo = [];
    $p = [];
    if ($genre) {
        $wo[] = 's.id IN (SELECT serie_id FROM serie_genres WHERE genre_id = :g)';
        $p['g'] = $genre;
    }
    if (trim($suche) !== '') {
        $wo[] = '(s.titel LIKE :q1 OR s.originaltitel LIKE :q2)';
        $p['q1'] = $p['q2'] = '%' . str_replace(['%', '_'], ['\%', '\_'], trim($suche)) . '%';
    }
    $ordnung = match ($sort) { 'neu' => 'neueste DESC', 'jahr' => 's.jahr_von DESC, s.sortiertitel', default => 's.sortiertitel' };
    return serie_kacheln(db_alle(SERIE_KACHEL_SQL . ($wo ? ' WHERE ' . implode(' AND ', $wo) : '') . ' GROUP BY s.id ORDER BY ' . $ordnung, $p), $konto);
}

/** Staffeln und Folgen in der gewünschten Reihenfolge (null = Ausstrahlung) */
function serie_staffeln(int $serieId, ?int $reihenfolgeId, int $konto): array
{
    $staffeln = [];
    if ($reihenfolgeId) {
        $zeilen = db_alle('SELECT st.nummer AS s_nr, st.name AS s_name, NULL AS s_poster, rf.nummer AS f_nr, fo.* FROM reihenfolge_folgen rf
            JOIN folgen fo ON fo.id = rf.folge_id LEFT JOIN staffeln st ON st.id = rf.staffel_id
            WHERE rf.reihenfolge_id = :r ORDER BY st.nummer = 0, st.nummer, rf.nummer', ['r' => $reihenfolgeId]);
    } else {
        $zeilen = db_alle('SELECT fo.staffel_nr AS s_nr, ss.name AS s_name, ss.poster AS s_poster, fo.folge_nr AS f_nr, fo.* FROM folgen fo
            LEFT JOIN serien_staffeln ss ON ss.serie_id = fo.serie_id AND ss.nummer = fo.staffel_nr
            WHERE fo.serie_id = :s ORDER BY fo.staffel_nr = 0, fo.staffel_nr, fo.folge_nr', ['s' => $serieId]);
    }
    $ids = array_column($zeilen, 'id');
    $dateien = [];
    if ($ids) {
        foreach (db_alle('SELECT id, folge_id, hoehe, breite, hdr, dauer_ms FROM dateien WHERE fehlt_seit IS NULL AND folge_id IN (' . implode(',', array_map('intval', $ids)) . ') ORDER BY hoehe DESC') as $d) {
            $dateien[(int) $d['folge_id']] ??= $d;
        }
    }
    $fs = fortschritt_map($konto, 'folge', $ids);
    foreach ($zeilen as $z) {
        $nr = (int) $z['s_nr'];
        if (!isset($staffeln[$nr])) {
            $staffeln[$nr] = ['nummer' => $nr, 'name' => $z['s_name'] ?: ($nr === 0 ? 'Specials' : 'Staffel ' . $nr), 'poster' => bild_url($z['s_poster']), 'folgen' => []];
        }
        $d = $dateien[(int) $z['id']] ?? null;
        $staffeln[$nr]['folgen'][] = [
            'id' => (int) $z['id'], 'nummer' => (int) $z['f_nr'], 'staffel' => $nr, 'titel' => $z['titel'] ?: 'Folge ' . $z['f_nr'],
            'beschreibung' => $z['beschreibung'], 'erstausstrahlung' => $z['erstausstrahlung'], 'laufzeit_min' => $z['laufzeit_min'] ? (int) $z['laufzeit_min'] : null,
            'standbild' => bild_url($z['standbild']), 'vorhanden' => $d !== null, 'qualitaet' => $d ? qualitaet_text((int) $d['hoehe'], (int) $d['breite']) : null,
            'fortschritt' => $fs[(int) $z['id']] ?? null, 'ausstrahlung_nr' => sprintf('S%02dE%02d', (int) $z['staffel_nr'], (int) $z['folge_nr']),
        ];
    }
    return array_values($staffeln);
}

function serie_detail(int $id, int $konto, ?int $reihenfolgeWunsch = null, bool $wunschGesetzt = false): ?array
{
    $s = db_zeile('SELECT * FROM serien WHERE id = :id', ['id' => $id]);
    if (!$s) {
        return null;
    }
    $reihenfolgen = [['id' => null, 'name' => 'Ausstrahlung', 'art' => 'ausstrahlung']];
    foreach (db_alle('SELECT id, name, art FROM reihenfolgen WHERE serie_id = :s ORDER BY FIELD(art, "ausstrahlung","dvd","streaming","absolut","sonstige"), name', ['s' => $id]) as $r) {
        $reihenfolgen[] = ['id' => (int) $r['id'], 'name' => $r['name'], 'art' => $r['art']];
    }
    $standard = $s['reihenfolge_id'] ? (int) $s['reihenfolge_id'] : null;
    $aktiv = $wunschGesetzt ? $reihenfolgeWunsch : $standard;
    if ($aktiv !== null && !in_array($aktiv, array_column($reihenfolgen, 'id'), true)) {
        $aktiv = $standard;
    }
    $naechste = naechste_folge_fuer($id, $konto);
    // Specials/Extras (Staffel 0) ausblenden – die Seite kann sie mit ?specials=1 trotzdem zeigen
    $staffeln = serie_staffeln($id, $aktiv, $konto);
    $versteckt = 0;
    if (specials_ausblenden($s['specials_ausblenden'] === null ? null : (int) $s['specials_ausblenden']) && ($_GET['specials'] ?? '') !== '1') {
        foreach ($staffeln as $i => $st) {
            if ($st['nummer'] === 0) {
                $versteckt = count($st['folgen']);
                unset($staffeln[$i]);
            }
        }
        $staffeln = array_values($staffeln);
    }
    return [
        'art' => 'serie', 'id' => $id, 'titel' => $s['titel'], 'originaltitel' => $s['originaltitel'], 'jahr' => $s['jahr_von'] ? (int) $s['jahr_von'] : null,
        'zeitraum' => $s['jahr_von'] ? $s['jahr_von'] . ($s['status'] === 'laufend' ? '–' : ($s['jahr_bis'] && $s['jahr_bis'] != $s['jahr_von'] ? '–' . $s['jahr_bis'] : '')) : null,
        'status' => $s['status'], 'beschreibung' => $s['beschreibung'], 'poster' => bild_url($s['poster']), 'hintergrund' => bild_url($s['hintergrund']),
        'logo' => bild_url($s['logo']), 'sender' => $s['sender'], 'freigabe' => $s['freigabe'], 'bewertung' => $s['bewertung'] !== null ? (float) $s['bewertung'] : null,
        'besetzung' => array_map(static fn($b) => $b + ['bild_url' => bild_url($b['bild'] ?? null)], json_decode((string) $s['besetzung'], true) ?: []),
        'genres' => db_alle('SELECT g.id, g.name FROM genres g JOIN serie_genres sg ON sg.genre_id = g.id WHERE sg.serie_id = :s ORDER BY g.name', ['s' => $id]),
        'reihenfolgen' => $reihenfolgen, 'reihenfolge_standard' => $standard, 'reihenfolge' => $aktiv,
        'staffeln' => $staffeln, 'specials_versteckt' => $versteckt, 'specials_einstellung' => $s['specials_ausblenden'] === null ? null : (int) $s['specials_ausblenden'],
        'naechste' => $naechste, 'universen' => universum_positionen('serie', $id, $konto),
        'tmdb_id' => $s['tmdb_id'] ? (int) $s['tmdb_id'] : null, 'metadaten_status' => $s['metadaten_status'],
    ];
}

/** Specials/Extras dieser Serie ausblenden? Einstellung der Serie, sonst die des Nutzers */
function specials_ausblenden(?int $serienWert): bool
{
    if ($serienWert !== null) {
        return $serienWert === 1;
    }
    return (konto()['einstellungen']['specials'] ?? 'zeigen') === 'ausblenden';
}

/** Abspielbare Folgen einer Serie in Server-Reihenfolge (ohne Specials) */
function serie_folgen_flach(int $serieId): array
{
    $rf = db_wert('SELECT reihenfolge_id FROM serien WHERE id = :s', ['s' => $serieId]);
    if ($rf) {
        $ids = db_alle('SELECT rf.folge_id AS id FROM reihenfolge_folgen rf LEFT JOIN staffeln st ON st.id = rf.staffel_id
            WHERE rf.reihenfolge_id = :r AND COALESCE(st.nummer, 1) > 0 ORDER BY st.nummer, rf.nummer', ['r' => $rf]);
    } else {
        $ids = db_alle('SELECT id FROM folgen WHERE serie_id = :s AND staffel_nr > 0 ORDER BY staffel_nr, folge_nr', ['s' => $serieId]);
    }
    $ids = array_map('intval', array_column($ids, 'id'));
    if (!$ids) {
        return [];
    }
    $vorhanden = array_flip(array_map('intval', array_column(db_alle('SELECT DISTINCT folge_id FROM dateien WHERE fehlt_seit IS NULL AND folge_id IN (' . implode(',', $ids) . ')'), 'folge_id')));
    return array_values(array_filter($ids, static fn($i) => isset($vorhanden[$i])));
}

/** Folge nach $folgeId (in Server-Reihenfolge) */
function folge_danach(int $folgeId): ?int
{
    $serie = db_wert('SELECT serie_id FROM folgen WHERE id = :f', ['f' => $folgeId]);
    if (!$serie) {
        return null;
    }
    $liste = serie_folgen_flach((int) $serie);
    $pos = array_search($folgeId, $liste, true);
    return $pos !== false && isset($liste[$pos + 1]) ? $liste[$pos + 1] : null;
}

/** Womit der Nutzer bei dieser Serie weitermacht: angefangene Folge, sonst die nach der zuletzt gesehenen, sonst die erste */
function naechste_folge_fuer(int $serieId, int $konto): ?array
{
    $liste = serie_folgen_flach($serieId);
    if (!$liste) {
        return null;
    }
    $fs = fortschritt_map($konto, 'folge', $liste);
    $zuletzt = db_zeile("SELECT ziel_id, gesehen FROM wiedergabe WHERE konto_id = :k AND art = 'folge' AND ziel_id IN (" . implode(',', $liste) . ') ORDER BY aktualisiert_am DESC LIMIT 1', ['k' => $konto]);
    $ziel = $liste[0];
    $modus = 'start';
    if ($zuletzt) {
        $z = (int) $zuletzt['ziel_id'];
        if (!$zuletzt['gesehen']) {
            $ziel = $z;
            $modus = 'weiter';
        } else {
            $pos = array_search($z, $liste, true);
            if ($pos === false || !isset($liste[$pos + 1])) {
                return null; // alles gesehen
            }
            $ziel = $liste[$pos + 1];
            $modus = 'naechste';
        }
    }
    $f = db_zeile('SELECT id, staffel_nr, folge_nr, titel, standbild FROM folgen WHERE id = :id', ['id' => $ziel]);
    return $f ? ['id' => (int) $f['id'], 'modus' => $modus, 'titel' => $f['titel'] ?: 'Folge ' . $f['folge_nr'],
        'kennung' => sprintf('S%02dE%02d', (int) $f['staffel_nr'], (int) $f['folge_nr']), 'standbild' => bild_url($f['standbild']),
        'fortschritt' => $fs[(int) $f['id']] ?? null] : null;
}

// ---------- Reihen ----------

/** Reihen als Kacheln (für „Filme › Reihen“): nur Reihen mit mindestens einem vorhandenen Film */
function reihen_liste(int $konto, string $sort = 'titel', ?int $genre = null): array
{
    $wo = '';
    $p = ['k' => $konto];
    if ($genre) {
        $wo = ' AND f.id IN (SELECT film_id FROM film_genres WHERE genre_id = :g)';
        $p['g'] = $genre;
    }
    $zeilen = db_alle("SELECT r.id, r.name, r.sortname, r.poster, COUNT(DISTINCT f.id) AS n, MIN(f.jahr) AS von, MAX(f.jahr) AS bis, MAX(f.hinzugefuegt_am) AS neu,
            COUNT(DISTINCT CASE WHEN w.gesehen = 1 THEN f.id END) AS gesehen
        FROM reihen r JOIN filme f ON f.reihe_id = r.id
        LEFT JOIN wiedergabe w ON w.art = 'film' AND w.ziel_id = f.id AND w.konto_id = :k
        WHERE EXISTS (SELECT 1 FROM fassungen fa JOIN dateien d ON d.fassung_id = fa.id AND d.fehlt_seit IS NULL WHERE fa.film_id = f.id)$wo
        GROUP BY r.id", $p);
    usort($zeilen, match ($sort) {
        'neu' => static fn($a, $b) => strcmp((string) $b['neu'], (string) $a['neu']),
        'jahr' => static fn($a, $b) => [(int) $b['bis'], $a['sortname']] <=> [(int) $a['bis'], $b['sortname']],
        default => static fn($a, $b) => strnatcasecmp((string) ($a['sortname'] ?: $a['name']), (string) ($b['sortname'] ?: $b['name'])),
    });
    return array_map(static fn($r) => ['art' => 'reihe', 'id' => (int) $r['id'], 'titel' => $r['name'], 'poster' => bild_url($r['poster']),
        'jahr' => $r['von'] ? (int) $r['von'] : null,
        'zusatz' => $r['n'] . ' ' . ((int) $r['n'] === 1 ? 'Film' : 'Filme') . ($r['von'] ? ' · ' . $r['von'] . ($r['bis'] && $r['bis'] !== $r['von'] ? '–' . $r['bis'] : '') : ''),
        'fortschritt' => (int) $r['gesehen'] > 0 ? ['gesehen' => (int) $r['gesehen'] >= (int) $r['n'], 'prozent' => (int) round($r['gesehen'] * 100 / max(1, $r['n']))] : null],
        $zeilen);
}


function reihe_detail(int $id, int $konto): ?array
{
    $r = db_zeile('SELECT * FROM reihen WHERE id = :id', ['id' => $id]);
    if (!$r) {
        return null;
    }
    return ['art' => 'reihe', 'id' => $id, 'name' => $r['name'], 'beschreibung' => $r['beschreibung'], 'poster' => bild_url($r['poster']),
        'hintergrund' => bild_url($r['hintergrund']),
        'filme' => film_kacheln(db_alle(FILM_KACHEL_SQL . ' WHERE f.reihe_id = :r GROUP BY f.id ORDER BY f.reihe_position IS NULL, f.reihe_position, f.jahr', ['r' => $id]), $konto),
        'universen' => array_map(static fn($u) => ['id' => (int) $u['id'], 'name' => $u['name']],
            db_alle('SELECT DISTINCT u.id, u.name FROM universen u JOIN universum_eintraege e ON e.universum_id = u.id JOIN filme f ON f.id = e.film_id WHERE f.reihe_id = :r', ['r' => $id]))];
}

// ---------- Startseite ----------

function startseite(int $konto): array
{
    // Weiterschauen: angefangen, nicht gesehen (Filme und Folgen gemischt, zuletzt zuerst)
    $weiter = [];
    foreach (db_alle("SELECT art, ziel_id, position_ms, dauer_ms FROM wiedergabe WHERE konto_id = :k AND gesehen = 0 AND position_ms > 30000
        ORDER BY aktualisiert_am DESC LIMIT 20", ['k' => $konto]) as $w) {
        $prozent = $w['dauer_ms'] > 0 ? min(100, (int) round($w['position_ms'] * 100 / $w['dauer_ms'])) : 0;
        if ($w['art'] === 'film') {
            $f = db_zeile('SELECT id, titel, hintergrund, poster, logo FROM filme WHERE id = :id', ['id' => $w['ziel_id']]);
            if ($f) {
                $weiter[] = ['art' => 'film', 'id' => (int) $f['id'], 'titel' => $f['titel'], 'bild' => bild_url($f['hintergrund'] ?: $f['poster']),
                    'logo' => bild_url($f['logo']), 'prozent' => $prozent, 'rest_min' => (int) max(1, round(($w['dauer_ms'] - $w['position_ms']) / 60000))];
            }
        } else {
            $f = db_zeile('SELECT fo.id, fo.titel, fo.staffel_nr, fo.folge_nr, fo.standbild, s.id AS serie_id, s.titel AS serie, s.hintergrund FROM folgen fo
                JOIN serien s ON s.id = fo.serie_id WHERE fo.id = :id', ['id' => $w['ziel_id']]);
            if ($f) {
                $weiter[] = ['art' => 'folge', 'id' => (int) $f['id'], 'serie_id' => (int) $f['serie_id'], 'titel' => $f['serie'],
                    'untertitel' => sprintf('S%02dE%02d', $f['staffel_nr'], $f['folge_nr']) . ($f['titel'] ? ' · ' . $f['titel'] : ''),
                    'bild' => bild_url($f['standbild'] ?: $f['hintergrund']), 'prozent' => $prozent,
                    'rest_min' => (int) max(1, round(($w['dauer_ms'] - $w['position_ms']) / 60000))];
            }
        }
    }
    // Als Nächstes: Serien, deren letzte gesehene Folge fertig ist und die eine weitere Folge haben
    $naechste = [];
    $serienZuletzt = db_alle("SELECT fo.serie_id, MAX(w.aktualisiert_am) AS zuletzt FROM wiedergabe w JOIN folgen fo ON fo.id = w.ziel_id
        WHERE w.konto_id = :k AND w.art = 'folge' GROUP BY fo.serie_id ORDER BY zuletzt DESC LIMIT 15", ['k' => $konto]);
    $schonWeiter = array_flip(array_map(static fn($w) => $w['serie_id'] ?? 0, array_filter($weiter, static fn($w) => $w['art'] === 'folge')));
    foreach ($serienZuletzt as $z) {
        if (isset($schonWeiter[(int) $z['serie_id']])) {
            continue;
        }
        $n = naechste_folge_fuer((int) $z['serie_id'], $konto);
        if ($n && $n['modus'] === 'naechste') {
            $s = db_zeile('SELECT titel, hintergrund FROM serien WHERE id = :s', ['s' => $z['serie_id']]);
            $naechste[] = ['art' => 'folge', 'id' => $n['id'], 'serie_id' => (int) $z['serie_id'], 'titel' => $s['titel'] ?? '',
                'untertitel' => $n['kennung'] . ' · ' . $n['titel'], 'bild' => $n['standbild'] ?: bild_url($s['hintergrund'] ?? null), 'prozent' => 0];
        }
    }
    $neueFilme = film_kacheln(db_alle(FILM_KACHEL_SQL . ' GROUP BY f.id ORDER BY MAX(d.hinzugefuegt_am) DESC LIMIT 18'), $konto);
    $neueSerien = serie_kacheln(db_alle(SERIE_KACHEL_SQL . ' GROUP BY s.id ORDER BY neueste DESC LIMIT 18'), $konto);
    // Hero: zufälliger Film mit Hintergrund aus den letzten 30 neuen
    $hero = db_zeile("SELECT f.id, f.titel, f.tagline, f.beschreibung, f.hintergrund, f.logo, f.jahr, f.laufzeit_min FROM filme f
        JOIN fassungen fa ON fa.film_id = f.id JOIN dateien d ON d.fassung_id = fa.id AND d.fehlt_seit IS NULL
        WHERE f.hintergrund IS NOT NULL GROUP BY f.id ORDER BY RAND() LIMIT 1");
    return [
        'hero' => $hero ? ['art' => 'film', 'id' => (int) $hero['id'], 'titel' => $hero['titel'], 'text' => $hero['tagline'] ?: mb_strimwidth((string) $hero['beschreibung'], 0, 220, '…'),
            'hintergrund' => bild_url($hero['hintergrund']), 'logo' => bild_url($hero['logo']), 'jahr' => $hero['jahr'], 'laufzeit_min' => $hero['laufzeit_min']] : null,
        'weiterschauen' => $weiter, 'als_naechstes' => $naechste, 'neue_filme' => $neueFilme, 'neue_serien' => $neueSerien,
        'universen' => $universen = universen_liste($konto),
        'universum_band' => universum_band($universen, $konto),
        'leer' => !$neueFilme && !$neueSerien,
    ];
}

function suche(string $q, int $konto): array
{
    require_once __DIR__ . '/suche.php';
    return suche_alles($q, $konto);
}

/** Abzeichen für die Technikzeile: Auflösung, HDR, Ton (aus der besten Datei der Standardfassung) */
function technik_marken(array $fassungen): array
{
    $d = $fassungen[0]['dateien'][0] ?? null;
    if (!$d) {
        return [];
    }
    $m = [];
    if ($d['qualitaet'] === '4K') {
        $m[] = ['text' => '4K', 'art' => 'normal'];
    }
    if ($d['hdr']) {
        $m[] = ['text' => strtoupper($d['hdr']), 'art' => 'hdr'];
    }
    $ton = db_alle('SELECT codec, profil, titel FROM tonspuren WHERE datei_id = :d', ['d' => $d['id']]);
    $text = null;
    foreach ($ton as $t) {
        $alles = strtolower($t['codec'] . ' ' . $t['profil'] . ' ' . $t['titel']);
        if (str_contains($alles, 'atmos')) {
            $text = 'ATMOS';
            break;
        }
        if (str_contains($alles, 'dts:x') || str_contains($alles, 'dts-x')) {
            $text = 'DTS:X';
        } elseif ($text === null && $t['codec'] === 'dts' && str_contains($alles, 'ma')) {
            $text = 'DTS-HD MA';
        } elseif ($text === null && $t['codec'] === 'truehd') {
            $text = 'TRUEHD';
        }
    }
    if ($text) {
        $m[] = ['text' => $text, 'art' => 'normal'];
    }
    return $m;
}

/** Für die Startseite: ein Universum als Band (das größte) mit seinen ersten Titeln */
function universum_band(array $universen, int $konto): ?array
{
    if (!$universen) {
        return null;
    }
    usort($universen, static fn($a, $b) => $b['eintraege'] <=> $a['eintraege']);
    $u = $universen[0];
    if ($u['eintraege'] < 2) {
        return null;
    }
    $titel = universum_naechstes(universum_titel($u['id'], $konto), $konto);
    return $u + ['titel_liste' => array_slice(universum_titel($u['id'], $konto), 0, 6), 'naechstes' => $titel];
}

require_once __DIR__ . '/universen.php';
