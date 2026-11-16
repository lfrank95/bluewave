<?php
// Bibliothek einlesen: Filme- und Serienordner durchgehen, Namen deuten, Fassungen erkennen, Dateien mit ffprobe analysieren.
// Nur geänderte Dateien (Größe/Zeit) werden neu analysiert – ein erneuter Scan ist deshalb schnell.
// Extras (Trailer, Featurettes …) werden bewusst übergangen.
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/einstellungen.php';

const VIDEO_ENDUNGEN = ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'ts', 'm2ts', 'wmv', 'webm', 'mpg', 'mpeg', 'mts'];
const UNTERTITEL_ENDUNGEN = ['srt', 'ass', 'ssa', 'vtt', 'sup'];
const EXTRA_ORDNER = ['extras', 'featurettes', 'behind the scenes', 'deleted scenes', 'interviews', 'scenes', 'shorts', 'trailers', 'trailer',
    'samples', 'sample', 'other', 'bonus', 'specials-extras', '@eadir', '.trash', '#recycle', '.recycle.bin', 'subs', 'subtitles'];
const SPRACHEN = ['de' => 'deu', 'ger' => 'deu', 'deu' => 'deu', 'german' => 'deu', 'deutsch' => 'deu', 'en' => 'eng', 'eng' => 'eng', 'english' => 'eng',
    'fr' => 'fra', 'fre' => 'fra', 'fra' => 'fra', 'es' => 'spa', 'spa' => 'spa', 'it' => 'ita', 'ita' => 'ita', 'ja' => 'jpn', 'jpn' => 'jpn',
    'nl' => 'nld', 'dut' => 'nld', 'nld' => 'nld', 'pl' => 'pol', 'pol' => 'pol', 'tr' => 'tur', 'tur' => 'tur', 'ru' => 'rus', 'rus' => 'rus',
    'pt' => 'por', 'por' => 'por', 'sv' => 'swe', 'swe' => 'swe', 'da' => 'dan', 'dan' => 'dan', 'no' => 'nor', 'nor' => 'nor', 'ko' => 'kor', 'kor' => 'kor',
    'zh' => 'zho', 'chi' => 'zho', 'zho' => 'zho', 'cs' => 'ces', 'cze' => 'ces', 'hu' => 'hun', 'fi' => 'fin', 'el' => 'ell', 'gre' => 'ell'];

const FASSUNG_NAMEN = ['kino' => 'Kinofassung', 'extended' => 'Extended Edition', 'directors_cut' => "Director's Cut", 'unrated' => 'Unrated',
    'remastered' => 'Remastered', 'imax' => 'IMAX', 'sonstige' => 'Andere Fassung'];

function sprache3(?string $s): ?string
{
    $s = strtolower(trim((string) $s));
    if ($s === '' || $s === 'und') {
        return null;
    }
    return SPRACHEN[$s] ?? (preg_match('/^[a-z]{3}$/', $s) ? $s : null);
}

/** Sortiertitel: Artikel nach hinten („Der Herr der Ringe“ → „Herr der Ringe“) */
/**
 * Sortierschlüssel: führende Artikel (Der/Die/Das/The/A/Ein …, auch L'), Anführungszeichen und Satzzeichen
 * werden übergangen, Umlaute wie ihr Grundbuchstabe einsortiert, Zahlen natürlich (2 vor 10).
 */
function sortiertitel(string $t): string
{
    $t = trim($t);
    $roh = (string) preg_replace('/^[\s\p{P}\p{S}]+/u', '', $t);              // „…“, '…', (…), ¡…, ...
    $s = (string) preg_replace("/^(der|die|das|den|dem|des|the|a|an|ein|eine|einer|le|la|les|los|las|el|il|lo|gli|un|una|une)\\s+|^(l|d)['’]\\s*/iu", '', $roh);
    $s = trim($s) !== '' ? $s : ($roh !== '' ? $roh : $t);
    $s = mb_strtolower($s);
    $s = strtr($s, ['ä' => 'a', 'ö' => 'o', 'ü' => 'u', 'ß' => 'ss', 'é' => 'e', 'è' => 'e', 'ê' => 'e', 'á' => 'a', 'à' => 'a', 'â' => 'a', 'ó' => 'o', 'ò' => 'o', 'ô' => 'o',
        'í' => 'i', 'ì' => 'i', 'ú' => 'u', 'ù' => 'u', 'ñ' => 'n', 'ç' => 'c', 'ø' => 'o', 'å' => 'a', 'æ' => 'ae', 'œ' => 'oe']);
    $s = (string) preg_replace_callback('/\d+/', static fn($m) => str_pad(ltrim($m[0], '0') ?: '0', 6, '0', STR_PAD_LEFT), $s);
    return mb_substr($s, 0, 255);
}

/** Vergleichsschlüssel für Titel (Groß/klein, Satzzeichen, Umlaute egal) */
function titel_schluessel(string $t): string
{
    $t = mb_strtolower($t);
    $t = strtr($t, ['ä' => 'ae', 'ö' => 'oe', 'ü' => 'ue', 'ß' => 'ss', '&' => 'and']);
    $t = (string) preg_replace('/[^\p{L}\p{N}]+/u', ' ', $t);
    return trim($t);
}

/** Fassung aus einem Namen: [art, text] oder null */
function fassung_erkennen(string $name): ?array
{
    if (preg_match('/\{edition-([^}]+)\}/i', $name, $m)) {
        $text = trim($m[1]);
        $art = fassung_art($text) ?? 'sonstige';
        return [$art, $art === 'sonstige' ? $text : FASSUNG_NAMEN[$art]];
    }
    $n = ' ' . strtolower(str_replace(['.', '_', '-'], ' ', $name)) . ' ';
    $muster = [
        'directors_cut' => '/\bdirector\'?s?\s*cut\b|\bdc\b(?=.*\b(19|20)\d\d\b)?/',
        'extended' => '/\bextended\b|\berweitert/',
        'unrated' => '/\bunrated\b|\buncut\b|\bungeschnitten\b/',
        'imax' => '/\bimax\b/',
        'remastered' => '/\bremaster(ed)?\b/',
        'kino' => '/\btheatrical\b|\bkinofassung\b/',
    ];
    foreach ($muster as $art => $re) {
        if ($art === 'directors_cut' ? preg_match('/\bdirector\'?s?\s*cut\b/', $n) : preg_match($re, $n)) {
            return [$art, FASSUNG_NAMEN[$art]];
        }
    }
    return null;
}

function fassung_art(string $text): ?string
{
    $t = strtolower($text);
    return match (true) {
        (bool) preg_match('/director/', $t) => 'directors_cut',
        (bool) preg_match('/extended|erweitert/', $t) => 'extended',
        (bool) preg_match('/unrated|uncut/', $t) => 'unrated',
        (bool) preg_match('/imax/', $t) => 'imax',
        (bool) preg_match('/remaster/', $t) => 'remastered',
        (bool) preg_match('/theatrical|kino/', $t) => 'kino',
        default => null,
    };
}

/**
 * Film aus Ordner-/Dateiname: ['titel', 'jahr', 'tmdb', 'imdb']
 * Erkennt „Titel (2010)“, „Titel.2010.1080p.BluRay…“, „Titel [2010]“ sowie {tmdb-123} / {imdb-tt…}.
 */
function film_name_deuten(string $name): array
{
    $tmdb = preg_match('/\{tmdb-(\d+)\}|\[tmdbid-(\d+)\]|tmdbid[=-](\d+)/i', $name, $m) ? (int) ($m[1] ?: ($m[2] ?? '') ?: ($m[3] ?? '')) : null;
    $imdb = preg_match('/(tt\d{7,9})/', $name, $m) ? $m[1] : null;
    $n = (string) preg_replace('/\{[^}]*\}|\[[^\]]*id[^\]]*\]/i', ' ', $name);
    $jahr = null;
    $titel = $n;
    $maxJahr = (int) date('Y') + 1;
    $treffer = null;
    // 1. Jahr in Klammern hat Vorrang (letztes Vorkommen): „Blade Runner 2049 (2017)“
    if (preg_match_all('/[(\[]((?:19|20)\d\d)[)\]]/', $n, $alle, PREG_OFFSET_CAPTURE) && $alle[1]) {
        $letztes = end($alle[0]);
        $treffer = [substr($n, 0, $letztes[1]), (int) substr($letztes[0], 1, 4)];
    } elseif (preg_match_all('/(?<=[\s._-])((?:19|20)\d\d)(?=[\s._-]|$)/', $n, $alle, PREG_OFFSET_CAPTURE)) {
        // 2. freistehendes Jahr (Release-Namen): das letzte plausible, nicht in der Zukunft („Blade Runner 2049“ bleibt Titel)
        foreach (array_reverse($alle[1]) as [$wert, $pos]) {
            if ((int) $wert <= $maxJahr && trim(substr($n, 0, $pos), " ._-") !== '') {
                $treffer = [substr($n, 0, $pos), (int) $wert];
                break;
            }
        }
    }
    if ($treffer !== null) {
        [$titel, $jahr] = $treffer;
    } else {
        // ohne Jahr: alles ab typischen Release-Angaben abschneiden
        $titel = (string) preg_replace('/[\s._-]+(2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|web-?dl|webrip|hdtv|remux|x264|x265|h264|h265|hevc|german|dl|ac3|dts).*$/i', '', $n);
    }
    $titel = trim((string) preg_replace('/[._]+/', ' ', $titel));
    $titel = trim((string) preg_replace('/\s+-\s*$/', '', $titel));
    $titel = trim((string) preg_replace('/\s{2,}/', ' ', $titel));
    return ['titel' => $titel, 'jahr' => $jahr, 'tmdb' => $tmdb ?: null, 'imdb' => $imdb];
}

/** Serienordner: ['titel', 'jahr', 'tmdb', 'tvdb'] */
function serie_name_deuten(string $name): array
{
    $tmdb = preg_match('/\{tmdb-(\d+)\}|\[tmdbid-(\d+)\]/i', $name, $m) ? (int) ($m[1] ?: $m[2]) : null;
    $tvdb = preg_match('/\{tvdb-(\d+)\}|\[tvdbid-(\d+)\]/i', $name, $m) ? (int) ($m[1] ?: $m[2]) : null;
    $f = film_name_deuten($name);
    return ['titel' => $f['titel'], 'jahr' => $f['jahr'], 'tmdb' => $tmdb, 'tvdb' => $tvdb];
}

/** Staffel/Folge aus einem Dateinamen (S01E02, 1x02, „Staffel 1/Folge 2“) – [staffel, folge] oder null */
function folge_deuten(string $relPfad): ?array
{
    $datei = basename($relPfad);
    if (preg_match('/S(\d{1,3})[ ._-]?E(\d{1,4})/i', $datei, $m)) {
        return [(int) $m[1], (int) $m[2]];
    }
    if (preg_match('/(?<![0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i', $datei, $m)) {
        return [(int) $m[1], (int) $m[2]];
    }
    // Ordner „Season 2“/„Staffel 2“ + Nummer im Dateinamen („02 - Titel.mkv“, „E02“)
    if (preg_match('#(?:season|staffel|s)[ ._-]?(\d{1,3})/[^/]*$#i', $relPfad, $s)
        && preg_match('/^(?:e|ep|episode|folge)?[ ._-]?(\d{1,3})(?![0-9])/i', $datei, $f)) {
        return [(int) $s[1], (int) $f[1]];
    }
    if (preg_match('/(?:specials?|extras?)\//i', $relPfad) && preg_match('/(\d{1,3})/', $datei, $f)) {
        return [0, (int) $f[1]];
    }
    return null;
}

/** Alle Videodateien unter $wurzel (ohne Extras/Samples) */
function video_dateien(string $wurzel): array
{
    $aus = [];
    if (!is_dir($wurzel)) {
        return $aus;
    }
    $stapel = [$wurzel];
    while ($stapel) {
        $d = array_pop($stapel);
        $eintraege = @scandir($d) ?: [];
        foreach ($eintraege as $e) {
            if ($e === '.' || $e === '..' || $e[0] === '.') {
                continue;
            }
            $p = $d . '/' . $e;
            if (is_dir($p)) {
                if (!in_array(strtolower($e), EXTRA_ORDNER, true)) {
                    $stapel[] = $p;
                }
                continue;
            }
            $endung = strtolower(pathinfo($e, PATHINFO_EXTENSION));
            if (!in_array($endung, VIDEO_ENDUNGEN, true)) {
                continue;
            }
            // Samples und Trailer neben dem Film übergehen
            if (preg_match('/(^|[ ._-])(sample|trailer|featurette|behindthescenes|deleted)([ ._-]|$)/i', pathinfo($e, PATHINFO_FILENAME))) {
                continue;
            }
            $aus[] = $p;
        }
    }
    sort($aus, SORT_NATURAL | SORT_FLAG_CASE);
    return $aus;
}

/** ffprobe auswerten → Werte für dateien, tonspuren, untertitel */
function datei_analysieren(string $pfad): ?array
{
    $k = konfig()['transkodieren'];
    $r = bw_ausfuehren([$k['ffprobe'], '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', $pfad], 90);
    $j = json_decode($r['aus'], true);
    if (!is_array($j) || empty($j['streams'])) {
        return null;
    }
    $f = $j['format'] ?? [];
    $aus = [
        'container' => strtolower(pathinfo($pfad, PATHINFO_EXTENSION)),
        'dauer_ms' => isset($f['duration']) ? (int) round((float) $f['duration'] * 1000) : null,
        'bitrate' => isset($f['bit_rate']) ? (int) $f['bit_rate'] : null,
        'video' => null, 'ton' => [], 'untertitel' => [],
    ];
    $ai = 0;
    $si = 0;
    foreach ($j['streams'] as $s) {
        $typ = $s['codec_type'] ?? '';
        $tags = array_change_key_case($s['tags'] ?? [], CASE_LOWER);
        $disp = $s['disposition'] ?? [];
        if ($typ === 'video' && empty($disp['attached_pic']) && $aus['video'] === null) {
            $hdr = 'sdr';
            $trc = (string) ($s['color_transfer'] ?? '');
            if ($trc === 'smpte2084') {
                $hdr = 'hdr10';
            } elseif ($trc === 'arib-std-b67') {
                $hdr = 'hlg';
            }
            foreach ($s['side_data_list'] ?? [] as $sd) {
                $t = (string) ($sd['side_data_type'] ?? '');
                if (stripos($t, 'DOVI') !== false) {
                    $hdr = 'dolby_vision';
                } elseif (stripos($t, 'HDR10+') !== false || stripos($t, 'HDR Dynamic Metadata SMPTE2094-40') !== false) {
                    $hdr = $hdr === 'dolby_vision' ? $hdr : 'hdr10plus';
                }
            }
            $bits = isset($s['bits_per_raw_sample']) && (int) $s['bits_per_raw_sample'] > 0 ? (int) $s['bits_per_raw_sample']
                : (preg_match('/(10|12)(le|be)?$/', (string) ($s['pix_fmt'] ?? ''), $m) ? (int) $m[1] : 8);
            $fps = null;
            if (preg_match('#^(\d+)/(\d+)$#', (string) ($s['avg_frame_rate'] ?? $s['r_frame_rate'] ?? ''), $m) && (int) $m[2] > 0) {
                $fps = round((int) $m[1] / (int) $m[2], 3);
            }
            $aus['video'] = [
                'codec' => (string) ($s['codec_name'] ?? ''), 'profil' => isset($s['profile']) ? mb_substr((string) $s['profile'], 0, 60) : null,
                'breite' => (int) ($s['width'] ?? 0), 'hoehe' => (int) ($s['height'] ?? 0), 'bittiefe' => $bits, 'bildrate' => $fps, 'hdr' => $hdr,
            ];
        } elseif ($typ === 'audio') {
            $aus['ton'][] = [
                'strom_index' => $ai++, 'codec' => (string) ($s['codec_name'] ?? ''), 'profil' => isset($s['profile']) ? mb_substr((string) $s['profile'], 0, 60) : null,
                'sprache' => sprache3($tags['language'] ?? null), 'kanaele' => (int) ($s['channels'] ?? 0), 'layout' => $s['channel_layout'] ?? null,
                'titel' => isset($tags['title']) ? mb_substr((string) $tags['title'], 0, 255) : null, 'standard' => (int) !empty($disp['default']),
                'kommentar' => (int) (!empty($disp['comment']) || preg_match('/kommentar|commentary/i', (string) ($tags['title'] ?? ''))),
            ];
        } elseif ($typ === 'subtitle') {
            $aus['untertitel'][] = [
                'strom_index' => $si++, 'format' => (string) ($s['codec_name'] ?? ''), 'sprache' => sprache3($tags['language'] ?? null),
                'titel' => isset($tags['title']) ? mb_substr((string) $tags['title'], 0, 255) : null,
                'erzwungen' => (int) (!empty($disp['forced']) || preg_match('/forced|erzwungen/i', (string) ($tags['title'] ?? ''))),
                'hoergeschaedigt' => (int) (!empty($disp['hearing_impaired']) || preg_match('/sdh|hörgeschädigt|cc\b/i', (string) ($tags['title'] ?? ''))),
                'standard' => (int) !empty($disp['default']),
            ];
        }
    }
    return $aus['video'] ? $aus : null;
}

/** Externe Untertitel neben der Videodatei: Film.de.srt, Film.deu.forced.srt, Film.en.sdh.ass … */
function externe_untertitel(string $video): array
{
    $ordner = dirname($video);
    $basis = pathinfo($video, PATHINFO_FILENAME);
    $aus = [];
    foreach (@scandir($ordner) ?: [] as $e) {
        $endung = strtolower(pathinfo($e, PATHINFO_EXTENSION));
        if (!in_array($endung, UNTERTITEL_ENDUNGEN, true) || !str_starts_with($e, $basis)) {
            continue;
        }
        $rest = strtolower(substr(pathinfo($e, PATHINFO_FILENAME), strlen($basis)));
        $teile = array_values(array_filter(explode('.', trim($rest, '. _-'))));
        $sprache = null;
        $erzwungen = 0;
        $sdh = 0;
        foreach ($teile as $t) {
            if (in_array($t, ['forced', 'erzwungen', 'foreign'], true)) {
                $erzwungen = 1;
            } elseif (in_array($t, ['sdh', 'cc', 'hi'], true)) {
                $sdh = 1;
            } elseif ($sprache === null) {
                $sprache = sprache3($t);
            }
        }
        $aus[] = ['pfad' => $ordner . '/' . $e, 'format' => $endung === 'sup' ? 'hdmv_pgs_subtitle' : $endung, 'sprache' => $sprache,
            'erzwungen' => $erzwungen, 'hoergeschaedigt' => $sdh];
    }
    return $aus;
}

// ---------- Datenbank ----------

function bibliothek_id(string $art, string $pfad): int
{
    $id = db_wert('SELECT id FROM bibliotheken WHERE art = :a AND pfad = :p', ['a' => $art, 'p' => $pfad]);
    if ($id) {
        return (int) $id;
    }
    return db_einfuegen('INSERT INTO bibliotheken (art, name, pfad) VALUES (:a, :n, :p)', ['a' => $art, 'n' => $art === 'filme' ? 'Filme' : 'Serien', 'p' => $pfad]);
}

/** Datei anlegen/aktualisieren; analysiert nur, wenn neu oder geändert. Liefert [id, neu_analysiert] */
function datei_merken(int $bib, string $pfad, ?int $fassungId, ?int $folgeId): array
{
    $hash = sha1($pfad, true);
    $groesse = (int) @filesize($pfad);
    $zeit = date('Y-m-d H:i:s', (int) @filemtime($pfad));
    $alt = db_zeile('SELECT id, groesse, geaendert, analysiert_am FROM dateien WHERE pfad_hash = :h', ['h' => $hash]);
    if ($alt) {
        db_tun('UPDATE dateien SET fehlt_seit = NULL, fassung_id = COALESCE(:fa, fassung_id), folge_id = COALESCE(:fo, folge_id) WHERE id = :id',
            ['fa' => $fassungId, 'fo' => $folgeId, 'id' => $alt['id']]);
        if ((int) $alt['groesse'] === $groesse && (string) $alt['geaendert'] === $zeit && $alt['analysiert_am'] !== null) {
            untertitel_extern_merken((int) $alt['id'], $pfad);
            return [(int) $alt['id'], false];
        }
        $id = (int) $alt['id'];
    } else {
        $id = db_einfuegen('INSERT INTO dateien (bibliothek_id, pfad, pfad_hash, groesse, geaendert, fassung_id, folge_id) VALUES (:b, :p, :h, :g, :z, :fa, :fo)',
            ['b' => $bib, 'p' => $pfad, 'h' => $hash, 'g' => $groesse, 'z' => $zeit, 'fa' => $fassungId, 'fo' => $folgeId]);
    }
    $a = datei_analysieren($pfad);
    if ($a === null) {
        db_tun('UPDATE dateien SET groesse = :g, geaendert = :z, analysiert_am = NOW() WHERE id = :id', ['g' => $groesse, 'z' => $zeit, 'id' => $id]);
        return [$id, true];
    }
    $v = $a['video'];
    db_tun('UPDATE dateien SET groesse = :g, geaendert = :z, container = :c, dauer_ms = :d, bitrate = :br, video_codec = :vc, video_profil = :vp,
        breite = :b, hoehe = :h, bittiefe = :bt, bildrate = :fps, hdr = :hdr, audio_codec = :ac, analysiert_am = NOW() WHERE id = :id', [
        'g' => $groesse, 'z' => $zeit, 'c' => $a['container'], 'd' => $a['dauer_ms'], 'br' => $a['bitrate'], 'vc' => $v['codec'], 'vp' => $v['profil'],
        'b' => $v['breite'], 'h' => $v['hoehe'], 'bt' => $v['bittiefe'], 'fps' => $v['bildrate'], 'hdr' => $v['hdr'],
        'ac' => $a['ton'][0]['codec'] ?? null, 'id' => $id,
    ]);
    db_tun('DELETE FROM tonspuren WHERE datei_id = :id', ['id' => $id]);
    foreach ($a['ton'] as $t) {
        db_tun('INSERT INTO tonspuren (datei_id, strom_index, codec, profil, sprache, kanaele, layout, titel, standard, kommentar)
            VALUES (:d, :i, :c, :p, :s, :k, :l, :t, :st, :ko)', ['d' => $id, 'i' => $t['strom_index'], 'c' => $t['codec'], 'p' => $t['profil'],
            's' => $t['sprache'], 'k' => $t['kanaele'], 'l' => $t['layout'], 't' => $t['titel'], 'st' => $t['standard'], 'ko' => $t['kommentar']]);
    }
    db_tun("DELETE FROM untertitel WHERE datei_id = :id AND quelle = 'eingebettet'", ['id' => $id]);
    foreach ($a['untertitel'] as $u) {
        db_tun("INSERT INTO untertitel (datei_id, quelle, strom_index, format, sprache, titel, erzwungen, hoergeschaedigt, standard)
            VALUES (:d, 'eingebettet', :i, :f, :s, :t, :e, :h, :st)", ['d' => $id, 'i' => $u['strom_index'], 'f' => $u['format'], 's' => $u['sprache'],
            't' => $u['titel'], 'e' => $u['erzwungen'], 'h' => $u['hoergeschaedigt'], 'st' => $u['standard']]);
    }
    untertitel_extern_merken($id, $pfad);
    return [$id, true];
}

function untertitel_extern_merken(int $dateiId, string $video): void
{
    $vorhanden = db_alle("SELECT id, pfad FROM untertitel WHERE datei_id = :d AND quelle = 'datei'", ['d' => $dateiId]);
    $gefunden = [];
    foreach (externe_untertitel($video) as $u) {
        $gefunden[$u['pfad']] = true;
        if (in_array($u['pfad'], array_column($vorhanden, 'pfad'), true)) {
            continue;
        }
        db_tun("INSERT INTO untertitel (datei_id, quelle, pfad, format, sprache, erzwungen, hoergeschaedigt) VALUES (:d, 'datei', :p, :f, :s, :e, :h)",
            ['d' => $dateiId, 'p' => $u['pfad'], 'f' => $u['format'], 's' => $u['sprache'], 'e' => $u['erzwungen'], 'h' => $u['hoergeschaedigt']]);
    }
    foreach ($vorhanden as $v) {
        if (!isset($gefunden[$v['pfad']])) {
            db_tun('DELETE FROM untertitel WHERE id = :id', ['id' => $v['id']]);
        }
    }
}

function fassung_finden_oder_anlegen(int $filmId, ?array $fassung): int
{
    [$art, $text] = $fassung ?? ['kino', FASSUNG_NAMEN['kino']];
    $id = db_wert('SELECT id FROM fassungen WHERE film_id = :f AND art = :a AND (art <> \'sonstige\' OR name = :n) ORDER BY id LIMIT 1', ['f' => $filmId, 'a' => $art, 'n' => $text]);
    if ($id) {
        return (int) $id;
    }
    $erste = !db_wert('SELECT id FROM fassungen WHERE film_id = :f', ['f' => $filmId]);
    return db_einfuegen('INSERT INTO fassungen (film_id, art, name, standard) VALUES (:f, :a, :n, :s)', ['f' => $filmId, 'a' => $art, 'n' => $text, 's' => (int) ($erste || $art === 'kino')]);
}

/** Fortschritt des laufenden Auftrags für die Oberfläche */
function auftrag_stand(string $schritt, int $fertig, int $gesamt, string $text = ''): void
{
    static $zuletzt = 0.0;
    if (microtime(true) - $zuletzt < 1.0 && $fertig < $gesamt) {
        return;
    }
    $zuletzt = microtime(true);
    $alt = json_decode((string) system_wert('auftrag'), true) ?: [];
    $alt['schritt'] = $schritt;
    $alt['fertig'] = $fertig;
    $alt['gesamt'] = $gesamt;
    $alt['text'] = $text;
    $alt['aktualisiert'] = date('c');
    system_wert_setzen('auftrag', (string) json_encode($alt, JSON_UNESCAPED_UNICODE));
}

/** Filme einlesen */
function filme_scannen(): array
{
    $wurzel = konfig()['pfade']['filme'];
    $bib = bibliothek_id('filme', $wurzel);
    $dateien = video_dateien($wurzel);
    $gesehen = [];
    $stat = ['dateien' => count($dateien), 'neu_analysiert' => 0, 'filme_neu' => 0];
    foreach ($dateien as $i => $pfad) {
        auftrag_stand('Filme einlesen', $i, count($dateien), basename($pfad));
        $rel = substr($pfad, strlen($wurzel) + 1);
        $ordner = dirname($rel) !== '.' ? basename(dirname($rel)) : '';
        $dateiname = pathinfo($pfad, PATHINFO_FILENAME);
        // Ordner „Titel (Jahr)“ hat Vorrang, sonst der Dateiname
        $nOrdner = $ordner !== '' ? film_name_deuten($ordner) : null;
        $nDatei = film_name_deuten($dateiname);
        $n = ($nOrdner && $nOrdner['jahr']) ? $nOrdner : ($nDatei['jahr'] ? $nDatei : ($nOrdner ?? $nDatei));
        $n['tmdb'] = $n['tmdb'] ?? $nDatei['tmdb'] ?? ($nOrdner['tmdb'] ?? null);
        if ($n['titel'] === '') {
            continue;
        }
        $schluessel = titel_schluessel($n['titel']) . '|' . ($n['jahr'] ?? '');
        $fassung = fassung_erkennen($dateiname) ?? ($ordner !== '' ? fassung_erkennen($ordner) : null);

        $hashAlt = db_zeile('SELECT d.id, f.film_id FROM dateien d LEFT JOIN fassungen f ON f.id = d.fassung_id WHERE d.pfad_hash = :h', ['h' => sha1($pfad, true)]);
        $filmId = $hashAlt['film_id'] ?? null;
        if (!$filmId && $n['tmdb']) {
            $filmId = db_wert('SELECT id FROM filme WHERE tmdb_id = :t', ['t' => $n['tmdb']]);
        }
        if (!$filmId) {
            $filmId = db_wert('SELECT id FROM filme WHERE ordner_titel = :s', ['s' => $schluessel]);
        }
        if (!$filmId) {
            $filmId = db_einfuegen('INSERT INTO filme (titel, sortiertitel, jahr, ordner_titel, tmdb_id, imdb_id) VALUES (:t, :s, :j, :o, :tm, :im)', [
                't' => $n['titel'], 's' => sortiertitel($n['titel']), 'j' => $n['jahr'], 'o' => $schluessel,
                'tm' => $n['tmdb'] && !db_wert('SELECT id FROM filme WHERE tmdb_id = :t', ['t' => $n['tmdb']]) ? $n['tmdb'] : null, 'im' => $n['imdb'],
            ]);
            $stat['filme_neu']++;
        }
        // vorhandene Datei behält ihre (evtl. von Hand korrigierte) Fassung
        $fassungId = $hashAlt && $hashAlt['film_id'] ? null : fassung_finden_oder_anlegen((int) $filmId, $fassung);
        [, $neu] = datei_merken($bib, $pfad, $fassungId, null);
        if ($fassung) {
            db_tun('UPDATE dateien SET fassung_text = :t WHERE pfad_hash = :h', ['t' => $fassung[1], 'h' => sha1($pfad, true)]);
        }
        $stat['neu_analysiert'] += (int) $neu;
        $gesehen[] = sha1($pfad, true);
    }
    $stat['fehlen'] = dateien_als_fehlend($bib, $gesehen);
    return $stat;
}

/** Serien einlesen */
function serien_scannen(): array
{
    $wurzel = konfig()['pfade']['serien'];
    $bib = bibliothek_id('serien', $wurzel);
    $dateien = video_dateien($wurzel);
    $gesehen = [];
    $stat = ['dateien' => count($dateien), 'neu_analysiert' => 0, 'serien_neu' => 0, 'ohne_nummer' => 0];
    $serienCache = [];
    foreach ($dateien as $i => $pfad) {
        auftrag_stand('Serien einlesen', $i, count($dateien), basename($pfad));
        $rel = substr($pfad, strlen($wurzel) + 1);
        $teile = explode('/', $rel);
        if (count($teile) < 2) {
            continue; // Folgen müssen in einem Serienordner liegen
        }
        $serienOrdner = $wurzel . '/' . $teile[0];
        $nr = folge_deuten(implode('/', array_slice($teile, 1)));
        if ($nr === null) {
            $stat['ohne_nummer']++;
            continue;
        }
        if (!isset($serienCache[$serienOrdner])) {
            $sid = db_wert('SELECT id FROM serien WHERE ordner_pfad = :p', ['p' => $serienOrdner]);
            if (!$sid) {
                $n = serie_name_deuten($teile[0]);
                $sid = $n['tmdb'] ? db_wert('SELECT id FROM serien WHERE tmdb_id = :t', ['t' => $n['tmdb']]) : null;
                if ($sid) {
                    db_tun('UPDATE serien SET ordner_pfad = :p WHERE id = :id', ['p' => $serienOrdner, 'id' => $sid]);
                } else {
                    $sid = db_einfuegen('INSERT INTO serien (titel, sortiertitel, jahr_von, ordner_pfad, tmdb_id, tvdb_id) VALUES (:t, :s, :j, :p, :tm, :tv)', [
                        't' => $n['titel'], 's' => sortiertitel($n['titel']), 'j' => $n['jahr'], 'p' => $serienOrdner, 'tm' => $n['tmdb'], 'tv' => $n['tvdb'],
                    ]);
                    $stat['serien_neu']++;
                }
            }
            $serienCache[$serienOrdner] = (int) $sid;
        }
        $sid = $serienCache[$serienOrdner];
        $fid = db_wert('SELECT id FROM folgen WHERE serie_id = :s AND staffel_nr = :st AND folge_nr = :f', ['s' => $sid, 'st' => $nr[0], 'f' => $nr[1]]);
        if (!$fid) {
            $fid = db_einfuegen('INSERT INTO folgen (serie_id, staffel_nr, folge_nr) VALUES (:s, :st, :f)', ['s' => $sid, 'st' => $nr[0], 'f' => $nr[1]]);
        }
        [, $neu] = datei_merken($bib, $pfad, null, (int) $fid);
        $stat['neu_analysiert'] += (int) $neu;
        $gesehen[] = sha1($pfad, true);
    }
    $stat['fehlen'] = dateien_als_fehlend($bib, $gesehen);
    return $stat;
}

/** Dateien dieser Bibliothek, die nicht mehr da sind, als fehlend markieren (nicht löschen – Fortschritt bleibt erhalten) */
function dateien_als_fehlend(int $bib, array $gesehen): int
{
    $set = array_flip(array_map('bin2hex', $gesehen));
    $n = 0;
    foreach (db_alle('SELECT id, pfad_hash FROM dateien WHERE bibliothek_id = :b AND fehlt_seit IS NULL', ['b' => $bib]) as $d) {
        if (!isset($set[bin2hex($d['pfad_hash'])])) {
            db_tun('UPDATE dateien SET fehlt_seit = NOW() WHERE id = :id', ['id' => $d['id']]);
            $n++;
        }
    }
    // Wurzelordner nicht erreichbar (z. B. Freigabe nicht eingehängt)? Dann nichts als fehlend werten – nur Hinweis.
    return $n;
}

function bibliothek_scannen(): array
{
    $e = [];
    foreach (['filme' => 'filme_scannen', 'serien' => 'serien_scannen'] as $art => $fn) {
        $wurzel = konfig()['pfade'][$art];
        if (!is_dir($wurzel) || !(@scandir($wurzel))) {
            $e[$art] = ['fehler' => 'Ordner nicht erreichbar: ' . $wurzel];
            continue;
        }
        $e[$art] = $fn();
    }
    db_tun('UPDATE bibliotheken SET letzter_scan = NOW()');
    system_wert_setzen('letzter_scan', date('c'));
    return $e;
}
