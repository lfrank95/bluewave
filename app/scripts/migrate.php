<?php
// Migrationen: wendet alle Dateien in /migrations an (NNN_name.sql oder NNN_name.php mit $pdo), die noch nicht in
// schema_version stehen. Datenbank neuer als dieser Code → nichts anfassen (Downgrade-Sperre wie bei Amberwave).
declare(strict_types=1);
require_once __DIR__ . '/../includes/db.php';

class SchemaZuNeu extends RuntimeException
{
}

function migrationen_dateien(): array
{
    $d = array_merge(glob(__DIR__ . '/../migrations/*.sql') ?: [], glob(__DIR__ . '/../migrations/*.php') ?: []);
    usort($d, static fn($a, $b) => strnatcmp(basename($a), basename($b)));
    return $d;
}

function migrationen_code_version(): int
{
    $max = 0;
    foreach (migrationen_dateien() as $d) {
        if (preg_match('/^(\d+)_/', basename($d), $t)) {
            $max = max($max, (int) $t[1]);
        }
    }
    return $max;
}

function migrationen_db_version(): int
{
    $pdo = db();
    if (!$pdo->query("SHOW TABLES LIKE 'schema_version'")->fetch()) {
        return 0;
    }
    return (int) $pdo->query('SELECT COALESCE(MAX(version), 0) FROM schema_version')->fetchColumn();
}

function migrationen_ausfuehren(): array
{
    $pdo = db();
    $sperre = (int) $pdo->query("SELECT GET_LOCK(CONCAT('bluewave_migration_', DATABASE()), 30)")->fetchColumn() === 1;
    if (!$sperre) {
        throw new RuntimeException('Ein anderer Prozess aktualisiert gerade die Datenbank.');
    }
    try {
        $pdo->exec('CREATE TABLE IF NOT EXISTS schema_version (version INT NOT NULL PRIMARY KEY, angewendet_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        $angewendet = array_map('intval', $pdo->query('SELECT version FROM schema_version')->fetchAll(PDO::FETCH_COLUMN));
        $dbVersion = $angewendet ? max($angewendet) : 0;
        $codeVersion = migrationen_code_version();
        if ($dbVersion > $codeVersion) {
            throw new SchemaZuNeu("Die Datenbank gehört zu einer neueren Bluewave-Version (Schema $dbVersion, diese App kennt nur $codeVersion). "
                . 'Zum Schutz deiner Daten ändert diese ältere Version nichts – bitte die neuere Version einspielen.');
        }
        $neu = [];
        foreach (migrationen_dateien() as $datei) {
            if (!preg_match('/^(\d+)_/', basename($datei), $t) || in_array((int) $t[1], $angewendet, true)) {
                continue;
            }
            $version = (int) $t[1];
            // DDL beendet Transaktionen von selbst – Migrationen sind deshalb wiederholbar geschrieben (IF NOT EXISTS)
            try {
                if (str_ends_with($datei, '.sql')) {
                    $sql = preg_replace('/^\s*--.*$/m', '', (string) file_get_contents($datei)) ?? '';
                    foreach (array_filter(array_map('trim', explode(';', $sql))) as $anweisung) {
                        $pdo->exec($anweisung);
                    }
                } else {
                    (static function () use ($datei, $pdo): void {
                        require $datei;
                    })();
                }
                $pdo->prepare('INSERT IGNORE INTO schema_version (version) VALUES (:v)')->execute(['v' => $version]);
                $neu[] = $version;
            } catch (Throwable $e) {
                throw new RuntimeException('Migration ' . $version . ' (' . basename($datei) . ') fehlgeschlagen: ' . $e->getMessage());
            }
        }
        return $neu;
    } finally {
        try { $pdo->query("SELECT RELEASE_LOCK(CONCAT('bluewave_migration_', DATABASE()))"); } catch (Throwable $e) {}
    }
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === realpath(__FILE__)) {
    $beimStart = in_array('--start', $argv, true);
    $versuche = $beimStart ? 30 : 1;
    for ($i = 1; $i <= $versuche; $i++) {
        try {
            $r = migrationen_ausfuehren();
            echo $r ? 'Datenbank: Migrationen angewendet: ' . implode(', ', $r) . "\n" : "Datenbank: Schema aktuell (Version " . migrationen_db_version() . ")\n";
            exit(0);
        } catch (SchemaZuNeu $e) {
            fwrite(STDERR, $e->getMessage() . "\n");
            exit($beimStart ? 0 : 2);
        } catch (Throwable $e) {
            if ($i === $versuche) {
                fwrite(STDERR, 'Datenbank: ' . $e->getMessage() . "\n");
                exit($beimStart ? 0 : 1);
            }
            db_schliessen();
            sleep(2);
        }
    }
}
