<?php
// Hardware-Erkennung: Was kann die Grafik (vainfo), funktionieren die QuickSync-Encoder wirklich (kurzer Probelauf),
// welche Filter hat ffmpeg – und welches Encoder-Profil läuft damit tatsächlich. Ergebnis: <Cache>/hardware.json
declare(strict_types=1);
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/encoder.php';

function hw_datei(): string
{
    return konfig()['pfade']['cache'] . '/hardware.json';
}

function hw_lesen(): ?array
{
    $d = @json_decode((string) @file_get_contents(hw_datei()), true);
    return is_array($d) ? $d : null;
}

/** Hersteller-Kennung (PCI) eines Render-Geräts */
function hw_hersteller(string $geraet): array
{
    $sys = '/sys/class/drm/' . basename($geraet) . '/device';
    $v = strtolower(trim((string) @file_get_contents($sys . '/vendor')));
    $d = strtolower(trim((string) @file_get_contents($sys . '/device')));
    $name = ['0x8086' => 'Intel', '0x10de' => 'NVIDIA', '0x1002' => 'AMD'][$v] ?? ($v !== '' ? 'Unbekannt' : '');
    return ['hersteller' => $name, 'vendor_id' => $v, 'device_id' => $d];
}

/** vainfo auswerten: Treiber und je Codec, ob dekodiert/kodiert werden kann */
function hw_vainfo(string $geraet): array
{
    $r = bw_ausfuehren([konfig()['transkodieren']['vainfo'], '--display', 'drm', '--device', $geraet], 15);
    $text = $r['aus'] . "\n" . $r['fehler'];
    $aus = ['ok' => $r['code'] === 0, 'treiber' => null, 'dekodieren' => [], 'kodieren' => [], 'fehler' => null];
    if (preg_match('/Driver version:\s*(.+)/', $text, $m)) {
        $aus['treiber'] = trim($m[1]);
    }
    preg_match_all('/^\s*(VAProfile\w+)\s*:\s*(VAEntrypoint\w+)/m', $text, $t, PREG_SET_ORDER);
    $profile = [];
    foreach ($t as $z) {
        $profile[$z[1]][] = $z[2];
    }
    $codecs = [
        'h264' => ['VAProfileH264Main', 'VAProfileH264High', 'VAProfileH264ConstrainedBaseline'],
        'hevc' => ['VAProfileHEVCMain'],
        'hevc10' => ['VAProfileHEVCMain10'],
        'vp9' => ['VAProfileVP9Profile0'],
        'vp9_10' => ['VAProfileVP9Profile2'],
        'av1' => ['VAProfileAV1Profile0'],
    ];
    foreach ($codecs as $codec => $namen) {
        $dek = false;
        $kod = false;
        foreach ($namen as $n) {
            foreach ($profile[$n] ?? [] as $ep) {
                $dek = $dek || $ep === 'VAEntrypointVLD';
                $kod = $kod || in_array($ep, ['VAEntrypointEncSlice', 'VAEntrypointEncSliceLP'], true);
            }
        }
        $aus['dekodieren'][$codec] = $dek;
        $aus['kodieren'][$codec] = $kod;
    }
    if (!$aus['ok']) {
        $aus['fehler'] = trim(substr($text, 0, 600));
    }
    return $aus;
}

/** 1 Sekunde Testbild mit einem QSV-Encoder – klappt das, kann die GPU diesen Codec wirklich */
function hw_qsv_probe(string $geraet, string $encoder, bool $zehnBit = false): array
{
    $k = konfig()['transkodieren'];
    $cmd = array_merge([$k['ffmpeg'], '-hide_banner', '-nostdin', '-loglevel', 'error'], encoder_geraet_args('quicksync', $geraet), [
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1',
        '-vf', 'format=' . ($zehnBit ? 'p010le' : 'nv12') . ',hwupload=extra_hw_frames=64',
        '-c:v', $encoder,
    ], $zehnBit ? ['-profile:v', 'main10'] : [], ['-f', 'null', '-']);
    $r = bw_ausfuehren($cmd, 20);
    return ['ok' => $r['code'] === 0, 'fehler' => $r['code'] === 0 ? null : trim(substr($r['fehler'], 0, 400))];
}

function hw_ffmpeg_liste(string $art): string
{
    return bw_ausfuehren([konfig()['transkodieren']['ffmpeg'], '-hide_banner', '-' . $art], 15)['aus'];
}

/** Komplette Erkennung (dauert ein paar Sekunden) und Speichern */
function hw_erkennen(): array
{
    $k = konfig()['transkodieren'];
    $ver = bw_ausfuehren([$k['ffmpeg'], '-hide_banner', '-version'], 10);
    $encoder = hw_ffmpeg_liste('encoders');
    $filter = hw_ffmpeg_liste('filters');
    $hatEnc = static fn(string $n): bool => (bool) preg_match('/^\s*V\S*\s+' . preg_quote($n, '/') . '\s/m', $encoder);
    $hatFilter = static fn(string $n): bool => (bool) preg_match('/^\s*\S*\s+' . preg_quote($n, '/') . '\s/m', $filter);

    $erg = [
        'zeit' => date('c'),
        'wunsch' => $k['hwaccel'],
        'aktiv' => 'software',
        'warnungen' => [],
        'ffmpeg' => [
            'pfad' => $k['ffmpeg'],
            'ok' => $ver['code'] === 0,
            'version' => preg_match('/ffmpeg version (\S+)/', $ver['aus'], $m) ? $m[1] : null,
            'jellyfin' => str_contains($ver['aus'], 'Jellyfin') || str_contains($k['ffmpeg'], 'jellyfin'),
        ],
        'geraete' => [],
        'quicksync' => ['verfuegbar' => false],
        'software' => [
            'h264' => $hatEnc('libx264'),
            'hevc' => $hatEnc('libx265'),
            'av1' => $hatEnc('libsvtav1'),
            'threads' => (int) (bw_ausfuehren(['nproc'], 5)['aus'] ?: 0),
        ],
        'filter' => [
            'tonemapx' => $hatFilter('tonemapx'),
            'zscale' => $hatFilter('zscale'),
            'vpp_qsv' => $hatFilter('vpp_qsv'),
            'tonemap_opencl' => $hatFilter('tonemap_opencl'),
        ],
    ];
    if (!$erg['ffmpeg']['ok']) {
        $erg['warnungen'][] = 'ffmpeg wurde nicht gefunden oder startet nicht (' . $k['ffmpeg'] . ').';
    }

    foreach (glob('/dev/dri/renderD*') ?: [] as $g) {
        $erg['geraete'][] = ['pfad' => $g, 'zugriff' => is_readable($g) && is_writable($g)] + hw_hersteller($g);
    }

    // QuickSync: erstes Intel-Gerät, auf das wir zugreifen dürfen
    $intel = null;
    foreach ($erg['geraete'] as $g) {
        if ($g['hersteller'] === 'Intel') {
            $intel = $g;
            if ($g['zugriff']) {
                break;
            }
        }
    }
    if ($intel !== null && !$intel['zugriff']) {
        $erg['warnungen'][] = 'Intel-Grafik gefunden (' . $intel['pfad'] . '), aber kein Zugriff – Rechte des Geräts auf dem Server prüfen.';
    }
    if ($intel !== null && $intel['zugriff'] && $erg['ffmpeg']['ok']) {
        $va = hw_vainfo($intel['pfad']);
        $probe = [
            'h264' => $hatEnc('h264_qsv') ? hw_qsv_probe($intel['pfad'], 'h264_qsv') : ['ok' => false, 'fehler' => 'h264_qsv fehlt in ffmpeg'],
            'hevc' => $hatEnc('hevc_qsv') ? hw_qsv_probe($intel['pfad'], 'hevc_qsv') : ['ok' => false, 'fehler' => 'hevc_qsv fehlt in ffmpeg'],
            'hevc10' => $hatEnc('hevc_qsv') ? hw_qsv_probe($intel['pfad'], 'hevc_qsv', true) : ['ok' => false, 'fehler' => null],
            'av1' => $hatEnc('av1_qsv') ? hw_qsv_probe($intel['pfad'], 'av1_qsv') : ['ok' => false, 'fehler' => 'av1_qsv fehlt in ffmpeg'],
        ];
        $erg['quicksync'] = [
            'verfuegbar' => $probe['h264']['ok'],
            'geraet' => $intel['pfad'],
            'treiber' => $va['treiber'],
            'dekodieren' => $va['dekodieren'],
            'kodieren' => array_map(static fn($p) => $p['ok'], $probe),
            'tonemapping' => $erg['filter']['vpp_qsv'] && $va['dekodieren']['hevc10'],
            'fehler' => $probe['h264']['ok'] ? null : ($probe['h264']['fehler'] ?: $va['fehler']),
        ];
    }

    // ---- Welches Profil läuft wirklich? ----
    $wunsch = $k['hwaccel'];
    if ($wunsch === 'auto') {
        $erg['aktiv'] = $erg['quicksync']['verfuegbar'] ? 'quicksync' : 'software';
    } elseif ($wunsch === 'quicksync') {
        if ($erg['quicksync']['verfuegbar']) {
            $erg['aktiv'] = 'quicksync';
        } else {
            $erg['warnungen'][] = 'QuickSync ist eingestellt, funktioniert hier aber nicht – Bluewave transkodiert per Software.'
                . (!empty($erg['quicksync']['fehler']) ? ' Grund: ' . $erg['quicksync']['fehler'] : ($intel === null ? ' Keine Intel-Grafik im Container (/dev/dri durchreichen).' : ''));
        }
    } elseif (!(ENCODER_PROFILE[$wunsch]['umgesetzt'] ?? false)) {
        $erg['warnungen'][] = (ENCODER_PROFILE[$wunsch]['name'] ?? $wunsch) . ' kommt in einer späteren Version – bis dahin Software.';
    }
    if ($erg['aktiv'] === 'software' && !$erg['software']['h264']) {
        $erg['warnungen'][] = 'Software-Encoder libx264 fehlt – Transkodieren ist nicht möglich.';
    }

    $alt = hw_lesen();
    if (isset($alt['test'])) {
        $erg['test'] = $alt['test']; // letzte Messung behalten, solange das Profil gleich ist
        if (($alt['test']['profil'] ?? '') !== $erg['aktiv']) {
            unset($erg['test']);
        }
    }
    @mkdir(dirname(hw_datei()), 0775, true);
    bw_schreiben(hw_datei(), (string) json_encode($erg, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    return $erg;
}

/**
 * „Transkodierung testen“: 10 s Testbild durch das aktive Profil – 1080p und 4K → 1080p, H.264.
 * Die Messung enthält das Erzeugen des Testbilds auf der CPU – echte Filme sind eher schneller.
 */
function hw_testen(): array
{
    $hw = hw_lesen() ?? hw_erkennen();
    $profil = (string) $hw['aktiv'];
    $sperre = fopen(konfig()['pfade']['cache'] . '/tmp/transkodiertest.lock', 'c');
    if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
        throw new RuntimeException('Es läuft schon ein Test.');
    }
    $dauer = 10;
    $laeufe = [
        ['name' => '1080p → 1080p H.264', 'b' => 1920, 'h' => 1080, 'ziel' => 1080, 'k' => 8000],
        ['name' => '4K → 1080p H.264', 'b' => 3840, 'h' => 2160, 'ziel' => 1080, 'k' => 8000],
    ];
    $ergebnis = ['profil' => $profil, 'zeit' => date('c'), 'laeufe' => []];
    try {
        foreach ($laeufe as $l) {
            $cmd = encoder_befehl($profil, [
                'eingabe' => ['lavfi' => 'testsrc2=size=' . $l['b'] . 'x' . $l['h'] . ':rate=30'],
                'dauer_s' => $dauer,
                'quelle' => ['breite' => $l['b'], 'hoehe' => $l['h'], 'hdr' => false],
                'video' => ['codec' => 'h264', 'hoehe' => $l['ziel'], 'bitrate_k' => $l['k'], 'tonemap' => false],
                'audio' => null,
                'ziel' => ['format' => 'null'],
            ], $hw);
            $r = bw_ausfuehren($cmd, 90);
            $ok = $r['code'] === 0;
            $ergebnis['laeufe'][] = [
                'name' => $l['name'],
                'ok' => $ok,
                'sekunden' => round($r['sekunden'], 2),
                'echtzeit' => $ok && $r['sekunden'] > 0 ? round($dauer / $r['sekunden'], 1) : null,
                'fps' => $ok && $r['sekunden'] > 0 ? (int) round($dauer * 30 / $r['sekunden']) : null,
                'fehler' => $ok ? null : trim(substr($r['fehler'] ?: ($r['zeit_um'] ? 'Zeitlimit überschritten' : 'Fehler'), 0, 500)),
            ];
        }
    } finally {
        flock($sperre, LOCK_UN);
        fclose($sperre);
    }
    // grobe Einschätzung: wie viele Streams gleichzeitig (4K → 1080p) – ab 1,2× Echtzeit je Stream gilt es als flüssig
    $vier = $ergebnis['laeufe'][1]['echtzeit'] ?? null;
    $ergebnis['streams_4k'] = $vier ? max(0, (int) floor($vier / 1.2)) : 0;
    $hw = hw_lesen() ?? $hw;
    $hw['test'] = $ergebnis;
    bw_schreiben(hw_datei(), (string) json_encode($hw, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    return $ergebnis;
}
