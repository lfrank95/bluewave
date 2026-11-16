<?php
// JSON-API v1. Bis die Konten (aus Amberwave) da sind, ist alles außer /ping nur direkt aus dem Heimnetz erreichbar –
// über den Cloudflare Tunnel oder einen Proxy kommt niemand an die Verwaltung.
declare(strict_types=1);
require_once __DIR__ . '/../includes/hilfen.php';

$pfad = trim((string) ($_GET['pfad'] ?? ''), '/');
$methode = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($pfad === 'ping') {
    bw_json(['app' => 'bluewave', 'version' => konfig()['version']]);
}
if (!bw_ist_heimnetz()) {
    bw_json(['fehler' => 'Nur im Heimnetz erreichbar, bis die Anmeldung fertig ist.'], 403);
}
// Schreibende Aufrufe nur von der eigenen Seite (eigene Kopfzeile erzwingt beim Browser eine Vorabprüfung → kein CSRF)
if ($methode !== 'GET' && ($_SERVER['HTTP_X_BLUEWAVE'] ?? '') !== '1') {
    bw_json(['fehler' => 'Ungültige Anfrage.'], 400);
}

try {
    switch ("$methode $pfad") {
        case 'GET system':
            require_once __DIR__ . '/../includes/hardware.php';
            $k = konfig();
            $db = ['ok' => false, 'schema' => null, 'fehler' => null];
            try {
                require_once __DIR__ . '/../includes/db.php';
                $db['schema'] = (int) db_wert('SELECT COALESCE(MAX(version), 0) FROM schema_version');
                $db['ok'] = true;
                $db['version'] = (string) db_wert('SELECT VERSION()');
            } catch (Throwable $e) {
                $db['fehler'] = $e->getMessage();
            }
            $ordner = [];
            foreach (['filme' => 'Filme', 'serien' => 'Serien', 'cache' => 'Appdata (Cache)', 'transkodieren' => 'Transkodieren'] as $s => $n) {
                $p = $k['pfade'][$s];
                $ordner[] = ['name' => $n, 'pfad' => $p, 'da' => is_dir($p), 'lesbar' => is_readable($p), 'schreibbar' => is_writable($p)];
            }
            $hw = hw_lesen();
            bw_json([
                'version' => $k['version'],
                'datenbank' => $db,
                'ordner' => $ordner,
                'hardware' => $hw,
                'profile' => ENCODER_PROFILE,
            ]);
            // no break
        case 'POST system/hardware/erkennen':
            require_once __DIR__ . '/../includes/hardware.php';
            bw_json(['hardware' => hw_erkennen()]);
            // no break
        case 'POST system/hardware/test':
            require_once __DIR__ . '/../includes/hardware.php';
            @set_time_limit(240);
            bw_json(['test' => hw_testen()]);
            // no break
        default:
            bw_json(['fehler' => 'Unbekannt: ' . $pfad], 404);
    }
} catch (Throwable $e) {
    error_log('Bluewave API: ' . $e->getMessage());
    bw_json(['fehler' => $e->getMessage()], 500);
}
