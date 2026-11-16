<?php
// Verschachtelte Abschnitte in Universen (z. B. „Infinity Saga“ › „Phase 1“)
/** @var PDO $pdo */
$pdo->exec('ALTER TABLE universum_abschnitte ADD COLUMN IF NOT EXISTS eltern_id INT UNSIGNED NULL AFTER universum_id');
try {
    $pdo->exec('ALTER TABLE universum_abschnitte ADD CONSTRAINT fk_ua_eltern FOREIGN KEY (eltern_id) REFERENCES universum_abschnitte (id) ON DELETE SET NULL');
} catch (Throwable $e) {
    // schon vorhanden
}
