<?php
// Steuerung der Hintergrundarbeit, die warten kann (optimierte Fassungen, Vorschaubilder): starten, Status, „jemand schaut“.
declare(strict_types=1);
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/hilfen.php';

function vorarbeit_datei(string $name): string
{
    $d = konfig()['pfade']['cache'] . '/tmp';
    @mkdir($d, 0775, true);
    return $d . '/' . $name;
}

/** Bei jeder Wiedergabe (Start, Fortschritt, Strom) aufrufen: solange das frisch ist, pausiert die Hintergrundarbeit */
function wiedergabe_aktiv_merken(): void
{
    @touch(vorarbeit_datei('wiedergabe.aktiv'));
}

function jemand_schaut(): bool
{
    clearstatcache();
    $f = vorarbeit_datei('wiedergabe.aktiv');
    $pause = max(1, (int) (getenv('VORARBEIT_PAUSE_S') ?: 90)); // nach der letzten Wiedergabe-Meldung so lange warten
    return is_file($f) && time() - (int) filemtime($f) < $pause;
}

function vorarbeit_laeuft(): bool
{
    $fh = @fopen(vorarbeit_datei('vorarbeit.lock'), 'c');
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

/** Arbeiter starten (falls er nicht schon läuft) – leise: niedrigste CPU- und Platten-Priorität */
function vorarbeit_starten(): bool
{
    if (vorarbeit_laeuft()) {
        return false;
    }
    $skript = realpath(__DIR__ . '/../scripts/vorarbeit.php');
    $nice = is_executable('/usr/bin/ionice') ? 'nice -n 19 ionice -c 3 ' : 'nice -n 19 ';
    $php = PHP_BINARY && !str_contains(PHP_BINARY, 'apache') && PHP_SAPI === 'cli' ? PHP_BINARY : 'php';
    $log = vorarbeit_datei('vorarbeit.log');
    if (@filesize($log) > 1000000) {
        @file_put_contents($log, '');
    }
    shell_exec('setsid ' . $nice . escapeshellarg($php) . ' ' . escapeshellarg((string) $skript) . ' >> ' . escapeshellarg($log) . ' 2>&1 < /dev/null &');
    return true;
}

function vorarbeit_status(): array
{
    $s = @json_decode((string) @file_get_contents(vorarbeit_datei('vorarbeit.json')), true) ?: [];
    $s['laeuft'] = vorarbeit_laeuft();
    $s['jemand_schaut'] = jemand_schaut();
    return $s;
}
