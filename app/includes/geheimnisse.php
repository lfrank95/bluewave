<?php
// Geheimnisse im Cache-Ordner (geheimnisse/, Rechte 0700/0600): Datenbank-Zugang, Root-Notfallpasswort
declare(strict_types=1);
require_once __DIR__ . '/config.php';

function geheimnisse_ordner(): string
{
    $d = konfig()['pfade']['cache'] . '/geheimnisse';
    if (!is_dir($d)) {
        @mkdir($d, 0700, true);
    }
    return $d;
}

function geheimnis_lesen(string $name): string
{
    $p = geheimnisse_ordner() . '/' . $name;
    return is_file($p) ? trim((string) @file_get_contents($p)) : '';
}

/** Atomar schreiben, nur für den Webserver-Benutzer lesbar */
function geheimnis_schreiben(string $name, string $inhalt): bool
{
    $p = geheimnisse_ordner() . '/' . $name;
    $tmp = $p . '.' . bin2hex(random_bytes(3)) . '.tmp';
    if (@file_put_contents($tmp, $inhalt . "\n", LOCK_EX) === false) {
        @unlink($tmp);
        return false;
    }
    @chmod($tmp, 0600);
    if (!@rename($tmp, $p)) {
        @unlink($tmp);
        return false;
    }
    return true;
}
