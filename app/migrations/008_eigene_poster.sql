-- Eigene Poster (per Link gesetzt, z. B. von ThePosterDB) – haben Vorrang vor TMDB und Ordnerbildern
CREATE TABLE IF NOT EXISTS eigene_poster (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    art ENUM('film','serie','staffel') NOT NULL,
    ziel_id INT UNSIGNED NOT NULL,
    staffel SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    bild VARCHAR(255) NOT NULL,
    datei VARCHAR(1024) NULL,
    quelle VARCHAR(500) NULL,
    gesetzt_am DATETIME NOT NULL,
    UNIQUE KEY uq_ep (art, ziel_id, staffel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
