<?php
// Suche: tolerant gegenüber Groß/Klein, Umlauten, Akzenten, Satzzeichen ("spiderman" = "Spider-Man"),
// Wortreihenfolge und kleinen Tippfehlern; findet Filme, Serien, Reihen, Universen, Personen (Besetzung, Regie) und Folgen.
// Bei einer privaten Bibliothek (einige tausend Titel) ist das Bewerten in PHP schnell genug und viel besser als LIKE.
declare(strict_types=1);

/** Text auf Suchform bringen: klein, ohne Akzente, ä→ae (und zusätzlich a), nur Buchstaben/Ziffern und Leerzeichen */
function such_norm(string $t): string
{
    $t = mb_strtolower($t);
    $t = strtr($t, ['ß' => 'ss', '&' => ' und ']);
    if (class_exists('Normalizer')) {
        $t = (string) Normalizer::normalize($t, Normalizer::FORM_D);
        $t = (string) preg_replace('/\p{Mn}+/u', '', $t);
    } else {
        $t = strtr($t, ['ä' => 'a', 'ö' => 'o', 'ü' => 'u', 'é' => 'e', 'è' => 'e', 'á' => 'a', 'à' => 'a', 'ó' => 'o', 'í' => 'i', 'ñ' => 'n', 'ç' => 'c']);
    }
    $t = (string) preg_replace('/[^\p{L}\p{N}]+/u', ' ', $t);
    return trim((string) preg_replace('/\s+/', ' ', $t));
}

/** Umlaute zusätzlich als ae/oe/ue (für "Moerder" → "Mörder") */
function such_norm_alt(string $t): string
{
    return such_norm(strtr(mb_strtolower($t), ['ä' => 'ae', 'ö' => 'oe', 'ü' => 'ue']));
}

/**
 * Bewertet, wie gut die Anfrage zu einem Text passt (0 = gar nicht).
 * $woerter: normalisierte Suchwörter, $kompakt: Anfrage ohne Leerzeichen
 */
function such_wert(string $text, array $woerter, string $kompakt, string $ganz): int
{
    if ($text === '') {
        return 0;
    }
    $n = such_norm($text);
    $varianten = array_unique([$n, such_norm_alt($text)]);
    $best = 0;
    foreach ($varianten as $v) {
        $vk = str_replace(' ', '', $v);
        if ($v === $ganz || $vk === $kompakt) {
            return 1000;
        }
        $w = 0;
        if (str_starts_with($v, $ganz) || str_starts_with($vk, $kompakt)) {
            $w = 800;
        } elseif (str_contains($v, $ganz)) {
            $w = 650;
        } elseif (mb_strlen($kompakt) >= 4 && str_contains($vk, $kompakt)) {
            $w = 600; // "spiderman" in "spider man"
        }
        // Wort für Wort: jedes Suchwort muss am Anfang eines Wortes stehen (oder fast passen)
        $textWoerter = explode(' ', $v);
        $treffer = 0;
        $fehler = 0;
        foreach ($woerter as $sw) {
            $ok = false;
            foreach ($textWoerter as $tw) {
                if (str_starts_with($tw, $sw)) {
                    $ok = true;
                    break;
                }
            }
            if (!$ok && mb_strlen($sw) >= 4) {
                $grenze = mb_strlen($sw) >= 8 ? 2 : 1;
                foreach ($textWoerter as $tw) {
                    // Tippfehler: gegen das Wort selbst und seinen Anfang in Suchwortlänge
                    if (levenshtein($sw, $tw) <= $grenze || (mb_strlen($tw) > mb_strlen($sw) && levenshtein($sw, mb_substr($tw, 0, mb_strlen($sw))) <= $grenze)) {
                        $ok = true;
                        $fehler++;
                        break;
                    }
                }
            }
            if ($ok) {
                $treffer++;
            }
        }
        if ($treffer === count($woerter)) {
            $w = max($w, 500 - 60 * $fehler);
        }
        $best = max($best, $w);
    }
    return $best;
}

/** Schneller Vorfilter für lange Texte (Besetzung): kommt ein Suchwort-Anfang (3 Zeichen) überhaupt vor? */
function such_vorfilter(string $roh, array $woerter): bool
{
    if ($roh === '' || $roh === '[]') {
        return false;
    }
    $n = such_norm($roh);
    foreach ($woerter as $w) {
        if (str_contains($n, mb_substr($w, 0, 3))) {
            return true;
        }
    }
    return false;
}

function suche_alles(string $q, int $konto, int $grenze = 40): array
{
    $leer = ['beste' => null, 'filme' => [], 'serien' => [], 'reihen' => [], 'universen' => [], 'personen' => [], 'folgen' => []];
    $ganz = such_norm($q);
    if (mb_strlen($ganz) < 2) {
        return $leer;
    }
    // Jahreszahl in der Anfrage ("dune 2021") filtert bzw. hebt hervor
    $jahr = null;
    if (preg_match('/\b(19\d{2}|20\d{2})\b/', $ganz, $m) && trim(str_replace($m[1], '', $ganz)) !== '') {
        $jahr = (int) $m[1];
        $ganz = trim((string) preg_replace('/\s+/', ' ', str_replace($m[1], '', $ganz)));
    }
    $woerter = array_values(array_filter(explode(' ', $ganz), static fn($w) => $w !== ''));
    $kompakt = str_replace(' ', '', $ganz);
    $jahrBonus = static fn(?int $j) => $jahr === null ? 0 : ($j === $jahr ? 150 : -200);

    // ---- Filme (nur vorhandene) ----
    $filme = [];
    $personen = [];
    $personAdd = static function (string $name, ?string $bild, string $rolle, array $titel, int $wert) use (&$personen): void {
        $k = such_norm($name);
        $personen[$k] ??= ['name' => $name, 'bild' => $bild, 'wert' => 0, 'titel' => [], 'rollen' => []];
        $personen[$k]['wert'] = max($personen[$k]['wert'], $wert);
        $personen[$k]['bild'] ??= $bild;
        $personen[$k]['titel'][$titel['art'] . $titel['id']] = $titel;
        if ($rolle !== '') {
            $personen[$k]['rollen'][$rolle] = true;
        }
    };
    $zeilen = db_alle("SELECT f.id, f.titel, f.originaltitel, f.jahr, f.regie, f.besetzung, f.stichwoerter FROM filme f
        WHERE EXISTS (SELECT 1 FROM fassungen fa JOIN dateien d ON d.fassung_id = fa.id AND d.fehlt_seit IS NULL WHERE fa.film_id = f.id)");
    foreach ($zeilen as $z) {
        $w = max(such_wert((string) $z['titel'], $woerter, $kompakt, $ganz), (int) (such_wert((string) $z['originaltitel'], $woerter, $kompakt, $ganz) * 0.95));
        $j = $z['jahr'] ? (int) $z['jahr'] : null;
        $kurz = ['art' => 'film', 'id' => (int) $z['id'], 'titel' => $z['titel'], 'jahr' => $j];
        // Personen (Vorfilter: mindestens ein Suchwort-Anfang kommt in den Namen vor)
        $grund = null;
        $besetzung = such_vorfilter((string) $z['besetzung'], $woerter) ? (json_decode((string) $z['besetzung'], true) ?: []) : [];
        foreach ($besetzung as $i => $b) {
            $pw = such_wert((string) ($b['name'] ?? ''), $woerter, $kompakt, $ganz);
            if ($pw >= 500) {
                $personAdd((string) $b['name'], bild_url($b['bild'] ?? null), (string) ($b['rolle'] ?? ''), $kurz, $pw);
                $grund ??= 'mit ' . $b['name'];
                $w = max($w, (int) ($pw * 0.55) - $i * 3); // Hauptrollen zuerst
            }
        }
        foreach (array_filter(array_map('trim', explode(',', (string) $z['regie']))) as $r) {
            $pw = such_wert($r, $woerter, $kompakt, $ganz);
            if ($pw >= 500) {
                $personAdd($r, null, 'Regie', $kurz, $pw);
                $grund ??= 'Regie: ' . $r;
                $w = max($w, (int) ($pw * 0.5));
            }
        }
        if ($w > 0) {
            $filme[(int) $z['id']] = $w + $jahrBonus($j);
            if ($grund && $w < 500) {
                $filme['g' . $z['id']] = $grund;
            }
        }
    }
    $filmGruende = [];
    foreach ($filme as $k => $v) {
        if (is_string($k)) {
            $filmGruende[(int) substr($k, 1)] = $v;
            unset($filme[$k]);
        }
    }
    $filme = array_filter($filme, static fn($w) => $w > 0);
    arsort($filme);
    $filmIds = array_slice(array_keys($filme), 0, $grenze);
    $filmKacheln = [];
    if ($filmIds) {
        foreach (film_kacheln(db_alle(FILM_KACHEL_SQL . ' WHERE f.id IN (' . implode(',', $filmIds) . ') GROUP BY f.id'), $konto) as $k) {
            $filmKacheln[$k['id']] = $k + ['wert' => $filme[$k['id']], 'zusatz' => isset($filmGruende[$k['id']]) ? $filmGruende[$k['id']] : ($k['jahr'] ? (string) $k['jahr'] : null)];
        }
    }
    $filmListe = array_values(array_filter(array_map(static fn($i) => $filmKacheln[$i] ?? null, $filmIds)));

    // ---- Serien ----
    $serien = [];
    $serienGruende = [];
    foreach (db_alle('SELECT s.id, s.titel, s.originaltitel, s.jahr_von, s.besetzung FROM serien s WHERE EXISTS (SELECT 1 FROM folgen fo JOIN dateien d ON d.folge_id = fo.id AND d.fehlt_seit IS NULL WHERE fo.serie_id = s.id)') as $z) {
        $w = max(such_wert((string) $z['titel'], $woerter, $kompakt, $ganz), (int) (such_wert((string) $z['originaltitel'], $woerter, $kompakt, $ganz) * 0.95));
        $j = $z['jahr_von'] ? (int) $z['jahr_von'] : null;
        $kurz = ['art' => 'serie', 'id' => (int) $z['id'], 'titel' => $z['titel'], 'jahr' => $j];
        foreach (such_vorfilter((string) $z['besetzung'], $woerter) ? (json_decode((string) $z['besetzung'], true) ?: []) : [] as $i => $b) {
            $pw = such_wert((string) ($b['name'] ?? ''), $woerter, $kompakt, $ganz);
            if ($pw >= 500) {
                $personAdd((string) $b['name'], bild_url($b['bild'] ?? null), (string) ($b['rolle'] ?? ''), $kurz, $pw);
                if ($w < 500) {
                    $serienGruende[(int) $z['id']] ??= 'mit ' . $b['name'];
                }
                $w = max($w, (int) ($pw * 0.55) - $i * 3);
            }
        }
        if ($w > 0) {
            $serien[(int) $z['id']] = $w + $jahrBonus($j);
        }
    }
    $serien = array_filter($serien, static fn($w) => $w > 0);
    arsort($serien);
    $serieIds = array_slice(array_keys($serien), 0, $grenze);
    $serieListe = [];
    if ($serieIds) {
        $kach = [];
        foreach (serie_kacheln(db_alle(SERIE_KACHEL_SQL . ' WHERE s.id IN (' . implode(',', $serieIds) . ') GROUP BY s.id'), $konto) as $k) {
            $kach[$k['id']] = $k + ['wert' => $serien[$k['id']]] + (isset($serienGruende[$k['id']]) ? ['zusatz' => $serienGruende[$k['id']]] : []);
        }
        $serieListe = array_values(array_filter(array_map(static fn($i) => $kach[$i] ?? null, $serieIds)));
    }

    // ---- Reihen und Universen ----
    $reihen = [];
    foreach (db_alle('SELECT r.id, r.name, r.poster, COUNT(f.id) AS n FROM reihen r JOIN filme f ON f.reihe_id = r.id GROUP BY r.id') as $z) {
        $w = such_wert((string) $z['name'], $woerter, $kompakt, $ganz);
        if ($w > 0) {
            $reihen[] = ['art' => 'reihe', 'id' => (int) $z['id'], 'titel' => $z['name'], 'poster' => bild_url($z['poster']),
                'zusatz' => $z['n'] . ' ' . ((int) $z['n'] === 1 ? 'Film' : 'Filme'), 'wert' => $w];
        }
    }
    usort($reihen, static fn($a, $b) => $b['wert'] <=> $a['wert']);
    require_once __DIR__ . '/universen.php';
    $universen = [];
    foreach (universen_liste($konto) as $u) {
        $w = such_wert((string) $u['name'], $woerter, $kompakt, $ganz);
        if ($w > 0) {
            $universen[] = $u + ['wert' => $w];
        }
    }
    usort($universen, static fn($a, $b) => $b['wert'] <=> $a['wert']);

    // ---- Personen: nach Treffergüte, dann Anzahl Titel ----
    $personen = array_values($personen);
    usort($personen, static fn($a, $b) => [$b['wert'], count($b['titel'])] <=> [$a['wert'], count($a['titel'])]);
    $personen = array_map(static fn($p) => ['name' => $p['name'], 'bild' => $p['bild'], 'anzahl' => count($p['titel']),
        'titel' => array_slice(array_values($p['titel']), 0, 6), 'rolle' => isset($p['rollen']['Regie']) && count($p['rollen']) === 1 ? 'Regie' : 'Schauspiel'],
        array_slice($personen, 0, 12));

    // ---- Folgen (Titel), nur wenn die Anfrage nach Wörtern aussieht ----
    $folgen = [];
    if (mb_strlen($kompakt) >= 3) {
        $like = '%' . str_replace(['%', '_'], ['\%', '\_'], $woerter[0]) . '%';
        foreach (db_alle('SELECT fo.id, fo.titel, fo.staffel_nr, fo.folge_nr, fo.standbild, fo.serie_id, s.titel AS serie FROM folgen fo JOIN serien s ON s.id = fo.serie_id
            WHERE fo.titel LIKE :q AND EXISTS (SELECT 1 FROM dateien d WHERE d.folge_id = fo.id AND d.fehlt_seit IS NULL) LIMIT 400', ['q' => $like]) as $z) {
            $w = such_wert((string) $z['titel'], $woerter, $kompakt, $ganz);
            if ($w >= 500) {
                $folgen[] = ['art' => 'folge', 'id' => (int) $z['id'], 'serie_id' => (int) $z['serie_id'], 'titel' => $z['titel'], 'serie' => $z['serie'],
                    'kennung' => sprintf('S%02dE%02d', (int) $z['staffel_nr'], (int) $z['folge_nr']), 'standbild' => bild_url($z['standbild']), 'wert' => $w];
            }
        }
        usort($folgen, static fn($a, $b) => $b['wert'] <=> $a['wert']);
        $folgen = array_slice($folgen, 0, 12);
    }

    // ---- Bester Treffer: höchster Wert über Filme, Serien, Universen, Reihen ----
    $kandidaten = array_merge(array_slice($filmListe, 0, 1), array_slice($serieListe, 0, 1), array_slice($universen, 0, 1), array_slice($reihen, 0, 1));
    usort($kandidaten, static fn($a, $b) => $b['wert'] <=> $a['wert']);
    $beste = null;
    if ($kandidaten && $kandidaten[0]['wert'] >= 500) {
        $b = $kandidaten[0];
        if ($b['art'] === 'film') {
            $f = film_detail($b['id'], $konto);
            $beste = ['art' => 'film', 'id' => $b['id'], 'titel' => $f['titel'], 'jahr' => $f['jahr'], 'poster' => $f['poster'], 'hintergrund' => $f['hintergrund'], 'logo' => $f['logo'],
                'text' => $f['tagline'] ?: mb_strimwidth((string) $f['beschreibung'], 0, 200, '…'), 'technik' => $f['technik'], 'fortschritt' => $f['fortschritt'],
                'laufzeit_min' => $f['laufzeit_min'], 'freigabe' => $f['freigabe']];
        } elseif ($b['art'] === 'serie') {
            $s = db_zeile('SELECT titel, beschreibung, hintergrund, logo, poster, freigabe FROM serien WHERE id = :i', ['i' => $b['id']]);
            $beste = ['art' => 'serie', 'id' => $b['id'], 'titel' => $s['titel'], 'jahr' => $b['jahr'], 'poster' => bild_url($s['poster']), 'hintergrund' => bild_url($s['hintergrund']),
                'logo' => bild_url($s['logo']), 'text' => mb_strimwidth((string) $s['beschreibung'], 0, 200, '…'), 'zusatz' => $b['zeitraum'] ?? null, 'freigabe' => $s['freigabe'],
                'naechste' => naechste_folge_fuer($b['id'], $konto)];
        } else {
            $beste = $b;
        }
    }
    $ohneWert = static fn(array $l) => array_map(static function ($x) { unset($x['wert']); return $x; }, $l);
    return ['beste' => $beste, 'filme' => $ohneWert($filmListe), 'serien' => $ohneWert($serieListe), 'reihen' => $ohneWert(array_slice($reihen, 0, 20)),
        'universen' => $ohneWert($universen), 'personen' => $personen, 'folgen' => $ohneWert($folgen), 'jahr' => $jahr];
}
