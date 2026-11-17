<?php
// HLS beim Umwandeln: Sitzungen, Teile-Raster, gemeinsamer Zwischenspeicher, Encoder-Steuerung und Ausliefern.
//
// Aufbau
//   <transkodieren>/teile/<schlüssel>/   gemeinsamer Zwischenspeicher je Datei + Umwandlungs-Einstellung:
//                                        init.mp4, teil_NNNNN.m4s (fertig) und teil_NNNNN.m4s.<sitzung>.part (entsteht gerade)
//   <transkodieren>/sitzung-<id>/        je Wiedergabe: meta.json, lauf.json (Auftrag an den Segmentierer), status.json, Logs
// Jede Sitzung hat ihren eigenen Encoder (Segmentierer + ffmpeg), alle teilen sich die fertigen Teile. Ein zweiter Zuschauer,
// ein Zurückspringen oder Weiterschauen am nächsten Tag braucht nichts neu zu berechnen, solange die Teile noch da sind.
// Platz: ältest benutzte Teile fliegen raus, sobald der Zwischenspeicher seine Obergrenze erreicht.
//
// Raster: erste drei Teile 2 s (schneller Start), danach 6 s. Bei unverändertem Video (nur Ton/Container neu) liegt das Raster
// auf den Schlüsselbildern der Quelle (nur dort lässt sich schneiden).
//
// Diese Datei braucht keine Datenbank – der Segmentierer lädt sie zum Aufräumen.
declare(strict_types=1);
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/encoder.php';
require_once __DIR__ . '/hardware.php';
require_once __DIR__ . '/diagnose.php';

const HLS_ZIEL_S = 6;          // normale Teillänge
const HLS_START_S = 2;         // Teillänge am Anfang
const HLS_START_TEILE = 3;     // so viele kurze Teile
const HLS_RASTER_VERSION = 2;  // ändert sich das Raster, gelten alte Zwischenspeicher nicht mehr
const HLS_VORAUS_MAX = 30;     // Encoder anhalten, wenn er so viele Teile vor der Wiedergabe ist …
const HLS_VORAUS_WEITER = 15;  // … und weiterlaufen lassen, wenn der Abstand darunter fällt
const HLS_ZEIT_VERSATZ = 10;   // Sekunden, um die alle Teile in der Medienzeit versetzt sind (siehe encoder.php, fmp4)

/** Gemeinsame Ausnahme: eine Teil-Anfrage, die von einem späteren Sprung überholt wurde */
class TeilUeberholt extends RuntimeException
{
}

// ---------- Raster ----------

/** Startzeiten der Teile beim Umwandeln: 0, 2, 4, 6, 12, 18, … (Schlüsselbilder erzwingt ffmpeg genau dort) */
function hls_raster_fest(float $dauer): array
{
    $g = [];
    $t = 0.0;
    while ($t < $dauer - 0.5 || !$g) {
        $g[] = $t;
        $t += count($g) <= HLS_START_TEILE ? HLS_START_S : HLS_ZIEL_S;
    }
    return $g;
}

/** Startzeiten bei unverändertem Video: Schlüsselbilder der Quelle, zu Teilen von ~2 s (Anfang) bzw. ~6 s gebündelt */
function hls_raster_kopie(array $schluessel, float $dauer): array
{
    $g = [0.0];
    $letzte = 0.0;
    foreach ($schluessel as $k) {
        $k = (float) $k;
        $ziel = count($g) <= HLS_START_TEILE ? HLS_START_S : HLS_ZIEL_S;
        if ($k - $letzte >= $ziel - 0.001 && $k < $dauer - 0.5) {
            $g[] = $k;
            $letzte = $k;
        }
    }
    return $g;
}

/** Dauer von Teil $n */
function hls_teil_dauer(array $g, int $n, float $dauer): float
{
    return max(0.04, ($g[$n + 1] ?? $dauer) - $g[$n]);
}

/** Teil, in dem die Zeit $t liegt */
function hls_teil_fuer_zeit(array $g, float $t): int
{
    $lo = 0;
    $hi = count($g) - 1;
    while ($lo < $hi) {
        $mid = intdiv($lo + $hi + 1, 2);
        if ($g[$mid] <= $t + 0.001) {
            $lo = $mid;
        } else {
            $hi = $mid - 1;
        }
    }
    return $lo;
}

/**
 * ffmpeg-Ausdruck für -force_key_frames: Schlüsselbild, sobald ein Bild in einen neuen Rasterabschnitt fällt.
 * t zählt ab dem ersten ausgegebenen Bild (also ab dem Startpunkt $s) – deshalb + $s. Muss zu hls_raster_fest passen.
 */
function hls_schluesselbild_ausdruck(float $s): string
{
    $abschnitt = static function (string $x) use ($s): string {
        $p = sprintf('(%s+%.3f+0.001)', $x, $s);
        $kurz = HLS_START_S * HLS_START_TEILE;
        return sprintf('if(lt(%1$s,%2$d),floor(%1$s/%3$d),%4$d+floor(%1$s/%5$d))', $p, $kurz, HLS_START_S, HLS_START_TEILE - intdiv($kurz, HLS_ZIEL_S), HLS_ZIEL_S);
    };
    return 'expr:if(isnan(prev_forced_t),1,gt(' . $abschnitt('t') . ',' . $abschnitt('prev_forced_t') . '))';
}

// ---------- Ordner ----------

function hls_basis(): string
{
    return konfig()['pfade']['transkodieren'];
}

function hls_cache_ordner(string $schluessel): string
{
    if (!preg_match('/^[a-f0-9]{20}$/', $schluessel)) {
        throw new RuntimeException('Ungültiger Zwischenspeicher.');
    }
    return hls_basis() . '/teile/' . $schluessel;
}

/** Schlüssel des Zwischenspeichers: dieselbe Datei (unverändert) mit derselben Umwandlung ergibt dieselben Teile */
function hls_schluessel(string $pfad, array $auftrag, string $profil, string $modus): string
{
    $st = @stat($pfad) ?: ['size' => 0, 'mtime' => 0];
    $relevant = [HLS_RASTER_VERSION, $pfad, $st['size'], $st['mtime'], $profil, $modus, $auftrag['video'] ?? null, $auftrag['audio'] ?? null,
        $auftrag['einbrennen'] ?? null, (bool) ($auftrag['quelle']['hdr'] ?? false)];
    return substr(sha1((string) json_encode($relevant)), 0, 20);
}

function sitzung_ordner(string $id): string
{
    if (!preg_match('/^[a-f0-9]{24}$/', $id)) {
        throw new RuntimeException('Ungültige Sitzung.');
    }
    return hls_basis() . '/sitzung-' . $id;
}

function sitzung_meta(string $id): ?array
{
    $m = @json_decode((string) @file_get_contents(sitzung_ordner($id) . '/meta.json'), true);
    return is_array($m) ? $m : null;
}

function sitzung_meta_schreiben(string $id, array $m): void
{
    bw_schreiben(sitzung_ordner($id) . '/meta.json', (string) json_encode($m, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

function hls_teil_datei(string $cache, int $n): string
{
    return sprintf('%s/teil_%05d.m4s', $cache, $n);
}

function hls_part_datei(string $cache, int $n, string $sid): string
{
    return hls_teil_datei($cache, $n) . '.' . $sid . '.part';
}

/** Stand des Segmentierers dieser Sitzung (nur, wenn er zum aktuellen Encoder gehört) */
function hls_status(string $id, array $m): array
{
    $s = @json_decode((string) @file_get_contents(sitzung_ordner($id) . '/status.json'), true);
    if (!is_array($s) || (int) ($s['generation'] ?? -1) !== (int) ($m['generation'] ?? 0)) {
        return ['kopf' => ($m['start_teil'] ?? 0) - 1, 'schreibt' => null, 'laeuft' => true];
    }
    return $s;
}

// ---------- Sitzungen ----------

/**
 * Neue Sitzung. $modus: 'umwandeln' (Raster fest, Schlüsselbilder erzwungen) oder 'kopie' (Video unverändert, Raster = $schluessel).
 * $startS: wo die Wiedergabe beginnt – dort startet der Encoder gleich beim ersten Abruf.
 */
function hls_sitzung_anlegen(array $konto, array $datei, array $auftrag, string $profil, string $alt, string $modus = 'umwandeln',
    ?array $schluessel = null, float $startS = 0.0, int $limitBytes = 0): string
{
    // alte Sitzung desselben Players beenden; zu viele gleichzeitige? Älteste (seit einer Minute untätige) beenden
    if ($alt !== '' && preg_match('/^[a-f0-9]{24}$/', $alt)) {
        sitzung_beenden($alt, (int) $konto['id']);
    }
    $max = konfig()['transkodieren']['max_gleichzeitig'];
    $laufend = sitzungen_alle();
    if (count($laufend) >= $max) {
        usort($laufend, static fn($a, $b) => $a['zuletzt'] <=> $b['zuletzt']);
        foreach ($laufend as $s) {
            if (time() - $s['zuletzt'] > 60) {
                sitzung_beenden($s['id']);
                break;
            }
        }
        if (count(sitzungen_alle()) >= $max) {
            throw new RuntimeException('Gerade laufen schon ' . $max . ' Umwandlungen – bitte später noch einmal.');
        }
    }
    $dauer = max(1.0, (int) $datei['dauer_ms'] / 1000);
    $grenzen = $modus === 'kopie' ? hls_raster_kopie((array) $schluessel, $dauer) : hls_raster_fest($dauer);
    $schl = hls_schluessel((string) $datei['pfad'], $auftrag, $profil, $modus);
    $cache = hls_cache_ordner($schl);
    @mkdir($cache, 0775, true);
    @touch($cache);
    $id = bin2hex(random_bytes(12));
    $o = sitzung_ordner($id);
    @mkdir($o, 0775, true);
    sitzung_meta_schreiben($id, [
        'id' => $id, 'konto_id' => (int) $konto['id'], 'datei_id' => (int) $datei['id'], 'auftrag' => $auftrag, 'profil' => $profil,
        'modus' => $modus, 'cache' => $schl, 'dauer_s' => $dauer, 'grenzen' => $grenzen, 'teile' => count($grenzen),
        'start_wunsch' => hls_teil_fuer_zeit($grenzen, $startS), 'limit_bytes' => $limitBytes ?: hls_limit_bytes(), 'pid' => null, 'start_teil' => null, 'generation' => 0, 'erstellt' => time(),
    ]);
    @touch($o . '/aktiv');
    return $id;
}

function sitzungen_alle(): array
{
    $aus = [];
    foreach (glob(hls_basis() . '/sitzung-*', GLOB_ONLYDIR) ?: [] as $d) {
        $id = substr(basename($d), 8);
        $m = @json_decode((string) @file_get_contents($d . '/meta.json'), true);
        $aus[] = ['id' => $id, 'konto_id' => (int) ($m['konto_id'] ?? 0), 'zuletzt' => (int) @filemtime($d . '/aktiv'), 'pid' => $m['pid'] ?? null,
            'cache' => $m['cache'] ?? null];
    }
    return $aus;
}

/** Läuft der Encoder dieser Sitzung (Segmentierer bzw. ffmpeg) noch? */
function prozess_laeuft(?int $pid): bool
{
    if (!$pid || !posix_kill($pid, 0)) {
        return false;
    }
    $stat = (string) @file_get_contents("/proc/$pid/stat");
    if (preg_match('/^\d+ \(.*\) Z/', $stat)) {
        return false; // Zombie zählt nicht
    }
    $cmd = (string) @file_get_contents("/proc/$pid/cmdline");
    return str_contains($cmd, 'segmentierer') || str_contains($cmd, 'ffmpeg');
}

/** Encoder beenden: ganze Prozessgruppe (Segmentierer + ffmpeg); der halbe Teil bleibt als .part liegen und wird verworfen */
function encoder_stoppen(?int $pid): void
{
    if (!$pid || !prozess_laeuft($pid)) {
        return;
    }
    @posix_kill(-$pid, SIGKILL);
    @posix_kill($pid, SIGKILL);
    for ($i = 0; $i < 40 && prozess_laeuft($pid); $i++) {
        usleep(25000);
    }
}

function encoder_signal(array $m, int $signal): void
{
    if (!empty($m['pid'])) {
        @posix_kill(-(int) $m['pid'], $signal);
        @posix_kill((int) $m['pid'], $signal);
    }
}

function sitzung_beenden(string $id, ?int $kontoId = null): void
{
    $m = sitzung_meta($id);
    if (!$m || ($kontoId !== null && (int) $m['konto_id'] !== $kontoId)) {
        return;
    }
    encoder_stoppen($m['pid'] ? (int) $m['pid'] : null);
    if (!empty($m['cache'])) {
        foreach (glob(hls_cache_ordner((string) $m['cache']) . '/*.' . $id . '.part') ?: [] as $p) {
            @unlink($p);
        }
    }
    $o = sitzung_ordner($id);
    foreach (glob($o . '/*') ?: [] as $f) {
        @unlink($f);
    }
    @rmdir($o);
}

/** Liegengebliebene Sitzungen (3 Minuten ohne Abruf) aufräumen */
function sitzungen_aufraeumen(): int
{
    $n = 0;
    foreach (sitzungen_alle() as $s) {
        if (time() - $s['zuletzt'] > 180) {
            sitzung_beenden($s['id']);
            $n++;
        }
    }
    return $n;
}

/** Obergrenze des Zwischenspeichers: Einstellung (GB) oder automatisch 30 % des Laufwerks, höchstens 8 GB, mindestens 1 GB */
function hls_limit_bytes(int $einstellungGb = 0): int
{
    if ($einstellungGb > 0) {
        return $einstellungGb * 1024 ** 3;
    }
    $gesamt = (float) (@disk_total_space(hls_basis()) ?: 0);
    return (int) max(1024 ** 3, min(8 * 1024 ** 3, $gesamt * 0.3));
}

/** Encoder ab Teil $n (neu) starten */
function encoder_starten(string $id, array &$m, int $n): void
{
    encoder_stoppen($m['pid'] ? (int) $m['pid'] : null);
    $o = sitzung_ordner($id);
    $cache = hls_cache_ordner((string) $m['cache']);
    @mkdir($cache, 0775, true);
    foreach (glob($cache . '/*.' . $id . '.part') ?: [] as $p) {
        @unlink($p);
    }
    $g = $m['grenzen'];
    $a = $m['auftrag'];
    $kopie = ($m['modus'] ?? 'umwandeln') === 'kopie';
    // bei unverändertem Video knapp hinter das Schlüsselbild springen, damit ffmpeg genau dort beginnt (nicht beim vorigen)
    $a['start_s'] = $n > 0 ? (float) $g[$n] + ($kopie ? 0.001 : 0.0) : 0.0;
    $a['ziel'] = ['format' => 'fmp4'];
    $a['zeit_versatz'] = HLS_ZEIT_VERSATZ;
    if (!$kopie) {
        $a['schluesselbilder'] = hls_schluesselbild_ausdruck((float) $g[$n]);
    }
    $hw = hw_lesen() ?? [];
    $cmd = encoder_befehl((string) $m['profil'], $a, $hw);
    $m['generation'] = (int) ($m['generation'] ?? 0) + 1;
    $lauf = [
        'cmd' => $cmd, 'ordner' => $cache, 'sitzung' => $id, 'start' => $n, 'grenzen' => $g, 'generation' => $m['generation'],
        'status' => $o . '/status.json', 'log' => $o . '/ffmpeg.log', 'limit_bytes' => (int) ($m['limit_bytes'] ?? hls_limit_bytes()),
        'versatz' => HLS_ZEIT_VERSATZ,
    ];
    bw_schreiben($o . '/lauf.json', (string) json_encode($lauf, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    @unlink($o . '/status.json');
    $php = PHP_SAPI === 'cli' && PHP_BINARY !== '' ? PHP_BINARY : 'php';
    $befehl = 'setsid ' . escapeshellarg($php) . ' ' . escapeshellarg(realpath(__DIR__ . '/../scripts/segmentierer.php')) . ' '
        . escapeshellarg($o . '/lauf.json') . ' >> ' . escapeshellarg($o . '/segmentierer.log') . ' 2>&1 < /dev/null & echo $!';
    $pid = (int) trim((string) shell_exec($befehl));
    $m['pid'] = $pid ?: null;
    $m['start_teil'] = $n;
    $m['gestoppt'] = false;
    sitzung_meta_schreiben($id, $m);
}

// ---------- Teile abrufen ----------

/**
 * Teil $n (null = init.mp4) bereitstellen; startet bzw. steuert den Encoder nach Bedarf.
 * Ergebnis: ['datei' => fertige Datei] oder ['part' => wachsende Datei, 'datei' => Zielname, 'generation' => …]
 */
function hls_teil(string $id, ?int $n): array
{
    $o = sitzung_ordner($id);
    $sperre = @fopen($o . '/sperre', 'c');
    if (!$sperre) {
        throw new RuntimeException('Sitzung abgelaufen.');
    }
    @touch($o . '/aktiv');
    $ende = microtime(true) + 25;
    // Generation des Encoders beim Eintreffen: Hat inzwischen eine andere Anfrage neu gestartet (Spulen), darf diese
    // (vermutlich vom Browser längst abgebrochene) Anfrage den Encoder nicht zurücksetzen – sonst pendelt er hin und her.
    $generation = null;
    try {
        while (microtime(true) < $ende) {
            flock($sperre, LOCK_EX);
            $m = sitzung_meta($id) ?? throw new RuntimeException('Sitzung abgelaufen.');
            $generation ??= (int) ($m['generation'] ?? 0);
            $cache = hls_cache_ordner((string) $m['cache']);
            $laeuft = prozess_laeuft($m['pid'] ? (int) $m['pid'] : null);
            $st = hls_status($id, $m);
            clearstatcache();

            if ($n === null) {
                $init = $cache . '/init.mp4';
                if (is_file($init) && filesize($init) > 0) {
                    flock($sperre, LOCK_UN);
                    return ['datei' => $init];
                }
                if (!$laeuft) {
                    encoder_starten($id, $m, (int) ($m['start_wunsch'] ?? 0));
                    diag('hls_neustart', ['teil' => $m['start_teil'], 'ab_s' => $m['grenzen'][$m['start_teil']], 'grund' => 'init']);
                    $generation = (int) $m['generation'];
                }
                flock($sperre, LOCK_UN);
                usleep(40000);
                clearstatcache();
                if (($f = hls_encoder_fehler($id)) !== null && !is_file($init)) {
                    throw new RuntimeException('Umwandlung fehlgeschlagen: ' . mb_substr($f, -400));
                }
                continue;
            }

            if ($n >= (int) $m['teile']) {
                throw new RuntimeException('Teil gibt es nicht.');
            }
            $ziel = hls_teil_datei($cache, $n);
            if (is_file($ziel)) {
                @touch($ziel); // zuletzt benutzt (Aufräumen nach Alter)
                hls_vorausplanen($id, $m, $n, $laeuft, $st);
                flock($sperre, LOCK_UN);
                return ['datei' => $ziel];
            }
            // Teil entsteht gerade bei unserem Encoder → schon ausliefern, während er wächst
            $part = hls_part_datei($cache, $n, $id);
            if ($laeuft && ($st['schreibt'] ?? null) === $n && is_file($part)) {
                if (!empty($m['gestoppt'])) {
                    encoder_signal($m, SIGCONT);
                    $m['gestoppt'] = false;
                    sitzung_meta_schreiben($id, $m);
                }
                flock($sperre, LOCK_UN);
                return ['part' => $part, 'datei' => $ziel, 'generation' => (int) $m['generation']];
            }
            // Encoder läuft und kommt gleich hier an? Dann warten. Sonst ab hier neu starten.
            $kopf = (int) ($st['kopf'] ?? ((int) $m['start_teil'] - 1));
            $baldDa = $laeuft && $m['start_teil'] !== null && $n >= (int) $m['start_teil'] && $n <= $kopf + 4;
            if (!$baldDa) {
                if ((int) ($m['generation'] ?? 0) !== $generation) {
                    diag('hls_ueberholt', ['teil' => $n, 'encoder_ab' => $m['start_teil']]);
                    throw new TeilUeberholt('Überholt – inzwischen wurde woanders hingesprungen.');
                }
                $alt = $m['start_teil'];
                encoder_starten($id, $m, $n);
                $generation = (int) $m['generation'];
                diag('hls_neustart', ['teil' => $n, 'ab_s' => $m['grenzen'][$n], 'vorher_ab_teil' => $alt, 'kopf' => $kopf, 'lief' => $laeuft]);
            } elseif (!empty($m['gestoppt'])) {
                encoder_signal($m, SIGCONT);
                $m['gestoppt'] = false;
                sitzung_meta_schreiben($id, $m);
            }
            flock($sperre, LOCK_UN);
            usleep(40000);
            // Encoder gescheitert? Fehler zurückgeben statt endlos warten
            clearstatcache();
            if (($f = hls_encoder_fehler($id)) !== null && !is_file($ziel)) {
                throw new RuntimeException('Umwandlung fehlgeschlagen: ' . mb_substr($f, -400));
            }
        }
        $m = sitzung_meta($id) ?? [];
        diag('hls_zeitueberschreitung', ['teil' => $n ?? 'init', 'encoder_ab' => $m['start_teil'] ?? null,
            'laeuft' => prozess_laeuft(($m['pid'] ?? null) ? (int) $m['pid'] : null)]);
        throw new RuntimeException('Zeitüberschreitung beim Umwandeln.');
    } finally {
        @flock($sperre, LOCK_UN);
        fclose($sperre);
    }
}

/**
 * Nach dem Ausliefern eines fertigen Teils: Encoder drosseln (weit voraus → anhalten) und vorausschauen, ob bald eine Lücke
 * im Zwischenspeicher kommt, die unser Encoder nicht rechtzeitig füllt (dann dort starten). Läuft unter der Sitzungssperre.
 */
function hls_vorausplanen(string $id, array &$m, int $n, bool $laeuft, array $st): void
{
    $cache = hls_cache_ordner((string) $m['cache']);
    $kopf = (int) ($st['kopf'] ?? ((int) ($m['start_teil'] ?? 0) - 1));
    if ($laeuft) {
        $voraus = $kopf - $n;
        if ($voraus > HLS_VORAUS_MAX && empty($m['gestoppt'])) {
            encoder_signal($m, SIGSTOP);
            $m['gestoppt'] = true;
            sitzung_meta_schreiben($id, $m);
            return;
        }
        if ($voraus < HLS_VORAUS_WEITER && !empty($m['gestoppt'])) {
            encoder_signal($m, SIGCONT);
            $m['gestoppt'] = false;
            sitzung_meta_schreiben($id, $m);
        }
    }
    // erste Lücke in den nächsten 12 Teilen (≈ 1 Minute)
    $luecke = null;
    for ($i = $n + 1; $i < min((int) $m['teile'], $n + 13); $i++) {
        if (!is_file(hls_teil_datei($cache, $i))) {
            $luecke = $i;
            break;
        }
    }
    if ($laeuft && $kopf < $n - 1) {
        // Encoder hängt hinter der Wiedergabe und rechnet nur nach, was schon im Zwischenspeicher liegt
        if ($luecke === null) {
            encoder_stoppen((int) $m['pid']);
            $m['pid'] = null;
            sitzung_meta_schreiben($id, $m);
            return;
        }
        $laeuft = false; // → unten an der Lücke neu starten
    }
    if ($luecke === null) {
        return;
    }
    $erreichtLuecke = $laeuft && $m['start_teil'] !== null && (int) $m['start_teil'] <= $luecke && $kopf < $luecke;
    if (!$erreichtLuecke) {
        encoder_starten($id, $m, $luecke);
        diag('hls_neustart', ['teil' => $luecke, 'ab_s' => $m['grenzen'][$luecke], 'grund' => 'lücke im zwischenspeicher', 'wiedergabe_teil' => $n]);
    }
}

/** Beim Spulen gleich an der Zielstelle starten (der Player meldet sich, bevor hls.js den Teil anfragt) */
function hls_vorstart(string $id, float $zeit): ?int
{
    $o = sitzung_ordner($id);
    $sperre = @fopen($o . '/sperre', 'c');
    if (!$sperre) {
        return null;
    }
    flock($sperre, LOCK_EX);
    try {
        $m = sitzung_meta($id);
        if (!$m) {
            return null;
        }
        $n = hls_teil_fuer_zeit($m['grenzen'], $zeit);
        $cache = hls_cache_ordner((string) $m['cache']);
        if (is_file(hls_teil_datei($cache, $n))) {
            return null;
        }
        $laeuft = prozess_laeuft($m['pid'] ? (int) $m['pid'] : null);
        $st = hls_status($id, $m);
        $kopf = (int) ($st['kopf'] ?? ((int) ($m['start_teil'] ?? 0) - 1));
        if ($laeuft && $m['start_teil'] !== null && $n >= (int) $m['start_teil'] && $n <= $kopf + 4) {
            return null;
        }
        encoder_starten($id, $m, $n);
        diag('hls_neustart', ['teil' => $n, 'ab_s' => $m['grenzen'][$n], 'grund' => 'vorstart beim spulen']);
        return $n;
    } finally {
        flock($sperre, LOCK_UN);
        fclose($sperre);
    }
}

/** Ist der Encoder dieser Sitzung mit Fehler ausgestiegen? Dann die Meldung (sonst null) */
function hls_encoder_fehler(string $id): ?string
{
    $m = sitzung_meta($id);
    if (!$m || prozess_laeuft($m['pid'] ? (int) $m['pid'] : null)) {
        return null;
    }
    $st = hls_status($id, $m);
    return !empty($st['fehler']) ? (string) $st['fehler'] : null;
}

/** Wachsenden Teil ausliefern: alles Vorhandene sofort, dann jedes neue Fragment, bis der Teil fertig ist */
function hls_part_senden(string $sid, array $r): void
{
    $fh = @fopen($r['part'], 'rb');
    if (!$fh) {
        // gerade fertig geworden (umbenannt)
        clearstatcache();
        if (is_file($r['datei'])) {
            header('Content-Length: ' . filesize($r['datei']));
            readfile($r['datei']);
            return;
        }
        throw new RuntimeException('Teil verschwunden.');
    }
    @set_time_limit(600);
    header('Cache-Control: no-store');
    header('X-Accel-Buffering: no');
    $gesendet = 0;
    $ruhe = microtime(true);
    $beginn = microtime(true);
    while (true) {
        $stueck = fread($fh, 262144);
        if ($stueck !== false && $stueck !== '') {
            echo $stueck;
            flush();
            $gesendet += strlen($stueck);
            $ruhe = microtime(true);
            continue;
        }
        if (connection_aborted()) {
            break;
        }
        clearstatcache();
        $eigen = fstat($fh);
        $fertig = @stat($r['datei']);
        // fertig = unsere Datei wurde umbenannt (gleicher Inode) und alles ist gesendet
        if ($fertig && $eigen && $fertig['ino'] === $eigen['ino'] && $gesendet >= $eigen['size']) {
            break;
        }
        if (microtime(true) - $ruhe > 3) {
            // lange nichts Neues: läuft unser Encoder überhaupt noch?
            $m = sitzung_meta($sid);
            if (!$m || (int) ($m['generation'] ?? 0) !== (int) $r['generation'] || !prozess_laeuft($m['pid'] ? (int) $m['pid'] : null) || !empty($m['gestoppt'])) {
                diag('hls_teil_abgebrochen', ['grund' => 'encoder weg', 'kb' => (int) ($gesendet / 1024)]);
                break;
            }
            @touch(sitzung_ordner($sid) . '/aktiv');
            $ruhe = microtime(true);
        }
        if (microtime(true) - $beginn > 300) {
            break;
        }
        usleep(25000);
    }
    fclose($fh);
}

/** Wiedergabeliste: alle Teile von Anfang an (VOD) – Spulen springt einfach zum passenden Teil */
function hls_playlist(string $id): string
{
    $m = sitzung_meta($id) ?? throw new RuntimeException('Sitzung abgelaufen.');
    @touch(sitzung_ordner($id) . '/aktiv');
    $g = $m['grenzen'];
    $dauer = (float) $m['dauer_s'];
    $laengste = 1;
    foreach (array_keys($g) as $i) {
        $laengste = max($laengste, (int) ceil(hls_teil_dauer($g, $i, $dauer)));
    }
    $z = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:' . $laengste, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="init.mp4"'];
    foreach (array_keys($g) as $i) {
        $z[] = sprintf('#EXTINF:%.3f,', hls_teil_dauer($g, $i, $dauer));
        $z[] = 'teil/' . $i . '.m4s';
    }
    $z[] = '#EXT-X-ENDLIST';
    return implode("\n", $z) . "\n";
}

// ---------- Zwischenspeicher aufräumen ----------

/**
 * Über der Obergrenze: zuletzt am längsten unbenutzte Teile löschen (bis 85 %). Verwaiste .part-Dateien und leere
 * Zwischenspeicher ohne Sitzung fliegen ebenfalls raus. Läuft höchstens einmal gleichzeitig.
 */
function hls_zwischenspeicher_aufraeumen(int $limit): array
{
    $basis = hls_basis() . '/teile';
    if (!is_dir($basis)) {
        return ['geloescht' => 0, 'belegt' => 0];
    }
    $sperre = @fopen($basis . '/.aufraeumen.lock', 'c');
    if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
        return ['geloescht' => 0, 'belegt' => null];
    }
    $aktiv = [];
    foreach (sitzungen_alle() as $s) {
        if ($s['cache']) {
            $aktiv[$s['cache']] = true;
        }
    }
    $jetzt = time();
    $teile = [];
    $summe = 0;
    $geloescht = 0;
    foreach (glob($basis . '/*', GLOB_ONLYDIR) ?: [] as $ordner) {
        $schl = basename($ordner);
        $anzahl = 0;
        foreach (scandir($ordner) ?: [] as $f) {
            $p = $ordner . '/' . $f;
            if (str_ends_with($f, '.part') || str_ends_with($f, '.tmp')) {
                if ($jetzt - (int) @filemtime($p) > 600) {
                    @unlink($p);
                }
                continue;
            }
            if (str_starts_with($f, 'teil_')) {
                $st = @stat($p);
                if ($st) {
                    $teile[] = [$st['mtime'], $st['size'], $p];
                    $summe += $st['size'];
                    $anzahl++;
                }
            }
        }
        if ($anzahl === 0 && !isset($aktiv[$schl]) && $jetzt - (int) @filemtime($ordner) > 3600) {
            foreach (glob($ordner . '/*') ?: [] as $f) {
                @unlink($f);
            }
            @rmdir($ordner);
        }
    }
    if ($summe > $limit) {
        usort($teile, static fn($a, $b) => $a[0] <=> $b[0]);
        foreach ($teile as [$zeit, $groesse, $p]) {
            if ($summe <= $limit * 0.85) {
                break;
            }
            if ($jetzt - $zeit < 60) {
                break; // gerade benutzt bzw. gerade entstanden – nie wegwerfen
            }
            if (@unlink($p)) {
                $summe -= $groesse;
                $geloescht++;
            }
        }
    }
    flock($sperre, LOCK_UN);
    fclose($sperre);
    return ['geloescht' => $geloescht, 'belegt' => $summe];
}
