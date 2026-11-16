<?php
// Aufräumen per Knopf: Dateien nach Schema umbenennen/verschieben – immer erst Vorschau, dann Freigabe.
// Externe Untertitel wandern mit. Nur möglich, wenn der Ordner beschreibbar eingebunden ist (MEDIEN_MOUNT_MODUS=rw).
declare(strict_types=1);
require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/scanner.php';

function name_sauber(string $s): string
{
    $s = str_replace([':', '/', '\\'], [' -', '-', '-'], $s);
    $s = (string) preg_replace('/[<>"|?*\x00-\x1F]/u', '', $s);
    $s = (string) preg_replace('/\s{2,}/', ' ', $s);
    return rtrim(trim($s), '. ');
}

/** Schema füllen: {feld} ersetzen, „{ - feld}“ nur wenn das Feld einen Wert hat */
function schema_fuellen(string $schema, array $werte): string
{
    $aus = (string) preg_replace_callback('/\{([^{}a-z]*)([a-z]+)([^{}a-z]*)\}/', static function ($m) use ($werte) {
        $w = (string) ($werte[$m[2]] ?? '');
        return $w === '' ? '' : $m[1] . $w . $m[3];
    }, $schema);
    return implode('/', array_map('name_sauber', array_filter(explode('/', $aus), 'strlen')));
}

/** Vorschau: [[datei_id, alt, neu], …] für alle zugeordneten Dateien, deren Pfad nicht zum Schema passt */
function aufraeumen_vorschau(int $max = 500): array
{
    $e = server_einstellungen();
    $k = konfig()['pfade'];
    $aus = [];
    foreach (db_alle("SELECT d.id, d.pfad, f.titel, f.jahr, fa.art, fa.name AS fassung FROM dateien d JOIN fassungen fa ON fa.id = d.fassung_id
        JOIN filme f ON f.id = fa.film_id WHERE d.fehlt_seit IS NULL AND f.metadaten_status IN ('gefunden','manuell')") as $d) {
        $mehrereQualitaeten = (int) db_wert('SELECT COUNT(*) FROM dateien WHERE fassung_id = (SELECT fassung_id FROM dateien WHERE id = :id) AND fehlt_seit IS NULL', ['id' => $d['id']]) > 1;
        $rel = schema_fuellen($e['aufraeumen_film'], ['titel' => $d['titel'], 'jahr' => $d['jahr'], 'fassung' => $d['art'] === 'kino' ? '' : $d['fassung']]);
        if ($mehrereQualitaeten) {
            $h = (int) db_wert('SELECT hoehe FROM dateien WHERE id = :id', ['id' => $d['id']]);
            $rel .= ' - ' . (qualitaet_text_kurz($h));
        }
        $neu = $k['filme'] . '/' . $rel . '.' . strtolower(pathinfo((string) $d['pfad'], PATHINFO_EXTENSION));
        if ($neu !== $d['pfad']) {
            $aus[] = ['datei_id' => (int) $d['id'], 'alt' => substr((string) $d['pfad'], strlen($k['filme']) + 1), 'neu' => substr($neu, strlen($k['filme']) + 1), 'art' => 'film'];
        }
        if (count($aus) >= $max) {
            return $aus;
        }
    }
    foreach (db_alle("SELECT d.id, d.pfad, s.titel AS serie, s.jahr_von, fo.staffel_nr, fo.folge_nr, fo.titel FROM dateien d JOIN folgen fo ON fo.id = d.folge_id
        JOIN serien s ON s.id = fo.serie_id WHERE d.fehlt_seit IS NULL AND s.metadaten_status IN ('gefunden','manuell') AND fo.titel IS NOT NULL") as $d) {
        $rel = schema_fuellen($e['aufraeumen_serie'], ['serie' => $d['serie'], 'jahr' => $d['jahr_von'], 'staffel' => sprintf('%02d', $d['staffel_nr']),
            'folge' => sprintf('%02d', $d['folge_nr']), 'titel' => $d['titel']]);
        $neu = $k['serien'] . '/' . $rel . '.' . strtolower(pathinfo((string) $d['pfad'], PATHINFO_EXTENSION));
        if ($neu !== $d['pfad']) {
            $aus[] = ['datei_id' => (int) $d['id'], 'alt' => substr((string) $d['pfad'], strlen($k['serien']) + 1), 'neu' => substr($neu, strlen($k['serien']) + 1), 'art' => 'serie'];
        }
        if (count($aus) >= $max) {
            break;
        }
    }
    return $aus;
}

function qualitaet_text_kurz(int $h): string
{
    return $h >= 1700 ? '2160p' : ($h >= 1000 ? '1080p' : ($h >= 700 ? '720p' : 'SD'));
}

function aufraeumen_moeglich(): array
{
    $k = konfig()['pfade'];
    return ['filme' => is_writable($k['filme']), 'serien' => is_writable($k['serien'])];
}

/** Freigegebene Einträge ausführen (Vorschau wird neu berechnet – nur was dort steht, wird bewegt) */
function aufraeumen_ausfuehren(array $dateiIds): array
{
    $k = konfig()['pfade'];
    $moeglich = aufraeumen_moeglich();
    $wunsch = array_flip(array_map('intval', $dateiIds));
    $stat = ['verschoben' => 0, 'fehler' => []];
    foreach (aufraeumen_vorschau(100000) as $v) {
        if (!isset($wunsch[$v['datei_id']])) {
            continue;
        }
        $wurzel = $v['art'] === 'film' ? $k['filme'] : $k['serien'];
        if (!$moeglich[$v['art'] === 'film' ? 'filme' : 'serien']) {
            $stat['fehler'][] = 'Ordner ist nur lesend eingebunden: ' . $wurzel;
            break;
        }
        $alt = $wurzel . '/' . $v['alt'];
        $neu = $wurzel . '/' . $v['neu'];
        if (file_exists($neu)) {
            $stat['fehler'][] = 'Ziel existiert schon: ' . $v['neu'];
            continue;
        }
        if (!is_dir(dirname($neu)) && !@mkdir(dirname($neu), 0777, true)) {
            $stat['fehler'][] = 'Ordner nicht anlegbar: ' . dirname($v['neu']);
            continue;
        }
        if (!@rename($alt, $neu)) {
            $stat['fehler'][] = 'Verschieben fehlgeschlagen: ' . $v['alt'];
            continue;
        }
        db_tun('UPDATE dateien SET pfad = :p, pfad_hash = :h WHERE id = :id', ['p' => $neu, 'h' => sha1($neu, true), 'id' => $v['datei_id']]);
        // externe Untertitel mitnehmen (gleicher Namensanfang)
        $altBasis = pathinfo($alt, PATHINFO_FILENAME);
        $neuBasis = pathinfo($neu, PATHINFO_FILENAME);
        foreach (externe_untertitel($alt) as $u) {
            $ziel = dirname($neu) . '/' . $neuBasis . substr(basename($u['pfad']), strlen($altBasis));
            if (!file_exists($ziel) && @rename($u['pfad'], $ziel)) {
                db_tun("UPDATE untertitel SET pfad = :n WHERE datei_id = :d AND pfad = :a", ['n' => $ziel, 'd' => $v['datei_id'], 'a' => $u['pfad']]);
            }
        }
        // leeren alten Ordner entfernen (nie die Wurzel)
        $ordner = dirname($alt);
        while ($ordner !== $wurzel && strlen($ordner) > strlen($wurzel) && count(array_diff(@scandir($ordner) ?: ['x'], ['.', '..'])) === 0) {
            @rmdir($ordner);
            $ordner = dirname($ordner);
        }
        $stat['verschoben']++;
    }
    return $stat;
}
