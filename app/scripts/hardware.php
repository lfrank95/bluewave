<?php
// Hardware erkennen und im Log ausgeben. Beim Start: php scripts/hardware.php --start
// Zum Nachsehen: docker exec bluewave_app php /var/www/html/scripts/hardware.php [--test]
declare(strict_types=1);
require_once __DIR__ . '/../includes/hardware.php';

$hw = hw_erkennen();
$name = ENCODER_PROFILE[$hw['aktiv']]['name'] ?? $hw['aktiv'];
echo 'Transkodieren: ' . $name . ' (eingestellt: ' . $hw['wunsch'] . ')' . "\n";
if (!empty($hw['quicksync']['verfuegbar'])) {
    $q = $hw['quicksync'];
    $ja = static fn(bool $b): string => $b ? 'ja' : 'nein';
    echo '  Treiber: ' . ($q['treiber'] ?? '?') . "\n";
    echo '  Dekodieren: HEVC 10-Bit ' . $ja((bool) $q['dekodieren']['hevc10']) . ', AV1 ' . $ja((bool) $q['dekodieren']['av1']) . "\n";
    echo '  Kodieren: H.264 ' . $ja((bool) $q['kodieren']['h264']) . ', HEVC ' . $ja((bool) $q['kodieren']['hevc']) . ', AV1 ' . $ja((bool) $q['kodieren']['av1']) . "\n";
    echo '  Tone-Mapping: ' . $ja((bool) $q['tonemapping']) . "\n";
}
foreach ($hw['warnungen'] as $w) {
    echo '  Hinweis: ' . $w . "\n";
}
if (in_array('--test', $argv, true)) {
    foreach (hw_testen()['laeufe'] as $l) {
        echo '  Test ' . $l['name'] . ': ' . ($l['ok'] ? $l['echtzeit'] . '× Echtzeit (' . $l['fps'] . ' fps)' : 'Fehler – ' . $l['fehler']) . "\n";
    }
}
