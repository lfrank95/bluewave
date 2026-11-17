<?php
// Wiedergabe: Welche Datei, Direct Play, Direct Stream oder Umwandeln (HLS-Sitzungen in hls.php), Untertitel als WebVTT, Fortschritt.
declare(strict_types=1);
require_once __DIR__ . '/hardware.php';
require_once __DIR__ . '/bibliothek.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/diagnose.php';
require_once __DIR__ . '/remux.php';
require_once __DIR__ . '/hls.php';
require_once __DIR__ . '/schluesselbilder.php';
require_once __DIR__ . '/vorarbeit.php';
require_once __DIR__ . '/vorschau.php';
require_once __DIR__ . '/optimiert.php';

const BITRATE_JE_HOEHE = [2160 => 20000, 1440 => 12000, 1080 => 8000, 720 => 4000, 480 => 1500];

function qualitaet_grenze(string $wahl): array
{
    return match ($wahl) {
        '2160' => ['hoehe' => 2160, 'bitrate_k' => 30000],
        '1080' => ['hoehe' => 1080, 'bitrate_k' => 10000],
        '720' => ['hoehe' => 720, 'bitrate_k' => 4000],
        '480' => ['hoehe' => 480, 'bitrate_k' => 1500],
        default => ['hoehe' => 4320, 'bitrate_k' => 0],
    };
}

/** Datei für ein Ziel wählen: Film (Fassung) oder Folge; bei mehreren Qualitäten die passendste */
function wiedergabe_datei(string $art, int $id, ?int $fassungId, ?int $dateiId, array $grenze): ?array
{
    if ($dateiId) {
        $d = db_zeile('SELECT * FROM dateien WHERE id = :id AND fehlt_seit IS NULL', ['id' => $dateiId]);
        if ($d) {
            return $d;
        }
    }
    if ($art === 'film') {
        $fassungId = $fassungId ?: (int) db_wert('SELECT fa.id FROM fassungen fa JOIN dateien d ON d.fassung_id = fa.id AND d.fehlt_seit IS NULL
            WHERE fa.film_id = :f ORDER BY fa.standard DESC, fa.id LIMIT 1', ['f' => $id]);
        $kand = db_alle('SELECT * FROM dateien WHERE fassung_id = :fa AND fehlt_seit IS NULL ORDER BY hoehe DESC', ['fa' => $fassungId]);
    } else {
        $kand = db_alle('SELECT * FROM dateien WHERE folge_id = :f AND fehlt_seit IS NULL ORDER BY hoehe DESC', ['f' => $id]);
    }
    if (!$kand) {
        return null;
    }
    // höchste Auflösung, die unter der Grenze liegt – sonst die kleinste (wird dann heruntergerechnet)
    foreach ($kand as $d) {
        if ((int) $d['hoehe'] <= $grenze['hoehe'] + 40) {
            return $d;
        }
    }
    return end($kand);
}

/** Kann der Browser/die App die Datei ohne Umwandlung abspielen? Grund im zweiten Wert. */
function direkt_moeglich(array $d, array $ton, array $faehig, array $grenze, ?array $untertitel, int $tonIndex): array
{
    $container = strtolower((string) $d['container']);
    $vc = strtolower((string) $d['video_codec']);
    $vName = ['h264' => 'h264', 'hevc' => 'hevc', 'av1' => 'av1', 'vp9' => 'vp9'][$vc] ?? null;
    $c = $faehig['container'] ?? [];
    if (!in_array($container, ['mp4', 'm4v', 'mov', 'webm', 'mkv'], true) || empty($c[$container === 'm4v' || $container === 'mov' ? 'mp4' : $container])) {
        return [false, 'Container ' . $container];
    }
    if (!$vName || empty($faehig['video'][$vName])) {
        return [false, 'Video ' . $vc];
    }
    if ($d['hdr'] !== 'sdr' && empty($faehig['hdr'])) {
        return [false, 'HDR'];
    }
    if ((int) $d['bittiefe'] > 8 && $vName === 'h264') {
        return [false, '10-Bit H.264'];
    }
    // Browser spielen nur die erste Tonspur
    if ($tonIndex !== 0) {
        return [false, 'andere Tonspur'];
    }
    $ac = strtolower((string) ($ton[0]['codec'] ?? ''));
    if ($ac !== '' && empty($faehig['audio'][$ac])) {
        return [false, 'Ton ' . $ac];
    }
    if ($untertitel && untertitel_ist_bild((string) $untertitel['format'])) {
        return [false, 'Bild-Untertitel einbrennen'];
    }
    if ($grenze['bitrate_k'] > 0 && (int) $d['bitrate'] > $grenze['bitrate_k'] * 1000 * 1.1) {
        return [false, 'Bitrate'];
    }
    if ((int) $d['hoehe'] > $grenze['hoehe'] + 40) {
        return [false, 'Auflösung'];
    }
    return [true, ''];
}

/**
 * Zielformat, wenn der Ton umgewandelt werden muss: Dolby Digital Plus (E-AC3) bis 5.1, wenn das Gerät es kann
 * (Fernseher, AV-Receiver per eARC) – klingt besser und bleibt mehrkanalig; sonst AAC (Stereo bzw. 5.1)
 */
function ton_ziel(array $ton, int $tonIndex, array $faehig): array
{
    $kan = 2;
    foreach ($ton as $t) {
        if ((int) $t['strom_index'] === $tonIndex) {
            $kan = max(1, (int) $t['kanaele']);
        }
    }
    if (!empty($faehig['audio']['eac3'])) {
        $k = min(6, $kan);
        return ['codec' => 'eac3', 'kanaele' => $k, 'bitrate_k' => $k > 2 ? 640 : 256];
    }
    $k = min(6, $kan);
    return ['codec' => 'aac', 'kanaele' => $k, 'bitrate_k' => $k > 2 ? 384 : 192];
}

/** Tonspur nach Wunsch des Nutzers: Sprache passt (keine Kommentarspur), sonst Standard, sonst erste */
function tonspur_waehlen(array $ton, string $sprache, ?int $wunsch, array $faehig = []): int
{
    if ($wunsch !== null && in_array($wunsch, array_map('intval', array_column($ton, 'strom_index')), true)) {
        return $wunsch;
    }
    // Spuren in der gewünschten Sprache (ohne Kommentar); gibt es mehrere, gewinnt die, die das Gerät unverändert
    // abspielen kann (z. B. deutsche E-AC3 statt deutscher DTS-HD auf einem Fernseher ohne DTS), dann mehr Kanäle, dann Standard
    $passend = array_values(array_filter($ton, static fn($t) => $t['sprache'] === $sprache && !$t['kommentar']));
    if ($passend) {
        $kann = static fn($t) => !empty($faehig['audio'][strtolower((string) $t['codec'])]);
        usort($passend, static fn($a, $b) => [(int) $kann($b), (int) $b['kanaele'], (int) $b['standard']] <=> [(int) $kann($a), (int) $a['kanaele'], (int) $a['standard']]);
        return (int) $passend[0]['strom_index'];
    }
    foreach ($ton as $t) {
        if ($t['standard']) {
            return (int) $t['strom_index'];
        }
    }
    return 0;
}

/** Untertitel nach Einstellung: aus | erzwungen (nur erzwungene in Nutzersprache bzw. wenn Ton fremd: volle) | immer */
function untertitel_waehlen(array $alle, array $e, ?string $tonSprache, $wunsch): ?array
{
    if ($wunsch === 'aus') {
        return null;
    }
    if (is_numeric($wunsch)) {
        foreach ($alle as $u) {
            if ((int) $u['id'] === (int) $wunsch) {
                return $u;
            }
        }
    }
    $sprache = $e['untertitelsprache'];
    $passend = array_values(array_filter($alle, static fn($u) => $u['sprache'] === $sprache));
    $nachText = static function (array $liste): array {
        usort($liste, static fn($a, $b) => (int) untertitel_ist_bild((string) $a['format']) <=> (int) untertitel_ist_bild((string) $b['format']));
        return $liste;
    };
    $erzwungen = $nachText(array_values(array_filter($passend, static fn($u) => $u['erzwungen'])));
    $voll = $nachText(array_values(array_filter($passend, static fn($u) => !$u['erzwungen'])));
    if ($e['untertitel'] === 'immer') {
        return $voll[0] ?? $erzwungen[0] ?? null;
    }
    if ($e['untertitel'] === 'erzwungen') {
        // Ton in fremder Sprache: volle Untertitel; sonst nur erzwungene (fremdsprachige Stellen)
        if ($tonSprache !== null && $tonSprache !== $sprache) {
            return $voll[0] ?? $erzwungen[0] ?? null;
        }
        return $erzwungen[0] ?? null;
    }
    return null;
}

/**
 * Wiedergabe starten. $w = [art, id, fassung_id, datei_id, ton, untertitel, start_ms, faehigkeiten, sitzung_alt]
 * Liefert alles, was der Player braucht.
 */
function wiedergabe_starten(array $konto, array $w): array
{
    $art = $w['art'] === 'folge' ? 'folge' : 'film';
    $id = (int) $w['id'];
    $e = $konto['einstellungen'];
    $heim = bw_ist_heimnetz();
    // Qualität: im Player gewählt (gilt für diese Wiedergabe), sonst die Einstellung für Heimnetz bzw. unterwegs
    $wahl = in_array((string) ($w['qualitaet'] ?? ''), ['original', '2160', '1080', '720', '480'], true) ? (string) $w['qualitaet'] : null;
    $grenze = qualitaet_grenze($wahl ?? ($heim ? $e['qualitaet_heim'] : $e['qualitaet_unterwegs']));
    $hoehe = (int) ($w['faehigkeiten']['max_hoehe'] ?? 0);
    // Fernseher melden ihrem Browser oft nur 1920×1080, auch bei 4K-Panel → dort (und auf Wunsch) nicht begrenzen
    $ignorieren = ($e['aufloesung'] ?? 'geraet') === 'egal' || !empty($w['faehigkeiten']['fernseher']) || ($konto['art'] ?? '') === 'geraet';
    if ($hoehe > 0 && $wahl === null && !$ignorieren) {
        $grenze['hoehe'] = min($grenze['hoehe'], max(480, $hoehe));
    }
    $d = wiedergabe_datei($art, $id, isset($w['fassung_id']) ? (int) $w['fassung_id'] : null, isset($w['datei_id']) ? (int) $w['datei_id'] : null, $grenze);
    if (!$d) {
        throw new RuntimeException('Keine abspielbare Datei gefunden.');
    }
    $ton = db_alle('SELECT * FROM tonspuren WHERE datei_id = :d ORDER BY strom_index', ['d' => $d['id']]);
    $tonIndex = tonspur_waehlen($ton, $e['tonsprache'], isset($w['ton']) && $w['ton'] !== null ? (int) $w['ton'] : null, (array) ($w['faehigkeiten'] ?? []));
    $tonSprache = null;
    foreach ($ton as $t) {
        if ((int) $t['strom_index'] === $tonIndex) {
            $tonSprache = $t['sprache'];
        }
    }
    $alleUt = db_alle('SELECT * FROM untertitel WHERE datei_id = :d ORDER BY quelle, strom_index', ['d' => $d['id']]);
    $ut = untertitel_waehlen($alleUt, $e, $tonSprache, $w['untertitel'] ?? null);
    // Bild-Untertitel aus Dateien (.sup) können wir (noch) nicht einbrennen
    if ($ut && untertitel_ist_bild((string) $ut['format']) && $ut['quelle'] !== 'eingebettet') {
        $ut = null;
    }

    $start = max(0, (int) ($w['start_ms'] ?? -1));
    if (!isset($w['start_ms']) || (int) $w['start_ms'] < 0) {
        $fs = fortschritt_map((int) $konto['id'], $art, [$id])[$id] ?? null;
        $start = $fs && !$fs['gesehen'] && $fs['position_ms'] > 30000 ? max(0, $fs['position_ms'] - 5000) : 0;
    }
    [$direkt, $grund] = direkt_moeglich($d, $ton, (array) ($w['faehigkeiten'] ?? []), $grenze, $ut, $tonIndex);
    if (!empty($w['erzwinge_transkodieren'])) {
        [$direkt, $grund] = [false, 'gewünscht'];
    }

    $antwort = [
        'art' => $art, 'id' => $id, 'datei_id' => (int) $d['id'], 'dauer_ms' => (int) $d['dauer_ms'], 'start_ms' => $start,
        'ton' => $tonIndex, 'untertitel_aktiv' => $ut ? (int) $ut['id'] : null,
        'tonspuren' => array_map(static fn($t) => ['index' => (int) $t['strom_index'], 'text' => ton_text($t), 'sprache' => $t['sprache'],
            'sprache_name' => sprache_name($t['sprache']), 'kommentar' => (bool) $t['kommentar']], $ton),
        'untertitel' => array_map(static fn($u) => ['id' => (int) $u['id'], 'sprache' => $u['sprache'], 'sprache_name' => sprache_name($u['sprache']),
            'erzwungen' => (bool) $u['erzwungen'], 'sdh' => (bool) $u['hoergeschaedigt'], 'bild' => untertitel_ist_bild((string) $u['format']),
            'url' => untertitel_ist_bild((string) $u['format']) ? null : '/api/v1/untertitel/' . $u['id'] . '.vtt', 'titel' => $u['titel']], $alleUt),
        'marker' => marker_fuer((int) $d['id']),
        'info' => wiedergabe_info($art, $id),
        'naechste' => $art === 'folge' ? naechste_info(folge_danach($id)) : null,
        'heimnetz' => $heim,
        'vorschau' => vorschau_info($d),
    ];
    // angebotene Qualitäten: Original plus jede Stufe bis zur Quellauflösung
    $antwort['qualitaet'] = $wahl ?? 'auto';
    $antwort['qualitaet_einstellung'] = $heim ? $e['qualitaet_heim'] : $e['qualitaet_unterwegs'];
    $antwort['qualitaeten'] = array_values(array_filter(['original', '2160', '1080', '720', '480'],
        static fn($q) => $q === 'original' || (int) $q <= (int) $d['hoehe'] + 40 || $q === '480'));
    $antwort['quelle'] = ['hoehe' => (int) $d['hoehe'], 'video_codec' => strtoupper((string) $d['video_codec']), 'container' => (string) $d['container'],
        'bitrate_k' => (int) round((int) $d['bitrate'] / 1000), 'hdr' => $d['hdr'] !== 'sdr'];
    if ($direkt) {
        $antwort['modus'] = 'direkt';
        $antwort['url'] = '/api/v1/datei/' . $d['id'] . '/inhalt';
        $antwort['grund'] = '';
        return $antwort;
    }
    // ---- Direct Stream: Video unverändert, nur Container (und ggf. Ton) neu ----
    if (empty($w['erzwinge_transkodieren']) && !empty($w['faehigkeiten']['remux'])) {
        [$rm, , $tonModus] = remux_moeglich($d, $ton, (array) $w['faehigkeiten'], $grenze, $ut, $tonIndex);
        // Geräte ohne MediaSource (iPhone, manche Fernseher-Browser) können den fortlaufenden Strom nicht sauber spulen:
        // dort dasselbe als HLS – Video unverändert, nur Ton/Container neu, Teile an den Schlüsselbildern der Quelle
        if ($rm && ($w['faehigkeiten']['mse'] ?? true) === false && ($w['faehigkeiten']['hls'] ?? '') === 'nativ'
            && ($schl = schluesselbilder((string) $d['pfad'], (string) $d['container'])) !== null) {
            $kan = 2;
            foreach ($ton as $t) {
                if ((int) $t['strom_index'] === $tonIndex) {
                    $kan = max(1, (int) $t['kanaele']);
                }
            }
            $audio = !$ton ? null : ($tonModus === 'copy' ? ['strom' => $tonIndex, 'codec' => 'copy']
                : ['strom' => $tonIndex, 'codec' => $tonModus, 'kanaele' => min(6, $kan), 'bitrate_k' => $tonModus === 'eac3' ? ($kan > 2 ? 640 : 256) : ($kan > 2 ? 384 : 192)]);
            $auftrag = [
                'eingabe' => $d['pfad'],
                'quelle' => ['breite' => (int) $d['breite'], 'hoehe' => (int) $d['hoehe'], 'hdr' => false, 'video_codec' => strtolower((string) $d['video_codec'])],
                'video' => ['codec' => 'copy'],
                'audio' => $audio,
                'einbrennen' => null,
            ];
            $hw = hw_lesen() ?? hw_erkennen();
            $sitzung = hls_sitzung_anlegen($konto, $d, $auftrag, (string) $hw['aktiv'], (string) ($w['sitzung_alt'] ?? ''), 'kopie', $schl,
                $start / 1000, hls_limit_bytes((int) (server_einstellungen()['hls_zwischenspeicher_gb'] ?? 0)));
            $antwort['modus'] = 'hls';
            $antwort['url'] = '/api/v1/stream/' . $sitzung . '/index.m3u8';
            $antwort['sitzung'] = $sitzung;
            $antwort['grund'] = $grund;
            $antwort['transkodierung'] = ['profil' => 'Video unverändert', 'hoehe' => (int) $d['hoehe'], 'bitrate_k' => (int) round((int) $d['bitrate'] / 1000),
                'tonemap' => false, 'eingebrannt' => false, 'kopie' => true, 'ton' => $tonModus];
            return $antwort;
        }
        if ($rm) {
            $kan = 2;
            foreach ($ton as $t) {
                if ((int) $t['strom_index'] === $tonIndex) {
                    $kan = (int) $t['kanaele'];
                }
            }
            $antwort['modus'] = 'remux';
            $antwort['url'] = '/api/v1/remux/' . $d['id'];
            $antwort['remux'] = ['ton' => $tonIndex, 'audio' => $tonModus, 'kanaele' => $kan];
            $antwort['grund'] = $grund;
            return $antwort;
        }
    }
    // ---- Optimierte Fassung: vorab umgewandelt → direkt abspielen (oder Direct Stream), statt live umzuwandeln ----
    if (empty($w['erzwinge_transkodieren'])) {
        $faehig = (array) ($w['faehigkeiten'] ?? []);
        foreach (optimiert_fuer_datei((int) $d['id']) as $o) {
            if (min((int) $o['hoehe'], (int) $d['hoehe']) > $grenze['hoehe'] + 40) {
                continue;
            }
            $od = optimiert_als_datei($d, $o);
            $ot = optimiert_als_ton($ton);
            [$dir] = direkt_moeglich($od, $ot, $faehig, $grenze, $ut, $tonIndex);
            $antwort['optimiert'] = ['hoehe' => (int) $od['hoehe'], 'bitrate_k' => (int) $o['bitrate_k']];
            $antwort['quelle'] = ['hoehe' => (int) $od['hoehe'], 'video_codec' => 'H264', 'container' => 'mp4', 'bitrate_k' => (int) $o['bitrate_k'] + 160, 'hdr' => false];
            if ($dir) {
                $antwort['modus'] = 'direkt';
                $antwort['url'] = '/api/v1/datei/o' . (int) $o['id'] . '/inhalt';
                $antwort['grund'] = 'optimierte Fassung (' . $grund . ')';
                return $antwort;
            }
            if (!empty($faehig['remux'])) {
                [$rm, , $tonModus] = remux_moeglich($od, $ot, $faehig, $grenze, $ut, $tonIndex);
                if ($rm) {
                    $antwort['modus'] = 'remux';
                    $antwort['url'] = '/api/v1/remux/o' . (int) $o['id'];
                    $antwort['remux'] = ['ton' => $tonIndex, 'audio' => $tonModus, 'kanaele' => 2];
                    $antwort['grund'] = 'optimierte Fassung (' . $grund . ')';
                    return $antwort;
                }
            }
            unset($antwort['optimiert']);
            $antwort['quelle'] = ['hoehe' => (int) $d['hoehe'], 'video_codec' => strtoupper((string) $d['video_codec']), 'container' => (string) $d['container'],
                'bitrate_k' => (int) round((int) $d['bitrate'] / 1000), 'hdr' => $d['hdr'] !== 'sdr'];
        }
    }
    // ---- Transkodieren ----
    $hw = hw_lesen() ?? hw_erkennen();
    [$zb, $zh] = encoder_zielmasse((int) $d['breite'], (int) $d['hoehe'], $grenze['hoehe']);
    $stufe = 480;
    foreach (array_keys(BITRATE_JE_HOEHE) as $h) {
        if ($zh >= $h - 40) {
            $stufe = $h;
            break;
        }
    }
    $bitrate = BITRATE_JE_HOEHE[$stufe];
    if ($grenze['bitrate_k'] > 0) {
        $bitrate = min($bitrate, $grenze['bitrate_k']);
    }
    $dek = $hw['quicksync']['dekodieren'] ?? [];
    $vc = strtolower((string) $d['video_codec']);
    $hwDek = match ($vc) {
        'h264' => !empty($dek['h264']) && (int) $d['bittiefe'] <= 8,
        'hevc' => (int) $d['bittiefe'] > 8 ? !empty($dek['hevc10']) : !empty($dek['hevc']),
        'av1' => !empty($dek['av1']), 'vp9' => (int) $d['bittiefe'] > 8 ? !empty($dek['vp9_10']) : !empty($dek['vp9']),
        default => false,
    };
    $einbrennen = ($ut && untertitel_ist_bild((string) $ut['format']) && $ut['quelle'] === 'eingebettet') ? (int) $ut['strom_index'] : null;
    $auftrag = [
        'eingabe' => $d['pfad'],
        'quelle' => ['breite' => (int) $d['breite'], 'hoehe' => (int) $d['hoehe'], 'hdr' => $d['hdr'] !== 'sdr' && empty($w['faehigkeiten']['hdr']), 'hw_dekodieren' => $hwDek],
        'video' => ['codec' => 'h264', 'hoehe' => $zh, 'bitrate_k' => $bitrate, 'tonemap' => true],
        'audio' => $ton ? ton_ziel($ton, $tonIndex, (array) ($w['faehigkeiten'] ?? [])) + ['strom' => $tonIndex] : null,
        'einbrennen' => $einbrennen,
    ];
    $sitzung = hls_sitzung_anlegen($konto, $d, $auftrag, (string) $hw['aktiv'], (string) ($w['sitzung_alt'] ?? ''), 'umwandeln', null,
        $start / 1000, hls_limit_bytes((int) (server_einstellungen()['hls_zwischenspeicher_gb'] ?? 0)));
    $antwort['modus'] = 'hls';
    $antwort['url'] = '/api/v1/stream/' . $sitzung . '/index.m3u8';
    $antwort['sitzung'] = $sitzung;
    $antwort['grund'] = $grund;
    $antwort['transkodierung'] = ['profil' => ENCODER_PROFILE[$hw['aktiv']]['name'] ?? $hw['aktiv'], 'hoehe' => $zh, 'bitrate_k' => $bitrate,
        'tonemap' => $auftrag['quelle']['hdr'], 'eingebrannt' => $einbrennen !== null];
    return $antwort;
}

function wiedergabe_info(string $art, int $id): array
{
    if ($art === 'film') {
        $f = db_zeile('SELECT titel, jahr, logo, hintergrund FROM filme WHERE id = :id', ['id' => $id]);
        return ['titel' => $f['titel'] ?? '', 'untertitel' => $f['jahr'] ?? null, 'logo' => bild_url($f['logo'] ?? null), 'hintergrund' => bild_url($f['hintergrund'] ?? null)];
    }
    $f = db_zeile('SELECT fo.titel, fo.staffel_nr, fo.folge_nr, s.titel AS serie, s.id AS serie_id, s.logo, s.hintergrund FROM folgen fo JOIN serien s ON s.id = fo.serie_id WHERE fo.id = :id', ['id' => $id]);
    return ['titel' => $f['serie'] ?? '', 'serie_id' => (int) ($f['serie_id'] ?? 0),
        'untertitel' => $f ? sprintf('S%02dE%02d', $f['staffel_nr'], $f['folge_nr']) . ($f['titel'] ? ' · ' . $f['titel'] : '') : null,
        'logo' => bild_url($f['logo'] ?? null), 'hintergrund' => bild_url($f['hintergrund'] ?? null)];
}

function naechste_info(?int $folgeId): ?array
{
    if (!$folgeId) {
        return null;
    }
    $f = db_zeile('SELECT id, titel, staffel_nr, folge_nr, standbild, beschreibung FROM folgen WHERE id = :id', ['id' => $folgeId]);
    return $f ? ['art' => 'folge', 'id' => (int) $f['id'], 'titel' => $f['titel'] ?: 'Folge ' . $f['folge_nr'],
        'kennung' => sprintf('S%02dE%02d', $f['staffel_nr'], $f['folge_nr']), 'standbild' => bild_url($f['standbild']),
        'beschreibung' => $f['beschreibung']] : null;
}

function marker_fuer(int $dateiId): array
{
    $aus = [];
    foreach (db_alle('SELECT art, start_ms, ende_ms, quelle FROM marker WHERE datei_id = :d', ['d' => $dateiId]) as $m) {
        $aus[$m['art']] = ['start_ms' => (int) $m['start_ms'], 'ende_ms' => (int) $m['ende_ms'], 'quelle' => $m['quelle']];
    }
    return $aus;
}

// ---------- Direkt abspielen und Untertitel ----------

/** Datei mit Range-Unterstützung ausliefern */
function datei_senden(string $pfad, string $mime): never
{
    $groesse = filesize($pfad);
    $von = 0;
    $bis = $groesse - 1;
    header('Accept-Ranges: bytes');
    header('Content-Type: ' . $mime);
    header('Cache-Control: private, max-age=3600');
    if (preg_match('/bytes=(\d*)-(\d*)/', (string) ($_SERVER['HTTP_RANGE'] ?? ''), $m)) {
        if ($m[1] === '' && $m[2] !== '') {
            $von = max(0, $groesse - (int) $m[2]);
        } else {
            $von = (int) $m[1];
            if ($m[2] !== '') {
                $bis = min($bis, (int) $m[2]);
            }
        }
        if ($von > $bis || $von >= $groesse) {
            http_response_code(416);
            header("Content-Range: bytes */$groesse");
            exit;
        }
        http_response_code(206);
        header("Content-Range: bytes $von-$bis/$groesse");
    }
    header('Content-Length: ' . ($bis - $von + 1));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
        exit;
    }
    db_schliessen();
    session_write_close();
    @set_time_limit(0);
    $fh = fopen($pfad, 'rb');
    fseek($fh, $von);
    $rest = $bis - $von + 1;
    while ($rest > 0 && !feof($fh) && !connection_aborted()) {
        $teil = fread($fh, (int) min(1048576, $rest));
        if ($teil === false) {
            break;
        }
        echo $teil;
        flush();
        $rest -= strlen($teil);
    }
    fclose($fh);
    exit;
}

function mime_fuer(string $container): string
{
    return match (strtolower($container)) {
        'mp4', 'm4v' => 'video/mp4', 'mov' => 'video/quicktime', 'webm' => 'video/webm', 'mkv' => 'video/x-matroska', default => 'application/octet-stream',
    };
}

/** Untertitel als WebVTT (umgewandelt und im Cache gemerkt) */
/** Cache-Datei für einen Untertitel (ändert sich die Quelldatei, gibt es eine neue) */
function untertitel_cache_pfad(array $u): string
{
    $quelle = $u['quelle'] === 'eingebettet' ? (string) $u['video'] : (string) $u['pfad'];
    return konfig()['pfade']['cache'] . '/untertitel/' . $u['id'] . '-' . substr(sha1($quelle . '|' . @filemtime($quelle)), 0, 10) . '.vtt';
}

/** Untertitel wird noch vorbereitet (eingebettet, große Datei) – später nochmal fragen */
class UntertitelNochNicht extends RuntimeException {}

function untertitel_vtt(int $id): string
{
    $u = db_zeile('SELECT u.*, d.pfad AS video FROM untertitel u JOIN dateien d ON d.id = u.datei_id WHERE u.id = :id', ['id' => $id]);
    if (!$u || untertitel_ist_bild((string) $u['format'])) {
        throw new RuntimeException('Diese Untertitel gibt es nicht als Text.');
    }
    $cache = untertitel_cache_pfad($u);
    if (is_file($cache)) {
        return $cache;
    }
    @mkdir(dirname($cache), 0775, true);
    if ($u['quelle'] === 'eingebettet') {
        // Eingebettete Untertitel: ffmpeg muss dafür die ganze Datei lesen. Das läuft im Hintergrund (niedrige Priorität)
        // und für alle Text-Untertitel der Datei in EINEM Durchgang – die Wiedergabe wartet nicht darauf.
        untertitel_extraktion_starten((int) $u['datei_id']);
        throw new UntertitelNochNicht('Untertitel werden vorbereitet.');
    }
    $k = konfig()['transkodieren'];
    $cmd = [$k['ffmpeg'], '-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
    // Zeichensatz: SRT ist oft Windows-1252 – ffmpeg erkennt UTF-8 selbst, sonst lesen wir als cp1252
    $roh = (string) @file_get_contents((string) $u['pfad'], false, null, 0, 65536);
    if (!mb_check_encoding($roh, 'UTF-8')) {
        $cmd = array_merge($cmd, ['-sub_charenc', 'CP1252']);
    }
    $cmd = array_merge($cmd, ['-i', (string) $u['pfad']]);
    $tmp = $cache . '.' . bin2hex(random_bytes(3)) . '.vtt';
    $r = bw_ausfuehren(array_merge($cmd, ['-c:s', 'webvtt', '-f', 'webvtt', $tmp]), 60);
    if ($r['code'] !== 0 || !is_file($tmp)) {
        @unlink($tmp);
        throw new RuntimeException('Untertitel konnten nicht umgewandelt werden.');
    }
    rename($tmp, $cache);
    return $cache;
}

/** Hintergrund-Durchgang für alle eingebetteten Text-Untertitel einer Datei starten (nur einmal gleichzeitig) */
function untertitel_extraktion_starten(int $dateiId): void
{
    $sperre = konfig()['pfade']['cache'] . '/untertitel/extrahieren-' . $dateiId . '.laeuft';
    if (is_file($sperre) && filemtime($sperre) > time() - 3 * 3600 && @posix_kill((int) @file_get_contents($sperre), 0)) {
        return;
    }
    @mkdir(dirname($sperre), 0775, true);
    $skript = realpath(__DIR__ . '/../scripts/untertitel_extrahieren.php');
    $nice = is_executable('/usr/bin/ionice') ? 'nice -n 19 ionice -c 3 ' : 'nice -n 19 ';
    shell_exec('setsid ' . $nice . escapeshellarg(PHP_BINARY && !str_contains(PHP_BINARY, 'apache') ? PHP_BINARY : 'php') . ' ' . escapeshellarg((string) $skript) . ' '
        . $dateiId . ' > /dev/null 2>&1 < /dev/null &');
}

// ---------- Fortschritt ----------

function fortschritt_speichern(int $konto, string $art, int $id, ?int $dateiId, int $pos, int $dauer): array
{
    $art = $art === 'folge' ? 'folge' : 'film';
    $gesehen = $dauer > 0 && $pos >= $dauer * 0.92;
    if (!$gesehen && $dateiId) {
        $abspann = db_wert("SELECT start_ms FROM marker WHERE datei_id = :d AND art = 'abspann'", ['d' => $dateiId]);
        if ($abspann && $pos >= (int) $abspann) {
            $gesehen = true;
        }
    }
    // einmal gesehen bleibt gesehen (bis man es von Hand zurücksetzt) – der Fortschritt läuft trotzdem mit
    db_tun('INSERT INTO wiedergabe (konto_id, art, ziel_id, datei_id, position_ms, dauer_ms, gesehen, gesehen_am) VALUES (:k, :a, :z, :d, :p, :du, :g, IF(:g2 = 1, NOW(), NULL))
        ON DUPLICATE KEY UPDATE datei_id = VALUES(datei_id), position_ms = VALUES(position_ms), dauer_ms = VALUES(dauer_ms),
        gesehen_am = IF(VALUES(gesehen) = 1 AND gesehen = 0, NOW(), gesehen_am), gesehen = GREATEST(gesehen, VALUES(gesehen))', [
        'k' => $konto, 'a' => $art, 'z' => $id, 'd' => $dateiId, 'p' => max(0, $pos), 'du' => max(0, $dauer), 'g' => (int) $gesehen, 'g2' => (int) $gesehen,
    ]);
    return ['gesehen' => $gesehen];
}

function gesehen_setzen(int $konto, string $art, int $id, bool $gesehen): void
{
    if ($art === 'staffel' || $art === 'serie') {
        return;
    }
    $art = $art === 'folge' ? 'folge' : 'film';
    if ($gesehen) {
        db_tun('INSERT INTO wiedergabe (konto_id, art, ziel_id, position_ms, dauer_ms, gesehen, gesehen_am) VALUES (:k, :a, :z, 0, 0, 1, NOW())
            ON DUPLICATE KEY UPDATE gesehen = 1, position_ms = 0, gesehen_am = NOW()', ['k' => $konto, 'a' => $art, 'z' => $id]);
    } else {
        db_tun('DELETE FROM wiedergabe WHERE konto_id = :k AND art = :a AND ziel_id = :z', ['k' => $konto, 'a' => $art, 'z' => $id]);
    }
}
