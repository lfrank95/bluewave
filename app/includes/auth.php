<?php
// Anmeldung: Sitzungen per Cookie (Browser/PWA) oder Bearer-Token (fest angemeldete Geräte, z. B. Fire TV).
// Tokens liegen nur als SHA-256 in der Datenbank. Schutz gegen Raten: Sperre je Benutzername und je IP.
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';

const SITZUNG_COOKIE = 'bw_sitzung';

function auth_ip(): string
{
    // Über den Cloudflare Tunnel die echte Adresse (cloudflared setzt sie), sonst die Verbindung
    $cf = (string) ($_SERVER['HTTP_CF_CONNECTING_IP'] ?? '');
    return filter_var($cf, FILTER_VALIDATE_IP) ? $cf : (string) ($_SERVER['REMOTE_ADDR'] ?? '');
}

function auth_https(): bool
{
    return (($_SERVER['HTTPS'] ?? '') === 'on') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') || !empty($_SERVER['HTTP_CF_CONNECTING_IP']);
}

function auth_token_aus_anfrage(): string
{
    $h = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if (preg_match('/^Bearer\s+([A-Za-z0-9_-]{20,128})$/', $h, $m)) {
        return $m[1];
    }
    $c = (string) ($_COOKIE[SITZUNG_COOKIE] ?? '');
    return preg_match('/^[A-Za-z0-9_-]{20,128}$/', $c) ? $c : '';
}

/** Angemeldetes Konto (oder null). Hält die Sitzung am Leben. */
function konto(): ?array
{
    static $geladen = false;
    static $konto = null;
    if ($geladen) {
        return $konto;
    }
    $geladen = true;
    $token = auth_token_aus_anfrage();
    if ($token === '') {
        return null;
    }
    try {
        $z = db_zeile('SELECT s.id AS sitzung_id, s.art, s.ablauf_am, s.zuletzt_am, k.* FROM sitzungen s JOIN konten k ON k.id = s.konto_id
            WHERE s.token_hash = :h AND k.aktiv = 1 AND (s.ablauf_am IS NULL OR s.ablauf_am > NOW())', ['h' => hash('sha256', $token, true)]);
    } catch (Throwable $e) {
        return null;
    }
    if (!$z) {
        return null;
    }
    // höchstens einmal pro Minute schreiben
    if (strtotime((string) $z['zuletzt_am']) < time() - 60) {
        db_tun('UPDATE sitzungen SET zuletzt_am = NOW(), ip = :ip WHERE id = :id', ['ip' => auth_ip(), 'id' => $z['sitzung_id']]);
    }
    unset($z['passwort_hash']);
    $z['einstellungen'] = nutzer_einstellungen_normal(json_decode((string) ($z['einstellungen'] ?? ''), true) ?: []);
    $konto = $z;
    return $konto;
}

function ist_admin(): bool
{
    return (konto()['rolle'] ?? '') === 'admin';
}

function anzahl_konten(): int
{
    try {
        return (int) db_wert('SELECT COUNT(*) FROM konten');
    } catch (Throwable $e) {
        return -1; // Datenbank (noch) nicht bereit
    }
}

/** Neue Sitzung anlegen; liefert das Token (nur jetzt im Klartext) */
function sitzung_anlegen(int $kontoId, string $art = 'browser', ?string $geraet = null, bool $merken = false): string
{
    $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    $ablauf = $art === 'geraet' ? null : date('Y-m-d H:i:s', time() + ($merken ? 90 * 86400 : 12 * 3600));
    db_tun('INSERT INTO sitzungen (konto_id, token_hash, art, geraetename, ip, ablauf_am) VALUES (:k, :h, :a, :g, :ip, :ab)', [
        'k' => $kontoId, 'h' => hash('sha256', $token, true), 'a' => $art, 'g' => $geraet !== null ? mb_substr($geraet, 0, 100) : null,
        'ip' => auth_ip(), 'ab' => $ablauf,
    ]);
    db_tun('UPDATE konten SET letzter_login = NOW() WHERE id = :k', ['k' => $kontoId]);
    return $token;
}

function sitzung_cookie_setzen(string $token, bool $merken): void
{
    setcookie(SITZUNG_COOKIE, $token, [
        'expires' => $merken ? time() + 90 * 86400 : 0,
        'path' => '/',
        'secure' => auth_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/** Anmelden. Liefert [konto, token] oder wirft eine Meldung für die Oberfläche. */
function anmelden(string $name, string $passwort, bool $merken, string $art = 'browser', ?string $geraet = null): array
{
    $name = trim($name);
    $ip = auth_ip();
    db_tun('DELETE FROM login_versuche WHERE zeit < NOW() - INTERVAL 1 DAY');
    $proName = (int) db_wert('SELECT COUNT(*) FROM login_versuche WHERE benutzername = :n AND zeit > NOW() - INTERVAL 15 MINUTE', ['n' => $name]);
    $proIp = (int) db_wert('SELECT COUNT(*) FROM login_versuche WHERE ip = :i AND zeit > NOW() - INTERVAL 1 HOUR', ['i' => $ip]);
    if ($proName >= 5 || $proIp >= 30) {
        throw new RuntimeException('Zu viele Fehlversuche – bitte ein paar Minuten warten.');
    }
    $k = db_zeile('SELECT * FROM konten WHERE benutzername = :n AND aktiv = 1', ['n' => $name]);
    // Auch ohne Konto einmal hashen, damit die Antwortzeit nichts verrät
    $hash = $k['passwort_hash'] ?? password_hash(random_bytes(8), PASSWORD_ARGON2ID);
    if (!password_verify($passwort, $hash) || !$k) {
        db_tun('INSERT INTO login_versuche (benutzername, ip) VALUES (:n, :i)', ['n' => mb_substr($name, 0, 50), 'i' => $ip]);
        throw new RuntimeException('Benutzername oder Passwort stimmt nicht.');
    }
    if (password_needs_rehash($k['passwort_hash'], PASSWORD_ARGON2ID)) {
        db_tun('UPDATE konten SET passwort_hash = :h WHERE id = :id', ['h' => password_hash($passwort, PASSWORD_ARGON2ID), 'id' => $k['id']]);
    }
    db_tun('DELETE FROM login_versuche WHERE benutzername = :n', ['n' => $name]);
    return [$k, sitzung_anlegen((int) $k['id'], $art, $geraet, $merken)];
}

function abmelden(): void
{
    $t = auth_token_aus_anfrage();
    if ($t !== '') {
        db_tun('DELETE FROM sitzungen WHERE token_hash = :h', ['h' => hash('sha256', $t, true)]);
    }
    setcookie(SITZUNG_COOKIE, '', ['expires' => time() - 3600, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax', 'secure' => auth_https()]);
}

function passwort_pruefen(string $pw): ?string
{
    if (mb_strlen($pw) < 8) {
        return 'Das Passwort braucht mindestens 8 Zeichen.';
    }
    if (mb_strlen($pw) > 200) {
        return 'Das Passwort ist zu lang.';
    }
    return null;
}

function konto_anlegen(string $name, string $anzeige, string $pw, string $rolle): int
{
    $name = trim($name);
    if (!preg_match('/^[\p{L}0-9._-]{3,50}$/u', $name)) {
        throw new RuntimeException('Benutzername: 3–50 Zeichen (Buchstaben, Ziffern, . _ -).');
    }
    if (($f = passwort_pruefen($pw)) !== null) {
        throw new RuntimeException($f);
    }
    if (db_wert('SELECT id FROM konten WHERE benutzername = :n', ['n' => $name])) {
        throw new RuntimeException('Diesen Benutzernamen gibt es schon.');
    }
    $anzeige = trim($anzeige) !== '' ? mb_substr(trim($anzeige), 0, 100) : $name;
    return db_einfuegen('INSERT INTO konten (benutzername, anzeigename, passwort_hash, rolle) VALUES (:n, :a, :h, :r)', [
        'n' => $name, 'a' => $anzeige, 'h' => password_hash($pw, PASSWORD_ARGON2ID), 'r' => $rolle === 'admin' ? 'admin' : 'nutzer',
    ]);
}

// ---------- Einstellungen je Nutzer ----------

const NUTZER_STANDARD = [
    'tonsprache' => 'deu',          // bevorzugte Tonspur (ISO 639-2)
    'untertitel' => 'aus',          // aus | erzwungen | immer
    'untertitelsprache' => 'deu',
    'autoplay' => 'countdown',      // countdown | sofort | aus
    'countdown_s' => 10,
    'intro' => 'knopf',             // knopf | automatisch
    'qualitaet_heim' => 'original', // original | 1080 | 720
    'qualitaet_unterwegs' => '1080',// original | 1080 | 720 | 480
    'nachtmodus' => 'aus',          // aus | leicht | stark – Standard aus: Ton bleibt unangetastet
    'dialog_db' => 0,               // 0 … 6 dB, Standard 0 = aus
    'sortierung' => [],             // gemerkte Sortierung je Ansicht, z. B. {"filme": "neu", "universum:3": "erscheinung"}
];

function nutzer_einstellungen_normal(array $e): array
{
    $n = NUTZER_STANDARD;
    foreach ($e as $k => $v) {
        if (!array_key_exists($k, $n)) {
            continue;
        }
        if (is_array(NUTZER_STANDARD[$k])) {
            $n[$k] = [];
            foreach (is_array($v) ? array_slice($v, 0, 80, true) : [] as $sk => $sv) {
                if (preg_match('/^[a-z0-9_:-]{1,40}$/', (string) $sk) && preg_match('/^[a-z_]{1,20}$/', (string) $sv)) {
                    $n[$k][(string) $sk] = (string) $sv;
                }
            }
            continue;
        }
        $n[$k] = is_int(NUTZER_STANDARD[$k]) ? (int) $v : (string) $v;
    }
    $erlaubt = [
        'untertitel' => ['aus', 'erzwungen', 'immer'], 'autoplay' => ['countdown', 'sofort', 'aus'], 'intro' => ['knopf', 'automatisch'],
        'qualitaet_heim' => ['original', '1080', '720'], 'qualitaet_unterwegs' => ['original', '1080', '720', '480'], 'nachtmodus' => ['aus', 'leicht', 'stark'],
    ];
    foreach ($erlaubt as $k => $liste) {
        if (!in_array($n[$k], $liste, true)) {
            $n[$k] = NUTZER_STANDARD[$k];
        }
    }
    foreach (['tonsprache', 'untertitelsprache'] as $k) {
        if (!preg_match('/^[a-z]{3}$/', $n[$k])) {
            $n[$k] = NUTZER_STANDARD[$k];
        }
    }
    $n['countdown_s'] = max(3, min(30, $n['countdown_s']));
    $n['dialog_db'] = max(0, min(6, $n['dialog_db']));
    return $n;
}
