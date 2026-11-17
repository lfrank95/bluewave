-- Von Hand bearbeitete Felder (gesperrt gegen TMDB) und eigene Hintergründe/Logos
CREATE TABLE IF NOT EXISTS metadaten_eigen (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    art ENUM('film','serie') NOT NULL,
    ziel_id INT UNSIGNED NOT NULL,
    feld VARCHAR(40) NOT NULL,
    wert TEXT NULL,
    UNIQUE KEY uq_me (art, ziel_id, feld)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE eigene_poster ADD COLUMN IF NOT EXISTS typ ENUM('poster','hintergrund','logo') NOT NULL DEFAULT 'poster' AFTER staffel;
ALTER TABLE eigene_poster DROP INDEX IF EXISTS uq_ep;
ALTER TABLE eigene_poster ADD UNIQUE KEY IF NOT EXISTS uq_ep_typ (art, ziel_id, staffel, typ);
