<?php
// Wiedergabe-Diagnose: Player (Browser) und Server schreiben Ereignisse mit Zeitstempel in eine gemeinsame Protokolldatei,
// zugeordnet über eine Diagnose-Kennung pro Wiedergabe. In der Verwaltung als Zeitleiste lesbar.
declare(strict_types=1);
require_once __DIR__ . '/config.php';

const DIAG_MAX_BYTES = 8 * 1024 * 1024;

function diag_datei(): string
{
    return konfig()['pfade']['cache'] . '/logs/wiedergabe.jsonl';
}

/** Kennung der laufenden Wiedergabe aus Kopfzeile oder Adresse (vom Player mitgeschickt) */
function diag_kennung(): ?string
{
    $k = (string) ($_SERVER['HTTP_X_BLUEWAVE_DIAG'] ?? $_GET['diag'] ?? '');
    return preg_match('/^[a-z0-9]{6,32}$/', $k) ? $k : null;
}

/** Ereignis vom Server protokollieren (nur wenn eine Kennung bekannt ist) */
function diag(string $ereignis, array $daten = [], ?string $kennung = null): void
{
    $kennung ??= diag_kennung();
    if ($kennung === null) {
        return;
    }
    diag_schreiben([['k' => $kennung, 'q' => 'server', 't' => (int) round(microtime(true) * 1000), 'e' => $ereignis, 'd' => $daten]]);
}

function diag_schreiben(array $zeilen): void
{
    $datei = diag_datei();
    @mkdir(dirname($datei), 0775, true);
    clearstatcache(true, $datei);
    if (@filesize($datei) > DIAG_MAX_BYTES) {
        // ältere Hälfte verwerfen
        $alt = (string) @file_get_contents($datei, false, null, (int) (DIAG_MAX_BYTES / 2));
        @file_put_contents($datei, substr($alt, (int) strpos($alt, "\n") + 1), LOCK_EX);
    }
    $text = '';
    foreach ($zeilen as $z) {
        $text .= json_encode($z, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
    }
    @file_put_contents($datei, $text, FILE_APPEND | LOCK_EX);
}

/** Ereignisse vom Player annehmen: {k, start: {...}, ereignisse: [{t, e, d}]} */
function diag_annehmen(array $e, array $konto): void
{
    $k = (string) ($e['k'] ?? '');
    if (!preg_match('/^[a-z0-9]{6,32}$/', $k)) {
        return;
    }
    $zeilen = [];
    if (!empty($e['start']) && is_array($e['start'])) {
        $zeilen[] = ['k' => $k, 'q' => 'info', 't' => (int) round(microtime(true) * 1000), 'e' => 'sitzung',
            'd' => array_slice($e['start'], 0, 20) + ['konto' => $konto['anzeigename'] ?? $konto['name'] ?? '', 'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
                'ua' => mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 300)]];
    }
    foreach (array_slice((array) ($e['ereignisse'] ?? []), 0, 500) as $x) {
        if (!is_array($x) || !isset($x['e'])) {
            continue;
        }
        $zeilen[] = ['k' => $k, 'q' => 'player', 't' => (int) ($x['t'] ?? 0), 'e' => mb_substr((string) $x['e'], 0, 40),
            'd' => is_array($x['d'] ?? null) ? array_slice($x['d'], 0, 20) : []];
    }
    if ($zeilen) {
        diag_schreiben($zeilen);
    }
}

/** Letzte Wiedergaben (neueste zuerst) mit allen Ereignissen */
function diag_lesen(int $anzahl = 30): array
{
    $roh = @file(diag_datei(), FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
    $sitzungen = [];
    foreach ($roh as $zeile) {
        $z = json_decode($zeile, true);
        if (!is_array($z) || empty($z['k'])) {
            continue;
        }
        $s = &$sitzungen[$z['k']];
        $s ??= ['k' => $z['k'], 'info' => [], 'ereignisse' => []];
        if ($z['q'] === 'info') {
            $s['info'] = $z['d'] + $s['info'];
            $s['beginn'] ??= $z['t'];
        } else {
            $s['ereignisse'][] = $z;
        }
        unset($s);
    }
    foreach ($sitzungen as &$s) {
        usort($s['ereignisse'], static fn($a, $b) => $a['t'] <=> $b['t']);
        $s['beginn'] = $s['ereignisse'][0]['t'] ?? ($s['beginn'] ?? 0);
    }
    unset($s);
    usort($sitzungen, static fn($a, $b) => $b['beginn'] <=> $a['beginn']);
    return array_slice($sitzungen, 0, $anzahl);
}
