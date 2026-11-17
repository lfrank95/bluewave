<?php
// Läuft jede Minute (start.sh): liegengebliebene Streams aufräumen, Ordner regelmäßig auf Neues prüfen.
declare(strict_types=1);
require_once __DIR__ . '/../includes/auftrag.php';
require_once __DIR__ . '/../includes/wiedergabe.php';
require_once __DIR__ . '/../includes/vorarbeit.php';

try {
    sitzungen_aufraeumen();
    // Zwischenspeicher der umgewandelten Teile unter seiner Obergrenze halten
    hls_zwischenspeicher_aufraeumen(hls_limit_bytes((int) (server_einstellungen()['hls_zwischenspeicher_gb'] ?? 0)));
    db_tun('DELETE FROM kopplungen WHERE erstellt_am < NOW() - INTERVAL 15 MINUTE');
    // Hintergrundarbeit (optimierte Fassungen, Vorschaubilder) anstoßen – beendet sich selbst, wenn nichts zu tun ist
    if (!jemand_schaut()) {
        vorarbeit_starten();
    }
    $min = (int) server_einstellungen()['scan_minuten'];
    $letzter = strtotime((string) (system_wert('letzter_scan') ?? '')) ?: 0;
    if ($min > 0 && time() - $letzter >= $min * 60 && !auftrag_laeuft()) {
        auftrag_starten('alles');
    }
} catch (Throwable $e) {
    // Datenbank noch nicht bereit o. ä. – nächste Minute erneut
}
