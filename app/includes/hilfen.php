<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

// Signal-Nummern (Linux), falls die pcntl-Erweiterung im Webserver nicht geladen ist
foreach (['SIGKILL' => 9, 'SIGTERM' => 15, 'SIGSTOP' => 19, 'SIGCONT' => 18] as $n => $w) {
    if (!defined($n)) {
        define($n, $w);
    }
}

/**
 * Programm ohne Shell starten (Argumente als Liste, nichts wird interpretiert) und mit Zeitlimit warten.
 * @return array{code:int, aus:string, fehler:string, sekunden:float, zeit_um:bool}
 */
function bw_ausfuehren(array $befehl, float $limit = 30.0): array
{
    $start = microtime(true);
    $rohre = [];
    $p = @proc_open($befehl, [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $rohre);
    if (!is_resource($p)) {
        return ['code' => 127, 'aus' => '', 'fehler' => 'Programm nicht gefunden: ' . ($befehl[0] ?? ''), 'sekunden' => 0.0, 'zeit_um' => false];
    }
    stream_set_blocking($rohre[1], false);
    stream_set_blocking($rohre[2], false);
    $aus = '';
    $fehler = '';
    $zeitUm = false;
    $code = -1;
    while (true) {
        $lesen = [$rohre[1], $rohre[2]];
        $x = null;
        $y = null;
        if (@stream_select($lesen, $x, $y, 0, 200000) > 0) {
            foreach ($lesen as $r) {
                $teil = (string) fread($r, 65536);
                if ($r === $rohre[1]) {
                    $aus .= $teil;
                } else {
                    $fehler .= $teil;
                }
            }
        }
        $st = proc_get_status($p);
        if (!$st['running']) {
            $code = (int) $st['exitcode'];
            $aus .= (string) stream_get_contents($rohre[1]);
            $fehler .= (string) stream_get_contents($rohre[2]);
            break;
        }
        if (microtime(true) - $start > $limit) {
            $zeitUm = true;
            proc_terminate($p, 9);
            break;
        }
        // Ausgabe begrenzen (ffmpeg kann sehr gesprächig sein)
        if (strlen($fehler) > 200000) {
            $fehler = substr($fehler, -100000);
        }
    }
    fclose($rohre[1]);
    fclose($rohre[2]);
    $c = proc_close($p);
    if ($code === -1) {
        $code = $zeitUm ? 124 : $c;
    }
    return ['code' => $code, 'aus' => $aus, 'fehler' => $fehler, 'sekunden' => microtime(true) - $start, 'zeit_um' => $zeitUm];
}

/** Anfrage kommt direkt aus dem Heimnetz (kein Tunnel, kein Proxy) – bis die Konten da sind, ist die Verwaltung nur so erreichbar */
function bw_ist_heimnetz(): bool
{
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP', 'HTTP_FORWARDED'] as $h) {
        if (!empty($_SERVER[$h])) {
            return false;
        }
    }
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if ($ip === '' || filter_var($ip, FILTER_VALIDATE_IP) === false) {
        return false;
    }
    if (str_starts_with($ip, '::ffff:')) {
        $ip = substr($ip, 7);
    }
    if ($ip === '127.0.0.1' || $ip === '::1') {
        return true;
    }
    // privat/lokal = nicht öffentlich routbar
    return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
}

function bw_json(mixed $daten, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($daten, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
    exit;
}

/** Datei atomar schreiben */
function bw_schreiben(string $pfad, string $inhalt): bool
{
    $tmp = $pfad . '.' . bin2hex(random_bytes(3)) . '.tmp';
    if (@file_put_contents($tmp, $inhalt, LOCK_EX) === false) {
        @unlink($tmp);
        return false;
    }
    if (!@rename($tmp, $pfad)) {
        @unlink($tmp);
        return false;
    }
    return true;
}
