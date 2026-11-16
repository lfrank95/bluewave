<?php
// Hintergrund-Aufträge (Scan, Metadaten, Intro-Erkennung, Untertitel) – immer nur einer gleichzeitig.
declare(strict_types=1);
require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/hilfen.php';

const AUFTRAG_ARTEN = ['scan', 'metadaten', 'metadaten_alle', 'marker', 'untertitel', 'alles'];

function auftrag_sperrdatei(): string
{
    $d = konfig()['pfade']['cache'] . '/tmp';
    @mkdir($d, 0775, true);
    return $d . '/auftrag.lock';
}

function auftrag_laeuft(): bool
{
    $fh = @fopen(auftrag_sperrdatei(), 'c');
    if (!$fh) {
        return false;
    }
    $frei = flock($fh, LOCK_EX | LOCK_NB);
    if ($frei) {
        flock($fh, LOCK_UN);
    }
    fclose($fh);
    return !$frei;
}

function auftrag_starten(string $art): bool
{
    if (!in_array($art, AUFTRAG_ARTEN, true) || auftrag_laeuft()) {
        return false;
    }
    $log = konfig()['pfade']['cache'] . '/auftrag.log';
    if (@filesize($log) > 2000000) {
        @file_put_contents($log, '');
    }
    $skript = realpath(__DIR__ . '/../scripts/auftrag.php');
    shell_exec('setsid ' . escapeshellarg(PHP_BINARY ?: 'php') . ' ' . escapeshellarg($skript) . ' ' . escapeshellarg($art)
        . ' >> ' . escapeshellarg($log) . ' 2>&1 < /dev/null &');
    return true;
}

function auftrag_status(): array
{
    $s = json_decode((string) system_wert('auftrag'), true) ?: [];
    $s['laeuft'] = auftrag_laeuft();
    return $s;
}
