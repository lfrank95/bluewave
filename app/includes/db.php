<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

/** Eine gemeinsame PDO-Verbindung pro Request (echte Prepared Statements) */
function db(): PDO
{
    $pdo = &$GLOBALS['__bw_pdo'];
    if ($pdo !== null) {
        return $pdo;
    }
    $c = konfig()['db'];
    if ($c['password'] === '') {
        throw new RuntimeException('Die Datenbank ist noch nicht eingerichtet (Bluewave legt sie beim Start selbst an – siehe Container-Log).');
    }
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $c['host'], $c['port'], $c['name']);
    $pdo = new PDO($dsn, $c['user'], $c['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => false,
        PDO::ATTR_TIMEOUT => 5,
    ]);
    $pdo->exec("SET time_zone = '" . (new DateTime())->format('P') . "'");
    return $pdo;
}

function db_schliessen(): void
{
    $GLOBALS['__bw_pdo'] = null;
}

function db_tun(string $sql, array $p = []): int
{
    $st = db()->prepare($sql);
    $st->execute($p);
    return $st->rowCount();
}

function db_einfuegen(string $sql, array $p = []): int
{
    db_tun($sql, $p);
    return (int) db()->lastInsertId();
}

function db_wert(string $sql, array $p = []): mixed
{
    $st = db()->prepare($sql);
    $st->execute($p);
    $w = $st->fetchColumn();
    return $w === false ? null : $w;
}

function db_zeile(string $sql, array $p = []): ?array
{
    $st = db()->prepare($sql);
    $st->execute($p);
    $z = $st->fetch();
    return $z === false ? null : $z;
}

function db_alle(string $sql, array $p = []): array
{
    $st = db()->prepare($sql);
    $st->execute($p);
    return $st->fetchAll();
}
