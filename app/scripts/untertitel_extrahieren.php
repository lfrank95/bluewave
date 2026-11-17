<?php
// Alle eingebetteten Text-Untertitel einer Datei in einem Durchgang nach WebVTT (läuft im Hintergrund, niedrige Priorität).
// Aufruf: php untertitel_extrahieren.php <datei_id>
declare(strict_types=1);
require_once __DIR__ . '/../includes/config.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/hilfen.php';
require_once __DIR__ . '/../includes/wiedergabe.php';

$dateiId = (int) ($argv[1] ?? 0);
$sperre = konfig()['pfade']['cache'] . '/untertitel/extrahieren-' . $dateiId . '.laeuft';
@mkdir(dirname($sperre), 0775, true);
file_put_contents($sperre, (string) getmypid());
try {
    $liste = db_alle("SELECT u.*, d.pfad AS video FROM untertitel u JOIN dateien d ON d.id = u.datei_id WHERE u.datei_id = :d AND u.quelle = 'eingebettet'", ['d' => $dateiId]);
    $ziele = [];
    $cmd = [konfig()['transkodieren']['ffmpeg'], '-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
    $video = null;
    foreach ($liste as $u) {
        if (untertitel_ist_bild((string) $u['format'])) {
            continue;
        }
        $cache = untertitel_cache_pfad($u);
        if (is_file($cache)) {
            continue;
        }
        $video ??= (string) $u['video'];
        $tmp = $cache . '.' . bin2hex(random_bytes(3)) . '.tmp';
        $ziele[$tmp] = $cache;
        array_push($cmd, '-map', '0:s:' . (int) $u['strom_index'], '-c:s', 'webvtt', '-f', 'webvtt', $tmp);
    }
    if ($ziele && $video) {
        // Eingang vor die Ausgaben: nur Untertitel-Ströme lesen, Video/Ton verwerfen
        array_splice($cmd, 6, 0, ['-i', $video]);
        $r = bw_ausfuehren($cmd, 4 * 3600);
        foreach ($ziele as $tmp => $cache) {
            if ($r['code'] === 0 && is_file($tmp)) {
                rename($tmp, $cache);
            } else {
                @unlink($tmp);
            }
        }
    }
} finally {
    @unlink($sperre);
}
