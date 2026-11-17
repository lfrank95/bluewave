<?php
// Router für den Oberflächentest des Clients: liefert app/ aus und beantwortet die nötigen API-Aufrufe mit festen Daten
// (ohne Datenbank).  php -S 127.0.0.1:PORT -t app windows-client/tests/oberflaeche_router.php
$pfad = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (!str_starts_with($pfad, '/api/v1/')) {
    if ($pfad === '/' || $pfad === '/index.php') {
        putenv('PFAD_CACHE=' . sys_get_temp_dir() . '/bwtest-cache');
        require $_SERVER['DOCUMENT_ROOT'] . '/index.php';
        return true;
    }
    return false;   // statische Dateien
}
header('Content-Type: application/json');
$api = substr($pfad, 8);
$log = sys_get_temp_dir() . '/bwtest-api.log';
file_put_contents($log, $_SERVER['REQUEST_METHOD'] . ' ' . $api . ' ' . file_get_contents('php://input') . "\n", FILE_APPEND);
$einst = ['tonsprache' => 'deu', 'untertitel' => 'aus', 'untertitelsprache' => 'deu', 'autoplay' => 'countdown', 'countdown_s' => 10, 'intro' => 'knopf',
    'qualitaet_heim' => 'original', 'qualitaet_unterwegs' => '720', 'specials' => 'zeigen', 'aufloesung' => 'geraet', 'nachtmodus' => 'aus', 'dialog_db' => 0];
$antwort = match (true) {
    $api === 'ich' => ['id' => 1, 'benutzername' => 'lorenzo', 'anzeigename' => 'Lorenzo', 'rolle' => 'admin', 'einstellungen' => $einst, 'heimnetz' => true, 'version' => 'test', 'art' => 'browser'],
    $api === 'ich/geraete' => ['geraete' => []],
    $api === 'client/version' => ['version' => '0.2.0-beta.7', 'datei' => 'Bluewave-Windows-Client-0.2.0-beta.7.exe', 'groesse' => 150 * 1048576, 'sha256' => str_repeat('a', 64), 'url' => '/api/v1/client/download'],
    $api === 'wiedergabe/start' => [
        'art' => 'film', 'id' => 7, 'datei_id' => 12, 'dauer_ms' => 7200000, 'start_ms' => 600000, 'ton' => 0, 'untertitel_aktiv' => null,
        'tonspuren' => [['index' => 0, 'text' => 'DTS-HD MA 7.1', 'sprache' => 'deu', 'sprache_name' => 'Deutsch', 'kommentar' => false],
                        ['index' => 1, 'text' => 'Dolby TrueHD 7.1', 'sprache' => 'eng', 'sprache_name' => 'Englisch', 'kommentar' => false]],
        'untertitel' => [['id' => 3, 'sprache' => 'deu', 'sprache_name' => 'Deutsch', 'erzwungen' => true, 'sdh' => false, 'bild' => true, 'url' => null, 'titel' => null, 'eingebettet' => true, 'strom_index' => 1, 'datei_url' => null],
                         ['id' => 4, 'sprache' => 'eng', 'sprache_name' => 'Englisch', 'erzwungen' => false, 'sdh' => false, 'bild' => false, 'url' => '/api/v1/untertitel/4.vtt', 'titel' => null, 'eingebettet' => false, 'strom_index' => 0, 'datei_url' => '/api/v1/untertitel/4/datei']],
        'marker' => [], 'info' => ['titel' => 'Testfilm', 'untertitel' => null], 'naechste' => null, 'heimnetz' => true, 'vorschau' => null,
        'qualitaet' => 'auto', 'qualitaet_einstellung' => 'original', 'qualitaeten' => ['original', '2160', '1080'],
        'quelle' => ['hoehe' => 2160, 'video_codec' => 'HEVC', 'container' => 'mkv', 'bitrate_k' => 60000, 'hdr' => true],
        'modus' => 'direkt', 'url' => '/api/v1/datei/12/inhalt', 'grund' => ''],
    default => ['ok' => true],
};
echo json_encode($antwort);
return true;
