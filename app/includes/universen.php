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
    $zeilen = db_alle('SELECT e.id AS eid, e.art, e.film_id, e.serie_id, e.position, e.abschnitt_id, a.name AS abschnitt, a.position AS apos
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
    $gesehenFolgen = [];
    $angefangenFolgen = [];
    if ($serieIds) {
        foreach (db_alle("SELECT fo.serie_id, SUM(w.gesehen) AS g, COUNT(*) AS n FROM wiedergabe w JOIN folgen fo ON fo.id = w.ziel_id
            WHERE w.konto_id = :k AND w.art = 'folge' AND fo.serie_id IN (" . implode(',', $serieIds) . ') AND fo.staffel_nr > 0 GROUP BY fo.serie_id', ['k' => $konto]) as $z) {
            $gesehenFolgen[(int) $z['serie_id']] = (int) $z['g'];
            $angefangenFolgen[(int) $z['serie_id']] = (int) $z['n'];
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
            $folgen = (int) $s['folgen'];
            $g = $gesehenFolgen[(int) $s['id']] ?? 0;
            $aus[] = ['eintrag_id' => (int) $z['eid'], 'art' => 'serie', 'id' => (int) $s['id'], 'titel' => $s['titel'], 'jahr' => $s['jahr_von'] ? (int) $s['jahr_von'] : null,
                'datum' => $s['start'] ?: ($s['jahr_von'] ? $s['jahr_von'] . '-07-01' : '9999'), 'poster' => bild_url($s['poster']), 'hintergrund' => bild_url($s['hintergrund']),
                'zusatz' => 'Serie' . ($s['jahr_von'] ? ' · ' . $s['jahr_von'] : '') . ($folgen ? ' · ' . $folgen . ' ' . ($folgen === 1 ? 'Folge' : 'Folgen') : ''),
                'vorhanden' => $folgen > 0, 'gesehen' => $folgen > 0 && $g >= $folgen, 'prozent' => $folgen > 0 && $g < $folgen ? (int) round($g * 100 / $folgen) : 0,
                'angefangen' => ($angefangenFolgen[(int) $s['id']] ?? 0) > 0,
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
            'poster' => $poster, 'hintergrund' => $hg, 'eintraege' => count($titel), 'filme' => $filme, 'serien' => count($titel) - $filme,
            'von' => $jahre ? min($jahre) : null, 'bis' => $jahre ? max($jahre) : null,
            'gesehen' => count(array_filter($titel, static fn($t) => $t['gesehen'])),
            'collage' => array_slice(array_values(array_filter(array_column($titel, 'poster'))), 0, 6),
            'zusatz' => count($titel) . ' Titel'];
    }
    return $aus;
}

/** Erster nicht gesehener, vorhandener Titel – bei Serien mit der passenden Folge */
function universum_naechstes(array $titel, int $konto): ?array
{
    foreach ($titel as $t) {
        if ($t['gesehen'] || !$t['vorhanden']) {
            continue;
        }
        if ($t['art'] === 'serie') {
            $n = naechste_folge_fuer($t['id'], $konto);
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
    // Gruppen: bei eigener Reihenfolge nach Abschnitten, sonst eine Liste
    $gruppen = [];
    if ($sort === 'eigen') {
        foreach ($titel as $t) {
            $k = $t['abschnitt_id'] ?? 0;
            $gruppen[$k] ??= ['id' => $t['abschnitt_id'], 'name' => $t['abschnitt'], 'titel' => []];
            $gruppen[$k]['titel'][] = $t;
        }
        // leere Abschnitte (für den Editor sichtbar)
        foreach (db_alle('SELECT id, name FROM universum_abschnitte WHERE universum_id = :u ORDER BY position, id', ['u' => $id]) as $a) {
            $gruppen[(int) $a['id']] ??= ['id' => (int) $a['id'], 'name' => $a['name'], 'titel' => []];
        }
        // Reihenfolge der Abschnitte: ohne Abschnitt zuerst, dann nach Position
        $pos = array_flip(array_map('intval', array_column(db_alle('SELECT id FROM universum_abschnitte WHERE universum_id = :u ORDER BY position, id', ['u' => $id]), 'id')));
        uksort($gruppen, static fn($a, $b) => ($a === 0 ? -1 : $pos[$a] ?? 999) <=> ($b === 0 ? -1 : $pos[$b] ?? 999));
    } else {
        $gruppen[0] = ['id' => null, 'name' => null, 'titel' => $titel];
    }
    foreach ($gruppen as &$g) {
        $f = count(array_filter($g['titel'], static fn($t) => $t['art'] === 'film'));
        $s = count($g['titel']) - $f;
        $ges = count(array_filter($g['titel'], static fn($t) => $t['gesehen']));
        $teile = array_filter([$f ? $f . ' ' . ($f === 1 ? 'Film' : 'Filme') : null, $s ? $s . ' ' . ($s === 1 ? 'Serie' : 'Serien') : null]);
        $g['info'] = implode(' · ', $teile) . ($g['titel'] ? ($ges === count($g['titel']) ? ' · alle gesehen' : ($ges ? ' · ' . $ges . ' gesehen' : '')) : '');
    }
    unset($g);
    $filme = count(array_filter($titel, static fn($t) => $t['art'] === 'film'));
    $jahre = array_filter(array_column($titel, 'jahr'));
    return [
        'art' => 'universum', 'id' => $id, 'name' => $u['name'], 'beschreibung' => $u['beschreibung'], 'poster' => $poster, 'hintergrund' => $hg,
        'bild' => $u['bild'] ? bild_url($u['bild']) : null, 'sortierung' => $sort,
        'zahlen' => ['filme' => $filme, 'serien' => count($titel) - $filme, 'gesamt' => count($titel), 'von' => $jahre ? min($jahre) : null, 'bis' => $jahre ? max($jahre) : null,
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
        foreach ($titel as $i => $t) {
            if ($t['art'] === $art && $t['id'] === $id) {
                $idx = $i;
                break;
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
        $n += db_tun("INSERT IGNORE INTO universum_eintraege (universum_id, art, serie_id, position, abschnitt_id) VALUES (:u, 'serie', :s, :p, :a)",
            ['u' => $uid, 's' => $s, 'p' => ++$pos, 'a' => $abschnitt]);
    }
    return $n;
}

/**
 * Ordnung speichern: $daten = ['ohne' => [eid…], 'abschnitte' => [['id' => int|null, 'name' => '…', 'eintraege' => [eid…]], …]]
 * Abschnitte, die fehlen, werden gelöscht (ihre Titel bleiben ohne Abschnitt), neue (id null) angelegt.
 */
function universum_ordnung(int $uid, array $daten): void
{
    $vorhanden = array_map('intval', array_column(db_alle('SELECT id FROM universum_abschnitte WHERE universum_id = :u', ['u' => $uid]), 'id'));
    $behalten = [];
    $pos = 0;
    $setzen = static function (array $eids, ?int $abschnitt) use ($uid, &$pos): void {
        foreach ($eids as $eid) {
            db_tun('UPDATE universum_eintraege SET position = :p, abschnitt_id = :a WHERE id = :e AND universum_id = :u', ['p' => ++$pos, 'a' => $abschnitt, 'e' => (int) $eid, 'u' => $uid]);
        }
    };
    $setzen((array) ($daten['ohne'] ?? []), null);
    foreach (array_values((array) ($daten['abschnitte'] ?? [])) as $i => $a) {
        $name = mb_substr(trim((string) ($a['name'] ?? '')), 0, 120) ?: 'Abschnitt ' . ($i + 1);
        $aid = isset($a['id']) && in_array((int) $a['id'], $vorhanden, true) ? (int) $a['id'] : null;
        if ($aid) {
            db_tun('UPDATE universum_abschnitte SET name = :n, position = :p WHERE id = :id', ['n' => $name, 'p' => $i, 'id' => $aid]);
        } else {
            $aid = db_einfuegen('INSERT INTO universum_abschnitte (universum_id, name, position) VALUES (:u, :n, :p)', ['u' => $uid, 'n' => $name, 'p' => $i]);
        }
        $behalten[] = $aid;
        $setzen((array) ($a['eintraege'] ?? []), $aid);
    }
    foreach (array_diff($vorhanden, $behalten) as $weg) {
        db_tun('DELETE FROM universum_abschnitte WHERE id = :id', ['id' => $weg]);
    }
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
