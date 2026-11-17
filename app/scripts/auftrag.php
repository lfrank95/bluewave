<?php
// Hintergrund-Auftrag ausführen: php scripts/auftrag.php scan|metadaten|metadaten_alle|marker|untertitel|alles
declare(strict_types=1);
require_once __DIR__ . '/../includes/auftrag.php';
require_once __DIR__ . '/../includes/tmdb.php';
require_once __DIR__ . '/../includes/marker.php';
require_once __DIR__ . '/../includes/untertitel.php';
require_once __DIR__ . '/../includes/lokale_bilder.php';

$art = $argv[1] ?? 'alles';
if (!in_array($art, AUFTRAG_ARTEN, true)) {
    fwrite(STDERR, "Unbekannter Auftrag: $art\n");
    exit(1);
}
$fh = fopen(auftrag_sperrdatei(), 'c');
if (!$fh || !flock($fh, LOCK_EX | LOCK_NB)) {
    exit(0); // läuft schon
}
@set_time_limit(0);
$start = time();
system_wert_setzen('auftrag', (string) json_encode(['art' => $art, 'start' => date('c'), 'schritt' => 'Startet …', 'fertig' => 0, 'gesamt' => 0], JSON_UNESCAPED_UNICODE));
$ergebnis = [];
try {
    if ($art === 'scan' || $art === 'alles') {
        $ergebnis['scan'] = bibliothek_scannen();
    }
    if (in_array($art, ['metadaten', 'metadaten_alle', 'alles', 'scan'], true)) {
        $ergebnis['metadaten'] = metadaten_abgleichen($art === 'metadaten_alle');
        // Bilder aus den Medienordnern haben Vorrang vor TMDB
        $ergebnis['lokale_bilder'] = lokale_bilder_alle(static fn($i, $n) => auftrag_stand('Lokale Bilder', $i, $n));
        require_once __DIR__ . '/../includes/poster.php';
        eigene_poster_anwenden(); // per Link gesetzte Poster gewinnen immer
    }
    if ($art === 'marker' || $art === 'alles') {
        $ergebnis['marker'] = marker_erkennen_alle(static fn($i, $n) => auftrag_stand('Intro & Abspann erkennen', $i, $n));
    }
    if ($art === 'untertitel' || $art === 'alles') {
        auftrag_stand('Untertitel suchen', 0, 1);
        $ergebnis['untertitel'] = untertitel_alle_holen();
    }
} catch (Throwable $e) {
    $ergebnis['fehler'] = $e->getMessage();
    fwrite(STDERR, date('c') . " Auftrag $art: " . $e->getMessage() . "\n");
}
$st = json_decode((string) system_wert('auftrag'), true) ?: [];
$st = ['art' => $art, 'start' => $st['start'] ?? date('c', $start), 'ende' => date('c'), 'dauer_s' => time() - $start, 'ergebnis' => $ergebnis, 'schritt' => 'Fertig'];
system_wert_setzen('auftrag', (string) json_encode($st, JSON_UNESCAPED_UNICODE));
echo date('c') . " Auftrag $art fertig (" . (time() - $start) . " s): " . json_encode($ergebnis, JSON_UNESCAPED_UNICODE) . "\n";
flock($fh, LOCK_UN);
