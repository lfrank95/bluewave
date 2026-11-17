<?php
// Schlüsselbilder einer Videodatei aus ihrem Inhaltsverzeichnis lesen – ohne die Datei durchzugehen (bei 60 GB undenkbar):
//   MKV/WebM: Cues (Matroska-Index, Zeiten der Video-Schlüsselbilder)
//   MP4/MOV:  stss (Sync-Samples) + stts/ctts + Edit-Liste der Videospur
// Ergebnis: Anzeigezeiten in Sekunden, aufsteigend. Wird je Datei (Pfad, Größe, Änderungszeit) im Cache gemerkt.
// Gebraucht fürs Umwandeln mit unverändertem Video: Teile lassen sich nur an Schlüsselbildern schneiden.
declare(strict_types=1);
require_once __DIR__ . '/config.php';

function schluesselbilder(string $pfad, ?string $container = null): ?array
{
    $st = @stat($pfad);
    if (!$st) {
        return null;
    }
    $ordner = konfig()['pfade']['cache'] . '/schluesselbilder';
    $merk = $ordner . '/' . sha1($pfad . '|' . $st['size'] . '|' . $st['mtime']) . '.json';
    if (is_file($merk)) {
        $z = json_decode((string) file_get_contents($merk), true);
        return is_array($z) ? ($z ?: null) : null;
    }
    $container = strtolower($container ?? pathinfo($pfad, PATHINFO_EXTENSION));
    try {
        $zeiten = match (true) {
            in_array($container, ['mkv', 'webm', 'matroska'], true) => sb_matroska($pfad),
            in_array($container, ['mp4', 'm4v', 'mov'], true) => sb_mp4($pfad),
            default => null,
        };
    } catch (Throwable $e) {
        $zeiten = null;
    }
    if ($zeiten !== null) {
        $zeiten = array_values(array_unique(array_map(static fn($t) => round((float) $t, 3), $zeiten)));
        sort($zeiten);
        // ein Inhaltsverzeichnis mit fast nichts darin taugt nicht (z. B. nur ein Eintrag am Anfang)
        if (count($zeiten) < 2) {
            $zeiten = null;
        }
    }
    @mkdir($ordner, 0775, true);
    @file_put_contents($merk, json_encode($zeiten ?? []));
    return $zeiten;
}

// ---------- Matroska ----------

/** EBML-Zahl (VINT) ab $p in $d: [Wert, Länge]; $id = true behält das Längenbit (Element-IDs) */
function sb_vint(string $d, int $p, bool $id = false): ?array
{
    if ($p >= strlen($d)) {
        return null;
    }
    $erstes = ord($d[$p]);
    $laenge = 1;
    $maske = 0x80;
    while ($laenge <= 8 && !($erstes & $maske)) {
        $laenge++;
        $maske >>= 1;
    }
    if ($laenge > 8 || $p + $laenge > strlen($d)) {
        return null;
    }
    $wert = $id ? $erstes : ($erstes & ($maske - 1));
    $alleEins = ($erstes & ($maske - 1)) === $maske - 1;
    for ($i = 1; $i < $laenge; $i++) {
        $b = ord($d[$p + $i]);
        $wert = ($wert << 8) | $b;
        $alleEins = $alleEins && $b === 0xFF;
    }
    if (!$id && $alleEins) {
        $wert = -1; // unbekannte Größe
    }
    return [$wert, $laenge];
}

/** Elementkopf ab Dateiposition: [id, datenStart, groesse] */
function sb_kopf($fh, int $pos): ?array
{
    fseek($fh, $pos);
    $d = (string) fread($fh, 12);
    $id = sb_vint($d, 0, true);
    if (!$id) {
        return null;
    }
    $gr = sb_vint($d, $id[1]);
    if (!$gr) {
        return null;
    }
    return [$id[0], $pos + $id[1] + $gr[1], $gr[0]];
}

/** Kinder eines im Speicher liegenden Elements: Liste [id, start, ende] (relativ zu $d) */
function sb_kinder(string $d, int $von, int $bis): array
{
    $aus = [];
    $p = $von;
    while ($p < $bis) {
        $id = sb_vint($d, $p, true);
        if (!$id) {
            break;
        }
        $gr = sb_vint($d, $p + $id[1]);
        if (!$gr || $gr[0] < 0) {
            break;
        }
        $start = $p + $id[1] + $gr[1];
        $ende = min($bis, $start + $gr[0]);
        $aus[] = [$id[0], $start, $ende];
        $p = $start + $gr[0];
    }
    return $aus;
}

function sb_uint(string $d, int $von, int $bis): int
{
    $w = 0;
    for ($i = $von; $i < $bis; $i++) {
        $w = ($w << 8) | ord($d[$i]);
    }
    return $w;
}

function sb_matroska(string $pfad): ?array
{
    $fh = fopen($pfad, 'rb');
    if (!$fh) {
        return null;
    }
    try {
        $groesse = (int) fstat($fh)['size'];
        $ebml = sb_kopf($fh, 0);
        if (!$ebml || $ebml[0] !== 0x1A45DFA3) {
            return null;
        }
        $seg = sb_kopf($fh, $ebml[1] + $ebml[2]);
        if (!$seg || $seg[0] !== 0x18538067) {
            return null;
        }
        $segStart = $seg[1];
        $segEnde = $seg[2] < 0 ? $groesse : min($groesse, $segStart + $seg[2]);
        $pos = ['info' => null, 'tracks' => null, 'cues' => null];
        $ids = [0x1549A966 => 'info', 0x1654AE6B => 'tracks', 0x1C53BB6B => 'cues'];

        // 1. SeekHead(s) am Anfang lesen
        $p = $segStart;
        $schritte = 0;
        $seekheads = [];
        while ($p < $segEnde && $schritte++ < 64) {
            $k = sb_kopf($fh, $p);
            if (!$k || $k[2] < 0) {
                break;
            }
            if ($k[0] === 0x114D9B74) {
                $seekheads[] = $k;
            } elseif (isset($ids[$k[0]])) {
                $pos[$ids[$k[0]]] ??= $p;
            } elseif ($k[0] === 0x1F43B675) {
                break; // erster Cluster: Kopfbereich zu Ende
            }
            $p = $k[1] + $k[2];
        }
        foreach ($seekheads as $k) {
            fseek($fh, $k[1]);
            $d = (string) fread($fh, min($k[2], 1 << 20));
            foreach (sb_kinder($d, 0, strlen($d)) as [$id, $a, $e]) {
                if ($id !== 0x4DBB) {
                    continue;
                }
                $sid = null;
                $spos = null;
                foreach (sb_kinder($d, $a, $e) as [$id2, $a2, $e2]) {
                    if ($id2 === 0x53AB) {
                        $sid = sb_uint($d, $a2, $e2);
                    } elseif ($id2 === 0x53AC) {
                        $spos = sb_uint($d, $a2, $e2);
                    }
                }
                if ($sid !== null && $spos !== null && isset($ids[$sid])) {
                    $pos[$ids[$sid]] ??= $segStart + $spos;
                }
            }
        }
        // 2. Cues nicht im SeekHead? Dann die Elemente der Reihe nach überspringen (begrenzt)
        if ($pos['cues'] === null) {
            $p = $segStart;
            $schritte = 0;
            while ($p < $segEnde && $schritte++ < 200000) {
                $k = sb_kopf($fh, $p);
                if (!$k || $k[2] < 0) {
                    break;
                }
                if ($k[0] === 0x1C53BB6B) {
                    $pos['cues'] = $p;
                    break;
                }
                $p = $k[1] + $k[2];
            }
        }
        if ($pos['cues'] === null) {
            return null;
        }
        // 3. Zeitskala (Info) und Video-Spurnummer (Tracks)
        $skala = 1000000;
        if ($pos['info'] !== null && ($k = sb_kopf($fh, $pos['info'])) && $k[2] > 0) {
            fseek($fh, $k[1]);
            $d = (string) fread($fh, min($k[2], 1 << 20));
            foreach (sb_kinder($d, 0, strlen($d)) as [$id, $a, $e]) {
                if ($id === 0x2AD7B1) {
                    $skala = sb_uint($d, $a, $e) ?: 1000000;
                }
            }
        }
        $video = null;
        if ($pos['tracks'] !== null && ($k = sb_kopf($fh, $pos['tracks'])) && $k[2] > 0) {
            fseek($fh, $k[1]);
            $d = (string) fread($fh, min($k[2], 4 << 20));
            foreach (sb_kinder($d, 0, strlen($d)) as [$id, $a, $e]) {
                if ($id !== 0xAE) {
                    continue;
                }
                $nr = null;
                $typ = null;
                foreach (sb_kinder($d, $a, $e) as [$id2, $a2, $e2]) {
                    if ($id2 === 0xD7) {
                        $nr = sb_uint($d, $a2, $e2);
                    } elseif ($id2 === 0x83) {
                        $typ = sb_uint($d, $a2, $e2);
                    }
                }
                if ($typ === 1 && $nr !== null) {
                    $video = $nr;
                    break;
                }
            }
        }
        // 4. Cues lesen
        $k = sb_kopf($fh, $pos['cues']);
        if (!$k || $k[0] !== 0x1C53BB6B || $k[2] <= 0) {
            return null;
        }
        fseek($fh, $k[1]);
        $d = (string) fread($fh, min($k[2], 64 << 20));
        $zeiten = [];
        foreach (sb_kinder($d, 0, strlen($d)) as [$id, $a, $e]) {
            if ($id !== 0xBB) {
                continue;
            }
            $zeit = null;
            $passt = $video === null;
            foreach (sb_kinder($d, $a, $e) as [$id2, $a2, $e2]) {
                if ($id2 === 0xB3) {
                    $zeit = sb_uint($d, $a2, $e2);
                } elseif ($id2 === 0xB7 && !$passt) {
                    foreach (sb_kinder($d, $a2, $e2) as [$id3, $a3, $e3]) {
                        if ($id3 === 0xF7 && sb_uint($d, $a3, $e3) === $video) {
                            $passt = true;
                        }
                    }
                }
            }
            if ($zeit !== null && $passt) {
                $zeiten[] = $zeit * $skala / 1e9;
            }
        }
        return $zeiten;
    } finally {
        fclose($fh);
    }
}

// ---------- MP4 ----------

/** Box-Köpfe ab Dateiposition durchgehen: [typ, datenStart, ende] */
function sb_mp4_boxen($fh, int $von, int $bis): array
{
    $aus = [];
    $p = $von;
    while ($p + 8 <= $bis) {
        fseek($fh, $p);
        $k = (string) fread($fh, 16);
        if (strlen($k) < 8) {
            break;
        }
        $gr = unpack('N', $k)[1];
        $typ = substr($k, 4, 4);
        $kopf = 8;
        if ($gr === 1) {
            $gr = unpack('J', $k, 8)[1];
            $kopf = 16;
        } elseif ($gr === 0) {
            $gr = $bis - $p;
        }
        if ($gr < $kopf) {
            break;
        }
        $aus[] = [$typ, $p + $kopf, min($bis, $p + $gr)];
        $p += $gr;
    }
    return $aus;
}

function sb_mp4_kinder(string $d, int $von, int $bis): array
{
    $aus = [];
    $i = $von;
    while ($i + 8 <= $bis) {
        $gr = unpack('N', $d, $i)[1];
        $typ = substr($d, $i + 4, 4);
        $kopf = 8;
        if ($gr === 1) {
            $gr = unpack('J', $d, $i + 8)[1];
            $kopf = 16;
        } elseif ($gr === 0) {
            $gr = $bis - $i;
        }
        if ($gr < $kopf || $i + $gr > $bis) {
            break;
        }
        $aus[$typ][] = [$i + $kopf, $i + $gr];
        $i += $gr;
    }
    return $aus;
}

function sb_mp4(string $pfad): ?array
{
    $fh = fopen($pfad, 'rb');
    if (!$fh) {
        return null;
    }
    try {
        $groesse = (int) fstat($fh)['size'];
        $moov = null;
        foreach (sb_mp4_boxen($fh, 0, $groesse) as [$typ, $a, $e]) {
            if ($typ === 'moov') {
                $moov = [$a, $e];
                break;
            }
        }
        if (!$moov || $moov[1] - $moov[0] > 256 << 20) {
            return null;
        }
        fseek($fh, $moov[0]);
        $d = (string) fread($fh, $moov[1] - $moov[0]);
        $k = sb_mp4_kinder($d, 0, strlen($d));
        foreach ($k['trak'] ?? [] as [$ta, $te]) {
            $tk = sb_mp4_kinder($d, $ta, $te);
            $mdia = $tk['mdia'][0] ?? null;
            if (!$mdia) {
                continue;
            }
            $mk = sb_mp4_kinder($d, $mdia[0], $mdia[1]);
            $hdlr = $mk['hdlr'][0] ?? null;
            if (!$hdlr || substr($d, $hdlr[0] + 8, 4) !== 'vide') {
                continue;
            }
            $mdhd = $mk['mdhd'][0][0];
            $skala = unpack('N', $d, $mdhd + (ord($d[$mdhd]) === 1 ? 20 : 12))[1] ?: 1;
            $minf = $mk['minf'][0] ?? null;
            $stblB = $minf ? (sb_mp4_kinder($d, $minf[0], $minf[1])['stbl'][0] ?? null) : null;
            if (!$stblB) {
                return null;
            }
            $stbl = sb_mp4_kinder($d, $stblB[0], $stblB[1]);
            // Edit-Liste: wo die Spur sichtbar beginnt (media_time des ersten normalen Eintrags)
            $versatz = 0;
            $edts = $tk['edts'][0] ?? null;
            if ($edts && ($elst = sb_mp4_kinder($d, $edts[0], $edts[1])['elst'][0] ?? null)) {
                $v = ord($d[$elst[0]]);
                $n = unpack('N', $d, $elst[0] + 4)[1];
                $p = $elst[0] + 8;
                for ($i = 0; $i < $n; $i++) {
                    $mt = $v === 1 ? unpack('J', $d, $p + 8)[1] : unpack('N', $d, $p + 4)[1];
                    if ($v === 0 && $mt === 0xFFFFFFFF) {
                        $mt = -1;
                    }
                    $p += $v === 1 ? 20 : 12;
                    if ($mt >= 0) {
                        $versatz = $mt;
                        break;
                    }
                }
            }
            $sync = null;
            if (isset($stbl['stss'][0])) {
                $a = $stbl['stss'][0][0];
                $n = unpack('N', $d, $a + 4)[1];
                $sync = array_values(unpack('N' . $n, $d, $a + 8) ?: []);
            }
            // stts: Laufzeiten → Dekodierzeit je Sample; ctts: Versatz zur Anzeigezeit
            $a = $stbl['stts'][0][0] ?? null;
            if ($a === null) {
                return null;
            }
            $laeufe = unpack('N*', substr($d, $a + 8, unpack('N', $d, $a + 4)[1] * 8)) ?: [];
            $ctts = [];
            if (isset($stbl['ctts'][0])) {
                $c = $stbl['ctts'][0][0];
                $cv = ord($d[$c]);
                $cn = unpack('N', $d, $c + 4)[1];
                $roh = unpack('N*', substr($d, $c + 8, $cn * 8)) ?: [];
                for ($i = 1; $i <= count($roh); $i += 2) {
                    $off = $roh[$i + 1];
                    if ($cv === 1 && $off >= 0x80000000) {
                        $off -= 0x100000000;
                    }
                    $ctts[] = [$roh[$i], $off];
                }
            }
            $wanted = $sync !== null ? array_flip($sync) : null;
            $zeiten = [];
            $sample = 1;
            $dts = 0;
            $ci = 0;
            $cRest = $ctts[0][0] ?? 0;
            for ($i = 1; $i <= count($laeufe); $i += 2) {
                $anzahl = $laeufe[$i];
                $delta = $laeufe[$i + 1];
                for ($j = 0; $j < $anzahl; $j++, $sample++) {
                    $off = 0;
                    if ($ctts) {
                        while ($cRest === 0 && $ci + 1 < count($ctts)) {
                            $ci++;
                            $cRest = $ctts[$ci][0];
                        }
                        $off = $ctts[$ci][1];
                        $cRest--;
                    }
                    if ($wanted === null || isset($wanted[$sample])) {
                        $zeiten[] = ($dts + $off - $versatz) / $skala;
                    }
                    $dts += $delta;
                }
                if ($wanted === null && count($zeiten) > 200000) {
                    break; // ohne stss ist jedes Bild ein Schlüsselbild (Intra-Codecs) – Raster würde sinnlos fein
                }
            }
            return $wanted === null ? null : array_values(array_filter($zeiten, static fn($t) => $t >= -0.001));
        }
        return null;
    } finally {
        fclose($fh);
    }
}
