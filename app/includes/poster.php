<?php
// Eigene Poster per Link (z. B. von ThePosterDB): Bild laden, prüfen, in den Medienordner legen – mit den Namen,
// die Kodi, Plex und Jellyfin lesen – und in Bluewave fest setzen (überlebt TMDB-Abgleich und Scans).
//   Film:    <Name der Videodatei>-poster.jpg   neben dem Film
//   Serie:   poster.jpg                          im Serienordner
//   Staffel: season01-poster.jpg / season-specials-poster.jpg im Serienordner
// Ist der Ordner nur lesend eingebunden, bleibt das Poster im Cache und gilt trotzdem.
declare(strict_types=1);
require_once __DIR__ . '/lokale_bilder.php';
require_once __DIR__ . '/bibliothek.php';

const POSTER_MAX_BYTES = 25 * 1024 * 1024;

/** Seiten-Links von ThePosterDB auf den Bild-Link umbiegen */
function poster_url_normalisieren(string $url): string
{
    $url = trim($url);
    if (preg_match('#^https?://(www\.)?theposterdb\.com/(?:poster|api/assets)/(\d+)#i', $url, $m)) {
        return 'https://theposterdb.com/api/assets/' . $m[2];
    }
    return $url;
}

/** Nur öffentliche Adressen (kein Heimnetz, kein localhost) – der Server holt das Bild */
function poster_host_erlaubt(string $host): bool
{
    if (getenv('BILD_URL_PRIVAT_ERLAUBT') === '1') {
        return true; // nur für die Tests
    }
    $ips = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : array_merge(gethostbynamel($host) ?: [], array_column(@dns_get_record($host, DNS_AAAA) ?: [], 'ipv6'));
    if (!$ips) {
        return false;
    }
    foreach ($ips as $ip) {
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
            return false;
        }
    }
    return true;
}

/** Bild herunterladen (Weiterleitungen einzeln geprüft), gibt die Bytes zurück */
function poster_laden(string $url): string
{
    for ($sprung = 0; $sprung < 5; $sprung++) {
        $teile = parse_url($url);
        if (!$teile || !in_array(strtolower($teile['scheme'] ?? ''), ['http', 'https'], true) || empty($teile['host'])) {
            throw new RuntimeException('Bitte einen http(s)-Link angeben.');
        }
        if (!poster_host_erlaubt($teile['host'])) {
            throw new RuntimeException('Diese Adresse ist nicht erlaubt.');
        }
        $daten = '';
        $c = curl_init($url);
        curl_setopt_array($c, [
            CURLOPT_FOLLOWLOCATION => false, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 60, CURLOPT_HEADER => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_USERAGENT => 'Bluewave/' . konfig()['version'] . ' (selbst gehostet)',
            CURLOPT_HTTPHEADER => ['Accept: image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8'],
            CURLOPT_WRITEFUNCTION => static function ($c, $stueck) use (&$daten) {
                $daten .= $stueck;
                return strlen($daten) > POSTER_MAX_BYTES ? 0 : strlen($stueck);
            },
        ]);
        $ok = curl_exec($c);
        $code = (int) curl_getinfo($c, CURLINFO_RESPONSE_CODE);
        $weiter = (string) curl_getinfo($c, CURLINFO_REDIRECT_URL);
        $fehler = curl_error($c);
        curl_close($c);
        if ($code >= 300 && $code < 400 && $weiter !== '') {
            $url = $weiter;
            continue;
        }
        if (strlen($daten) > POSTER_MAX_BYTES) {
            throw new RuntimeException('Das Bild ist größer als 25 MB.');
        }
        if ($ok === false || $code !== 200) {
            throw new RuntimeException($code === 404 ? 'Unter dem Link gibt es kein Bild.' : ($code === 403 || $code === 401
                ? 'Die Seite gibt das Bild nicht heraus (HTTP ' . $code . ') – bei ThePosterDB den Link über „Download“ kopieren.'
                : 'Laden fehlgeschlagen' . ($code ? ' (HTTP ' . $code . ')' : ': ' . $fehler) . '.'));
        }
        return $daten;
    }
    throw new RuntimeException('Zu viele Weiterleitungen.');
}

const BILD_TYPEN = ['poster', 'hintergrund', 'logo'];

/** Ziel im Medienordner für Film / Serie / Staffel; $typ poster | hintergrund (fanart) | logo (clearlogo) */
function poster_ziel(string $art, int $id, int $staffel, string $typ = 'poster'): array
{
    $endung = ['poster' => 'poster', 'hintergrund' => 'fanart', 'logo' => 'clearlogo'][$typ];
    if ($art === 'film') {
        $pfad = db_wert('SELECT d.pfad FROM dateien d JOIN fassungen fa ON fa.id = d.fassung_id WHERE fa.film_id = :f AND d.fehlt_seit IS NULL
            ORDER BY fa.standard DESC, d.hoehe DESC LIMIT 1', ['f' => $id]);
        if (!$pfad) {
            throw new RuntimeException('Zu diesem Film gibt es keine Datei.');
        }
        return ['ordner' => dirname((string) $pfad), 'name' => pathinfo((string) $pfad, PATHINFO_FILENAME) . '-' . $endung];
    }
    $pfade = array_column(db_alle('SELECT d.pfad FROM dateien d JOIN folgen fo ON fo.id = d.folge_id WHERE fo.serie_id = :s AND d.fehlt_seit IS NULL', ['s' => $id]), 'pfad');
    $wurzel = $pfade ? lb_serien_ordner($pfade) : null;
    if (!$wurzel) {
        throw new RuntimeException('Der Ordner der Serie lässt sich nicht bestimmen (Folgen liegen nicht in einem eigenen Serienordner).');
    }
    if ($art === 'serie') {
        return ['ordner' => $wurzel, 'name' => $endung];
    }
    return ['ordner' => $wurzel, 'name' => $staffel === 0 ? 'season-specials-poster' : sprintf('season%02d-poster', $staffel)];
}

/**
 * Poster setzen. Gibt ['poster' => URL, 'datei' => Pfad|null, 'hinweis' => string|null] zurück.
 * Ein vorhandenes Bild gleichen Namens wird nicht gelöscht, sondern in die Sicherungen verschoben.
 */
function poster_setzen(string $art, int $id, int $staffel, string $url, string $typ = 'poster'): array
{
    if (!in_array($art, ['film', 'serie', 'staffel', 'reihe', 'universum'], true) || !in_array($typ, BILD_TYPEN, true)
        || ($art === 'staffel' && $typ !== 'poster') || (in_array($art, ['reihe', 'universum'], true) && $typ === 'logo')) {
        throw new RuntimeException('Unbekannte Art.');
    }
    // Reihen und Universen haben keinen eigenen Ordner – ihr Bild liegt nur in Bluewave
    $ohneOrdner = in_array($art, ['reihe', 'universum'], true);
    $roh = poster_laden(poster_url_normalisieren($url));
    $info = @getimagesizefromstring($roh);
    if (!$info || !in_array($info[2], [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP], true)) {
        throw new RuntimeException('Unter dem Link liegt kein Bild (JPEG, PNG oder WebP).');
    }
    $mindest = ['poster' => [150, 200], 'hintergrund' => [640, 300], 'logo' => [100, 30]][$typ];
    if ($info[0] < $mindest[0] || $info[1] < $mindest[1]) {
        throw new RuntimeException('Das Bild ist zu klein (' . $info[0] . '×' . $info[1] . ').');
    }
    $ziel = $ohneOrdner ? null : poster_ziel($art, $id, $staffel, $typ);
    $endung = [IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_WEBP => 'webp'][$info[2]];
    $datei = $ziel ? $ziel['ordner'] . '/' . $ziel['name'] . '.' . $endung : '';
    $hinweis = null;
    $geschrieben = null;

    if ($ohneOrdner) {
        // kein Hinweis nötig
    } elseif (is_writable($ziel['ordner'])) {
        // gleichnamige Poster (auch andere Endung) sichern, damit nur eins gilt
        foreach (LB_ENDUNGEN as $e) {
            $alt = $ziel['ordner'] . '/' . $ziel['name'] . '.' . $e;
            if (is_file($alt)) {
                $sich = konfig()['pfade']['backups'] . '/poster/' . date('Y-m-d_His') . '/' . ltrim(str_replace('/', '_', $alt), '_');
                @mkdir(dirname($sich), 0775, true);
                if (!@rename($alt, $sich) && !(@copy($alt, $sich) && @unlink($alt))) {
                    throw new RuntimeException('Das vorhandene Poster ' . basename($alt) . ' lässt sich nicht ersetzen.');
                }
            }
        }
        $tmp = $datei . '.bluewave-tmp';
        if (@file_put_contents($tmp, $roh) === strlen($roh) && @rename($tmp, $datei)) {
            $geschrieben = $datei;
        } else {
            @unlink($tmp);
            $hinweis = 'Konnte nicht in den Ordner schreiben – das Poster gilt nur in Bluewave.';
        }
    } else {
        $hinweis = 'Der Medienordner ist nur lesend eingebunden (MEDIEN_MOUNT_MODUS=ro) – das Poster gilt nur in Bluewave.';
    }

    // in den Cache übernehmen (aus der Datei im Ordner oder direkt aus den geladenen Bytes)
    if ($geschrieben) {
        $rel = lb_uebernehmen($geschrieben, $typ === 'hintergrund' ? 1920 : ($typ === 'logo' ? 800 : ($art === 'staffel' ? 500 : 780)));
    } else {
        $quelle = konfig()['pfade']['cache'] . '/bilder/eigen/' . sha1($roh) . '.' . $endung;
        @mkdir(dirname($quelle), 0775, true);
        file_put_contents($quelle, $roh);
        $rel = lb_uebernehmen($quelle, $typ === 'hintergrund' ? 1920 : ($typ === 'logo' ? 800 : ($art === 'staffel' ? 500 : 780)));
    }
    if (!$rel) {
        throw new RuntimeException('Das Bild ließ sich nicht verarbeiten.');
    }
    db_tun('INSERT INTO eigene_poster (art, ziel_id, staffel, typ, bild, datei, quelle, gesetzt_am) VALUES (:a, :z, :s, :t, :b, :d, :q, NOW())
        ON DUPLICATE KEY UPDATE bild = VALUES(bild), datei = VALUES(datei), quelle = VALUES(quelle), gesetzt_am = NOW()',
        ['a' => $art, 'z' => $id, 's' => $art === 'staffel' ? $staffel : 0, 't' => $typ, 'b' => $rel, 'd' => $geschrieben, 'q' => mb_substr($url, 0, 500)]);
    eigene_poster_anwenden($art, $id);
    return ['poster' => bild_url($rel), 'datei' => $geschrieben, 'hinweis' => $hinweis];
}

/** Eigene Poster haben Vorrang vor TMDB und Ordnerbildern – nach jedem Abgleich erneut anwenden */
function eigene_poster_anwenden(?string $art = null, ?int $id = null): int
{
    $wo = $art ? ' WHERE ' . ($art === 'serie' ? "art IN ('serie', 'staffel')" : 'art = ' . db()->quote($art)) . ' AND ziel_id = :z' : '';
    $n = 0;
    foreach (db_alle('SELECT art, ziel_id, staffel, typ, bild FROM eigene_poster' . $wo, $art ? ['z' => $id] : []) as $p) {
        $spalte = in_array($p['typ'], BILD_TYPEN, true) ? $p['typ'] : 'poster';
        if ($p['art'] === 'film') {
            $n += db_tun("UPDATE filme SET $spalte = :b WHERE id = :i", ['b' => $p['bild'], 'i' => $p['ziel_id']]);
        } elseif ($p['art'] === 'serie') {
            $n += db_tun("UPDATE serien SET $spalte = :b WHERE id = :i", ['b' => $p['bild'], 'i' => $p['ziel_id']]);
        } elseif ($p['art'] === 'reihe') {
            $n += db_tun("UPDATE reihen SET $spalte = :b WHERE id = :i", ['b' => $p['bild'], 'i' => $p['ziel_id']]);
        } elseif ($p['art'] === 'universum') {
            $sp = $spalte === 'poster' ? 'bild' : 'hintergrund';
            $n += db_tun("UPDATE universen SET $sp = :b WHERE id = :i", ['b' => $p['bild'], 'i' => $p['ziel_id']]);
        } else {
            $n += db_tun('INSERT INTO serien_staffeln (serie_id, nummer, poster) VALUES (:s, :n, :b) ON DUPLICATE KEY UPDATE poster = VALUES(poster)',
                ['s' => $p['ziel_id'], 'n' => $p['staffel'], 'b' => $p['bild']]);
        }
    }
    return $n;
}

/** Eigenes Bild entfernen (Datei im Ordner wandert in die Sicherungen), danach gilt wieder TMDB bzw. das Ordnerbild */
function eigenes_bild_entfernen(string $art, int $id, int $staffel, string $typ): void
{
    $z = db_zeile('SELECT id, datei FROM eigene_poster WHERE art = :a AND ziel_id = :z AND staffel = :s AND typ = :t',
        ['a' => $art, 'z' => $id, 's' => $art === 'staffel' ? $staffel : 0, 't' => $typ]);
    if (!$z) {
        return;
    }
    if ($z['datei'] && is_file($z['datei']) && is_writable(dirname($z['datei']))) {
        $sich = konfig()['pfade']['backups'] . '/poster/' . date('Y-m-d_His') . '/' . ltrim(str_replace('/', '_', $z['datei']), '_');
        @mkdir(dirname($sich), 0775, true);
        @rename($z['datei'], $sich) || (@copy($z['datei'], $sich) && @unlink($z['datei']));
    }
    db_tun('DELETE FROM eigene_poster WHERE id = :i', ['i' => $z['id']]);
}
