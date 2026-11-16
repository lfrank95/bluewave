<?php
// Universen 2: jeder Film und jede Serie steht einzeln im Universum (Reihen werden aufgelöst), optionale Abschnitte
// (z. B. „Phase 1“), Stichwörter von TMDB für Vorschläge.
/** @var PDO $pdo */

$pdo->exec("CREATE TABLE IF NOT EXISTS universum_abschnitte (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    universum_id INT UNSIGNED NOT NULL,
    name VARCHAR(120) NOT NULL,
    position INT NOT NULL DEFAULT 0,
    KEY idx_ua_universum (universum_id, position),
    CONSTRAINT fk_ua_universum FOREIGN KEY (universum_id) REFERENCES universen (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

$pdo->exec('ALTER TABLE universum_eintraege ADD COLUMN IF NOT EXISTS abschnitt_id INT UNSIGNED NULL');
try {
    $pdo->exec('ALTER TABLE universum_eintraege ADD CONSTRAINT fk_ue_abschnitt FOREIGN KEY (abschnitt_id) REFERENCES universum_abschnitte (id) ON DELETE SET NULL');
} catch (Throwable $e) {
    // schon vorhanden (Migration wiederholt)
}
$pdo->exec('ALTER TABLE filme ADD COLUMN IF NOT EXISTS stichwoerter JSON NULL');
$pdo->exec('ALTER TABLE serien ADD COLUMN IF NOT EXISTS stichwoerter JSON NULL');

// Reihen-Einträge in ihre Filme auflösen (an derselben Stelle, in Reihenfolge der Reihe)
$reihen = $pdo->query("SELECT id, universum_id, reihe_id, position FROM universum_eintraege WHERE art = 'reihe' ORDER BY universum_id, position, id")->fetchAll(PDO::FETCH_ASSOC);
$filmeDerReihe = $pdo->prepare('SELECT id FROM filme WHERE reihe_id = :r ORDER BY reihe_position IS NULL, reihe_position, jahr, id');
$einfuegen = $pdo->prepare("INSERT IGNORE INTO universum_eintraege (universum_id, art, film_id, position) VALUES (:u, 'film', :f, :p)");
$loeschen = $pdo->prepare('DELETE FROM universum_eintraege WHERE id = :id');
foreach ($reihen as $r) {
    $filmeDerReihe->execute(['r' => $r['reihe_id']]);
    $basis = (float) ($r['position'] ?? 0);
    foreach ($filmeDerReihe->fetchAll(PDO::FETCH_COLUMN) as $i => $fid) {
        $einfuegen->execute(['u' => $r['universum_id'], 'f' => $fid, 'p' => $basis + ($i + 1) * 0.01]);
    }
    $loeschen->execute(['id' => $r['id']]);
}

// Positionen je Universum durchnummerieren
$neu = $pdo->prepare('UPDATE universum_eintraege SET position = :p WHERE id = :id');
foreach ($pdo->query('SELECT DISTINCT universum_id FROM universum_eintraege')->fetchAll(PDO::FETCH_COLUMN) as $uid) {
    $st = $pdo->prepare('SELECT id FROM universum_eintraege WHERE universum_id = :u ORDER BY position IS NULL, position, id');
    $st->execute(['u' => $uid]);
    foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $i => $eid) {
        $neu->execute(['p' => $i + 1, 'id' => $eid]);
    }
}
