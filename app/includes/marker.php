<?php
// Intro und Abspann erkennen: Audio-Fingerabdrücke (Chromaprint über ffmpeg) der Folgen einer Staffel vergleichen –
// derselbe Abschnitt in mehreren Folgen ist das Intro (Anfang) bzw. der Abspann (Ende). Manuell gesetzte Marker gewinnen immer.
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';

const FP_SCHRITT = 0.1238;      // Sekunden je Fingerabdruck-Wert (Chromaprint: 4096/3 Samples bei 11025 Hz)
const INTRO_SUCHEN_S = 600;     // die ersten 10 Minuten
const ABSPANN_SUCHEN_S = 420;   // die letzten 7 Minuten
const MIN_LAENGE_S = 12;
const MAX_INTRO_S = 150;

/** Roh-Fingerabdruck (Liste von 32-Bit-Werten) eines Abschnitts */
function fingerabdruck(string $pfad, float $start, float $dauer): array
{
    $k = konfig()['transkodieren'];
    $cmd = [$k['ffmpeg'], '-hide_banner', '-nostdin', '-loglevel', 'error'];
    if ($start > 0) {
        $cmd = array_merge($cmd, ['-ss', sprintf('%.2f', $start)]);
    }
    $cmd = array_merge($cmd, ['-t', sprintf('%.2f', $dauer), '-i', $pfad, '-map', '0:a:0', '-ac', '1', '-f', 'chromaprint', '-fp_format', 'raw', '-']);
    $r = bw_ausfuehren($cmd, 240);
    if ($r['code'] !== 0 || strlen($r['aus']) < 400) {
        return [];
    }
    return array_values(unpack('V*', $r['aus']));
}

function bits_tabelle(): array
{
    static $t = null;
    if ($t === null) {
        $t = [];
        for ($i = 0; $i < 256; $i++) {
            $t[$i] = substr_count(decbin($i), '1');
        }
    }
    return $t;
}

function bit_abstand(int $a, int $b): int
{
    $x = ($a ^ $b) & 0xFFFFFFFF;
    $t = bits_tabelle();
    return $t[$x & 255] + $t[($x >> 8) & 255] + $t[($x >> 16) & 255] + $t[($x >> 24) & 255];
}

/**
 * Längsten gemeinsamen Abschnitt zweier Fingerabdrücke finden.
 * Liefert [startA, endeA, startB, endeB] in Sekunden (relativ) oder null.
 */
function gemeinsamer_abschnitt(array $a, array $b): ?array
{
    if (count($a) < 50 || count($b) < 50) {
        return null;
    }
    // Index über B: exakte Werte → Positionen; Verschiebungen auszählen
    $index = [];
    foreach ($b as $j => $v) {
        $index[$v][] = $j;
    }
    $stimmen = [];
    foreach ($a as $i => $v) {
        foreach ($index[$v] ?? [] as $j) {
            $d = $j - $i;
            $stimmen[$d] = ($stimmen[$d] ?? 0) + 1;
        }
    }
    if (!$stimmen) {
        return null;
    }
    arsort($stimmen);
    $bester = null;
    foreach (array_slice($stimmen, 0, 6, true) as $versatz => $anzahl) {
        if ($anzahl < 5) {
            break;
        }
        // entlang dieser Verschiebung: längster Lauf ähnlicher Werte (kleine Lücken erlaubt)
        $lauf = null;
        $start = null;
        $letzterTreffer = null;
        $iVon = max(0, -$versatz);
        $iBis = min(count($a), count($b) - $versatz);
        for ($i = $iVon; $i < $iBis; $i++) {
            $treffer = bit_abstand($a[$i], $b[$i + $versatz]) <= 8;
            if ($treffer) {
                if ($start === null || ($letzterTreffer !== null && $i - $letzterTreffer > 8)) {
                    $start = $i;
                }
                $letzterTreffer = $i;
                if ($lauf === null || ($letzterTreffer - $start) > ($lauf[1] - $lauf[0])) {
                    $lauf = [$start, $letzterTreffer];
                }
            }
        }
        if ($lauf && ($bester === null || ($lauf[1] - $lauf[0]) > ($bester[1] - $bester[0]))) {
            $bester = [$lauf[0], $lauf[1], $versatz];
        }
    }
    if (!$bester) {
        return null;
    }
    $laenge = ($bester[1] - $bester[0]) * FP_SCHRITT;
    if ($laenge < MIN_LAENGE_S) {
        return null;
    }
    return [$bester[0] * FP_SCHRITT, ($bester[1] + 1) * FP_SCHRITT, ($bester[0] + $bester[2]) * FP_SCHRITT, ($bester[1] + $bester[2] + 1) * FP_SCHRITT];
}

/** Marker speichern – nie über einen manuellen schreiben */
function marker_setzen(int $dateiId, string $art, int $startMs, int $endeMs, string $quelle, ?int $sicherheit = null): bool
{
    $alt = db_wert('SELECT quelle FROM marker WHERE datei_id = :d AND art = :a', ['d' => $dateiId, 'a' => $art]);
    if ($alt === 'manuell' && $quelle !== 'manuell') {
        return false;
    }
    db_tun('INSERT INTO marker (datei_id, art, start_ms, ende_ms, quelle, sicherheit) VALUES (:d, :a, :s, :e, :q, :si)
        ON DUPLICATE KEY UPDATE start_ms = VALUES(start_ms), ende_ms = VALUES(ende_ms), quelle = VALUES(quelle), sicherheit = VALUES(sicherheit)',
        ['d' => $dateiId, 'a' => $art, 's' => max(0, $startMs), 'e' => max($startMs + 1000, $endeMs), 'q' => $quelle, 'si' => $sicherheit]);
    return true;
}

/** Eine Staffel durchgehen. $dateien = [[id, pfad, dauer_ms], …] in Folgenreihenfolge */
function staffel_marker_erkennen(array $dateien): array
{
    $stat = ['intro' => 0, 'abspann' => 0];
    if (count($dateien) < 2) {
        return $stat;
    }
    $anfang = [];
    $ende = [];
    foreach ($dateien as $d) {
        $dauer = (int) $d['dauer_ms'] / 1000;
        $anfang[$d['id']] = fingerabdruck($d['pfad'], 0, min(INTRO_SUCHEN_S, $dauer * 0.4));
        $abStart = max($dauer * 0.6, $dauer - ABSPANN_SUCHEN_S);
        $ende[$d['id']] = ['ab' => $abStart, 'fp' => fingerabdruck($d['pfad'], $abStart, $dauer - $abStart)];
    }
    $ids = array_column($dateien, 'id');
    $dauern = array_column($dateien, 'dauer_ms', 'id');
    $intro = [];
    $abspann = [];
    // Jede Folge mit der nächsten (und die letzte mit der vorletzten) vergleichen; das längste Ergebnis gewinnt
    $paare = [];
    for ($i = 0; $i < count($ids); $i++) {
        $paare[] = [$ids[$i], $ids[$i + 1] ?? $ids[$i - 1]];
        if (isset($ids[$i + 2])) {
            $paare[] = [$ids[$i], $ids[$i + 2]];
        }
    }
    foreach ($paare as [$x, $y]) {
        $r = gemeinsamer_abschnitt($anfang[$x], $anfang[$y]);
        if ($r && ($r[1] - $r[0]) <= MAX_INTRO_S) {
            foreach ([[$x, $r[0], $r[1]], [$y, $r[2], $r[3]]] as [$id, $s, $e]) {
                if (!isset($intro[$id]) || ($e - $s) > ($intro[$id][1] - $intro[$id][0])) {
                    $intro[$id] = [$s, $e];
                }
            }
        }
        $r = gemeinsamer_abschnitt($ende[$x]['fp'], $ende[$y]['fp']);
        if ($r) {
            foreach ([[$x, $r[0]], [$y, $r[2]]] as [$id, $s]) {
                $abs = $ende[$id]['ab'] + $s;
                if (!isset($abspann[$id]) || $abs < $abspann[$id]) {
                    $abspann[$id] = $abs;
                }
            }
        }
    }
    foreach ($intro as $id => [$s, $e]) {
        // Intro direkt am Anfang: bei 0 beginnen lassen (kein Knopf für 2 Sekunden Vorlauf)
        $s = $s < 3 ? 0 : $s;
        $stat['intro'] += (int) marker_setzen((int) $id, 'intro', (int) round($s * 1000), (int) round($e * 1000), 'erkannt');
    }
    foreach ($abspann as $id => $s) {
        $stat['abspann'] += (int) marker_setzen((int) $id, 'abspann', (int) round($s * 1000), (int) $dauern[$id], 'erkannt');
    }
    return $stat;
}

/** Alle Staffeln mit Folgen ohne erkannte Marker */
function marker_erkennen_alle(?callable $stand = null): array
{
    $stat = ['staffeln' => 0, 'intro' => 0, 'abspann' => 0];
    $staffeln = db_alle("SELECT fo.serie_id, fo.staffel_nr FROM folgen fo JOIN dateien d ON d.folge_id = fo.id AND d.fehlt_seit IS NULL
        LEFT JOIN marker m ON m.datei_id = d.id AND m.art = 'intro'
        WHERE fo.staffel_nr IS NOT NULL GROUP BY fo.serie_id, fo.staffel_nr HAVING COUNT(DISTINCT d.id) >= 2 AND SUM(m.id IS NULL) > 0");
    foreach ($staffeln as $i => $st) {
        if ($stand) {
            $stand($i, count($staffeln));
        }
        // geprüfte Staffeln merken, damit Staffeln ohne Intro nicht bei jedem Lauf erneut gerechnet werden
        $schluessel = 'marker_geprueft_' . $st['serie_id'] . '_' . $st['staffel_nr'];
        $dateien = db_alle('SELECT d.id, d.pfad, d.dauer_ms FROM folgen fo JOIN dateien d ON d.folge_id = fo.id AND d.fehlt_seit IS NULL
            WHERE fo.serie_id = :s AND fo.staffel_nr = :n AND d.dauer_ms > 120000 ORDER BY fo.folge_nr', ['s' => $st['serie_id'], 'n' => $st['staffel_nr']]);
        $fingerprint = md5(implode(',', array_column($dateien, 'id')));
        if (db_wert('SELECT wert FROM system_werte WHERE schluessel = :k', ['k' => $schluessel]) === $fingerprint) {
            continue;
        }
        $r = staffel_marker_erkennen($dateien);
        db_tun('INSERT INTO system_werte (schluessel, wert) VALUES (:k, :w) ON DUPLICATE KEY UPDATE wert = VALUES(wert)', ['k' => $schluessel, 'w' => $fingerprint]);
        $stat['staffeln']++;
        $stat['intro'] += $r['intro'];
        $stat['abspann'] += $r['abspann'];
    }
    return $stat;
}
