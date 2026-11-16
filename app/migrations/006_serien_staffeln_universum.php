<?php
// Universen: Serien lassen sich in Staffeln aufteilen (Watch-Order, z. B. Loki S1 → … → Loki S2).
// staffel = 0 steht für die ganze Serie.
/** @var PDO $pdo */
$pdo->exec('ALTER TABLE universum_eintraege ADD COLUMN IF NOT EXISTS staffel SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER serie_id');
try {
    $pdo->exec('ALTER TABLE universum_eintraege ADD UNIQUE KEY uq_ue_serie_staffel (universum_id, serie_id, staffel)');
} catch (Throwable $e) {
    // schon vorhanden
}
try {
    $pdo->exec('ALTER TABLE universum_eintraege DROP INDEX uq_ue_serie');
} catch (Throwable $e) {
    // schon entfernt
}
