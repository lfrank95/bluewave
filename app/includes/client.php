<?php
// Windows-Client im Image: CI legt den Installer samt version.json unter /opt/bluewave/client ab (CLIENT_PFAD zum Überschreiben).
// Der Client fragt hier nach neuen Versionen und lädt sie von hier – das Repository ist privat, GitHub bleibt außen vor.
declare(strict_types=1);
require_once __DIR__ . '/config.php';

function client_ordner(): string
{
    $p = getenv('CLIENT_PFAD');
    return rtrim($p !== false && trim($p) !== '' ? trim($p) : '/opt/bluewave/client', '/');
}

/** {version, datei, groesse, sha256, gebaut} oder null, wenn das Image keinen Client enthält */
function client_info(): ?array
{
    $j = json_decode((string) @file_get_contents(client_ordner() . '/version.json'), true);
    if (!is_array($j) || !preg_match('/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/', (string) ($j['version'] ?? ''))
        || !preg_match('/^[A-Za-z0-9._-]+\.exe$/', (string) ($j['datei'] ?? ''))) {
        return null;
    }
    $pfad = client_ordner() . '/' . $j['datei'];
    if (!is_file($pfad)) {
        return null;
    }
    return ['version' => (string) $j['version'], 'datei' => (string) $j['datei'], 'groesse' => filesize($pfad),
        'sha256' => preg_match('/^[0-9a-f]{64}$/', (string) ($j['sha256'] ?? '')) ? (string) $j['sha256'] : null,
        'gebaut' => (string) ($j['gebaut'] ?? ''), 'url' => '/api/v1/client/download'];
}

function client_senden(): never
{
    $i = client_info();
    if (!$i) {
        bw_json(['fehler' => 'Dieses Image enthält keinen Windows-Client.'], 404);
    }
    $pfad = client_ordner() . '/' . $i['datei'];
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    header('Content-Type: application/vnd.microsoft.portable-executable');
    header('Content-Disposition: attachment; filename="' . $i['datei'] . '"');
    header('Content-Length: ' . $i['groesse']);
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
        readfile($pfad);
    }
    exit;
}
