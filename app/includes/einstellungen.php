<?php
// Server-Einstellungen (Admin, in der App): TMDB-Schlüssel, OpenSubtitles, Scan-Intervall, Aufräum-Schema …
// Schlüssel lassen sich auch über die .env setzen (TMDB_API_KEY, OPENSUBTITLES_API_KEY) – die .env hat dann Vorrang.
// Passwörter werden mit dem App-Schlüssel verschlüsselt abgelegt.
declare(strict_types=1);
require_once __DIR__ . '/db.php';

const SERVER_STANDARD = [
    'tmdb_schluessel' => '',
    'metadaten_sprache' => 'de-DE',
    'scan_minuten' => 15,
    'untertitel_auto' => true,
    'untertitel_sprachen' => 'deu',
    'opensubtitles_schluessel' => '',
    'opensubtitles_benutzer' => '',
    'opensubtitles_passwort' => '',
    'aufraeumen_film' => '{titel} ({jahr})/{titel} ({jahr}){ - fassung}',
    'aufraeumen_serie' => '{serie} ({jahr})/Staffel {staffel}/{serie} - S{staffel}E{folge} - {titel}',
];

function server_einstellungen(bool $neu = false): array
{
    static $e = null;
    if ($e !== null && !$neu) {
        return $e;
    }
    $roh = [];
    try {
        $roh = json_decode((string) db_wert("SELECT wert FROM system_werte WHERE schluessel = 'einstellungen'"), true) ?: [];
    } catch (Throwable $x) {
    }
    $e = array_replace(SERVER_STANDARD, array_intersect_key($roh, SERVER_STANDARD));
    if (($w = trim((string) getenv('TMDB_API_KEY'))) !== '') {
        $e['tmdb_schluessel'] = $w;
        $e['tmdb_aus_env'] = true;
    }
    if (($w = trim((string) getenv('OPENSUBTITLES_API_KEY'))) !== '') {
        $e['opensubtitles_schluessel'] = $w;
        $e['opensubtitles_aus_env'] = true;
    }
    $e['opensubtitles_passwort'] = geheim_entschluesseln((string) $e['opensubtitles_passwort']);
    return $e;
}

function server_einstellungen_speichern(array $neu): array
{
    $alt = server_einstellungen(true);
    $e = [];
    foreach (SERVER_STANDARD as $k => $std) {
        $v = array_key_exists($k, $neu) ? $neu[$k] : $alt[$k];
        $e[$k] = is_bool($std) ? (bool) $v : (is_int($std) ? (int) $v : trim((string) $v));
    }
    $e['scan_minuten'] = max(0, min(1440, $e['scan_minuten']));
    if (!preg_match('/^[a-z]{2}-[A-Z]{2}$/', $e['metadaten_sprache'])) {
        $e['metadaten_sprache'] = 'de-DE';
    }
    if (!empty($alt['tmdb_aus_env'])) {
        $e['tmdb_schluessel'] = (string) (json_decode((string) db_wert("SELECT wert FROM system_werte WHERE schluessel = 'einstellungen'"), true)['tmdb_schluessel'] ?? '');
    }
    $e['opensubtitles_passwort'] = geheim_verschluesseln($e['opensubtitles_passwort']);
    system_wert_setzen('einstellungen', (string) json_encode($e, JSON_UNESCAPED_UNICODE));
    return server_einstellungen(true);
}

function system_wert(string $schluessel): ?string
{
    try {
        $w = db_wert('SELECT wert FROM system_werte WHERE schluessel = :s', ['s' => $schluessel]);
        return $w === null ? null : (string) $w;
    } catch (Throwable $e) {
        return null;
    }
}

function system_wert_setzen(string $schluessel, ?string $wert): void
{
    db_tun('INSERT INTO system_werte (schluessel, wert) VALUES (:s, :w) ON DUPLICATE KEY UPDATE wert = VALUES(wert)', ['s' => $schluessel, 'w' => $wert]);
}

function geheim_schluessel(): string
{
    return hash('sha256', 'bluewave-geheim|' . konfig()['app_secret_key'], true);
}

function geheim_verschluesseln(string $klar): string
{
    if ($klar === '' || str_starts_with($klar, 'v1:')) {
        return $klar;
    }
    $n = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
    return 'v1:' . base64_encode($n . sodium_crypto_secretbox($klar, $n, geheim_schluessel()));
}

function geheim_entschluesseln(string $wert): string
{
    if (!str_starts_with($wert, 'v1:')) {
        return $wert;
    }
    $roh = base64_decode(substr($wert, 3), true);
    if ($roh === false || strlen($roh) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES) {
        return '';
    }
    $klar = sodium_crypto_secretbox_open(substr($roh, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), substr($roh, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), geheim_schluessel());
    return $klar === false ? '' : $klar;
}
