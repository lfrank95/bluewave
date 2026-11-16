<?php
// Zentrale Konfiguration – liest nur aus Umgebungsvariablen (.env bzw. Unraid-Vorlage). Nie Zugangsdaten im Klartext hier.
// Nutzereinstellungen (Sprache, Untertitel, Autoplay …) kommen später in die App, nicht hierher.
declare(strict_types=1);

if (!function_exists('konfig')) {

/** Zufälliger App-Schlüssel (64 Hex) im Cache-Ordner – wird einmal erzeugt und bleibt */
function konfig_app_schluessel(string $cache): string
{
    $p = $cache . '/.app_secret_key';
    $alt = is_file($p) ? trim((string) @file_get_contents($p)) : '';
    if (preg_match('/^[0-9a-f]{64}$/', $alt)) {
        return $alt;
    }
    $neu = bin2hex(random_bytes(32));
    @mkdir($cache, 0775, true);
    if (@file_put_contents($p . '.tmp', $neu . "\n", LOCK_EX) !== false && @rename($p . '.tmp', $p)) {
        @chmod($p, 0600);
    }
    return $neu;
}

function konfig(): array
{
    static $k = null;
    if ($k !== null) {
        return $k;
    }
    $env = static function (string $name, string $standard = ''): string {
        $w = getenv($name);
        return ($w === false || trim($w) === '') ? $standard : trim($w);
    };
    $zahl = static function (string $name, int $standard) use ($env): int {
        $w = $env($name, (string) $standard);
        return is_numeric($w) ? (int) $w : $standard;
    };

    $cache = rtrim($env('PFAD_CACHE', '/cache'), '/');
    $zone = $env('APP_ZEITZONE', 'Europe/Berlin');
    if (!@date_default_timezone_set($zone)) {
        date_default_timezone_set('Europe/Berlin');
    }

    $hw = strtolower($env('HWACCEL', 'auto'));
    if (!in_array($hw, ['auto', 'quicksync', 'nvenc', 'vaapi', 'software'], true)) {
        $hw = 'auto';
    }

    $k = [
        'version' => '0.1.0-dev.1',
        'app_name' => 'Bluewave',
        'zeitzone' => date_default_timezone_get(),
        'db' => [
            'host' => $env('DB_HOST', 'db'),
            'port' => $zahl('DB_PORT', 3306),
            'name' => $env('DB_NAME', 'bluewave'),
            'user' => $env('DB_USER', 'bluewave'),
            'password' => $env('DB_PASSWORD'),
            'quelle' => $env('DB_PASSWORD') !== '' ? 'env' : 'keine',
        ],
        'pfade' => [
            'filme' => rtrim($env('PFAD_FILME', '/filme'), '/'),
            'serien' => rtrim($env('PFAD_SERIEN', '/serien'), '/'),
            'cache' => $cache,
            'backups' => rtrim($env('PFAD_BACKUPS', '/backups'), '/'),
            'transkodieren' => rtrim($env('PFAD_TRANSKODIEREN', '/transkodieren'), '/'),
        ],
        'transkodieren' => [
            // Gewünschtes Encoder-Profil aus Vorlage/.env; was wirklich läuft, entscheidet hardware.php
            'hwaccel' => $hw,
            'ffmpeg' => $env('FFMPEG_PFAD', is_file('/usr/lib/jellyfin-ffmpeg/ffmpeg') ? '/usr/lib/jellyfin-ffmpeg/ffmpeg' : 'ffmpeg'),
            'ffprobe' => $env('FFPROBE_PFAD', is_file('/usr/lib/jellyfin-ffmpeg/ffprobe') ? '/usr/lib/jellyfin-ffmpeg/ffprobe' : 'ffprobe'),
            'vainfo' => $env('VAINFO_PFAD', is_file('/usr/lib/jellyfin-ffmpeg/vainfo') ? '/usr/lib/jellyfin-ffmpeg/vainfo' : 'vainfo'),
            'max_gleichzeitig' => max(1, $zahl('TRANSKODIER_MAX', 4)),
        ],
        'app_secret_key' => $env('APP_SECRET_KEY'),
    ];

    // Datenbank-Zugang: .env hat Vorrang, sonst das, was Bluewave beim ersten Start selbst angelegt hat
    if ($k['db']['quelle'] === 'keine') {
        $d = @json_decode((string) @file_get_contents($cache . '/geheimnisse/datenbank.json'), true);
        if (is_array($d) && !empty($d['name']) && !empty($d['user']) && !empty($d['passwort'])) {
            $k['db']['name'] = (string) $d['name'];
            $k['db']['user'] = (string) $d['user'];
            $k['db']['password'] = (string) $d['passwort'];
            $k['db']['quelle'] = 'datei';
        }
    }
    if ($k['app_secret_key'] === '') {
        $k['app_secret_key'] = konfig_app_schluessel($cache);
    }
    return $k;
}

}

return konfig();
