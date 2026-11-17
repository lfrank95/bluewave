<?php
// Segmentierer: startet ffmpeg (fragmentiertes MP4 auf stdout) und schneidet den Strom in HLS-Teile.
//   php scripts/segmentierer.php <lauf.json>
//
// Warum nicht ffmpegs eigener HLS-Muxer? Der sammelt jeden Teil komplett im Speicher und schreibt ihn erst am Ende –
// so lässt sich ein Teil nicht ausliefern, während er entsteht. Hier landet jedes ~1-s-Fragment sofort in der Datei
// (teil_NNNNN.m4s.<sitzung>.part); der Server kann den wachsenden Teil schon durchreichen. Fertig heißt umbenennen.
//
// Teilgrenzen: Ein Teil beginnt mit dem ersten Fragment, das mit einem Schlüsselbild anfängt und dessen Zeit (tfdt,
// echte Filmzeit dank -copyts) die nächste Rastergrenze erreicht. Beim Umwandeln erzwingt ffmpeg genau dort Schlüsselbilder,
// bei unverändertem Video liegt das Raster auf den Schlüsselbildern der Quelle.
declare(strict_types=1);
require_once __DIR__ . '/../includes/config.php';

$lauf = json_decode((string) @file_get_contents($argv[1] ?? ''), true);
if (!is_array($lauf) || empty($lauf['cmd'])) {
    fwrite(STDERR, "Segmentierer: Auftrag fehlt\n");
    exit(2);
}
@set_time_limit(0);
$ordner = rtrim((string) $lauf['ordner'], '/');
$sid = (string) $lauf['sitzung'];
$grenzen = array_map('floatval', (array) $lauf['grenzen']);
$teile = count($grenzen);
$aktuell = (int) $lauf['start'];
$statusDatei = (string) $lauf['status'];
$generation = (int) $lauf['generation'];
$limit = (int) ($lauf['limit_bytes'] ?? 0);
$versatz = (float) ($lauf['versatz'] ?? 0); // Medienzeit = Filmzeit + Versatz

function status_schreiben(array $s): void
{
    global $statusDatei, $generation;
    $s['generation'] = $generation;
    $s['t'] = microtime(true);
    $tmp = $statusDatei . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, json_encode($s)) !== false) {
        @rename($tmp, $statusDatei);
    }
}

function teil_pfad(int $n): string
{
    global $ordner;
    return sprintf('%s/teil_%05d.m4s', $ordner, $n);
}

function part_pfad(int $n): string
{
    global $sid;
    return teil_pfad($n) . '.' . $sid . '.part';
}

// ---------- kleine MP4-Box-Helfer ----------
/** Kind-Boxen in $d zwischen $von und $bis: [typ, inhaltStart, inhaltEnde] */
function boxen(string $d, int $von, int $bis): array
{
    $aus = [];
    $i = $von;
    while ($i + 8 <= $bis) {
        $groesse = unpack('N', $d, $i)[1];
        $typ = substr($d, $i + 4, 4);
        $kopf = 8;
        if ($groesse === 1) {
            if ($i + 16 > $bis) {
                break;
            }
            $groesse = unpack('J', $d, $i + 8)[1];
            $kopf = 16;
        } elseif ($groesse === 0) {
            $groesse = $bis - $i;
        }
        if ($groesse < $kopf || $i + $groesse > $bis) {
            break;
        }
        $aus[] = [$typ, $i + $kopf, $i + $groesse];
        $i += $groesse;
    }
    return $aus;
}

function kind(string $d, int $von, int $bis, string $typ): ?array
{
    foreach (boxen($d, $von, $bis) as $b) {
        if ($b[0] === $typ) {
            return $b;
        }
    }
    return null;
}

/** moov auswerten: Video-Spur (ID, Zeitbasis) und Standard-Flags je Spur (trex) */
function moov_lesen(string $d, int $von, int $bis): array
{
    $info = ['video' => null, 'skala' => [], 'trex_flags' => []];
    foreach (boxen($d, $von, $bis) as [$typ, $a, $e]) {
        if ($typ === 'trak') {
            $tkhd = kind($d, $a, $e, 'tkhd');
            $mdia = kind($d, $a, $e, 'mdia');
            if (!$tkhd || !$mdia) {
                continue;
            }
            $v = ord($d[$tkhd[1]]);
            $id = unpack('N', $d, $tkhd[1] + ($v === 1 ? 20 : 12))[1];
            $mdhd = kind($d, $mdia[1], $mdia[2], 'mdhd');
            $hdlr = kind($d, $mdia[1], $mdia[2], 'hdlr');
            if ($mdhd) {
                $mv = ord($d[$mdhd[1]]);
                $info['skala'][$id] = unpack('N', $d, $mdhd[1] + ($mv === 1 ? 20 : 12))[1];
            }
            if ($hdlr && substr($d, $hdlr[1] + 8, 4) === 'vide' && $info['video'] === null) {
                $info['video'] = $id;
            }
        } elseif ($typ === 'mvex') {
            foreach (boxen($d, $a, $e) as [$t2, $a2]) {
                if ($t2 === 'trex') {
                    $info['trex_flags'][unpack('N', $d, $a2 + 4)[1]] = unpack('N', $d, $a2 + 20)[1];
                }
            }
        }
    }
    return $info;
}

/** moof auswerten: Anzeigezeit des ersten Bildes (Sekunden) und ob es ein Schlüsselbild ist */
function moof_lesen(string $d, int $von, int $bis, array $moov): array
{
    $ergebnis = ['zeit' => null, 'schluessel' => false, 'video' => false];
    foreach (boxen($d, $von, $bis) as [$typ, $a, $e]) {
        if ($typ !== 'traf') {
            continue;
        }
        $tfhd = kind($d, $a, $e, 'tfhd');
        if (!$tfhd) {
            continue;
        }
        $tfFlags = unpack('N', $d, $tfhd[1])[1] & 0xFFFFFF;
        $spur = unpack('N', $d, $tfhd[1] + 4)[1];
        $video = $moov['video'] === null || $spur === $moov['video'];
        if (!$video && $ergebnis['zeit'] !== null) {
            continue;
        }
        $p = $tfhd[1] + 8;
        if ($tfFlags & 0x01) {
            $p += 8;
        }
        if ($tfFlags & 0x02) {
            $p += 4;
        }
        if ($tfFlags & 0x08) {
            $p += 4;
        }
        if ($tfFlags & 0x10) {
            $p += 4;
        }
        $standard = ($tfFlags & 0x20) ? unpack('N', $d, $p)[1] : ($moov['trex_flags'][$spur] ?? 0);
        $tfdt = kind($d, $a, $e, 'tfdt');
        $zeit = null;
        if ($tfdt) {
            $v = ord($d[$tfdt[1]]);
            $zeit = $v === 1 ? unpack('J', $d, $tfdt[1] + 4)[1] : unpack('N', $d, $tfdt[1] + 4)[1];
        }
        $erstesFlags = $standard;
        $cto = 0; // Kompositionsversatz des ersten Bildes: Anzeigezeit = Dekodierzeit + Versatz (B-Frames)
        $trun = kind($d, $a, $e, 'trun');
        if ($trun) {
            $trVersion = ord($d[$trun[1]]);
            $trFlags = unpack('N', $d, $trun[1])[1] & 0xFFFFFF;
            $q = $trun[1] + 8;
            if ($trFlags & 0x01) {
                $q += 4;
            }
            if ($trFlags & 0x04) {
                $erstesFlags = unpack('N', $d, $q)[1];
                $q += 4;
            }
            // erstes Sample: [Dauer][Größe][Flags][Versatz]
            $r = $q + (($trFlags & 0x100) ? 4 : 0) + (($trFlags & 0x200) ? 4 : 0);
            if ($trFlags & 0x400) {
                if (!($trFlags & 0x04)) {
                    $erstesFlags = unpack('N', $d, $r)[1];
                }
                $r += 4;
            }
            if (($trFlags & 0x800) && $r + 4 <= $e) {
                $cto = unpack('N', $d, $r)[1];
                if ($trVersion === 1 && $cto >= 0x80000000) {
                    $cto -= 0x100000000;
                }
            }
        }
        if ($zeit !== null) {
            $zeit = ($zeit + $cto) / max(1, $moov['skala'][$spur] ?? 1000);
        }
        if ($video) {
            // sample_is_non_sync_sample (Bit 16) nicht gesetzt = Schlüsselbild
            $ergebnis = ['zeit' => $zeit, 'schluessel' => (($erstesFlags >> 16) & 1) === 0, 'video' => true];
        } elseif ($ergebnis['zeit'] === null) {
            $ergebnis['zeit'] = $zeit;
        }
    }
    return $ergebnis;
}

// ---------- Teile schreiben ----------
$fh = null;          // offene .part-Datei des aktuellen Teils
$fertigeTeile = 0;

function teil_oeffnen(int $n): void
{
    global $fh;
    $fh = fopen(part_pfad($n), 'wb');
    if (!$fh) {
        throw new RuntimeException('Kann ' . part_pfad($n) . ' nicht schreiben');
    }
}

function teil_abschliessen(int $n): void
{
    global $fh, $fertigeTeile, $limit;
    if (!$fh) {
        return;
    }
    fclose($fh);
    $fh = null;
    @rename(part_pfad($n), teil_pfad($n));
    $fertigeTeile++;
    status_schreiben(['kopf' => $n, 'schreibt' => $n + 1, 'laeuft' => true]);
    if ($limit > 0 && $fertigeTeile % 10 === 0) {
        require_once __DIR__ . '/../includes/hls.php';
        hls_zwischenspeicher_aufraeumen($limit);
    }
}

/** Index des Teils, zu dem die Zeit $t gehört */
function teil_fuer_zeit(float $t): int
{
    global $grenzen;
    $lo = 0;
    $hi = count($grenzen) - 1;
    while ($lo < $hi) {
        $mid = intdiv($lo + $hi + 1, 2);
        if ($grenzen[$mid] <= $t + 0.05) {
            $lo = $mid;
        } else {
            $hi = $mid - 1;
        }
    }
    return $lo;
}

// ---------- ffmpeg starten ----------
$proc = proc_open($lauf['cmd'], [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', (string) $lauf['log'], 'w']], $pipes);
if (!is_resource($proc)) {
    status_schreiben(['kopf' => $aktuell - 1, 'schreibt' => $aktuell, 'laeuft' => false, 'fehler' => 'ffmpeg startet nicht']);
    exit(1);
}
status_schreiben(['kopf' => $aktuell - 1, 'schreibt' => $aktuell, 'laeuft' => true]);
$aus = $pipes[1];
$puffer = '';
$init = '';
$moov = null;
$fragment = null;   // [zeit, schluessel] des gerade gelesenen moof (wartet auf sein mdat)
$moofBytes = '';
$fehler = null;

try {
    while (true) {
        $stueck = fread($aus, 1 << 20);
        if ($stueck === false || ($stueck === '' && feof($aus))) {
            break;
        }
        if ($stueck === '') {
            continue;
        }
        $puffer .= $stueck;
        // vollständige Boxen abarbeiten
        while (strlen($puffer) >= 8) {
            $groesse = unpack('N', $puffer, 0)[1];
            $kopf = 8;
            if ($groesse === 1) {
                if (strlen($puffer) < 16) {
                    break;
                }
                $groesse = unpack('J', $puffer, 8)[1];
                $kopf = 16;
            }
            if ($groesse < $kopf) {
                throw new RuntimeException('Ungültige Box im Strom');
            }
            if (strlen($puffer) < $groesse) {
                break;
            }
            $typ = substr($puffer, 4, 4);
            $box = substr($puffer, 0, $groesse);
            $puffer = (string) substr($puffer, $groesse);

            if ($moov === null) {
                // Kopf: ftyp (+ ggf. free) + moov = init.mp4
                $init .= $box;
                if ($typ === 'moov') {
                    $moov = moov_lesen($box, $kopf, strlen($box));
                    $ziel = $ordner . '/init.mp4';
                    if (!is_file($ziel) || filesize($ziel) === 0) {
                        $tmp = $ziel . '.' . $sid . '.tmp';
                        file_put_contents($tmp, $init);
                        @rename($tmp, $ziel);
                    }
                    teil_oeffnen($aktuell);
                    status_schreiben(['kopf' => $aktuell - 1, 'schreibt' => $aktuell, 'laeuft' => true, 'init' => true]);
                }
                continue;
            }
            if ($typ === 'moof') {
                $f = moof_lesen($box, $kopf, strlen($box), $moov);
                if ($f['zeit'] !== null) {
                    $f['zeit'] -= $versatz;
                }
                // Grenze erreicht? (nur an einem Schlüsselbild schneiden)
                if ($f['video'] && $f['zeit'] !== null && $f['schluessel'] && $aktuell + 1 < $teile && $f['zeit'] >= $grenzen[$aktuell + 1] - 0.05) {
                    $neu = teil_fuer_zeit($f['zeit']);
                    teil_abschliessen($aktuell);
                    if ($neu > $aktuell + 1) {
                        fwrite(STDERR, date('c') . " Lücke: Teil $aktuell → $neu (Zeit {$f['zeit']})\n");
                    }
                    $aktuell = max($aktuell + 1, $neu);
                    teil_oeffnen($aktuell);
                    status_schreiben(['kopf' => $aktuell - 1, 'schreibt' => $aktuell, 'laeuft' => true]);
                }
                $moofBytes = $box;
                continue;
            }
            if ($typ === 'mdat') {
                // moof + mdat zusammen schreiben: Leser sehen immer ganze Fragmente
                fwrite($fh, $moofBytes . $box);
                fflush($fh);
                $moofBytes = '';
                continue;
            }
            // andere Boxen (mfra, free …) gehören nicht in die Teile
        }
    }
} catch (Throwable $e) {
    $fehler = $e->getMessage();
}
fclose($aus);
$code = proc_close($proc);
if ($fehler === null && $code === 0 && $fh) {
    // Datei zu Ende: letzten Teil abschließen
    teil_abschliessen($aktuell);
    status_schreiben(['kopf' => $aktuell, 'schreibt' => null, 'laeuft' => false, 'ende' => true]);
} else {
    if ($fh) {
        fclose($fh);
        @unlink(part_pfad($aktuell));
    }
    $log = trim((string) @file_get_contents((string) $lauf['log']));
    status_schreiben(['kopf' => $aktuell - 1, 'schreibt' => null, 'laeuft' => false,
        'fehler' => $fehler ?? ('ffmpeg beendet mit Code ' . $code . ($log !== '' ? ': ' . mb_substr($log, -400) : ''))]);
    exit(1);
}
