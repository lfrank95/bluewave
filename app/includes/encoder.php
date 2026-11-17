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
 *   'video' => ['codec' => h264|hevc|av1|copy, 'hoehe' => int, 'bitrate_k' => int, 'tonemap' => bool],
 *   'audio' => null | ['strom' => int, 'codec' => aac|eac3|opus|copy, 'kanaele' => int, 'bitrate_k' => int],
 *   'schluesselbilder' => ffmpeg-Ausdruck für -force_key_frames (Teilgrenzen), sonst alle 6 s,
 *   'ziel' => ['format' => fmp4|null|mp4, 'datei' => …],   fmp4 = fragmentiertes MP4 auf stdout (für den Segmentierer)
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
    [$b, $h] = encoder_zielmasse((int) ($q['breite'] ?? 0), (int) ($q['hoehe'] ?? 0), (int) ($v['hoehe'] ?? 0));
    $tonemap = !empty($v['tonemap']) && !empty($q['hdr']);
    $kopie = ($v['codec'] ?? '') === 'copy'; // Video unverändert, nur Ton/Container neu

    $cmd = [$k['ffmpeg'], '-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
    $cmd = array_merge($cmd, encoder_geraet_args($profil, $geraet));

    $einbrennen = isset($a['einbrennen']) ? (int) $a['einbrennen'] : null; // Index des Bild-Untertitels (0:s:N)
    // Hardware-Dekodieren nur bei echten Dateien und wenn die GPU das Format kann (sonst dekodiert die CPU, kodiert die GPU).
    // Beim Einbrennen von Bild-Untertiteln dekodiert die CPU (Overlay), kodiert wird trotzdem auf der GPU.
    $hwDekodieren = $profil === 'quicksync' && !$lavfi && !empty($q['hw_dekodieren']) && $einbrennen === null && !$kopie;
    $fmp4 = ($a['ziel']['format'] ?? '') === 'fmp4';
    $start = (float) ($a['start_s'] ?? 0);
    if ($hwDekodieren) {
        $cmd = array_merge($cmd, ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-hwaccel_device', 'va']);
    }
    if ($start > 0) {
        $cmd = array_merge($cmd, ['-ss', sprintf('%.3f', $start)]);
    }
    if ($fmp4) {
        // Zeitstempel der Quelle behalten: jeder Teil trägt seine echte Filmzeit – passt zur fertigen Wiedergabeliste,
        // auch nach einem Neustart beim Spulen und quer über Teile verschiedener Encoder-Läufe (Zwischenspeicher)
        $cmd = array_merge($cmd, ['-copyts', '-start_at_zero']);
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
    if ($kopie) {
        $cmd = array_merge($cmd, ['-map', '0:v:0', '-c:v', 'copy']);
        if (strtolower((string) ($q['video_codec'] ?? '')) === 'hevc') {
            $cmd = array_merge($cmd, ['-tag:v', 'hvc1']); // Apple/Safari spielt HEVC nur mit hvc1
        }
    } elseif ($profil === 'quicksync') {
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
    if ($kopie) {
        // nichts weiter: Video bleibt, wie es ist
    } elseif ($einbrennen !== null) {
        // Bild-Untertitel (PGS/VobSub) über das Bild legen, dann wie gewohnt weiter
        $cmd = array_merge($cmd, ['-filter_complex', '[0:v:0][0:s:' . $einbrennen . ']overlay=eof_action=pass,' . implode(',', $kette) . '[v]', '-map', '[v]']);
    } else {
        $cmd = array_merge($cmd, ['-map', '0:v:0', '-vf', implode(',', $kette)]);
    }

    // ---- Video-Encoder ----
    if (!$kopie) {
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
            // Schlüsselbilder genau an den Teilgrenzen (t zählt ab dem ersten Bild); ohne Vorgabe alle 6 s
            '-force_key_frames', (string) ($a['schluesselbilder'] ?? 'expr:gte(t,n_forced*6)'),
        ]);
        if ($v['codec'] === 'hevc') {
            $cmd = array_merge($cmd, ['-tag:v', 'hvc1']); // Apple/Safari spielt HEVC nur mit hvc1
        }
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
                '-c:a', match ($au['codec'] ?? 'aac') { 'opus' => 'libopus', 'eac3' => 'eac3', default => 'aac' },
                '-ac', (string) (int) ($au['kanaele'] ?? 2), '-b:a', (int) ($au['bitrate_k'] ?? 192) . 'k',
            ]);
        }
    }
    $cmd[] = '-sn';

    // ---- Ziel ----
    $z = $a['ziel'] ?? ['format' => 'null'];
    switch ($z['format']) {
        case 'fmp4':
            // fragmentiertes MP4 auf stdout: ~1-s-Fragmente, neues Fragment an jedem Schlüsselbild (= Teilgrenze).
            // delay_moov: AC3/E-AC3 unverändert geht nur so; frag_discont + avoid_negative_ts: echte Zeitstempel (tfdt)
            // Zeitversatz für alle Läufe gleich: so wird die Dekodierzeit (B-Frames!) auch am Filmanfang nie negativ und der
            // Muxer verschiebt keinen Lauf – Teile verschiedener Läufe passen nahtlos aneinander
            if (!empty($a['zeit_versatz'])) {
                $cmd = array_merge($cmd, ['-output_ts_offset', sprintf('%.3f', (float) $a['zeit_versatz'])]);
            }
            $cmd = array_merge($cmd, [
                '-max_muxing_queue_size', '4096', '-avoid_negative_ts', 'disabled',
                '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+delay_moov+default_base_moof+frag_discont', '-frag_duration', '1000000', 'pipe:1',
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
