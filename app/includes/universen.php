<?php
// Universen: eigene Sammlungen aus einzelnen Filmen und Serien (Reihen werden beim Hinzufügen aufgelöst), optional in
// Abschnitte gegliedert. Reihenfolge „eigen“ (von Hand) oder „erscheinung“ (Datum). Fortschritt je Nutzer.
declare(strict_types=1);
require_once __DIR__ . '/bibliothek.php';
require_once __DIR__ . '/scanner.php';

/**
 * Alle Titel eines Universums in Reihenfolge, mit Abschnitt, Bild, Fortschritt.
 * @return array<int, array> Liste von Titeln (Schlüssel 0…n)
 */
function universum_titel(int $uid, int $konto, string $sort = 'eigen'): array
{
    $zeilen = db_alle('SELECT e.id AS eid, e.art, e.film_id, e.serie_id, e.staffel, e.position, e.abschnitt_id, a.name AS abschnitt, a.position AS apos
        FROM universum_eintraege e LEFT JOIN universum_abschnitte a ON a.id = e.abschnitt_id
        WHERE e.universum_id = :u AND e.art IN (\'film\', \'serie\')
        ORDER BY a.id IS NOT NULL, a.position, a.id, e.position IS NULL, e.position, e.id', ['u' => $uid]);
    $filmIds = array_values(array_filter(array_map(static fn($z) => (int) $z['film_id'], $zeilen)));
    $serieIds = array_values(array_filter(array_map(static fn($z) => (int) $z['serie_id'], $zeilen)));
    $filme = [];
    if ($filmIds) {
        foreach (db_alle('SELECT f.id, f.titel, f.jahr, f.erscheinungsdatum, f.poster, f.hintergrund, f.laufzeit_min,
            (SELECT COUNT(*) FROM fassungen fa JOIN dateien d ON d.fassung_id = fa.id AND d.fehlt_seit IS NULL WHERE fa.film_id = f.id) AS dateien
            FROM filme f WHERE f.id IN (' . implode(',', $filmIds) . ')') as $f) {
            $filme[(int) $f['id']] = $f;
        }
    }
    $serien = [];
    if ($serieIds) {
        foreach (db_alle('SELECT s.id, s.titel, s.jahr_von, s.jahr_bis, s.status, s.poster, s.hintergrund,
            (SELECT MIN(fo.erstausstrahlung) FROM folgen fo WHERE fo.serie_id = s.id) AS start,
            (SELECT COUNT(DISTINCT fo.id) FROM folgen fo JOIN dateien d ON d.folge_id = fo.id AND d.fehlt_seit IS NULL WHERE fo.serie_id = s.id AND fo.staffel_nr > 0) AS folgen
            FROM serien s WHERE s.id IN (' . implode(',', $serieIds) . ')') as $s) {
            $serien[(int) $s['id']] = $s;
        }
    }
    $fsFilme = fortschritt_map($konto, 'film', $filmIds);
    // je Serie und Staffel: vorhandene Folgen, gesehen, angefangen, Start, Name und Poster der Staffel
    $je = [];
    if ($serieIds) {
        $liste = implode(',', array_unique($serieIds));
        foreach (db_alle("SELECT fo.serie_id, fo.staffel_nr, COUNT(DISTINCT fo.id) AS n, MIN(fo.erstausstrahlung) AS start FROM folgen fo
            JOIN dateien d ON d.folge_id = fo.id AND d.fehlt_seit IS NULL WHERE fo.serie_id IN ($liste) AND fo.staffel_nr > 0 GROUP BY fo.serie_id, fo.staffel_nr") as $z) {
            $je[(int) $z['serie_id']][(int) $z['staffel_nr']] = ['n' => (int) $z['n'], 'g' => 0, 'a' => 0, 'start' => $z['start'], 'name' => null, 'poster' => null];
        }
        foreach (db_alle("SELECT fo.serie_id, fo.staffel_nr, SUM(w.gesehen) AS g, COUNT(*) AS a FROM wiedergabe w JOIN folgen fo ON fo.id = w.ziel_id
            WHERE w.konto_id = :k AND w.art = 'folge' AND fo.serie_id IN ($liste) AND fo.staffel_nr > 0 GROUP BY fo.serie_id, fo.staffel_nr", ['k' => $konto]) as $z) {
            if (isset($je[(int) $z['serie_id']][(int) $z['staffel_nr']])) {
                $je[(int) $z['serie_id']][(int) $z['staffel_nr']]['g'] = (int) $z['g'];
                $je[(int) $z['serie_id']][(int) $z['staffel_nr']]['a'] = (int) $z['a'];
            }
        }
        foreach (db_alle("SELECT serie_id, nummer, name, poster FROM serien_staffeln WHERE serie_id IN ($liste)") as $z) {
            if (isset($je[(int) $z['serie_id']][(int) $z['nummer']])) {
                $je[(int) $z['serie_id']][(int) $z['nummer']]['name'] = $z['name'];
                $je[(int) $z['serie_id']][(int) $z['nummer']]['poster'] = $z['poster'];
            }
        }
    }
    $aus = [];
    foreach ($zeilen as $z) {
        if ($z['art'] === 'film' && isset($filme[(int) $z['film_id']])) {
            $f = $filme[(int) $z['film_id']];
            $fs = $fsFilme[(int) $f['id']] ?? null;
            $aus[] = ['eintrag_id' => (int) $z['eid'], 'art' => 'film', 'id' => (int) $f['id'], 'titel' => $f['titel'], 'jahr' => $f['jahr'] ? (int) $f['jahr'] : null,
                'datum' => $f['erscheinungsdatum'] ?: ($f['jahr'] ? $f['jahr'] . '-07-01' : '9999'), 'poster' => bild_url($f['poster']), 'hintergrund' => bild_url($f['hintergrund']),
                'zusatz' => 'Film' . ($f['jahr'] ? ' · ' . $f['jahr'] : ''), 'vorhanden' => (int) $f['dateien'] > 0,
                'gesehen' => (bool) ($fs['gesehen'] ?? false), 'prozent' => $fs && !$fs['gesehen'] ? $fs['prozent'] : 0,
                'abschnitt_id' => $z['abschnitt_id'] ? (int) $z['abschnitt_id'] : null, 'abschnitt' => $z['abschnitt']];
        } elseif ($z['art'] === 'serie' && isset($serien[(int) $z['serie_id']])) {
            $s = $serien[(int) $z['serie_id']];
            $st = (int) $z['staffel'];
            $teile = $je[(int) $s['id']] ?? [];
            if ($st > 0) {
                $d = $teile[$st] ?? ['n' => 0, 'g' => 0, 'a' => 0, 'start' => null, 'name' => null, 'poster' => null];
                $folgen = $d['n'];
                $g = $d['g'];
                $angefangen = $d['a'] > 0;
                $start = $d['start'];
                $sname = $d['name'] && !preg_match('/^(staffel|season)\s*\d+$/i', (string) $d['name']) ? $d['name'] : 'Staffel ' . $st;
                $titel = $s['titel'] . ' · ' . $sname;
                $poster = $d['poster'] ?: $s['poster'];
                $jahr = $start ? (int) substr((string) $start, 0, 4) : ($s['jahr_von'] ? (int) $s['jahr_von'] : null);
            } else {
                $folgen = array_sum(array_column($teile, 'n'));
                $g = array_sum(array_column($teile, 'g'));
                $angefangen = array_sum(array_column($teile, 'a')) > 0;
                $start = $s['start'];
                $titel = $s['titel'];
                $poster = $s['poster'];
                $jahr = $s['jahr_von'] ? (int) $s['jahr_von'] : null;
            }
            $aus[] = ['eintrag_id' => (int) $z['eid'], 'art' => 'serie', 'id' => (int) $s['id'], 'staffel' => $st, 'serie_titel' => $s['titel'],
                'staffeln' => count($teile), 'titel' => $titel, 'jahr' => $jahr,
                'datum' => $start ?: ($jahr ? $jahr . '-07-01' : '9999'), 'poster' => bild_url($poster), 'hintergrund' => bild_url($s['hintergrund']),
                'zusatz' => ($st ? 'Staffel' : 'Serie') . ($jahr ? ' · ' . $jahr : '') . ($folgen ? ' · ' . $folgen . ' ' . ($folgen === 1 ? 'Folge' : 'Folgen') : ''),
                'vorhanden' => $folgen > 0, 'gesehen' => $folgen > 0 && $g >= $folgen, 'prozent' => $folgen > 0 && $g < $folgen ? (int) round($g * 100 / $folgen) : 0,
                'angefangen' => $angefangen,
                'abschnitt_id' => $z['abschnitt_id'] ? (int) $z['abschnitt_id'] : null, 'abschnitt' => $z['abschnitt']];
        }
    }
    if ($sort === 'erscheinung') {
        usort($aus, static fn($a, $b) => [$a['datum'], $a['titel']] <=> [$b['datum'], $b['titel']]);
    }
    foreach ($aus as $i => &$t) {
        $t['nr'] = $i + 1;
    }
    return $aus;
}

function universum_bild(array $u, array $titel): array
{
    $poster = $u['bild'] ? bild_url($u['bild']) : null;
    $hg = $u['hintergrund'] ? bild_url($u['hintergrund']) : null;
    foreach ($titel as $t) {
        $poster ??= $t['poster'];
        $hg ??= $t['hintergrund'];
    }
    return [$poster, $hg];
}

function universen_liste(int $konto = 0): array
{
    $aus = [];
    foreach (db_alle('SELECT * FROM universen ORDER BY sortname') as $u) {
        $titel = universum_titel((int) $u['id'], $konto);
        [$poster, $hg] = universum_bild($u, $titel);
        $filme = count(array_filter($titel, static fn($t) => $t['art'] === 'film'));
        $jahre = array_filter(array_column($titel, 'jahr'));
        $aus[] = ['art' => 'universum', 'id' => (int) $u['id'], 'name' => $u['name'], 'titel' => $u['name'], 'beschreibung' => $u['beschreibung'],
            'poster' => $poster, 'hintergrund' => $hg, 'eintraege' => count($titel), 'filme' => $filme, 'serien' => count(array_unique(array_column(array_filter($titel, static fn($t) => $t['art'] === 'serie'), 'id'))),
            'von' => $jahre ? min($jahre) : null, 'bis' => $jahre ? max($jahre) : null,
            'gesehen' => count(array_filter($titel, static fn($t) => $t['gesehen'])),
            'collage' => array_slice(array_values(array_filter(array_column($titel, 'poster'))), 0, 6),
            'zusatz' => count($titel) . ' Titel'];
    }
    return $aus;
}

/** Nächste Folge innerhalb einer Staffel (für aufgeteilte Serien): angefangene, sonst erste ungesehene */
function naechste_folge_in_staffel(int $serieId, int $staffel, int $konto): ?array
{
    $folgen = db_alle('SELECT fo.id, fo.folge_nr, fo.titel, fo.standbild, w.gesehen, w.position_ms, w.dauer_ms FROM folgen fo
        LEFT JOIN wiedergabe w ON w.ziel_id = fo.id AND w.art = \'folge\' AND w.konto_id = :k
        WHERE fo.serie_id = :s AND fo.staffel_nr = :st AND EXISTS (SELECT 1 FROM dateien d WHERE d.folge_id = fo.id AND d.fehlt_seit IS NULL)
        ORDER BY fo.folge_nr', ['k' => $konto, 's' => $serieId, 'st' => $staffel]);
    $ziel = null;
    $modus = 'start';
    foreach ($folgen as $f) {
        if (!$f['gesehen'] && (int) $f['position_ms'] > 0) {
            $ziel = $f;
            $modus = 'weiter';
            break;
        }
    }
    if (!$ziel) {
        $gesehen = false;
        foreach ($folgen as $f) {
            if ($f['gesehen']) {
                $gesehen = true;
            } elseif (!$ziel) {
                $ziel = $f;
            }
        }
        $modus = $gesehen ? 'naechste' : 'start';
    }
    if (!$ziel) {
        return null;
    }
    return ['id' => (int) $ziel['id'], 'modus' => $modus, 'titel' => $ziel['titel'] ?: 'Folge ' . $ziel['folge_nr'],
        'kennung' => sprintf('S%02dE%02d', $staffel, (int) $ziel['folge_nr']), 'standbild' => bild_url($ziel['standbild']),
        'fortschritt' => $ziel['dauer_ms'] ? ['position_ms' => (int) $ziel['position_ms'], 'dauer_ms' => (int) $ziel['dauer_ms'], 'gesehen' => (bool) $ziel['gesehen'],
            'prozent' => min(100, (int) round($ziel['position_ms'] * 100 / max(1, $ziel['dauer_ms'])))] : null];
}

/** Erster nicht gesehener, vorhandener Titel – bei Serien mit der passenden Folge */
function universum_naechstes(array $titel, int $konto): ?array
{
    foreach ($titel as $t) {
        if ($t['gesehen'] || !$t['vorhanden']) {
            continue;
        }
        if ($t['art'] === 'serie') {
            $n = !empty($t['staffel']) ? naechste_folge_in_staffel($t['id'], (int) $t['staffel'], $konto) : naechste_folge_fuer($t['id'], $konto);
            if (!$n) {
                continue;
            }
            return $t + ['folge' => $n];
        }
        return $t;
    }
    return null;
}

function universum_detail(int $id, int $konto, string $sort = 'eigen'): ?array
{
    $u = db_zeile('SELECT * FROM universen WHERE id = :id', ['id' => $id]);
    if (!$u) {
        return null;
    }
    $sort = $sort === 'erscheinung' ? 'erscheinung' : 'eigen';
    $titel = universum_titel($id, $konto, $sort);
    [$poster, $hg] = universum_bild($u, $titel);
    // Gruppen: bei eigener Reihenfolge nach Abschnitten (verschachtelt, in Baum-Reihenfolge), sonst eine Liste
    $gruppen = [];
    if ($sort === 'eigen') {
        $abschnitte = universum_abschnitte_baum($id);
        $gruppen[0] = ['id' => null, 'name' => null, 'eltern_id' => null, 'tiefe' => 0, 'titel' => []];
        foreach ($abschnitte as $a) {
            $gruppen[$a['id']] = ['id' => $a['id'], 'name' => $a['name'], 'eltern_id' => $a['eltern_id'], 'tiefe' => $a['tiefe'], 'titel' => []];
        }
        foreach ($titel as $t) {
            $gruppen[$t['abschnitt_id'] ?? 0]['titel'][] = $t;
        }
        if (!$gruppen[0]['titel'] && count($gruppen) > 1) {
            unset($gruppen[0]);
        }
    } else {
        $gruppen[0] = ['id' => null, 'name' => null, 'eltern_id' => null, 'tiefe' => 0, 'titel' => $titel];
    }
    // Infotext je Abschnitt: eigene Titel plus die aller Unterabschnitte
    $unterbaum = static function (int $gid) use (&$gruppen, &$unterbaum): array {
        $l = $gruppen[$gid]['titel'];
        foreach ($gruppen as $k => $g) {
            if ($k !== 0 && $g['eltern_id'] === $gid) {
                $l = array_merge($l, $unterbaum($k));
            }
        }
        return $l;
    };
    foreach ($gruppen as $k => &$g) {
        $alle = $k === 0 ? $g['titel'] : $unterbaum($k);
        $f = count(array_filter($alle, static fn($t) => $t['art'] === 'film'));
        $s = count($alle) - $f;
        $ges = count(array_filter($alle, static fn($t) => $t['gesehen']));
        $teile = array_filter([$f ? $f . ' ' . ($f === 1 ? 'Film' : 'Filme') : null, $s ? $s . ' ' . ($s === 1 ? 'Serie' : 'Serien') : null]);
        $g['gesamt'] = count($alle);
        $g['info'] = implode(' · ', $teile) . ($alle ? ($ges === count($alle) ? ' · alle gesehen' : ($ges ? ' · ' . $ges . ' gesehen' : '')) : '');
    }
    unset($g);
    $filme = count(array_filter($titel, static fn($t) => $t['art'] === 'film'));
    $jahre = array_filter(array_column($titel, 'jahr'));
    return [
        'art' => 'universum', 'id' => $id, 'name' => $u['name'], 'beschreibung' => $u['beschreibung'], 'poster' => $poster, 'hintergrund' => $hg,
        'bild' => $u['bild'] ? bild_url($u['bild']) : null, 'sortierung' => $sort,
        'zahlen' => ['filme' => $filme, 'serien' => count(array_unique(array_column(array_filter($titel, static fn($t) => $t['art'] === 'serie'), 'id'))), 'gesamt' => count($titel), 'von' => $jahre ? min($jahre) : null, 'bis' => $jahre ? max($jahre) : null,
            'gesehen' => count(array_filter($titel, static fn($t) => $t['gesehen'])), 'ungesehen' => count(array_filter($titel, static fn($t) => !$t['gesehen']))],
        'collage' => array_slice(array_values(array_filter(array_column($titel, 'poster'))), 0, 18),
        'abschnitte' => array_values($gruppen),
        'naechstes' => universum_naechstes(universum_titel($id, $konto), $konto),
    ];
}

/** Für Detailseiten: in welchen Universen steckt der Titel, an welcher Stelle, Nachbarn davor/danach */
function universum_positionen(string $art, int $id, int $konto): array
{
    $spalte = $art === 'film' ? 'film_id' : 'serie_id';
    $aus = [];
    foreach (db_alle("SELECT DISTINCT u.id, u.name FROM universen u JOIN universum_eintraege e ON e.universum_id = u.id WHERE e.$spalte = :id ORDER BY u.sortname", ['id' => $id]) as $u) {
        $titel = universum_titel((int) $u['id'], $konto);
        $idx = null;
        $kand = array_keys(array_filter($titel, static fn($t) => $t['art'] === $art && $t['id'] === $id));
        if ($kand) {
            $idx = $kand[0];
            if (count($kand) > 1 && $art === 'serie' && ($n = naechste_folge_fuer($id, $konto))) {
                $stNr = (int) db_wert('SELECT staffel_nr FROM folgen WHERE id = :f', ['f' => $n['id']]);
                foreach ($kand as $k) {
                    if ($titel[$k]['staffel'] === $stNr) {
                        $idx = $k;
                    }
                }
            }
        }
        if ($idx === null) {
            continue;
        }
        $nachbarn = [];
        for ($i = max(0, $idx - 2); $i <= min(count($titel) - 1, $idx + 2); $i++) {
            $nachbarn[] = $titel[$i] + ['aktuell' => $i === $idx];
        }
        $danach = null;
        for ($i = $idx + 1; $i < count($titel); $i++) {
            if ($titel[$i]['vorhanden']) {
                $danach = $titel[$i];
                break;
            }
        }
        $aus[] = ['id' => (int) $u['id'], 'name' => $u['name'], 'nr' => $idx + 1, 'gesamt' => count($titel),
            'gesehen' => count(array_filter($titel, static fn($t) => $t['gesehen'])), 'nachbarn' => $nachbarn, 'danach' => $danach];
    }
    return $aus;
}

// ---------- Bearbeiten ----------

function universum_hinzufuegen(int $uid, string $art, int $id, ?int $abschnitt = null): int
{
    $filme = [];
    $serien = [];
    if ($art === 'reihe') {
        $filme = array_map('intval', array_column(db_alle('SELECT id FROM filme WHERE reihe_id = :r ORDER BY reihe_position IS NULL, reihe_position, jahr, id', ['r' => $id]), 'id'));
    } elseif ($art === 'film') {
        $filme = db_wert('SELECT id FROM filme WHERE id = :i', ['i' => $id]) ? [$id] : [];
    } elseif ($art === 'serie') {
        $serien = db_wert('SELECT id FROM serien WHERE id = :i', ['i' => $id]) ? [$id] : [];
    }
    if ($abschnitt !== null && !db_wert('SELECT id FROM universum_abschnitte WHERE id = :a AND universum_id = :u', ['a' => $abschnitt, 'u' => $uid])) {
        $abschnitt = null;
    }
    // ohne Angabe: in den letzten Abschnitt (falls es welche gibt)
    $abschnitt ??= ($a = db_wert('SELECT id FROM universum_abschnitte WHERE universum_id = :u ORDER BY position DESC, id DESC LIMIT 1', ['u' => $uid])) ? (int) $a : null;
    $pos = (float) db_wert('SELECT COALESCE(MAX(position), 0) FROM universum_eintraege WHERE universum_id = :u', ['u' => $uid]);
    $n = 0;
    foreach ($filme as $f) {
        $n += db_tun("INSERT IGNORE INTO universum_eintraege (universum_id, art, film_id, position, abschnitt_id) VALUES (:u, 'film', :f, :p, :a)",
            ['u' => $uid, 'f' => $f, 'p' => ++$pos, 'a' => $abschnitt]);
    }
    foreach ($serien as $s) {
        if (db_wert('SELECT id FROM universum_eintraege WHERE universum_id = :u AND serie_id = :s LIMIT 1', ['u' => $uid, 's' => $s])) {
            continue;
        }
        $n += db_tun("INSERT IGNORE INTO universum_eintraege (universum_id, art, serie_id, position, abschnitt_id) VALUES (:u, 'serie', :s, :p, :a)",
            ['u' => $uid, 's' => $s, 'p' => ++$pos, 'a' => $abschnitt]);
    }
    return $n;
}

/**
 * Ordnung speichern: $daten = ['ohne' => [eid…], 'abschnitte' => [['id' => int|null, 'name' => '…', 'eintraege' => [eid…]], …]]
 * Abschnitte, die fehlen, werden gelöscht (ihre Titel bleiben ohne Abschnitt), neue (id null) angelegt.
 */
/** Abschnitte eines Universums in Baum-Reihenfolge (vorab sortiert), mit Tiefe */
function universum_abschnitte_baum(int $uid): array
{
    $alle = db_alle('SELECT id, name, eltern_id, position FROM universum_abschnitte WHERE universum_id = :u ORDER BY position, id', ['u' => $uid]);
    $kinder = [];
    $ids = array_map('intval', array_column($alle, 'id'));
    foreach ($alle as $a) {
        $e = $a['eltern_id'] !== null && in_array((int) $a['eltern_id'], $ids, true) ? (int) $a['eltern_id'] : 0;
        $kinder[$e][] = ['id' => (int) $a['id'], 'name' => $a['name'], 'eltern_id' => $e ?: null];
    }
    $aus = [];
    $gehen = static function (int $e, int $tiefe) use (&$gehen, &$kinder, &$aus): void {
        foreach ($kinder[$e] ?? [] as $k) {
            $aus[] = $k + ['tiefe' => $tiefe];
            $gehen($k['id'], $tiefe + 1);
        }
    };
    $gehen(0, 0);
    return $aus;
}

/**
 * Reihenfolge und Abschnitte speichern.
 * {ohne: [eintrag_id…], abschnitte: [{id?, name, eintraege: [eintrag_id…], unter: [ …gleich… ]}, …]}
 * Positionen werden in Baum-Reihenfolge vergeben (Abschnitt, seine Titel, dann seine Unterabschnitte).
 */
function universum_ordnung(int $uid, array $daten): void
{
    $vorhanden = array_map('intval', array_column(db_alle('SELECT id FROM universum_abschnitte WHERE universum_id = :u', ['u' => $uid]), 'id'));
    $behalten = [];
    $pos = 0;
    $apos = 0;
    $setzen = static function (array $eids, ?int $abschnitt) use ($uid, &$pos): void {
        foreach ($eids as $eid) {
            db_tun('UPDATE universum_eintraege SET position = :p, abschnitt_id = :a WHERE id = :e AND universum_id = :u', ['p' => ++$pos, 'a' => $abschnitt, 'e' => (int) $eid, 'u' => $uid]);
        }
    };
    $setzen((array) ($daten['ohne'] ?? []), null);
    $ebene = static function (array $liste, ?int $eltern, int $tiefe) use (&$ebene, &$behalten, &$apos, $vorhanden, $uid, $setzen): void {
        foreach (array_values($liste) as $i => $a) {
            if (!is_array($a)) {
                continue;
            }
            $name = mb_substr(trim((string) ($a['name'] ?? '')), 0, 120) ?: 'Abschnitt ' . ($i + 1);
            $aid = isset($a['id']) && in_array((int) $a['id'], $vorhanden, true) ? (int) $a['id'] : null;
            if ($aid) {
                db_tun('UPDATE universum_abschnitte SET name = :n, position = :p, eltern_id = :e WHERE id = :id', ['n' => $name, 'p' => $apos++, 'e' => $eltern, 'id' => $aid]);
            } else {
                $aid = db_einfuegen('INSERT INTO universum_abschnitte (universum_id, eltern_id, name, position) VALUES (:u, :e, :n, :p)', ['u' => $uid, 'e' => $eltern, 'n' => $name, 'p' => $apos++]);
            }
            $behalten[] = $aid;
            $setzen((array) ($a['eintraege'] ?? []), $aid);
            if ($tiefe < 5) {
                $ebene((array) ($a['unter'] ?? []), $aid, $tiefe + 1);
            }
        }
    };
    $ebene((array) ($daten['abschnitte'] ?? []), null, 0);
    $weg = array_diff($vorhanden, $behalten);
    if ($weg) {
        // erst Verweise lösen, dann löschen (Reihenfolge der Fremdschlüssel egal)
        db_tun('UPDATE universum_abschnitte SET eltern_id = NULL WHERE id IN (' . implode(',', $weg) . ')');
        db_tun('DELETE FROM universum_abschnitte WHERE id IN (' . implode(',', $weg) . ')');
    }
}

/** Serien-Eintrag in Staffeln aufteilen (an derselben Stelle) bzw. Staffeln wieder zu einer Serie zusammenführen */
function universum_staffeln(int $uid, int $eid, bool $teilen): int
{
    $e = db_zeile("SELECT * FROM universum_eintraege WHERE id = :e AND universum_id = :u AND art = 'serie'", ['e' => $eid, 'u' => $uid]);
    if (!$e) {
        throw new RuntimeException('Kein Serien-Eintrag.');
    }
    if (!$teilen) {
        db_tun('DELETE FROM universum_eintraege WHERE universum_id = :u AND serie_id = :s AND id <> :e', ['u' => $uid, 's' => $e['serie_id'], 'e' => $eid]);
        db_tun('UPDATE universum_eintraege SET staffel = 0 WHERE id = :e', ['e' => $eid]);
        return 1;
    }
    $staffeln = array_map('intval', array_column(db_alle('SELECT DISTINCT staffel_nr FROM folgen WHERE serie_id = :s AND staffel_nr > 0 ORDER BY staffel_nr', ['s' => $e['serie_id']]), 'staffel_nr'));
    if (count($staffeln) < 2) {
        throw new RuntimeException('Die Serie hat nur eine Staffel.');
    }
    // vorhandene Reihenfolge holen, den Eintrag durch die Staffeln ersetzen, neu durchnummerieren
    $reihe = array_map('intval', array_column(db_alle('SELECT e.id FROM universum_eintraege e LEFT JOIN universum_abschnitte a ON a.id = e.abschnitt_id
        WHERE e.universum_id = :u ORDER BY a.id IS NOT NULL, a.position, a.id, e.position IS NULL, e.position, e.id', ['u' => $uid]), 'id'));
    db_tun('UPDATE universum_eintraege SET staffel = :st WHERE id = :e', ['st' => $staffeln[0], 'e' => $eid]);
    $neu = [$eid];
    foreach (array_slice($staffeln, 1) as $st) {
        $neu[] = db_einfuegen("INSERT INTO universum_eintraege (universum_id, art, serie_id, staffel, position, abschnitt_id) VALUES (:u, 'serie', :s, :st, 0, :a)",
            ['u' => $uid, 's' => $e['serie_id'], 'st' => $st, 'a' => $e['abschnitt_id']]);
    }
    $i = array_search($eid, $reihe, true);
    array_splice($reihe, $i === false ? count($reihe) : $i, 1, $neu);
    foreach ($reihe as $p => $id) {
        db_tun('UPDATE universum_eintraege SET position = :p WHERE id = :e', ['p' => $p + 1, 'e' => $id]);
    }
    return count($neu);
}

/** Innerhalb jedes Abschnitts nach Erscheinungsdatum sortieren */
function universum_nach_erscheinung(int $uid): void
{
    $titel = universum_titel($uid, 0);
    $gruppen = [];
    foreach ($titel as $t) {
        $gruppen[$t['abschnitt_id'] ?? 0][] = $t;
    }
    $pos = 0;
    foreach ($gruppen as $liste) {
        usort($liste, static fn($a, $b) => [$a['datum'], $a['titel']] <=> [$b['datum'], $b['titel']]);
        foreach ($liste as $t) {
            db_tun('UPDATE universum_eintraege SET position = :p WHERE id = :e', ['p' => ++$pos, 'e' => $t['eintrag_id']]);
        }
    }
}

/** Vorschläge: fehlende Teile von Reihen, die schon im Universum stecken, und Titel mit den typischen TMDB-Stichwörtern */
function universum_vorschlaege(int $uid): array
{
    $drin = ['film' => [], 'serie' => []];
    foreach (db_alle("SELECT art, film_id, serie_id FROM universum_eintraege WHERE universum_id = :u", ['u' => $uid]) as $e) {
        if ($e['film_id']) {
            $drin['film'][(int) $e['film_id']] = true;
        }
        if ($e['serie_id']) {
            $drin['serie'][(int) $e['serie_id']] = true;
        }
    }
    $aus = [];
    $dazu = static function (array $z, string $art, string $grund) use (&$aus, $drin): void {
        $k = $art . $z['id'];
        if (isset($drin[$art][(int) $z['id']]) || isset($aus[$k])) {
            return;
        }
        $aus[$k] = ['art' => $art, 'id' => (int) $z['id'], 'titel' => $z['titel'], 'jahr' => $z['jahr'] ? (int) $z['jahr'] : null,
            'poster' => bild_url($z['poster']), 'grund' => $grund];
    };
    if ($drin['film']) {
        foreach (db_alle('SELECT f.id, f.titel, f.jahr, f.poster, r.name AS reihe FROM filme f JOIN reihen r ON r.id = f.reihe_id
            WHERE f.reihe_id IN (SELECT reihe_id FROM filme WHERE id IN (' . implode(',', array_keys($drin['film'])) . ') AND reihe_id IS NOT NULL)
            ORDER BY f.erscheinungsdatum') as $z) {
            $dazu($z, 'film', 'Aus der Reihe „' . $z['reihe'] . '“');
        }
    }
    // Stichwörter, die bei mindestens 40 % (und 2) der Titel vorkommen
    $zaehler = [];
    $mitglieder = 0;
    foreach (['film' => 'filme', 'serie' => 'serien'] as $art => $tab) {
        if (!$drin[$art]) {
            continue;
        }
        foreach (db_alle("SELECT stichwoerter FROM $tab WHERE id IN (" . implode(',', array_keys($drin[$art])) . ')') as $z) {
            $mitglieder++;
            foreach (array_unique(json_decode((string) $z['stichwoerter'], true) ?: []) as $w) {
                $zaehler[$w] = ($zaehler[$w] ?? 0) + 1;
            }
        }
    }
    $typisch = array_keys(array_filter($zaehler, static fn($n) => $n >= max(2, (int) ceil($mitglieder * 0.4))));
    if ($typisch) {
        foreach (['film' => 'filme', 'serie' => 'serien'] as $art => $tab) {
            $jahr = $art === 'film' ? 'jahr' : 'jahr_von AS jahr';
            foreach (db_alle("SELECT id, titel, $jahr, poster, stichwoerter FROM $tab WHERE stichwoerter IS NOT NULL") as $z) {
                $w = array_values(array_intersect($typisch, json_decode((string) $z['stichwoerter'], true) ?: []));
                if ($w) {
                    $dazu($z, $art, 'Stichwort „' . $w[0] . '“');
                }
            }
        }
    }
    return array_slice(array_values($aus), 0, 40);
}

/** Universen eines Titels auf genau diese setzen (von der Detailseite aus) */
function titel_universen_setzen(string $art, int $id, array $uids): void
{
    $spalte = $art === 'film' ? 'film_id' : 'serie_id';
    $soll = array_map('intval', $uids);
    $ist = array_map('intval', array_column(db_alle("SELECT DISTINCT universum_id FROM universum_eintraege WHERE $spalte = :id", ['id' => $id]), 'universum_id'));
    foreach (array_diff($ist, $soll) as $u) {
        db_tun("DELETE FROM universum_eintraege WHERE universum_id = :u AND $spalte = :id", ['u' => $u, 'id' => $id]);
    }
    foreach (array_diff($soll, $ist) as $u) {
        if (db_wert('SELECT id FROM universen WHERE id = :u', ['u' => $u])) {
            universum_hinzufuegen($u, $art, $id);
        }
    }
}
