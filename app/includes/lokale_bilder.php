<?php
// Lokale Bilder aus den Medienordnern (Kodi/Plex/Jellyfin-Namen) haben Vorrang vor TMDB:
// Film: poster/folder/cover/movie.jpg, <datei>-poster.jpg; fanart/backdrop/background.jpg; logo/clearlogo.png
// Serie: poster/folder/cover/show.jpg, fanart …, logo …; Staffeln: seasonNN-poster.jpg, season-specials-poster.jpg,
//        „Season 01“/„Staffel 1“/poster|folder.jpg; Folgen: <datei>-thumb.jpg bzw. <datei>.jpg
// Allgemeine Namen (poster.jpg …) gelten nur, wenn der Ordner einem einzigen Film bzw. einer Serie gehört.
declare(strict_types=1);

require_once __DIR__ . '/scanner.php';
require_once __DIR__ . '/einstellungen.php';

const LB_ENDUNGEN = ['jpg', 'jpeg', 'png', 'webp'];

function lb_aktiv(): bool
{
    return (bool) (server_einstellungen()['lokale_bilder'] ?? true);
}

/** Erste vorhandene Datei aus Namen (ohne Endung) im Ordner, Groß/Klein egal */
function lb_finden(string $ordner, array $namen): ?string
{
    static $listen = [];
    if (!isset($listen[$ordner])) {
        $listen[$ordner] = [];
        foreach (@scandir($ordner) ?: [] as $e) {
            $listen[$ordner][mb_strtolower($e)] = $e;
        }
    }
    foreach ($namen as $n) {
        foreach (LB_ENDUNGEN as $end) {
            $k = mb_strtolower($n . '.' . $end);
            if (isset($listen[$ordner][$k]) && is_file($ordner . '/' . $listen[$ordner][$k])) {
                return $ordner . '/' . $listen[$ordner][$k];
            }
        }
    }
    return null;
}

/**
 * Bild in den Cache übernehmen (verkleinert, als JPEG; PNG mit Transparenz bleibt PNG).
 * Name aus Pfad, Größe und Änderungszeit → unverändert = keine Arbeit.
 */
function lb_uebernehmen(string $datei, int $maxBreite): ?string
{
    $st = @stat($datei);
    if (!$st || $st['size'] < 200 || $st['size'] > 40 * 1024 * 1024) {
        return null;
    }
    $istPng = (bool) preg_match('/\.png$/i', $datei);
    $name = sha1($datei . '|' . $st['size'] . '|' . $st['mtime'] . '|' . $maxBreite) . ($istPng ? '.png' : '.jpg');
    $rel = 'lokal/original/' . $name;
    $ziel = konfig()['pfade']['cache'] . '/bilder/' . $rel;
    if (is_file($ziel) && filesize($ziel) > 0) {
        return $rel;
    }
    @mkdir(dirname($ziel), 0775, true);
    $roh = @file_get_contents($datei);
    $bild = $roh !== false && function_exists('imagecreatefromstring') ? @imagecreatefromstring($roh) : false;
    if (!$bild) {
        return null; // kein lesbares Bild
    }
    $b = imagesx($bild);
    $h = imagesy($bild);
    if ($b > $maxBreite) {
        $neu = imagecreatetruecolor($maxBreite, (int) round($h * $maxBreite / $b));
        if ($istPng) {
            imagealphablending($neu, false);
            imagesavealpha($neu, true);
        }
        imagecopyresampled($neu, $bild, 0, 0, 0, 0, $maxBreite, (int) round($h * $maxBreite / $b), $b, $h);
        imagedestroy($bild);
        $bild = $neu;
    } elseif ($istPng) {
        imagesavealpha($bild, true);
    }
    $tmp = $ziel . '.' . bin2hex(random_bytes(3)) . '.tmp';
    $ok = $istPng ? imagepng($bild, $tmp, 6) : imagejpeg($bild, $tmp, 88);
    imagedestroy($bild);
    if (!$ok) {
        @unlink($tmp);
        return null;
    }
    rename($tmp, $ziel);
    return $rel;
}

function lb_video_im_ordner(string $ordner): array
{
    // wie der Scanner: Samples und Trailer zählen nicht
    return array_values(array_filter(@scandir($ordner) ?: [], static fn($e) => in_array(strtolower(pathinfo($e, PATHINFO_EXTENSION)), VIDEO_ENDUNGEN, true)
        && !preg_match('/(^|[ ._-])(sample|trailer|featurette|behindthescenes|deleted)([ ._-]|$)/i', pathinfo($e, PATHINFO_FILENAME))));
}

/** Lokale Bilder eines Films anwenden; gibt die Zahl gesetzter Bilder zurück */
function lokale_bilder_film(int $filmId): int
{
    $pfade = array_column(db_alle('SELECT d.pfad FROM dateien d JOIN fassungen fa ON fa.id = d.fassung_id WHERE fa.film_id = :f AND d.fehlt_seit IS NULL ORDER BY fa.standard DESC, d.hoehe DESC',
        ['f' => $filmId]), 'pfad');
    if (!$pfade) {
        return 0;
    }
    $ordner = dirname($pfade[0]);
    $basis = pathinfo($pfade[0], PATHINFO_FILENAME);
    // gehören alle Videos im Ordner zu diesem Film? Dann gelten auch allgemeine Namen
    $eigene = array_map('basename', array_filter($pfade, static fn($p) => dirname($p) === $ordner));
    $eigenerOrdner = $ordner !== rtrim(konfig()['pfade']['filme'], '/') && !array_diff(lb_video_im_ordner($ordner), $eigene);
    $basen = array_unique(array_map(static fn($p) => pathinfo($p, PATHINFO_FILENAME), $pfade));
    $namen = static fn(array $allgemein, array $endungen) => array_merge(
        array_merge(...array_map(static fn($b) => array_map(static fn($e) => $b . $e, $endungen), $basen)),
        $eigenerOrdner ? $allgemein : []);
    $setzen = [];
    if ($p = lb_finden($ordner, $namen(['poster', 'folder', 'cover', 'movie'], ['-poster', '.poster', '-cover']))) {
        $setzen['poster'] = lb_uebernehmen($p, 780);
    }
    if ($p = lb_finden($ordner, $namen(['fanart', 'backdrop', 'background', 'art', 'landscape'], ['-fanart', '.fanart', '-backdrop']))) {
        $setzen['hintergrund'] = lb_uebernehmen($p, 1920);
    }
    if ($p = lb_finden($ordner, $namen(['logo', 'clearlogo'], ['-logo', '-clearlogo']))) {
        $setzen['logo'] = lb_uebernehmen($p, 800);
    }
    return lb_schreiben('filme', $filmId, $setzen);
}

function lb_schreiben(string $tabelle, int $id, array $setzen): int
{
    $setzen = array_filter($setzen);
    if (!$setzen) {
        return 0;
    }
    $teile = implode(', ', array_map(static fn($k) => "$k = :$k", array_keys($setzen)));
    db_tun("UPDATE $tabelle SET $teile WHERE id = :id", $setzen + ['id' => $id]);
    return count($setzen);
}

/** Wurzelordner einer Serie: gemeinsamer Ordner der Folgen, ohne „Season 1“/„Staffel 1“/„Specials“ */
function lb_serien_ordner(array $pfade): ?string
{
    $ordner = array_unique(array_map(static function ($p) {
        $o = dirname($p);
        return preg_match('/^(season|staffel|series|serie|s)\s*[-_.]?\s*\d+$|^specials?$/i', basename($o)) ? dirname($o) : $o;
    }, $pfade));
    $gemeinsam = array_shift($ordner);
    foreach ($ordner as $o) {
        while ($gemeinsam !== '/' && !str_starts_with($o . '/', $gemeinsam . '/')) {
            $gemeinsam = dirname($gemeinsam);
        }
    }
    $wurzel = rtrim(konfig()['pfade']['serien'], '/');
    return $gemeinsam && $gemeinsam !== $wurzel && str_starts_with($gemeinsam, $wurzel . '/') ? $gemeinsam : null;
}

function lokale_bilder_serie(int $serieId): int
{
    $zeilen = db_alle('SELECT d.pfad, fo.id AS folge_id, fo.staffel_nr FROM dateien d JOIN folgen fo ON fo.id = d.folge_id WHERE fo.serie_id = :s AND d.fehlt_seit IS NULL', ['s' => $serieId]);
    if (!$zeilen) {
        return 0;
    }
    $n = 0;
    $wurzel = lb_serien_ordner(array_column($zeilen, 'pfad'));
    if ($wurzel) {
        $setzen = [];
        if ($p = lb_finden($wurzel, ['poster', 'folder', 'cover', 'show'])) {
            $setzen['poster'] = lb_uebernehmen($p, 780);
        }
        if ($p = lb_finden($wurzel, ['fanart', 'backdrop', 'background', 'art', 'landscape'])) {
            $setzen['hintergrund'] = lb_uebernehmen($p, 1920);
        }
        if ($p = lb_finden($wurzel, ['logo', 'clearlogo'])) {
            $setzen['logo'] = lb_uebernehmen($p, 800);
        }
        $n += lb_schreiben('serien', $serieId, $setzen);
        // Staffel-Poster: im Serienordner (season01-poster) oder im Staffelordner (poster/folder)
        $staffelOrdner = [];
        foreach ($zeilen as $z) {
            $o = dirname($z['pfad']);
            if ($o !== $wurzel) {
                $staffelOrdner[(int) $z['staffel_nr']] = $o;
            }
        }
        foreach (array_unique(array_map(static fn($z) => (int) $z['staffel_nr'], $zeilen)) as $nr) {
            $kand = $nr === 0 ? ['season-specials-poster', 'season00-poster', 'season0-poster', 'specials'] : [sprintf('season%02d-poster', $nr), "season$nr-poster", sprintf('season%02d', $nr), "staffel$nr"];
            $p = lb_finden($wurzel, $kand);
            if (!$p && isset($staffelOrdner[$nr])) {
                $p = lb_finden($staffelOrdner[$nr], ['poster', 'folder', 'cover']);
            }
            if ($p && ($rel = lb_uebernehmen($p, 500))) {
                db_tun('INSERT INTO serien_staffeln (serie_id, nummer, poster) VALUES (:s, :n, :p) ON DUPLICATE KEY UPDATE poster = VALUES(poster)', ['s' => $serieId, 'n' => $nr, 'p' => $rel]);
                $n++;
            }
        }
    }
    // Vorschaubilder der Folgen: <datei>-thumb.jpg oder <datei>.jpg
    foreach ($zeilen as $z) {
        $b = pathinfo($z['pfad'], PATHINFO_FILENAME);
        if (($p = lb_finden(dirname($z['pfad']), [$b . '-thumb', $b])) && ($rel = lb_uebernehmen($p, 640))) {
            db_tun('UPDATE folgen SET standbild = :b WHERE id = :id', ['b' => $rel, 'id' => $z['folge_id']]);
            $n++;
        }
    }
    return $n;
}

/** Alle Filme und Serien (nach Scan und Metadaten) */
function lokale_bilder_alle(?callable $stand = null): array
{
    if (!lb_aktiv()) {
        return ['aus' => true];
    }
    $filme = array_map('intval', array_column(db_alle('SELECT id FROM filme'), 'id'));
    $serien = array_map('intval', array_column(db_alle('SELECT id FROM serien'), 'id'));
    $gesamt = count($filme) + count($serien);
    $i = 0;
    $bilder = 0;
    foreach ($filme as $id) {
        $bilder += lokale_bilder_film($id);
        if ($stand && ++$i % 50 === 0) {
            $stand('Lokale Bilder', $i, $gesamt);
        }
    }
    foreach ($serien as $id) {
        $bilder += lokale_bilder_serie($id);
        if ($stand && ++$i % 20 === 0) {
            $stand('Lokale Bilder', $i, $gesamt);
        }
    }
    return ['bilder' => $bilder];
}
