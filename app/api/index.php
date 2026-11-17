<?php
// JSON-API v1 für Web-App, Android-App und Fernseher.
// Anmeldung per Cookie (Browser) oder „Authorization: Bearer <token>“ (Geräte). Schreibende Aufrufe aus dem Browser
// brauchen die Kopfzeile X-Bluewave: 1 (Schutz gegen Cross-Site-Anfragen); Geräte mit Bearer-Token sind davon ausgenommen.
declare(strict_types=1);
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/einstellungen.php';

$pfad = trim((string) ($_GET['pfad'] ?? ''), '/');
$teile = $pfad === '' ? [] : explode('/', $pfad);
$methode = $_SERVER['REQUEST_METHOD'] ?? 'GET';

/** Abspielquelle aus dem Pfad: Datei-ID oder optimierte Fassung („o12“) → [pfad, container, video_codec] oder null */
function abspielquelle(string $t): ?array
{
    if (preg_match('/^o(\d+)$/', $t, $m)) {
        $o = db_zeile("SELECT pfad FROM optimiert WHERE id = :id AND status = 'fertig'", ['id' => (int) $m[1]]);
        return $o && $o['pfad'] && is_file((string) $o['pfad']) ? ['pfad' => (string) $o['pfad'], 'container' => 'mp4', 'video_codec' => 'h264'] : null;
    }
    if (!ctype_digit($t)) {
        return null;
    }
    $d = db_zeile('SELECT pfad, container, video_codec FROM dateien WHERE id = :id AND fehlt_seit IS NULL', ['id' => (int) $t]);
    return $d && is_file((string) $d['pfad']) ? $d : null;
}

function eingabe(): array
{
    static $e = null;
    if ($e === null) {
        $e = json_decode((string) file_get_contents('php://input'), true);
        $e = is_array($e) ? $e : $_POST;
    }
    return $e;
}

function fehler(string $text, int $status = 400): never
{
    bw_json(['fehler' => $text], $status);
}

function admin_noetig(): void
{
    if (!ist_admin()) {
        fehler('Nur für Admins.', 403);
    }
}

function zahl(string $s): int
{
    return ctype_digit($s) ? (int) $s : 0;
}

try {
    // ---------- ohne Anmeldung ----------
    if ($pfad === 'ping') {
        bw_json(['app' => 'bluewave', 'version' => konfig()['version']]);
    }
    $bearer = str_starts_with((string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? ''), 'Bearer ');
    if ($methode !== 'GET' && $methode !== 'HEAD' && !$bearer && ($_SERVER['HTTP_X_BLUEWAVE'] ?? '') !== '1') {
        fehler('Ungültige Anfrage.');
    }
    if ($pfad === 'einrichtung' && $methode === 'GET') {
        bw_json(['noetig' => anzahl_konten() === 0, 'heimnetz' => bw_ist_heimnetz()]);
    }
    if ($pfad === 'einrichtung' && $methode === 'POST') {
        if (anzahl_konten() !== 0) {
            fehler('Bluewave ist schon eingerichtet.', 409);
        }
        if (!bw_ist_heimnetz()) {
            fehler('Die Einrichtung geht nur direkt im Heimnetz.', 403);
        }
        $e = eingabe();
        $id = konto_anlegen((string) ($e['benutzername'] ?? ''), (string) ($e['anzeigename'] ?? ''), (string) ($e['passwort'] ?? ''), 'admin');
        $token = sitzung_anlegen($id, 'browser', null, true);
        sitzung_cookie_setzen($token, true);
        bw_json(['ok' => true]);
    }
    if ($pfad === 'auth/login' && $methode === 'POST') {
        $e = eingabe();
        $geraet = trim((string) ($e['geraet'] ?? ''));
        [$k, $token] = anmelden((string) ($e['benutzername'] ?? ''), (string) ($e['passwort'] ?? ''), !empty($e['merken']), $geraet !== '' ? 'geraet' : 'browser', $geraet ?: null);
        if ($geraet === '' || !empty($e['cookie'])) {
            sitzung_cookie_setzen($token, !empty($e['merken']) || $geraet !== '');
        }
        bw_json(['ok' => true, 'token' => $geraet !== '' ? $token : null, 'konto' => ['id' => (int) $k['id'], 'anzeigename' => $k['anzeigename'], 'rolle' => $k['rolle']]]);
    }
    if ($pfad === 'auth/logout' && $methode === 'POST') {
        abmelden();
        bw_json(['ok' => true]);
    }
    // Fernseher koppeln: TV fragt Code an und wartet, Nutzer bestätigt ihn am Handy
    if ($pfad === 'kopplung/start' && $methode === 'POST') {
        $geheimnis = bin2hex(random_bytes(16));
        $code = '';
        for ($i = 0; $i < 10; $i++) {
            $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
            if (!db_wert('SELECT code FROM kopplungen WHERE code = :c', ['c' => $code])) {
                break;
            }
        }
        db_tun('INSERT INTO kopplungen (code, geheimnis_hash, geraetename) VALUES (:c, :g, :n)',
            ['c' => $code, 'g' => hash('sha256', $geheimnis, true), 'n' => mb_substr(trim((string) (eingabe()['geraetename'] ?? 'Fernseher')) ?: 'Fernseher', 0, 100)]);
        bw_json(['code' => $code, 'geheimnis' => $geheimnis, 'gueltig_s' => 600]);
    }
    if ($pfad === 'kopplung/status' && $methode === 'POST') {
        $e = eingabe();
        $z = db_zeile('SELECT * FROM kopplungen WHERE code = :c AND erstellt_am > NOW() - INTERVAL 10 MINUTE', ['c' => (string) ($e['code'] ?? '')]);
        if (!$z || !hash_equals($z['geheimnis_hash'], hash('sha256', (string) ($e['geheimnis'] ?? ''), true))) {
            fehler('Code abgelaufen.', 404);
        }
        if ($z['token']) {
            db_tun('DELETE FROM kopplungen WHERE code = :c', ['c' => $z['code']]);
            bw_json(['bestaetigt' => true, 'token' => $z['token']]);
        }
        bw_json(['bestaetigt' => false]);
    }

    // ---------- ab hier angemeldet ----------
    $k = konto();
    if (!$k) {
        bw_json(['fehler' => 'Bitte anmelden.', 'anmelden' => true, 'einrichtung' => anzahl_konten() === 0], 401);
    }
    $kid = (int) $k['id'];
    $t0 = $teile[0] ?? '';
    $t1 = $teile[1] ?? '';
    $t2 = $teile[2] ?? '';

    switch ($t0) {
        case 'bild':
            $rel = implode('/', array_slice($teile, 1));
            if (!preg_match('#^[a-z]+/(w\d+|original)/[A-Za-z0-9_.-]+$#', $rel)) {
                fehler('Unbekannt.', 404);
            }
            $datei = konfig()['pfade']['cache'] . '/bilder/' . $rel;
            if (!is_file($datei)) {
                // noch nicht (oder beim Abgleich nicht) geladen → jetzt von TMDB holen
                db_schliessen();
                require_once __DIR__ . '/../includes/tmdb.php';
                if (!tmdb_bild_holen($rel)) {
                    header('Cache-Control: no-store');
                    fehler('Bild nicht verfügbar.', 404);
                }
            }
            header('Content-Type: ' . (str_ends_with($rel, '.png') ? 'image/png' : (str_ends_with($rel, '.svg') ? 'image/svg+xml' : 'image/jpeg')));
            header('Cache-Control: private, max-age=31536000, immutable');
            header('Content-Length: ' . filesize($datei));
            readfile($datei);
            exit;

        case 'ich':
            if ($t1 === '' && $methode === 'GET') {
                bw_json(['id' => $kid, 'benutzername' => $k['benutzername'], 'anzeigename' => $k['anzeigename'], 'rolle' => $k['rolle'],
                    'einstellungen' => $k['einstellungen'], 'heimnetz' => bw_ist_heimnetz(), 'version' => konfig()['version'], 'art' => $k['art']]);
            }
            if ($t1 === 'einstellungen' && $methode === 'PUT') {
                $neu = nutzer_einstellungen_normal(array_replace($k['einstellungen'], eingabe()));
                db_tun('UPDATE konten SET einstellungen = :e WHERE id = :id', ['e' => json_encode($neu), 'id' => $kid]);
                bw_json(['einstellungen' => $neu]);
            }
            if ($t1 === 'profil' && $methode === 'PUT') {
                $a = mb_substr(trim((string) (eingabe()['anzeigename'] ?? '')), 0, 100);
                if ($a !== '') {
                    db_tun('UPDATE konten SET anzeigename = :a WHERE id = :id', ['a' => $a, 'id' => $kid]);
                }
                bw_json(['ok' => true]);
            }
            if ($t1 === 'passwort' && $methode === 'POST') {
                $e = eingabe();
                $hash = (string) db_wert('SELECT passwort_hash FROM konten WHERE id = :id', ['id' => $kid]);
                if (!password_verify((string) ($e['alt'] ?? ''), $hash)) {
                    fehler('Das bisherige Passwort stimmt nicht.');
                }
                if (($f = passwort_pruefen((string) ($e['neu'] ?? ''))) !== null) {
                    fehler($f);
                }
                db_tun('UPDATE konten SET passwort_hash = :h WHERE id = :id', ['h' => password_hash((string) $e['neu'], PASSWORD_ARGON2ID), 'id' => $kid]);
                // andere Browser-Sitzungen abmelden, Geräte bleiben gekoppelt
                db_tun("DELETE FROM sitzungen WHERE konto_id = :k AND art = 'browser' AND id <> :s", ['k' => $kid, 's' => $k['sitzung_id']]);
                bw_json(['ok' => true]);
            }
            if ($t1 === 'geraete' && $methode === 'GET') {
                bw_json(['geraete' => db_alle('SELECT id, art, geraetename, ip, erstellt_am, zuletzt_am, id = :s AS dieses FROM sitzungen WHERE konto_id = :k ORDER BY zuletzt_am DESC',
                    ['k' => $kid, 's' => $k['sitzung_id']])]);
            }
            if ($t1 === 'geraete' && $methode === 'DELETE' && zahl($t2)) {
                db_tun('DELETE FROM sitzungen WHERE id = :id AND konto_id = :k', ['id' => zahl($t2), 'k' => $kid]);
                bw_json(['ok' => true]);
            }
            break;

        case 'kopplung':
            if ($t1 === 'bestaetigen' && $methode === 'POST') {
                $z = db_zeile('SELECT * FROM kopplungen WHERE code = :c AND erstellt_am > NOW() - INTERVAL 10 MINUTE AND token IS NULL',
                    ['c' => preg_replace('/\D/', '', (string) (eingabe()['code'] ?? ''))]);
                if (!$z) {
                    fehler('Diesen Code gibt es nicht (mehr). Am Fernseher einen neuen anzeigen lassen.', 404);
                }
                $token = sitzung_anlegen($kid, 'geraet', $z['geraetename']);
                db_tun('UPDATE kopplungen SET konto_id = :k, token = :t WHERE code = :c', ['k' => $kid, 't' => $token, 'c' => $z['code']]);
                bw_json(['ok' => true, 'geraet' => $z['geraetename']]);
            }
            break;

        // ---------- Bibliothek lesen ----------
        case 'start':
            require_once __DIR__ . '/../includes/bibliothek.php';
            bw_json(startseite($kid));
            // no break
        case 'filme':
            require_once __DIR__ . '/../includes/bibliothek.php';
            $alle = filme_liste($kid);
            $filterArt = (string) ($_GET['filter'] ?? '');
            bw_json(['filme' => $filterArt === 'reihen'
                    ? reihen_liste($kid, (string) ($_GET['sort'] ?? 'titel'), isset($_GET['genre']) ? (int) $_GET['genre'] : null)
                    : filme_liste($kid, (string) ($_GET['sort'] ?? 'titel'), isset($_GET['genre']) ? (int) $_GET['genre'] : null, (string) ($_GET['suche'] ?? ''), $filterArt),
                'genres' => db_alle('SELECT g.id, g.name, COUNT(*) AS anzahl FROM genres g JOIN film_genres fg ON fg.genre_id = g.id GROUP BY g.id ORDER BY anzahl DESC, g.name'),
                'zahlen' => ['gesamt' => count($alle), 'uhd' => count(array_filter($alle, static fn($f) => $f['qualitaet'] === '4K')),
                    'reihen' => (int) db_wert('SELECT COUNT(DISTINCT reihe_id) FROM filme WHERE reihe_id IS NOT NULL')],
                'highlights' => array_map(static function ($z) use ($kid) {
                    $f = film_detail((int) $z['id'], $kid);
                    return ['id' => $f['id'], 'titel' => $f['titel'], 'jahr' => $f['jahr'], 'poster' => $f['poster'], 'hintergrund' => $f['hintergrund'],
                        'zusatz' => implode(' · ', array_filter([$f['jahr'], implode(', ', array_slice(array_column($f['genres'], 'name'), 0, 2))])), 'technik' => $f['technik']];
                }, db_alle(FILM_KACHEL_SQL . ' WHERE f.hintergrund IS NOT NULL GROUP BY f.id ORDER BY MAX(d.hinzugefuegt_am) DESC LIMIT 2'))]);
            // no break
        case 'film':
            require_once __DIR__ . '/../includes/bibliothek.php';
            if (zahl($t1) && in_array($t2, ['bearbeiten', 'bilder'], true)) {
                require_once __DIR__ . '/../includes/bearbeiten.php';
                bearbeiten_api('film', zahl($t1), $t2, $methode);
            }
            if (zahl($t1) && $t2 === '' && $methode === 'GET') {
                $f = film_detail(zahl($t1), $kid) ?? fehler('Film nicht gefunden.', 404);
                bw_json($f);
            }
            if (zahl($t1) && $t2 === 'zuordnen' && $methode === 'POST') {
                admin_noetig();
                require_once __DIR__ . '/../includes/tmdb.php';
                $neu = tmdb_film_uebernehmen(zahl($t1), (int) (eingabe()['tmdb_id'] ?? 0), true);
                require_once __DIR__ . '/../includes/lokale_bilder.php';
                if (lb_aktiv()) {
                    lokale_bilder_film($neu ?: zahl($t1));
                }
                require_once __DIR__ . '/../includes/poster.php';
                eigene_poster_anwenden('film', $neu ?: zahl($t1));
                bw_json(['ok' => true, 'id' => $neu]);
            }
            if (zahl($t1) && $t2 === 'universen' && $methode === 'PUT') {
                admin_noetig();
                require_once __DIR__ . '/../includes/universen.php';
                titel_universen_setzen('film', zahl($t1), (array) (eingabe()['ids'] ?? []));
                bw_json(['ok' => true]);
            }
            if (zahl($t1) && $t2 === 'fassung' && $methode === 'PUT') {
                // Fassung einer Datei von Hand korrigieren: {datei_id, art, name}
                admin_noetig();
                require_once __DIR__ . '/../includes/scanner.php';
                $e = eingabe();
                $art = in_array($e['art'] ?? '', array_keys(FASSUNG_NAMEN), true) ? $e['art'] : 'sonstige';
                $name = trim((string) ($e['name'] ?? '')) ?: FASSUNG_NAMEN[$art];
                $faId = fassung_finden_oder_anlegen(zahl($t1), [$art, $name]);
                db_tun('UPDATE dateien d JOIN fassungen fa ON fa.id = d.fassung_id SET d.fassung_id = :neu WHERE d.id = :d AND fa.film_id = :f',
                    ['neu' => $faId, 'd' => (int) ($e['datei_id'] ?? 0), 'f' => zahl($t1)]);
                db_tun('DELETE fa FROM fassungen fa LEFT JOIN dateien d ON d.fassung_id = fa.id WHERE fa.film_id = :f AND d.id IS NULL', ['f' => zahl($t1)]);
                bw_json(['ok' => true]);
            }
            break;

        case 'serien':
            require_once __DIR__ . '/../includes/bibliothek.php';
            bw_json(['serien' => serien_liste($kid, (string) ($_GET['sort'] ?? 'titel'), isset($_GET['genre']) ? (int) $_GET['genre'] : null, (string) ($_GET['suche'] ?? '')),
                'genres' => db_alle('SELECT g.id, g.name, COUNT(*) AS anzahl FROM genres g JOIN serie_genres sg ON sg.genre_id = g.id GROUP BY g.id ORDER BY g.name')]);
            // no break
        case 'serie':
            require_once __DIR__ . '/../includes/bibliothek.php';
            if (zahl($t1) && in_array($t2, ['bearbeiten', 'bilder'], true)) {
                require_once __DIR__ . '/../includes/bearbeiten.php';
                bearbeiten_api('serie', zahl($t1), $t2, $methode);
            }
            if (zahl($t1) && $t2 === '' && $methode === 'GET') {
                $gesetzt = array_key_exists('reihenfolge', $_GET);
                $r = $gesetzt && ctype_digit((string) $_GET['reihenfolge']) ? (int) $_GET['reihenfolge'] : null;
                bw_json(serie_detail(zahl($t1), $kid, $r, $gesetzt) ?? fehler('Serie nicht gefunden.', 404));
            }
            if (zahl($t1) && $t2 === 'universen' && $methode === 'PUT') {
                admin_noetig();
                require_once __DIR__ . '/../includes/universen.php';
                titel_universen_setzen('serie', zahl($t1), (array) (eingabe()['ids'] ?? []));
                bw_json(['ok' => true]);
            }
            if (zahl($t1) && $t2 === 'reihenfolge' && $methode === 'PUT') {
                admin_noetig();
                $r = eingabe()['reihenfolge_id'] ?? null;
                $r = $r !== null && db_wert('SELECT id FROM reihenfolgen WHERE id = :r AND serie_id = :s', ['r' => (int) $r, 's' => zahl($t1)]) ? (int) $r : null;
                db_tun('UPDATE serien SET reihenfolge_id = :r WHERE id = :s', ['r' => $r, 's' => zahl($t1)]);
                bw_json(['ok' => true]);
            }
            if (zahl($t1) && $t2 === 'zuordnen' && $methode === 'POST') {
                admin_noetig();
                require_once __DIR__ . '/../includes/tmdb.php';
                @set_time_limit(300);
                $neu = tmdb_serie_uebernehmen(zahl($t1), (int) (eingabe()['tmdb_id'] ?? 0), true);
                require_once __DIR__ . '/../includes/lokale_bilder.php';
                if (lb_aktiv()) {
                    lokale_bilder_serie($neu ?: zahl($t1));
                }
                require_once __DIR__ . '/../includes/poster.php';
                eigene_poster_anwenden('serie', $neu ?: zahl($t1));
                bw_json(['ok' => true, 'id' => $neu]);
            }
            if (zahl($t1) && $t2 === 'gesehen' && $methode === 'POST') {
                // ganze Staffel/Serie als gesehen/ungesehen: {staffel?: n, gesehen: bool}
                require_once __DIR__ . '/../includes/wiedergabe.php';
                $e = eingabe();
                $sql = 'SELECT id FROM folgen WHERE serie_id = :s' . (isset($e['staffel']) ? ' AND staffel_nr = :n' : '');
                $p = ['s' => zahl($t1)] + (isset($e['staffel']) ? ['n' => (int) $e['staffel']] : []);
                foreach (db_alle($sql, $p) as $f) {
                    gesehen_setzen($kid, 'folge', (int) $f['id'], !empty($e['gesehen']));
                }
                bw_json(['ok' => true]);
            }
            break;

        case 'universen':
            require_once __DIR__ . '/../includes/universen.php';
            if ($methode === 'GET') {
                bw_json(['universen' => universen_liste($kid)]);
            }
            if ($methode === 'POST') {
                admin_noetig();
                $name = trim((string) (eingabe()['name'] ?? ''));
                if ($name === '') {
                    fehler('Name fehlt.');
                }
                bw_json(['id' => db_einfuegen('INSERT INTO universen (name, sortname, beschreibung) VALUES (:n, :s, :b)',
                    ['n' => mb_substr($name, 0, 255), 's' => sortiertitel($name), 'b' => trim((string) (eingabe()['beschreibung'] ?? '')) ?: null])]);
            }
            break;

        case 'universum':
            require_once __DIR__ . '/../includes/universen.php';
            $uid = zahl($t1);
            if (!$uid || !db_wert('SELECT id FROM universen WHERE id = :u', ['u' => $uid])) {
                fehler('Universum nicht gefunden.', 404);
            }
            if ($t2 === '' && $methode === 'GET') {
                bw_json(universum_detail($uid, $kid, (string) ($_GET['sort'] ?? 'eigen')));
            }
            admin_noetig();
            if ($t2 === '' && $methode === 'PUT') {
                $e = eingabe();
                $name = trim((string) ($e['name'] ?? ''));
                if ($name === '') {
                    fehler('Name fehlt.');
                }
                // Titelbild: nur Poster aus dem Cache (z. B. eines Titels im Universum); leer = automatisch
                $bild = (string) ($e['bild'] ?? '');
                $bild = preg_match('#^/api/v1/bild/([a-z]+/(w\d+|original)/[A-Za-z0-9_.-]+)$#', $bild, $mm) ? $mm[1] : null;
                db_tun('UPDATE universen SET name = :n, sortname = :s, beschreibung = :b, bild = :bi WHERE id = :id',
                    ['n' => mb_substr($name, 0, 255), 's' => sortiertitel($name), 'b' => trim((string) ($e['beschreibung'] ?? '')) ?: null, 'bi' => $bild, 'id' => $uid]);
                // ein anderes Titelbild gewählt → eigenes Poster (per Link) gilt nicht mehr
                db_tun("DELETE FROM eigene_poster WHERE art = 'universum' AND ziel_id = :u AND typ = 'poster' AND NOT (bild <=> :b)", ['u' => $uid, 'b' => $bild]);
                bw_json(['ok' => true]);
            }
            if ($t2 === '' && $methode === 'DELETE') {
                db_tun('DELETE FROM universen WHERE id = :id', ['id' => $uid]);
                bw_json(['ok' => true]);
            }
            if ($t2 === 'eintraege' && $methode === 'POST') {
                $e = eingabe();
                $art = (string) ($e['art'] ?? '');
                if (!in_array($art, ['film', 'serie', 'reihe'], true)) {
                    fehler('Unbekannte Art.');
                }
                $ids = isset($e['ids']) ? array_map('intval', (array) $e['ids']) : [(int) ($e['id'] ?? 0)];
                $n = 0;
                foreach ($ids as $zid) {
                    $n += universum_hinzufuegen($uid, $art, $zid, isset($e['abschnitt_id']) ? (int) $e['abschnitt_id'] : null);
                }
                bw_json(['ok' => true, 'hinzugefuegt' => $n]);
            }
            if ($t2 === 'liste' && $methode === 'POST') {
                // mehrere auf einmal (Vorschläge): {titel: [{art, id}, …]}
                $n = 0;
                $e = eingabe();
                $ab = isset($e['abschnitt_id']) && $e['abschnitt_id'] !== null ? (int) $e['abschnitt_id'] : null;
                foreach ((array) ($e['titel'] ?? []) as $x) {
                    if (in_array($x['art'] ?? '', ['film', 'serie', 'reihe'], true)) {
                        $n += universum_hinzufuegen($uid, $x['art'], (int) ($x['id'] ?? 0), $ab);
                    }
                }
                bw_json(['ok' => true, 'hinzugefuegt' => $n]);
            }
            if ($t2 === 'eintraege' && $methode === 'DELETE') {
                // mehrere auf einmal entfernen: {ids: [eintrag_id, …]}
                $n = 0;
                foreach (array_map('intval', (array) (eingabe()['ids'] ?? [])) as $eid) {
                    $n += db_tun('DELETE FROM universum_eintraege WHERE id = :e AND universum_id = :u', ['e' => $eid, 'u' => $uid]);
                }
                bw_json(['ok' => true, 'entfernt' => $n]);
            }
            if ($t2 === 'ordnung' && $methode === 'PUT') {
                universum_ordnung($uid, eingabe());
                bw_json(['ok' => true]);
            }
            if ($t2 === 'sortieren' && $methode === 'POST') {
                universum_nach_erscheinung($uid);
                bw_json(['ok' => true]);
            }
            if ($t2 === 'vorschlaege' && $methode === 'GET') {
                bw_json(['vorschlaege' => universum_vorschlaege($uid)]);
            }
            if ($t2 === 'eintrag' && zahl($teile[3] ?? '') && ($teile[4] ?? '') === 'staffeln' && $methode === 'POST') {
                // Serie in Staffeln aufteilen {teilen: true} oder zusammenführen {teilen: false}
                try {
                    bw_json(['ok' => true, 'eintraege' => universum_staffeln($uid, zahl($teile[3]), !empty(eingabe()['teilen']))]);
                } catch (RuntimeException $e) {
                    fehler($e->getMessage());
                }
            }
            if ($t2 === 'eintrag' && zahl($teile[3] ?? '') && $methode === 'DELETE') {
                db_tun('DELETE FROM universum_eintraege WHERE id = :e AND universum_id = :u', ['e' => zahl($teile[3]), 'u' => $uid]);
                bw_json(['ok' => true]);
            }
            break;

        case 'reihe':
            require_once __DIR__ . '/../includes/bibliothek.php';
            if (zahl($t1) && in_array($t2, ['bearbeiten', 'bilder'], true)) {
                require_once __DIR__ . '/../includes/bearbeiten.php';
                bearbeiten_api('reihe', zahl($t1), $t2, $methode);
            }
            if (zahl($t1) && $methode === 'GET') {
                bw_json(reihe_detail(zahl($t1), $kid) ?? fehler('Reihe nicht gefunden.', 404));
            }
            break;

        case 'suche':
            require_once __DIR__ . '/../includes/bibliothek.php';
            bw_json(suche((string) ($_GET['q'] ?? ''), $kid));
            // no break
        case 'auswahl':
            // Universums-Editor: Reihen, Filme, Serien nach Name, mit „schon drin“ für das Universum ?u=
            admin_noetig();
            require_once __DIR__ . '/../includes/bibliothek.php';
            $q = '%' . str_replace(['%', '_'], ['\%', '\_'], trim((string) ($_GET['q'] ?? ''))) . '%';
            $u = (int) ($_GET['u'] ?? 0);
            $nur = (string) ($_GET['art'] ?? '');
            $drinF = array_flip(array_map('intval', array_column(db_alle('SELECT film_id FROM universum_eintraege WHERE universum_id = :u AND film_id IS NOT NULL', ['u' => $u]), 'film_id')));
            $drinS = array_flip(array_map('intval', array_column(db_alle('SELECT serie_id FROM universum_eintraege WHERE universum_id = :u AND serie_id IS NOT NULL', ['u' => $u]), 'serie_id')));
            $aus = [];
            if ($nur === '' || $nur === 'reihe') {
                foreach (db_alle('SELECT r.id, r.name, r.poster, GROUP_CONCAT(f.id) AS filme FROM reihen r JOIN filme f ON f.reihe_id = r.id WHERE r.name LIKE :q GROUP BY r.id ORDER BY r.sortname LIMIT 15', ['q' => $q]) as $r) {
                    $ids = array_map('intval', explode(',', (string) $r['filme']));
                    $schon = count(array_filter($ids, static fn($i) => isset($drinF[$i])));
                    $aus[] = ['art' => 'reihe', 'id' => (int) $r['id'], 'titel' => $r['name'], 'poster' => bild_url($r['poster']), 'drin' => $schon === count($ids),
                        'zusatz' => 'Reihe · ' . count($ids) . ' ' . (count($ids) === 1 ? 'Film' : 'Filme') . ($schon ? ' · ' . $schon . ' schon drin' : '')];
                }
            }
            if ($nur === '' || $nur === 'film') {
                foreach (db_alle('SELECT id, titel, jahr, poster FROM filme WHERE titel LIKE :q1 OR originaltitel LIKE :q2 ORDER BY sortiertitel LIMIT 25', ['q1' => $q, 'q2' => $q]) as $r) {
                    $aus[] = ['art' => 'film', 'id' => (int) $r['id'], 'titel' => $r['titel'], 'poster' => bild_url($r['poster']), 'drin' => isset($drinF[(int) $r['id']]),
                        'zusatz' => 'Film' . ($r['jahr'] ? ' · ' . $r['jahr'] : '')];
                }
            }
            if ($nur === '' || $nur === 'serie') {
                foreach (db_alle('SELECT id, titel, jahr_von, poster FROM serien WHERE titel LIKE :q1 OR originaltitel LIKE :q2 ORDER BY sortiertitel LIMIT 15', ['q1' => $q, 'q2' => $q]) as $r) {
                    $aus[] = ['art' => 'serie', 'id' => (int) $r['id'], 'titel' => $r['titel'], 'poster' => bild_url($r['poster']), 'drin' => isset($drinS[(int) $r['id']]),
                        'zusatz' => 'Serie' . ($r['jahr_von'] ? ' · ' . $r['jahr_von'] : '')];
                }
            }
            bw_json(['treffer' => $aus]);
            // no break

        // ---------- Wiedergabe ----------
        case 'wiedergabe':
            require_once __DIR__ . '/../includes/wiedergabe.php';
            if ($t1 === 'start' && $methode === 'POST') {
                require_once __DIR__ . '/../includes/diagnose.php';
                wiedergabe_aktiv_merken();
                $t0 = microtime(true);
                try {
                    $antwort = wiedergabe_starten($k, eingabe());
                } catch (Throwable $x) {
                    diag('start_fehler', ['text' => $x->getMessage(), 'ms' => (int) round((microtime(true) - $t0) * 1000)]);
                    throw $x;
                }
                diag('start_entscheidung', ['ms' => (int) round((microtime(true) - $t0) * 1000), 'modus' => $antwort['modus'] ?? null, 'grund' => $antwort['grund'] ?? null,
                    'datei_id' => $antwort['datei_id'] ?? null, 'quelle' => $antwort['quelle'] ?? null, 'remux' => $antwort['remux'] ?? null,
                    'transkodierung' => isset($antwort['transkodierung']) ? array_intersect_key((array) $antwort['transkodierung'], array_flip(['hoehe', 'bitrate_k', 'profil', 'tonemap'])) : null]);
                bw_json($antwort);
            }
            if ($t1 === 'fortschritt' && $methode === 'POST') {
                wiedergabe_aktiv_merken();
                $e = eingabe();
                if (!empty($e['sitzung']) && preg_match('/^[a-f0-9]{24}$/', (string) $e['sitzung'])) {
                    @touch(sitzung_ordner((string) $e['sitzung']) . '/aktiv');
                }
                bw_json(fortschritt_speichern($kid, (string) ($e['art'] ?? ''), (int) ($e['id'] ?? 0), isset($e['datei_id']) ? (int) $e['datei_id'] : null,
                    (int) ($e['position_ms'] ?? 0), (int) ($e['dauer_ms'] ?? 0)));
            }
            if ($t1 === 'gesehen_mehrere' && $methode === 'POST') {
                // Mehrfachauswahl: {titel: [{art: film|serie|folge, id}], gesehen: bool}
                $e = eingabe();
                foreach ((array) ($e['titel'] ?? []) as $x) {
                    $zid = (int) ($x['id'] ?? 0);
                    if (($x['art'] ?? '') === 'serie') {
                        foreach (db_alle('SELECT id FROM folgen WHERE serie_id = :s', ['s' => $zid]) as $f) {
                            gesehen_setzen($kid, 'folge', (int) $f['id'], !empty($e['gesehen']));
                        }
                    } elseif (($x['art'] ?? '') === 'reihe') {
                        foreach (db_alle('SELECT id FROM filme WHERE reihe_id = :r', ['r' => $zid]) as $f) {
                            gesehen_setzen($kid, 'film', (int) $f['id'], !empty($e['gesehen']));
                        }
                    } elseif (in_array($x['art'] ?? '', ['film', 'folge'], true)) {
                        gesehen_setzen($kid, $x['art'], $zid, !empty($e['gesehen']));
                    }
                }
                bw_json(['ok' => true]);
            }
            if ($t1 === 'gesehen' && $methode === 'POST') {
                $e = eingabe();
                gesehen_setzen($kid, (string) ($e['art'] ?? ''), (int) ($e['id'] ?? 0), !empty($e['gesehen']));
                bw_json(['ok' => true]);
            }
            if ($t1 === 'naechste' && zahl($t2)) {
                bw_json(['naechste' => naechste_info(folge_danach(zahl($t2)))]);
            }
            break;

        case 'stream':
            require_once __DIR__ . '/../includes/wiedergabe.php';
            $sid = $t1;
            $m = preg_match('/^[a-f0-9]{24}$/', $sid) ? sitzung_meta($sid) : null;
            if (!$m || ((int) $m['konto_id'] !== $kid && !ist_admin())) {
                fehler('Sitzung abgelaufen.', 404);
            }
            if ($methode === 'DELETE') {
                sitzung_beenden($sid, $kid);
                bw_json(['ok' => true]);
            }
            db_schliessen();
            if ($t2 === 'index.m3u8') {
                header('Content-Type: application/vnd.apple.mpegurl');
                header('Cache-Control: no-store');
                echo hls_playlist($sid);
                exit;
            }
            session_write_close();
            if ($t2 === 'vorstart' && $methode === 'POST') {
                // Player meldet beim Spulen die Zielzeit: Encoder dort schon starten, bevor hls.js den Teil anfragt
                $n = hls_vorstart($sid, max(0.0, (float) (eingabe()['zeit'] ?? 0)));
                bw_json(['ok' => true, 'teil' => $n]);
            }
            $teilNr = null;
            if ($t2 === 'init.mp4') {
                $teilNr = null;
            } elseif ($t2 === 'teil' && preg_match('/^(\d+)\.m4s$/', $teile[3] ?? '', $mm)) {
                $teilNr = (int) $mm[1];
            } else {
                fehler('Unbekannt.', 404);
            }
            wiedergabe_aktiv_merken();
            $tw = microtime(true);
            try {
                $r = hls_teil($sid, $teilNr);
            } catch (TeilUeberholt $x) {
                fehler($x->getMessage(), 409);
            }
            $wartezeit = (int) round((microtime(true) - $tw) * 1000);
            header('Content-Type: ' . ($teilNr === null ? 'video/mp4' : 'video/iso.segment'));
            if (isset($r['part'])) {
                // Teil entsteht gerade: sofort ausliefern, was da ist, und jedes neue Fragment hinterher
                diag('hls_teil_server', ['teil' => $teilNr, 'warten_auf_encoder_ms' => $wartezeit, 'wachsend' => true]);
                hls_part_senden($sid, $r);
                exit;
            }
            if ($wartezeit > 300 || $teilNr === null || $teilNr % 10 === 0) {
                diag('hls_teil_server', ['teil' => $teilNr ?? 'init', 'warten_auf_encoder_ms' => $wartezeit, 'kb' => (int) (filesize($r['datei']) / 1024)]);
            }
            header('Cache-Control: private, max-age=600');
            header('Content-Length: ' . filesize($r['datei']));
            readfile($r['datei']);
            exit;

        case 'datei':
            require_once __DIR__ . '/../includes/wiedergabe.php';
            if ($t2 === 'inhalt') {
                $d = abspielquelle($t1);
                if (!$d) {
                    fehler('Datei nicht gefunden.', 404);
                }
                wiedergabe_aktiv_merken();
                require_once __DIR__ . '/../includes/diagnose.php';
                diag('direkt_anfrage', ['bereich' => (string) ($_SERVER['HTTP_RANGE'] ?? 'ganz')]);
                datei_senden($d['pfad'], mime_fuer((string) $d['container']));
            }
            break;

        case 'poster':
            // Eigenes Poster per Link: POST poster {art: film|serie|staffel, id, staffel?, url}
            admin_noetig();
            if ($methode === 'POST') {
                require_once __DIR__ . '/../includes/poster.php';
                $e = eingabe();
                @set_time_limit(120);
                try {
                    bw_json(['ok' => true] + poster_setzen((string) ($e['art'] ?? ''), (int) ($e['id'] ?? 0), (int) ($e['staffel'] ?? 0), (string) ($e['url'] ?? ''),
                        (string) ($e['typ'] ?? 'poster')));
                } catch (RuntimeException $x) {
                    fehler($x->getMessage());
                }
            }
            if ($methode === 'DELETE') {
                // eigenes Bild entfernen → wieder TMDB bzw. Ordnerbild
                require_once __DIR__ . '/../includes/poster.php';
                require_once __DIR__ . '/../includes/tmdb.php';
                $e = eingabe();
                $art = (string) ($e['art'] ?? '');
                $zid = (int) ($e['id'] ?? 0);
                eigenes_bild_entfernen($art, $zid, (int) ($e['staffel'] ?? 0), (string) ($e['typ'] ?? 'poster'));
                if ($art === 'reihe') {
                    $tm = (int) db_wert('SELECT tmdb_id FROM reihen WHERE id = :i', ['i' => $zid]);
                    if ($tm) {
                        tmdb_reihe_uebernehmen($tm, true);
                    }
                    bw_json(['ok' => true]);
                }
                if ($art === 'universum') {
                    $sp = ($e['typ'] ?? '') === 'hintergrund' ? 'hintergrund' : 'bild';
                    db_tun("UPDATE universen SET $sp = NULL WHERE id = :i", ['i' => $zid]);
                    bw_json(['ok' => true]);
                }
                $grund = $art === 'film' ? 'film' : 'serie';
                $tmdb = (int) db_wert('SELECT tmdb_id FROM ' . ($grund === 'film' ? 'filme' : 'serien') . ' WHERE id = :i', ['i' => $zid]);
                if ($tmdb) {
                    $grund === 'film' ? tmdb_film_uebernehmen($zid, $tmdb, true) : tmdb_serie_uebernehmen($zid, $tmdb, true);
                }
                if (lb_aktiv()) {
                    $grund === 'film' ? lokale_bilder_film($zid) : lokale_bilder_serie($zid);
                }
                eigene_poster_anwenden($grund, $zid);
                bw_json(['ok' => true]);
            }
            break;

        case 'diagnose':
            require_once __DIR__ . '/../includes/diagnose.php';
            if ($methode === 'POST') {
                diag_annehmen(eingabe(), $k);
                bw_json(['ok' => true]);
            }
            admin_noetig();
            if ($methode === 'GET') {
                bw_json(['wiedergaben' => diag_lesen(min(100, max(1, (int) ($_GET['anzahl'] ?? 30))))]);
            }
            if ($methode === 'DELETE') {
                @unlink(diag_datei());
                bw_json(['ok' => true]);
            }
            break;

        case 'remux':
            // Direct Stream: remux/{datei}/position?start=S → Schlüsselbild; remux/{datei}/strom?start=&ton=&audio=&kanaele=
            require_once __DIR__ . '/../includes/wiedergabe.php';
            $d = abspielquelle($t1);
            if (!$d) {
                fehler('Datei nicht gefunden.', 404);
            }
            wiedergabe_aktiv_merken();
            db_schliessen();
            session_write_close();
            if ($t2 === 'position' && $methode === 'GET') {
                bw_json(['start' => remux_schluesselbild($d['pfad'], max(0, (float) ($_GET['start'] ?? 0)))]);
            }
            if ($t2 === 'strom' && $methode === 'GET') {
                remux_senden(remux_befehl($d['pfad'], max(0, (float) ($_GET['start'] ?? 0)), max(0, (int) ($_GET['ton'] ?? 0)),
                    in_array($_GET['audio'] ?? '', ['copy', 'eac3'], true) ? (string) $_GET['audio'] : 'aac', (int) ($_GET['kanaele'] ?? 2),
                    strtolower((string) $d['video_codec']) === 'hevc', ($_GET['absolut'] ?? '') === '1'), (string) ($_GET['token'] ?? ''));
            }
            break;

        case 'vorschau':
            // Vorschaubilder der Zeitleiste: vorschau/{datei}/{n}.jpg (Kachelbild n)
            require_once __DIR__ . '/../includes/vorschau.php';
            if ($t1 === '' && $methode === 'GET') {
                // Stand für die Verwaltung: wie viele Dateien haben schon Vorschaubilder?
                admin_noetig();
                require_once __DIR__ . '/../includes/vorarbeit.php';
                $fertig = 0;
                $gesamt = 0;
                foreach (db_alle('SELECT id, groesse FROM dateien WHERE fehlt_seit IS NULL AND dauer_ms > 0') as $d) {
                    $gesamt++;
                    $fertig += vorschau_info($d) !== null ? 1 : 0;
                }
                bw_json(['fertig' => $fertig, 'gesamt' => $gesamt, 'arbeiter' => vorarbeit_status()]);
            }
            if ($t1 === '' && $methode === 'POST') {
                // Hintergrundarbeit sofort anstoßen (sonst beim nächsten Zeitplan-Lauf)
                admin_noetig();
                require_once __DIR__ . '/../includes/vorarbeit.php';
                bw_json(['gestartet' => vorarbeit_starten()]);
            }
            if (zahl($t1) && preg_match('/^(\d{1,4})\.jpg$/', $t2, $mm) && $methode === 'GET') {
                $f = vorschau_ordner(zahl($t1)) . '/' . (int) $mm[1] . '.jpg';
                if (!is_file($f)) {
                    fehler('Keine Vorschau.', 404);
                }
                db_schliessen();
                header('Content-Type: image/jpeg');
                header('Cache-Control: private, max-age=31536000, immutable');
                header('Content-Length: ' . filesize($f));
                readfile($f);
                exit;
            }
            break;

        case 'optimiert':
            // Optimierte Fassungen (Admin): Liste, einreihen {art: film|serie|datei, id, staffel?, hoehe}, löschen
            admin_noetig();
            require_once __DIR__ . '/../includes/optimiert.php';
            require_once __DIR__ . '/../includes/vorarbeit.php';
            if ($t1 === '' && $methode === 'GET') {
                $art = (string) ($_GET['art'] ?? '');
                $liste = optimiert_liste();
                if (in_array($art, ['film', 'serie'], true) && zahl((string) ($_GET['id'] ?? ''))) {
                    $ids = array_map(static fn($d) => (int) $d['id'], optimiert_dateien($art, (int) $_GET['id']));
                    $liste = array_values(array_filter($liste, static fn($o) => in_array($o['datei_id'], $ids, true)));
                }
                bw_json(['liste' => $liste, 'arbeiter' => vorarbeit_status(), 'ordner' => optimiert_ordner(),
                    'frei' => @disk_free_space(optimiert_ordner()) ?: @disk_free_space(dirname(optimiert_ordner())) ?: null]);
            }
            if ($t1 === '' && $methode === 'POST') {
                $e = eingabe();
                [$neu, $ueber] = optimiert_einreihen((string) ($e['art'] ?? ''), (int) ($e['id'] ?? 0), (int) ($e['hoehe'] ?? 1080),
                    isset($e['staffel']) && $e['staffel'] !== null ? (int) $e['staffel'] : null);
                vorarbeit_starten();
                bw_json(['neu' => $neu, 'uebersprungen' => $ueber]);
            }
            if (zahl($t1) && $methode === 'DELETE') {
                optimiert_loeschen(zahl($t1));
                bw_json(['ok' => true]);
            }
            break;

        case 'untertitel':
            require_once __DIR__ . '/../includes/wiedergabe.php';
            if (preg_match('/^(\d+)\.vtt$/', $t1, $mm) && $methode === 'GET') {
                try {
                    $p = untertitel_vtt((int) $mm[1]);
                } catch (UntertitelNochNicht $x) {
                    require_once __DIR__ . '/../includes/diagnose.php';
                    diag('untertitel_noch_nicht', ['id' => (int) $mm[1]]);
                    // läuft im Hintergrund – der Player fragt gleich nochmal
                    header('Retry-After: 5');
                    fehler($x->getMessage(), 503);
                }
                header('Content-Type: text/vtt; charset=utf-8');
                header('Cache-Control: private, max-age=3600');
                $versatz = (int) ($_GET['versatz_ms'] ?? 0);
                if ($versatz > 0) {
                    echo vtt_verschieben((string) file_get_contents($p), $versatz); // Direct Stream nach dem Spulen
                } else {
                    readfile($p);
                }
                exit;
            }
            if ($t1 === 'suchen' && $methode === 'POST') {
                admin_noetig();
                require_once __DIR__ . '/../includes/untertitel.php';
                $e = eingabe();
                bw_json(['gefunden' => untertitel_holen((int) ($e['datei_id'] ?? 0), (string) ($e['sprache'] ?? 'deu'))]);
            }
            break;

        case 'marker':
            admin_noetig();
            require_once __DIR__ . '/../includes/marker.php';
            if ($methode === 'PUT') {
                $e = eingabe();
                $art = in_array($e['art'] ?? '', ['intro', 'abspann', 'rueckblick', 'vorschau'], true) ? $e['art'] : fehler('Unbekannte Art.');
                marker_setzen((int) ($e['datei_id'] ?? 0), $art, (int) ($e['start_ms'] ?? 0), (int) ($e['ende_ms'] ?? 0), 'manuell');
                bw_json(['ok' => true]);
            }
            if ($methode === 'DELETE' && zahl($t1) && $t2 !== '') {
                db_tun('DELETE FROM marker WHERE datei_id = :d AND art = :a', ['d' => zahl($t1), 'a' => $t2]);
                bw_json(['ok' => true]);
            }
            break;

        // ---------- Verwaltung ----------
        case 'bibliothek':
            admin_noetig();
            require_once __DIR__ . '/../includes/auftrag.php';
            if ($t1 === 'status') {
                bw_json([
                    'auftrag' => auftrag_status(),
                    'zahlen' => [
                        'filme' => (int) db_wert('SELECT COUNT(DISTINCT fa.film_id) FROM fassungen fa JOIN dateien d ON d.fassung_id = fa.id AND d.fehlt_seit IS NULL'),
                        'serien' => (int) db_wert('SELECT COUNT(DISTINCT fo.serie_id) FROM folgen fo JOIN dateien d ON d.folge_id = fo.id AND d.fehlt_seit IS NULL'),
                        'folgen' => (int) db_wert('SELECT COUNT(DISTINCT folge_id) FROM dateien WHERE folge_id IS NOT NULL AND fehlt_seit IS NULL'),
                        'dateien' => (int) db_wert('SELECT COUNT(*) FROM dateien WHERE fehlt_seit IS NULL'),
                        'fehlend' => (int) db_wert('SELECT COUNT(*) FROM dateien WHERE fehlt_seit IS NOT NULL'),
                        'intros' => (int) db_wert("SELECT COUNT(*) FROM marker WHERE art = 'intro'"),
                    ],
                    'letzter_scan' => system_wert('letzter_scan'),
                    'tmdb' => server_einstellungen()['tmdb_schluessel'] !== '',
                    'offen' => [
                        'filme' => db_alle("SELECT id, titel, jahr, metadaten_status FROM filme WHERE metadaten_status IN ('offen','nicht_gefunden') ORDER BY sortiertitel LIMIT 200"),
                        'serien' => db_alle("SELECT id, titel, jahr_von AS jahr, metadaten_status FROM serien WHERE metadaten_status IN ('offen','nicht_gefunden') ORDER BY sortiertitel LIMIT 200"),
                    ],
                ]);
            }
            if ($t1 === 'auftrag' && $methode === 'POST') {
                $art = (string) (eingabe()['art'] ?? 'alles');
                if (!auftrag_starten($art)) {
                    fehler(auftrag_laeuft() ? 'Es läuft schon ein Auftrag.' : 'Unbekannter Auftrag.', 409);
                }
                bw_json(['ok' => true]);
            }
            break;

        case 'tmdb':
            admin_noetig();
            require_once __DIR__ . '/../includes/tmdb.php';
            if ($t1 === 'suche') {
                $q = trim((string) ($_GET['q'] ?? ''));
                $jahr = isset($_GET['jahr']) && ctype_digit((string) $_GET['jahr']) ? (int) $_GET['jahr'] : null;
                $roh = ($_GET['art'] ?? 'film') === 'serie' ? tmdb_serie_suchen($q, $jahr) : tmdb_film_suchen($q, $jahr);
                bw_json(['treffer' => array_map(static fn($r) => ['tmdb_id' => (int) $r['id'], 'titel' => $r['title'] ?? $r['name'] ?? '',
                    'original' => $r['original_title'] ?? $r['original_name'] ?? '', 'jahr' => substr((string) ($r['release_date'] ?? $r['first_air_date'] ?? ''), 0, 4),
                    'beschreibung' => mb_strimwidth((string) ($r['overview'] ?? ''), 0, 200, '…'),
                    'poster' => !empty($r['poster_path']) ? tmdb_bild_url() . '/w185' . $r['poster_path'] : null], array_slice($roh, 0, 12))]);
            }
            break;

        case 'aufraeumen':
            admin_noetig();
            require_once __DIR__ . '/../includes/aufraeumen.php';
            if ($t1 === 'vorschau') {
                bw_json(['liste' => aufraeumen_vorschau(), 'moeglich' => aufraeumen_moeglich()]);
            }
            if ($t1 === 'ausfuehren' && $methode === 'POST') {
                @set_time_limit(600);
                bw_json(aufraeumen_ausfuehren((array) (eingabe()['ids'] ?? [])));
            }
            break;

        case 'nutzer':
            admin_noetig();
            if ($t1 === '' && $methode === 'GET') {
                bw_json(['nutzer' => db_alle('SELECT k.id, k.benutzername, k.anzeigename, k.rolle, k.aktiv, k.letzter_login,
                    (SELECT COUNT(*) FROM sitzungen s WHERE s.konto_id = k.id AND s.art = \'geraet\') AS geraete FROM konten k ORDER BY k.anzeigename')]);
            }
            if ($t1 === '' && $methode === 'POST') {
                $e = eingabe();
                bw_json(['id' => konto_anlegen((string) ($e['benutzername'] ?? ''), (string) ($e['anzeigename'] ?? ''), (string) ($e['passwort'] ?? ''), (string) ($e['rolle'] ?? 'nutzer'))]);
            }
            if (zahl($t1) && $methode === 'PUT') {
                $e = eingabe();
                $ziel = zahl($t1);
                if (isset($e['rolle'])) {
                    if ($ziel === $kid && $e['rolle'] !== 'admin') {
                        fehler('Du kannst dir selbst die Admin-Rechte nicht nehmen.');
                    }
                    db_tun('UPDATE konten SET rolle = :r WHERE id = :id', ['r' => $e['rolle'] === 'admin' ? 'admin' : 'nutzer', 'id' => $ziel]);
                }
                if (isset($e['aktiv'])) {
                    if ($ziel === $kid) {
                        fehler('Du kannst dich nicht selbst sperren.');
                    }
                    db_tun('UPDATE konten SET aktiv = :a WHERE id = :id', ['a' => (int) (bool) $e['aktiv'], 'id' => $ziel]);
                }
                if (!empty($e['passwort'])) {
                    if (($f = passwort_pruefen((string) $e['passwort'])) !== null) {
                        fehler($f);
                    }
                    db_tun('UPDATE konten SET passwort_hash = :h WHERE id = :id', ['h' => password_hash((string) $e['passwort'], PASSWORD_ARGON2ID), 'id' => $ziel]);
                    db_tun("DELETE FROM sitzungen WHERE konto_id = :k AND art = 'browser'", ['k' => $ziel]);
                }
                if (isset($e['anzeigename']) && trim((string) $e['anzeigename']) !== '') {
                    db_tun('UPDATE konten SET anzeigename = :a WHERE id = :id', ['a' => mb_substr(trim((string) $e['anzeigename']), 0, 100), 'id' => $ziel]);
                }
                bw_json(['ok' => true]);
            }
            if (zahl($t1) && $methode === 'DELETE') {
                if (zahl($t1) === $kid) {
                    fehler('Du kannst dich nicht selbst löschen.');
                }
                db_tun('DELETE FROM konten WHERE id = :id', ['id' => zahl($t1)]);
                bw_json(['ok' => true]);
            }
            break;

        case 'einstellungen':
            admin_noetig();
            if ($methode === 'GET') {
                $e = server_einstellungen();
                $e['opensubtitles_passwort'] = $e['opensubtitles_passwort'] !== '' ? '••••••••' : '';
                bw_json(['einstellungen' => $e]);
            }
            if ($methode === 'PUT') {
                $neu = eingabe();
                if (($neu['opensubtitles_passwort'] ?? '') === '••••••••') {
                    unset($neu['opensubtitles_passwort']);
                }
                $e = server_einstellungen_speichern($neu);
                $e['opensubtitles_passwort'] = $e['opensubtitles_passwort'] !== '' ? '••••••••' : '';
                bw_json(['einstellungen' => $e]);
            }
            break;

        case 'system':
            admin_noetig();
            require_once __DIR__ . '/../includes/hardware.php';
            if ($t1 === '' && $methode === 'GET') {
                $kf = konfig();
                $db = ['ok' => false, 'schema' => null, 'fehler' => null];
                try {
                    $db['schema'] = (int) db_wert('SELECT COALESCE(MAX(version), 0) FROM schema_version');
                    $db['ok'] = true;
                    $db['version'] = (string) db_wert('SELECT VERSION()');
                } catch (Throwable $e) {
                    $db['fehler'] = $e->getMessage();
                }
                $ordner = [];
                foreach (['filme' => 'Filme', 'serien' => 'Serien', 'cache' => 'Appdata (Cache)', 'transkodieren' => 'Transkodieren'] as $s => $n) {
                    $p = $kf['pfade'][$s];
                    $ordner[] = ['name' => $n, 'pfad' => $p, 'da' => is_dir($p), 'lesbar' => is_readable($p), 'schreibbar' => is_writable($p)];
                }
                require_once __DIR__ . '/../includes/wiedergabe.php';
                bw_json(['version' => $kf['version'], 'datenbank' => $db, 'ordner' => $ordner, 'hardware' => hw_lesen(), 'profile' => ENCODER_PROFILE,
                    'streams' => count(sitzungen_alle())]);
            }
            if ($t1 === 'hardware' && $t2 === 'erkennen' && $methode === 'POST') {
                bw_json(['hardware' => hw_erkennen()]);
            }
            if ($t1 === 'hardware' && $t2 === 'test' && $methode === 'POST') {
                @set_time_limit(240);
                bw_json(['test' => hw_testen()]);
            }
            break;
    }
    fehler('Unbekannt: ' . $pfad, 404);
} catch (Throwable $e) {
    if ($e instanceof RuntimeException || $e instanceof InvalidArgumentException) {
        bw_json(['fehler' => $e->getMessage()], 400);
    }
    error_log('Bluewave API ' . $pfad . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    bw_json(['fehler' => 'Interner Fehler: ' . $e->getMessage()], 500);
}
