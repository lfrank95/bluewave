<?php
// Sortierschlüssel neu berechnen: Artikel, Anführungszeichen, Umlaute, natürliche Zahlen (siehe sortiertitel())
/** @var PDO $pdo */
require_once __DIR__ . '/../includes/scanner.php';
foreach ([['filme', 'titel', 'sortiertitel'], ['serien', 'titel', 'sortiertitel'], ['reihen', 'name', 'sortname'], ['universen', 'name', 'sortname']] as [$tab, $quelle, $ziel]) {
    $neu = $pdo->prepare("UPDATE $tab SET $ziel = :s WHERE id = :id");
    foreach ($pdo->query("SELECT id, $quelle AS t FROM $tab")->fetchAll(PDO::FETCH_ASSOC) as $z) {
        $neu->execute(['s' => sortiertitel((string) $z['t']), 'id' => $z['id']]);
    }
}
