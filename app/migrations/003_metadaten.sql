-- Metadaten aus TMDB: Genres, Besetzung, Freigabe (nur Anzeige), Bewertung; Staffeln der Ausstrahlungsreihenfolge;
-- Folgen behalten ihre Ausstrahlungsnummern (Staffel/Folge) – darüber werden Dateien zugeordnet. Andere Reihenfolgen
-- (Episodengruppen) liegen in reihenfolgen/staffeln/reihenfolge_folgen.

CREATE TABLE IF NOT EXISTS genres (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tmdb_id INT UNSIGNED NULL,
    name VARCHAR(100) NOT NULL,
    UNIQUE KEY uq_genres_tmdb (tmdb_id),
    UNIQUE KEY uq_genres_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS film_genres (
    film_id INT UNSIGNED NOT NULL,
    genre_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (film_id, genre_id),
    CONSTRAINT fk_fg_film FOREIGN KEY (film_id) REFERENCES filme (id) ON DELETE CASCADE,
    CONSTRAINT fk_fg_genre FOREIGN KEY (genre_id) REFERENCES genres (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS serie_genres (
    serie_id INT UNSIGNED NOT NULL,
    genre_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (serie_id, genre_id),
    CONSTRAINT fk_sg_serie FOREIGN KEY (serie_id) REFERENCES serien (id) ON DELETE CASCADE,
    CONSTRAINT fk_sg_genre FOREIGN KEY (genre_id) REFERENCES genres (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE filme
    ADD COLUMN IF NOT EXISTS besetzung JSON NULL,
    ADD COLUMN IF NOT EXISTS regie VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS freigabe VARCHAR(10) NULL,
    ADD COLUMN IF NOT EXISTS bewertung DECIMAL(3,1) NULL,
    ADD COLUMN IF NOT EXISTS ordner_titel VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS metadaten_status ENUM('offen','gefunden','nicht_gefunden','manuell') NOT NULL DEFAULT 'offen';

ALTER TABLE serien
    ADD COLUMN IF NOT EXISTS besetzung JSON NULL,
    ADD COLUMN IF NOT EXISTS sender VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS freigabe VARCHAR(10) NULL,
    ADD COLUMN IF NOT EXISTS bewertung DECIMAL(3,1) NULL,
    ADD COLUMN IF NOT EXISTS ordner_pfad VARCHAR(1024) NULL,
    ADD COLUMN IF NOT EXISTS metadaten_status ENUM('offen','gefunden','nicht_gefunden','manuell') NOT NULL DEFAULT 'offen';

ALTER TABLE folgen
    ADD COLUMN IF NOT EXISTS staffel_nr SMALLINT UNSIGNED NULL,
    ADD COLUMN IF NOT EXISTS folge_nr SMALLINT UNSIGNED NULL,
    ADD UNIQUE KEY IF NOT EXISTS uq_folgen_nr (serie_id, staffel_nr, folge_nr);

CREATE TABLE IF NOT EXISTS serien_staffeln (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    serie_id INT UNSIGNED NOT NULL,
    nummer SMALLINT UNSIGNED NOT NULL,
    name VARCHAR(255) NULL,
    beschreibung TEXT NULL,
    poster VARCHAR(255) NULL,
    UNIQUE KEY uq_ss (serie_id, nummer),
    CONSTRAINT fk_ss_serie FOREIGN KEY (serie_id) REFERENCES serien (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE dateien
    ADD COLUMN IF NOT EXISTS audio_codec VARCHAR(40) NULL,
    ADD COLUMN IF NOT EXISTS fassung_text VARCHAR(120) NULL
