<?php
// Encoder-Profile: QuickSync ist der Hauptweg, Software der Fallback. NVENC und VA-API (AMD) sind vorgesehen und kommen
// später als weiteres Profil dazu – ohne Umbau: Jedes Profil liefert nur seine Geräte-Argumente, Filter und Encoder.
declare(strict_types=1);
require_once __DIR__ . '/config.php';

const ENCODER_PROFILE = [
    'quicksync' => ['name' => 'Intel QuickSync', 'umgesetzt' => true],
    'software' => ['name' => 'Software (CPU)', 'umgesetzt' => true],
    'nvenc' => ['name' => 'NVIDIA NVENC', 'umgesetzt' => false],
    'vaapi' => ['name' => 'VA-API (AMD)', 'umgesetzt' => false],
];

/** Encoder je Ziel-Codec und Profil */
function encoder_name(string $profil, string $codec): string
{
    $tab = [
        'quicksync' => ['h264' => 'h264_qsv', 'hevc' => 'hevc_qsv', 'av1' => 'av1_qsv'],
        'software' => ['h264' => 'libx264', 'hevc' => 'libx265', 'av1' => 'libsvtav1'],
    ];
    return $tab[$profil][$codec] ?? throw new InvalidArgumentException("Kein Encoder für $codec mit Profil $profil");
}

/** Geräte-Argumente vor der Eingabe (QuickSync: VA-API-Gerät öffnen und QSV davon ableiten, wie jellyfin-ffmpeg unter Linux) */
function encoder_geraet_args(string $profil, string $geraet): array
{
    if ($profil !== 'quicksync') {
        return [];
    }
    return ['-init_hw_device', 'vaapi=va:' . $geraet . ',driver=iHD', '-init_hw_device', 'qsv=qs@va', '-filter_hw_device', 'qs'];
}

/** Gerade Zielmaße bei gleichem Seitenverhältnis (nie hochskalieren) */
function encoder_zielmasse(int $qb, int $qh, int $maxH): array
{
    if ($qb <= 0 || $qh <= 0) {
        return [0, $maxH];
    }
    $h = min($qh, $maxH);
    $b = (int) (round($qb * $h / $qh / 2) * 2);
    return [$b, (int) (round($h / 2) * 2)];
}

/**
 * Baut den ffmpeg-Aufruf für einen Transkodier-Auftrag.
 * $a = [
 *   'eingabe' => Datei | ['lavfi' => 'testsrc2=…'],  'start_s' => float, 'dauer_s' => ?float,
 *   'quelle' => ['breite' => int, 'hoehe' => int, 'hdr' => bool, 'hw_dekodieren' => bool],
 *   'video' => ['codec' => h264|hevc|av1, 'hoehe' => int, 'bitrate_k' => int, 'tonemap' => bool],
 *   'audio' => null | ['strom' => int, 'codec' => aac|opus|copy, 'kanaele' => int, 'bitrate_k' => int],
 *   'ziel' => ['format' => hls|null|mp4, 'ordner' => …],
 * ]
 * $hw = Ergebnis der Hardware-Erkennung (für Gerät und verfügbare Filter)
 */
function encoder_befehl(string $profil, array $a, array $hw): array
{
    if (!(ENCODER_PROFILE[$profil]['umgesetzt'] ?? false)) {
        throw new InvalidArgumentException("Profil $profil ist noch nicht umgesetzt");
    }
    $k = konfig()['transkodieren'];
    $v = $a['video'];
    $q = $a['quelle'] ?? [];
    $lavfi = is_array($a['eingabe']);
    $geraet = (string) ($hw['quicksync']['geraet'] ?? '/dev/dri/renderD128');
    [$b, $h] = encoder_zielmasse((int) ($q['breite'] ?? 0), (int) ($q['hoehe'] ?? 0), (int) $v['hoehe']);
    $tonemap = !empty($v['tonemap']) && !empty($q['hdr']);

    $cmd = [$k['ffmpeg'], '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-stats_period', '1', '-progress', 'pipe:1'];
    $cmd = array_merge($cmd, encoder_geraet_args($profil, $geraet));

    // Hardware-Dekodieren nur bei echten Dateien und wenn die GPU das Format kann (sonst dekodiert die CPU, kodiert die GPU)
    $hwDekodieren = $profil === 'quicksync' && !$lavfi && !empty($q['hw_dekodieren']);
    if ($hwDekodieren) {
        $cmd = array_merge($cmd, ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-hwaccel_device', 'va']);
    }
    if (!empty($a['start_s'])) {
        $cmd = array_merge($cmd, ['-ss', sprintf('%.3f', (float) $a['start_s'])]);
    }
    if ($lavfi) {
        $cmd = array_merge($cmd, ['-f', 'lavfi', '-i', (string) $a['eingabe']['lavfi']]);
    } else {
        $cmd = array_merge($cmd, ['-i', (string) $a['eingabe']]);
    }
    if (!empty($a['dauer_s'])) {
        $cmd = array_merge($cmd, ['-t', sprintf('%.3f', (float) $a['dauer_s'])]);
    }

    // ---- Video-Filter ----
    if ($profil === 'quicksync') {
        $kette = $hwDekodieren ? ['hwmap=derive_device=qsv', 'format=qsv'] : ['format=' . ($tonemap ? 'p010le' : 'nv12'), 'hwupload=extra_hw_frames=64'];
        $vpp = 'vpp_qsv=' . ($b > 0 ? 'w=' . $b . ':h=' . $h : 'h=' . $h) . ':format=nv12';
        if ($tonemap) {
            $vpp .= ':tonemap=1';
        }
        $kette[] = $vpp;
    } else {
        $kette = [];
        if ($tonemap) {
            $kette[] = !empty($hw['filter']['tonemapx'])
                ? 'tonemapx=tonemap=bt2390:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=yuv420p'
                : 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
        }
        $kette[] = 'scale=' . ($b > 0 ? $b . ':' . $h : '-2:' . $h) . ':flags=lanczos';
        $kette[] = 'format=yuv420p';
    }
    $cmd = array_merge($cmd, ['-map', '0:v:0', '-vf', implode(',', $kette)]);

    // ---- Video-Encoder ----
    $bitrate = max(500, (int) $v['bitrate_k']);
    $cmd = array_merge($cmd, ['-c:v', encoder_name($profil, (string) $v['codec'])]);
    if ($profil === 'quicksync') {
        $cmd = array_merge($cmd, ['-preset', 'veryfast', '-look_ahead', '0']);
    } elseif ($v['codec'] === 'av1') {
        $cmd = array_merge($cmd, ['-preset', '10']);
    } else {
        $cmd = array_merge($cmd, ['-preset', 'veryfast']);
    }
    $cmd = array_merge($cmd, [
        '-b:v', $bitrate . 'k', '-maxrate', (int) ($bitrate * 1.5) . 'k', '-bufsize', ($bitrate * 2) . 'k',
        // feste Schlüsselbilder alle 6 s = HLS-Segmentgrenzen (Spulen ohne Neustart)
        '-force_key_frames', 'expr:gte(t,n_forced*6)',
    ]);
    if ($v['codec'] === 'hevc') {
        $cmd = array_merge($cmd, ['-tag:v', 'hvc1']); // Apple/Safari spielt HEVC nur mit hvc1
    }

    // ---- Ton ----
    $au = $a['audio'] ?? null;
    if ($au === null) {
        $cmd[] = '-an';
    } else {
        $cmd = array_merge($cmd, ['-map', '0:a:' . (int) ($au['strom'] ?? 0)]);
        if (($au['codec'] ?? 'aac') === 'copy') {
            $cmd = array_merge($cmd, ['-c:a', 'copy']);
        } else {
            // Neutral umwandeln: keine Kompression, keine Normalisierung (Nachtmodus & Co. rechnet später das Gerät, nur wenn eingeschaltet)
            $cmd = array_merge($cmd, [
                '-c:a', ($au['codec'] ?? 'aac') === 'opus' ? 'libopus' : 'aac',
                '-ac', (string) (int) ($au['kanaele'] ?? 2), '-b:a', (int) ($au['bitrate_k'] ?? 192) . 'k',
            ]);
        }
    }
    $cmd[] = '-sn';

    // ---- Ziel ----
    $z = $a['ziel'] ?? ['format' => 'null'];
    switch ($z['format']) {
        case 'hls':
            $o = rtrim((string) $z['ordner'], '/');
            $cmd = array_merge($cmd, [
                '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4',
                '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', $o . '/teil_%05d.m4s',
                '-start_number', '0', $o . '/index.m3u8',
            ]);
            break;
        case 'mp4':
            $cmd = array_merge($cmd, ['-movflags', '+faststart', (string) $z['datei']]);
            break;
        default:
            $cmd = array_merge($cmd, ['-f', 'null', '-']);
    }
    return $cmd;
}
