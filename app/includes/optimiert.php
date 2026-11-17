<?php
// Optimierte Fassungen: vorab umgewandelte Kopien (1080p bzw. 720p H.264 + alle Tonspuren als AAC Stereo, MP4 mit Index vorn).
// Gedacht für unterwegs: statt live umzuwandeln, spielt der Browser die Kopie direkt – Start und Spulen sofort.
// Erzeugt im Hintergrund (scripts/vorarbeit.php), angehalten, solange jemand schaut.
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/encoder.php';
require_once __DIR__ . '/hardware.php';

const OPTIMIERT_STUFEN = [1080 => 8000, 720 => 4000];

function optimiert_ordner(): string
{
    return konfig()['pfade']['optimiert'];
}

/** Dateien eines Ziels: Film (beste Datei jeder Fassung), Serie, Staffel oder einzelne Datei */
function optimiert_dateien(string $art, int $id, ?int $staffel = null): array
{
    return match ($art) {
        'film' => db_alle('SELECT d.* FROM dateien d JOIN fassungen fa ON fa.id = d.fassung_id WHERE fa.film_id = :f AND d.fehlt_seit IS NULL
            AND d.hoehe = (SELECT MAX(d2.hoehe) FROM dateien d2 WHERE d2.fassung_id = d.fassung_id AND d2.fehlt_seit IS NULL)', ['f' => $id]),
        'serie' => db_alle('SELECT d.* FROM dateien d JOIN folgen fo ON fo.id = d.folge_id WHERE fo.serie_id = :s AND d.fehlt_seit IS NULL'
            . ($staffel !== null ? ' AND fo.staffel_nr = :st' : ''), ['s' => $id] + ($staffel !== null ? ['st' => $staffel] : [])),
        'datei' => db_alle('SELECT * FROM dateien WHERE id = :d AND fehlt_seit IS NULL', ['d' => $id]),
        default => [],
    };
}

/** In die Warteschlange; Dateien, die schon klein genug sind, werden übersprungen. Liefert [neu, übersprungen] */
function optimiert_einreihen(string $art, int $id, int $hoehe, ?int $staffel = null): array
{
    if (!isset(OPTIMIERT_STUFEN[$hoehe])) {
        throw new InvalidArgumentException('Unbekannte Stufe.');
    }
    $neu = 0;
    $ueber = 0;
    foreach (optimiert_dateien($art, $id, $staffel) as $d) {
        // schon klein, H.264 und Ton, den jeder Browser kann? Dann bringt eine Kopie nichts
        $tonOk = !db_wert("SELECT COUNT(*) FROM tonspuren WHERE datei_id = :d AND LOWER(codec) NOT IN ('aac', 'mp3')", ['d' => $d['id']]);
        if ($tonOk && (int) $d['hoehe'] <= $hoehe + 40 && strtolower((string) $d['video_codec']) === 'h264' && (int) $d['bitrate'] <= OPTIMIERT_STUFEN[$hoehe] * 1300) {
            $ueber++;
            continue;
        }
        $n = db_tun("INSERT INTO optimiert (datei_id, hoehe, bitrate_k, status) VALUES (:d, :h, :b, 'wartet')
            ON DUPLICATE KEY UPDATE status = IF(status = 'fehler', 'wartet', status), fehler = IF(status = 'wartet', NULL, fehler)",
            ['d' => $d['id'], 'h' => $hoehe, 'b' => OPTIMIERT_STUFEN[$hoehe]]);
        $neu += $n > 0 ? 1 : 0;
    }
    return [$neu, $ueber];
}

function optimiert_liste(): array
{
    $zeilen = db_alle("SELECT o.*, d.pfad AS quelle, d.hoehe AS quelle_hoehe, d.folge_id, d.fassung_id,
            COALESCE(f.titel, CONCAT(s.titel, ' · S', LPAD(fo.staffel_nr, 2, '0'), 'E', LPAD(fo.folge_nr, 2, '0'))) AS titel
        FROM optimiert o JOIN dateien d ON d.id = o.datei_id
        LEFT JOIN fassungen fa ON fa.id = d.fassung_id LEFT JOIN filme f ON f.id = fa.film_id
        LEFT JOIN folgen fo ON fo.id = d.folge_id LEFT JOIN serien s ON s.id = fo.serie_id
        ORDER BY FIELD(o.status, 'laeuft', 'wartet', 'fehler', 'fertig'), o.erstellt_am, o.id");
    return array_map(static fn($o) => [
        'id' => (int) $o['id'], 'datei_id' => (int) $o['datei_id'], 'titel' => $o['titel'] ?? basename((string) $o['quelle']), 'hoehe' => (int) $o['hoehe'],
        'status' => $o['status'], 'fortschritt' => (float) $o['fortschritt'], 'groesse' => $o['groesse'] !== null ? (int) $o['groesse'] : null,
        'fehler' => $o['fehler'], 'fertig_am' => $o['fertig_am'], 'quelle_hoehe' => (int) $o['quelle_hoehe'],
    ], $zeilen);
}

function optimiert_loeschen(int $oid): void
{
    $o = db_zeile('SELECT * FROM optimiert WHERE id = :id', ['id' => $oid]);
    if (!$o) {
        return;
    }
    if ($o['status'] === 'laeuft') {
        // der Arbeiter merkt das (Zeile weg) und bricht ab
        @touch(optimiert_ordner() . '/.abbruch-' . $oid);
    }
    if ($o['pfad'] && str_starts_with((string) $o['pfad'], optimiert_ordner() . '/')) {
        @unlink((string) $o['pfad']);
    }
    db_tun('DELETE FROM optimiert WHERE id = :id', ['id' => $oid]);
}

/** Fertige optimierte Fassungen einer Datei (die Datei liegt noch da) */
function optimiert_fuer_datei(int $dateiId): array
{
    $aus = [];
    foreach (db_alle("SELECT * FROM optimiert WHERE datei_id = :d AND status = 'fertig' ORDER BY hoehe DESC", ['d' => $dateiId]) as $o) {
        if ($o['pfad'] && is_file((string) $o['pfad'])) {
            $aus[] = $o;
        }
    }
    return $aus;
}

/**
 * Eine optimierte Fassung als „Datei“ für die Wiedergabe-Entscheidung: gleiche Länge und Tonspur-Reihenfolge wie das Original,
 * aber MP4, H.264 8 Bit SDR und Ton AAC Stereo.
 */
function optimiert_als_datei(array $original, array $o): array
{
    $d = $original;
    $d['pfad'] = $o['pfad'];
    $d['container'] = 'mp4';
    $d['video_codec'] = 'h264';
    // nie hochgerechnet: echte Höhe = Stufe oder kleiner
    $d['hoehe'] = min((int) $o['hoehe'], (int) $original['hoehe']);
    $d['breite'] = (int) ($o['breite'] ?: round((int) $original['breite'] * $d['hoehe'] / max(1, (int) $original['hoehe'])));
    $d['bittiefe'] = 8;
    $d['hdr'] = 'sdr';
    $d['bitrate'] = ((int) $o['bitrate_k'] + 160) * 1000;
    $d['groesse'] = (int) $o['groesse'];
    return $d;
}

function optimiert_als_ton(array $ton): array
{
    return array_map(static fn($t) => ['codec' => 'aac', 'kanaele' => min(2, max(1, (int) $t['kanaele']))] + $t, $ton);
}

/**
 * Umwandeln. $weiter(float $anteil): ?bool – false = abbrechen; null = pausieren (ffmpeg wird angehalten, bis wieder true kommt).
 * Liefert true (fertig) / false (abgebrochen); wirft bei Fehlern.
 */
function optimiert_umwandeln(array $o, array $datei, callable $weiter): bool
{
    $hw = hw_lesen() ?? hw_erkennen();
    $profil = (string) $hw['aktiv'];
    $dek = $hw['quicksync']['dekodieren'] ?? [];
    $vc = strtolower((string) $datei['video_codec']);
    $hwDek = match ($vc) {
        'h264' => !empty($dek['h264']) && (int) $datei['bittiefe'] <= 8,
        'hevc' => (int) $datei['bittiefe'] > 8 ? !empty($dek['hevc10']) : !empty($dek['hevc']),
        'av1' => !empty($dek['av1']), 'vp9' => (int) $datei['bittiefe'] > 8 ? !empty($dek['vp9_10']) : !empty($dek['vp9']),
        default => false,
    };
    @mkdir(optimiert_ordner(), 0775, true);
    $ziel = sprintf('%s/%d-%dp.mp4', optimiert_ordner(), (int) $datei['id'], (int) $o['hoehe']);
    $tmp = $ziel . '.entsteht.mp4';
    $tonAnzahl = (int) db_wert('SELECT COUNT(*) FROM tonspuren WHERE datei_id = :d', ['d' => $datei['id']]);
    $auftrag = [
        'eingabe' => $datei['pfad'],
        'quelle' => ['breite' => (int) $datei['breite'], 'hoehe' => (int) $datei['hoehe'], 'hdr' => ($datei['hdr'] ?? 'sdr') !== 'sdr', 'hw_dekodieren' => $hwDek],
        'video' => ['codec' => 'h264', 'hoehe' => (int) $o['hoehe'], 'bitrate_k' => (int) $o['bitrate_k'], 'tonemap' => true],
        'audio' => null,
        // Schlüsselbild alle 2 s: Spulen landet schnell und genau
        'schluesselbilder' => 'expr:gte(t,n_forced*2)',
        'ziel' => ['format' => 'mp4', 'datei' => $tmp],
    ];
    $cmd = encoder_befehl($profil, $auftrag, $hw);
    // alle Tonspuren als AAC Stereo (gleiche Reihenfolge wie im Original) statt -an
    $i = array_search('-an', $cmd, true);
    $ton = [];
    if ($tonAnzahl > 0) {
        $ton = ['-map', '0:a?', '-c:a', 'aac', '-ac', '2', '-b:a', '160k'];
    }
    array_splice($cmd, $i === false ? count($cmd) - 3 : $i, $i === false ? 0 : 1, $ton ?: ['-an']);
    // Fortschritt maschinenlesbar auf stdout
    array_splice($cmd, 1, 0, ['-progress', 'pipe:1', '-nostats']);
    $p = proc_open($cmd, [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $rohre);
    if (!is_resource($p)) {
        throw new RuntimeException('ffmpeg startet nicht');
    }
    stream_set_blocking($rohre[1], false);
    stream_set_blocking($rohre[2], false);
    $dauer = max(1, (int) $datei['dauer_ms'] / 1000);
    $fehler = '';
    $puffer = '';
    $anteil = 0.0;
    $pause = false;
    $abgebrochen = false;
    $pid = (int) proc_get_status($p)['pid'];
    while (true) {
        $r = [$rohre[1], $rohre[2]];
        $x = $y = null;
        if (@stream_select($r, $x, $y, 1, 0) > 0) {
            foreach ($r as $rohr) {
                $teil = (string) fread($rohr, 65536);
                if ($rohr === $rohre[2]) {
                    $fehler = substr($fehler . $teil, -4000);
                } else {
                    $puffer .= $teil;
                    while (($nl = strpos($puffer, "\n")) !== false) {
                        $zeile = substr($puffer, 0, $nl);
                        $puffer = substr($puffer, $nl + 1);
                        if (preg_match('/^out_time_us=(\d+)/', $zeile, $m)) {
                            $anteil = min(0.999, ((int) $m[1] / 1e6) / $dauer);
                        }
                    }
                }
            }
        }
        if (!proc_get_status($p)['running']) {
            break;
        }
        $w = $weiter($anteil);
        if ($w === false) {
            $abgebrochen = true;
            @posix_kill($pid, SIGCONT);
            proc_terminate($p, 9);
            break;
        }
        if ($w === null && !$pause) {
            @posix_kill($pid, SIGSTOP);
            $pause = true;
        } elseif ($w === true && $pause) {
            @posix_kill($pid, SIGCONT);
            $pause = false;
        }
    }
    fclose($rohre[1]);
    fclose($rohre[2]);
    $code = proc_close($p);
    if ($abgebrochen) {
        @unlink($tmp);
        return false;
    }
    if ($code !== 0 || !is_file($tmp) || filesize($tmp) < 1000) {
        @unlink($tmp);
        throw new RuntimeException('ffmpeg: ' . mb_substr(trim($fehler), -500));
    }
    rename($tmp, $ziel);
    [$b] = encoder_zielmasse((int) $datei['breite'], (int) $datei['hoehe'], (int) $o['hoehe']);
    db_tun("UPDATE optimiert SET status = 'fertig', fortschritt = 100, pfad = :p, groesse = :g, breite = :b, fehler = NULL, fertig_am = NOW() WHERE id = :id",
        ['p' => $ziel, 'g' => filesize($ziel), 'b' => $b ?: null, 'id' => $o['id']]);
    return true;
}
