<?php
// Vorschaubilder für die Zeitleiste: alle 10 s ein kleines Standbild, je 100 Stück auf einem Kachelbild (10 × 10).
// Erzeugt im Hintergrund (scripts/vorarbeit.php). Je Stelle springt ffmpeg zum nächsten Schlüsselbild davor und dekodiert
// nur dieses eine Bild – liest also nur einen Bruchteil der Datei (wichtig bei 60-GB-Remuxen auf Festplatten).
declare(strict_types=1);
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/hardware.php';

const VORSCHAU_VERSION = 1;
const VORSCHAU_BREITE = 240;
const VORSCHAU_SPALTEN = 10;
const VORSCHAU_ZEILEN = 10;

function vorschau_ordner(int $dateiId): string
{
    return konfig()['pfade']['cache'] . '/vorschau/' . $dateiId;
}

function vorschau_intervall(float $dauer): int
{
    return $dauer <= 1200 ? 5 : 10;
}

/** Fertige Vorschau einer Datei (passend zur aktuellen Datei) oder null */
function vorschau_info(array $datei): ?array
{
    $j = @json_decode((string) @file_get_contents(vorschau_ordner((int) $datei['id']) . '/vorschau.json'), true);
    if (!is_array($j) || ($j['version'] ?? 0) !== VORSCHAU_VERSION || (int) ($j['groesse'] ?? -1) !== (int) $datei['groesse']) {
        return null;
    }
    return [
        'intervall' => (int) $j['intervall'], 'breite' => (int) $j['breite'], 'hoehe' => (int) $j['hoehe'],
        'spalten' => (int) $j['spalten'], 'zeilen' => (int) $j['zeilen'], 'anzahl' => (int) $j['anzahl'],
        'url' => '/api/v1/vorschau/' . (int) $datei['id'] . '/{n}.jpg?v=' . substr(sha1((string) $j['erstellt']), 0, 8),
    ];
}

/** Ist für diese Datei schon einmal etwas schiefgegangen (gleiche Datei)? Dann nicht ständig neu versuchen. */
function vorschau_gescheitert(array $datei): bool
{
    $f = vorschau_ordner((int) $datei['id']) . '/fehler.json';
    $j = @json_decode((string) @file_get_contents($f), true);
    return is_array($j) && (int) ($j['groesse'] ?? -1) === (int) $datei['groesse'] && time() - (int) ($j['zeit'] ?? 0) < 7 * 86400;
}

/** Videofilter: verkleinern (zuerst – spart Rechenzeit), bei HDR ins SDR umrechnen */
function vorschau_filter(int $b, int $h, bool $hdr): string
{
    $f = 'scale=' . $b . ':' . $h . ':flags=bilinear';
    if ($hdr) {
        $hw = hw_lesen() ?? [];
        if (!empty($hw['filter']['tonemapx'])) {
            $f .= ',tonemapx=tonemap=bt2390:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=yuv420p';
        } elseif (!empty($hw['filter']['zscale'])) {
            $f .= ',zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
        }
    }
    return $f . ',format=yuvj420p';
}

/**
 * Vorschau erzeugen. $weiter(float $anteil): bool wird zwischendurch gerufen – false = abbrechen (z. B. weil jemand schaut).
 * Liefert true (fertig), false (abgebrochen) oder wirft bei Fehlern.
 */
function vorschau_erzeugen(array $datei, ?callable $weiter = null): bool
{
    if (!function_exists('imagecreatetruecolor')) {
        throw new RuntimeException('GD fehlt');
    }
    $pfad = (string) $datei['pfad'];
    $dauer = max(1.0, (int) $datei['dauer_ms'] / 1000);
    $qb = max(2, (int) $datei['breite']);
    $qh = max(2, (int) $datei['hoehe']);
    $b = VORSCHAU_BREITE;
    $h = max(2, (int) (round($b * $qh / $qb / 2) * 2));
    $intervall = vorschau_intervall($dauer);
    $anzahl = (int) ceil($dauer / $intervall);
    $hdr = ($datei['hdr'] ?? 'sdr') !== 'sdr';
    $filter = vorschau_filter($b, $h, $hdr);
    $ffmpeg = konfig()['transkodieren']['ffmpeg'];
    $ziel = vorschau_ordner((int) $datei['id']);
    $tmp = $ziel . '.neu';
    if (is_dir($tmp)) {
        array_map('unlink', glob($tmp . '/*') ?: []);
    }
    @mkdir($tmp, 0775, true);
    $proBild = VORSCHAU_SPALTEN * VORSCHAU_ZEILEN;
    $kachel = null;
    $leer = 0;
    for ($i = 0; $i < $anzahl; $i++) {
        if ($i % $proBild === 0) {
            $kachel = imagecreatetruecolor($b * VORSCHAU_SPALTEN, $h * VORSCHAU_ZEILEN);
            imagefill($kachel, 0, 0, imagecolorallocate($kachel, 8, 12, 20));
        }
        // etwas hinter den Anfang des Abschnitts (Szenenanfang ist oft schwarz), nie hinter das Ende
        $t = min($dauer - 0.5, $i * $intervall + min(2.0, $intervall / 2));
        $cmd = [$ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-noaccurate_seek', '-ss', sprintf('%.3f', max(0, $t)), '-i', $pfad,
            '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', $filter, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1'];
        $r = bw_ausfuehren($cmd, 60);
        $bild = $r['code'] === 0 && $r['aus'] !== '' ? @imagecreatefromstring($r['aus']) : false;
        if ($bild) {
            imagecopy($kachel, $bild, ($i % VORSCHAU_SPALTEN) * $b, (intdiv($i % $proBild, VORSCHAU_SPALTEN)) * $h, 0, 0, min($b, imagesx($bild)), min($h, imagesy($bild)));
            imagedestroy($bild);
        } else {
            $leer++;
            if ($leer > 20 && $leer > $i / 2) {
                array_map('unlink', glob($tmp . '/*') ?: []);
                @rmdir($tmp);
                throw new RuntimeException('Keine Bilder lesbar: ' . mb_substr(trim($r['fehler']), 0, 300));
            }
        }
        if ($i % $proBild === $proBild - 1 || $i === $anzahl - 1) {
            imagejpeg($kachel, sprintf('%s/%d.jpg', $tmp, intdiv($i, $proBild)), 72);
            imagedestroy($kachel);
            $kachel = null;
        }
        if ($weiter && $i % 5 === 4 && !$weiter(($i + 1) / $anzahl)) {
            array_map('unlink', glob($tmp . '/*') ?: []);
            @rmdir($tmp);
            return false;
        }
    }
    file_put_contents($tmp . '/vorschau.json', json_encode([
        'version' => VORSCHAU_VERSION, 'intervall' => $intervall, 'breite' => $b, 'hoehe' => $h, 'spalten' => VORSCHAU_SPALTEN,
        'zeilen' => VORSCHAU_ZEILEN, 'anzahl' => $anzahl, 'groesse' => (int) $datei['groesse'], 'erstellt' => time(),
    ]));
    // fertig: alten Ordner gegen den neuen tauschen
    if (is_dir($ziel)) {
        array_map('unlink', glob($ziel . '/*') ?: []);
        @rmdir($ziel);
    }
    rename($tmp, $ziel);
    return true;
}

function vorschau_fehler_merken(array $datei, string $text): void
{
    $o = vorschau_ordner((int) $datei['id']);
    @mkdir($o, 0775, true);
    @file_put_contents($o . '/fehler.json', json_encode(['groesse' => (int) $datei['groesse'], 'zeit' => time(), 'text' => mb_substr($text, 0, 500)]));
}
