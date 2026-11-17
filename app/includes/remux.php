<?php
// Direct Stream: das Video bleibt unverändert (kein Umrechnen), nur der Container wird zu fragmentiertem MP4 und – falls
// das Gerät ihn nicht kann – der Ton zu AAC. Fast keine CPU-Last, volle Bildqualität. Gestreamt wird fortlaufend
// (ffmpeg → PHP → Browser); Spulen außerhalb des Puffers startet den Strom am nächsten Schlüsselbild davor neu.
declare(strict_types=1);
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/db.php';

/** Tonformate, die in MP4 kopiert werden dürfen, wenn das Gerät sie kann */
const REMUX_TON_KOPIE = ['aac', 'mp3', 'opus', 'ac3', 'eac3', 'flac'];

/**
 * Geht Direct Stream? Video muss das Gerät können (Codec, HDR, Bittiefe), keine Bild-Untertitel zum Einbrennen,
 * Auflösung/Bitrate innerhalb der Grenze. Container, Tonformat und Tonspur sind egal – genau dafür ist es da.
 * @return array{0: bool, 1: string, 2: string} [geht, Grund, Tonmodus copy|eac3|aac]
 */
function remux_moeglich(array $d, array $ton, array $faehig, array $grenze, ?array $untertitel, int $tonIndex): array
{
    $vc = strtolower((string) $d['video_codec']);
    $vName = ['h264' => 'h264', 'hevc' => 'hevc', 'av1' => 'av1', 'vp9' => 'vp9'][$vc] ?? null;
    if (!$vName || empty($faehig['video'][$vName])) {
        return [false, 'Video ' . $vc, ''];
    }
    if ($vName === 'vp9') {
        return [false, 'VP9 nicht in MP4', ''];
    }
    if ($d['hdr'] !== 'sdr' && empty($faehig['hdr'])) {
        return [false, 'HDR', ''];
    }
    if ((int) $d['bittiefe'] > 8 && $vName === 'h264') {
        return [false, '10-Bit H.264', ''];
    }
    if ($untertitel && untertitel_ist_bild((string) $untertitel['format'])) {
        return [false, 'Bild-Untertitel einbrennen', ''];
    }
    if ($grenze['bitrate_k'] > 0 && (int) $d['bitrate'] > $grenze['bitrate_k'] * 1000 * 1.1) {
        return [false, 'Bitrate', ''];
    }
    if ((int) $d['hoehe'] > $grenze['hoehe'] + 40) {
        return [false, 'Auflösung', ''];
    }
    $ac = '';
    foreach ($ton as $t) {
        if ((int) $t['strom_index'] === $tonIndex) {
            $ac = strtolower((string) $t['codec']);
        }
    }
    $kopie = $ac !== '' && in_array($ac, REMUX_TON_KOPIE, true) && !empty($faehig['audio'][$ac]);
    return [true, '', $kopie ? 'copy' : (!empty($faehig['audio']['eac3']) ? 'eac3' : 'aac')];
}

/** Schlüsselbild an oder vor $start (Sekunden ab Dateianfang) – dort beginnt der Strom, das ist der Versatz der Zeitleiste */
function remux_schluesselbild(string $pfad, float $start): float
{
    if ($start <= 0.5) {
        return 0.0;
    }
    $k = konfig()['transkodieren'];
    $r = bw_ausfuehren([$k['ffprobe'], '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
        '-read_intervals', sprintf('%.3f%%%.3f', max(0, $start - 20), $start + 0.3),
        '-show_entries', 'frame=best_effort_timestamp_time,pts_time:format=start_time', '-of', 'json', $pfad], 20);
    $j = json_decode((string) $r['aus'], true);
    $basis = (float) ($j['format']['start_time'] ?? 0);
    $best = 0.0;
    foreach ($j['frames'] ?? [] as $f) {
        $t = (float) ($f['best_effort_timestamp_time'] ?? $f['pts_time'] ?? -1) - $basis;
        if ($t >= 0 && $t <= $start + 0.05 && $t > $best) {
            $best = $t;
        }
    }
    return round($best, 3);
}

/**
 * $absolut: Zeitstempel der Datei behalten (Strom ab 48 s beginnt auch bei 48 s) – für den MSE-Player, der so
 * eine durchgehende Zeitleiste hat und schon geladene Stücke behält. Sonst beginnt der Strom bei 0 (einfacher Player).
 */
function remux_befehl(string $pfad, float $start, int $tonIndex, string $tonModus, int $kanaele, bool $hevc, bool $absolut = false): array
{
    $k = konfig()['transkodieren'];
    $cmd = [$k['ffmpeg'], '-hide_banner', '-nostdin', '-loglevel', 'error', '-fflags', '+genpts'];
    if ($start > 0) {
        $cmd = array_merge($cmd, ['-ss', sprintf('%.3f', $start)]);
    }
    if ($absolut) {
        $cmd = array_merge($cmd, ['-copyts', '-start_at_zero']);
    }
    $cmd = array_merge($cmd, ['-i', $pfad, '-map', '0:v:0', '-map', '0:a:' . $tonIndex . '?', '-c:v', 'copy']);
    if ($hevc) {
        $cmd = array_merge($cmd, ['-tag:v', 'hvc1']);
    }
    if ($tonModus === 'copy') {
        $cmd = array_merge($cmd, ['-c:a', 'copy']);
    } elseif ($tonModus === 'eac3') {
        // Dolby Digital Plus bis 5.1 (z. B. DTS-HD auf einem Fernseher ohne DTS)
        $ac = max(1, min(6, $kanaele ?: 2));
        $cmd = array_merge($cmd, ['-c:a', 'eac3', '-ac', (string) $ac, '-b:a', ($ac > 2 ? 640 : 256) . 'k']);
    } else {
        // Raumklang bleibt erhalten (bis 5.1), das Gerät mischt bei Bedarf selbst herunter
        $ac = max(1, min(6, $kanaele ?: 2));
        $cmd = array_merge($cmd, ['-c:a', 'aac', '-ac', (string) $ac, '-b:a', ($ac > 2 ? 384 : 192) . 'k']);
    }
    // kurze Fragmente (1 s): das erste Bild ist schneller da; frag_discont hält die echten Zeitstempel im Fragment
    return array_merge($cmd, ['-sn', '-dn', '-avoid_negative_ts', $absolut ? 'disabled' : 'make_zero', '-max_muxing_queue_size', '4096',
        '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof' . ($absolut ? '+frag_discont' : ''), '-frag_duration', '1000000', 'pipe:1']);
}

/** Strom ausliefern, solange der Browser liest; bricht er ab, wird ffmpeg beendet.
 *  $token: pro Player – ein neuer Strom desselben Players beendet den alten sofort (wichtig über den Tunnel,
 *  wo ein Abbruch erst spät ankommt; sonst lesen mehrere ffmpeg gleichzeitig dieselbe große Datei). */
function remux_senden(array $cmd, string $token = ''): never
{
    $pidDatei = preg_match('/^[a-z0-9]{8,40}$/', $token) ? konfig()['pfade']['transkodieren'] . '/remux-' . $token . '.pid' : null;
    if ($pidDatei && ($alt = (int) @file_get_contents($pidDatei)) > 0 && @posix_kill($alt, 0)
        && str_contains((string) @file_get_contents("/proc/$alt/cmdline"), 'ffmpeg')) {
        posix_kill($alt, SIGKILL);
    }
    @set_time_limit(0);
    ignore_user_abort(true);
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    header('Content-Type: video/mp4');
    header('Cache-Control: no-store');
    header('Accept-Ranges: none');
    header('X-Accel-Buffering: no');
    if (function_exists('apache_setenv')) {
        @apache_setenv('no-gzip', '1');
    }
    $p = proc_open($cmd, [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $rohre);
    if (!is_resource($p)) {
        http_response_code(500);
        exit;
    }
    $meinPid = (int) (proc_get_status($p)['pid'] ?? 0);
    if ($pidDatei && $meinPid) {
        @mkdir(dirname($pidDatei), 0775, true);
        @file_put_contents($pidDatei, (string) $meinPid);
    }
    // große Lesehappen: PHP liest Pipes sonst in 8-KB-Stücken (viele Systemaufrufe und Mini-Pakete bei 50+ Mbit/s)
    stream_set_chunk_size($rohre[1], 1024 * 1024);
    stream_set_read_buffer($rohre[1], 0);
    while (!feof($rohre[1])) {
        $stueck = fread($rohre[1], 1024 * 1024);
        if ($stueck === false) {
            break;
        }
        if ($stueck === '') {
            continue;
        }
        echo $stueck;
        flush();
        if (connection_aborted()) {
            break;
        }
    }
    fclose($rohre[1]);
    $st = proc_get_status($p);
    if ($st['running']) {
        posix_kill($st['pid'], SIGKILL);
    }
    proc_close($p);
    if ($pidDatei && (int) @file_get_contents($pidDatei) === $meinPid) {
        @unlink($pidDatei);
    }
    exit;
}

/** WebVTT um $ms nach vorn verschieben (für Direct Stream, dessen Zeitleiste beim Neustart bei 0 beginnt) */
function vtt_verschieben(string $vtt, int $ms): string
{
    if ($ms <= 0) {
        return $vtt;
    }
    $zeit = static function (string $t) use ($ms): ?string {
        $teile = explode(':', $t);
        $sek = array_pop($teile);
        $h = count($teile) === 2 ? (int) $teile[0] : 0;
        $m = (int) end($teile);
        $neu = (int) round((($h * 3600 + $m * 60) + (float) $sek) * 1000) - $ms;
        if ($neu < 0) {
            return null;
        }
        return sprintf('%02d:%02d:%02d.%03d', intdiv($neu, 3600000), intdiv($neu % 3600000, 60000), intdiv($neu % 60000, 1000), $neu % 1000);
    };
    $bloecke = preg_split('/\R\R+/', $vtt) ?: [];
    $aus = [];
    foreach ($bloecke as $b) {
        if (preg_match('/^(.*?)((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})(.*)$/s', $b, $m)) {
            $ende = $zeit($m[3]);
            if ($ende === null) {
                continue; // vorbei
            }
            $anf = $zeit($m[2]) ?? '00:00:00.000';
            $aus[] = $m[1] . $anf . ' --> ' . $ende . $m[4];
        } else {
            $aus[] = $b;
        }
    }
    return implode("\n\n", $aus) . "\n";
}
