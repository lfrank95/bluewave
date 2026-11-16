-- Bluewave – Grundgerüst der Bibliothek. Objektmodell statt flacher Tags (wie Amberwave):
--   Universum ─┬─ Reihe ── Film ── Fassung (Kino, Extended …) ── Datei (4K, 1080p …)
--              ├─ Film (auch ohne Reihe)
--              └─ Serie ── Reihenfolge (Ausstrahlung, DVD, Netflix …) ── Staffel ── Folge ── Datei
-- Fassung und Qualität sind unabhängig: Die Fassung wählt man, die Qualität (Datei) sucht sich das Gerät aus.
-- Folgen gibt es je Serie genau einmal; welche Staffel/Nummer sie haben, hängt von der gewählten Reihenfolge ab
-- (z. B. „Haus des Geldes“: Originalausstrahlung in 2 Staffeln vs. Netflix-Schnitt in Teilen).
-- Konten folgen als eigene Migration (Bausteine aus Amberwave).

CREATE TABLE IF NOT EXISTS system_werte (
    schluessel VARCHAR(100) NOT NULL PRIMARY KEY,
    wert MEDIUMTEXT NULL,
    geaendert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bibliotheken (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    art ENUM('filme','serien') NOT NULL,
    name VARCHAR(100) NOT NULL,
    pfad VARCHAR(1024) NOT NULL,
    aktiv TINYINT(1) NOT NULL DEFAULT 1,
    letzter_scan DATETIME NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS universen (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    sortname VARCHAR(255) NOT NULL,
    beschreibung TEXT NULL,
    bild VARCHAR(255) NULL,
    hintergrund VARCHAR(255) NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    geaendert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_universen_sort (sortname)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reihen (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tmdb_id INT UNSIGNED NULL,
    name VARCHAR(255) NOT NULL,
    sortname VARCHAR(255) NOT NULL,
    beschreibung TEXT NULL,
    poster VARCHAR(255) NULL,
    hintergrund VARCHAR(255) NULL,
    eigen TINYINT(1) NOT NULL DEFAULT 0,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    geaendert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_reihen_tmdb (tmdb_id),
    KEY idx_reihen_sort (sortname)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS filme (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tmdb_id INT UNSIGNED NULL,
    imdb_id VARCHAR(20) NULL,
    titel VARCHAR(255) NOT NULL,
    originaltitel VARCHAR(255) NULL,
    sortiertitel VARCHAR(255) NOT NULL,
    jahr SMALLINT UNSIGNED NULL,
    erscheinungsdatum DATE NULL,
    laufzeit_min SMALLINT UNSIGNED NULL,
    tagline VARCHAR(500) NULL,
    beschreibung TEXT NULL,
    poster VARCHAR(255) NULL,
    hintergrund VARCHAR(255) NULL,
    logo VARCHAR(255) NULL,
    reihe_id INT UNSIGNED NULL,
    reihe_position DECIMAL(6,2) NULL,
    metadaten_am DATETIME NULL,
    hinzugefuegt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    geaendert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_filme_tmdb (tmdb_id),
    KEY idx_filme_sort (sortiertitel),
    KEY idx_filme_jahr (jahr),
    KEY idx_filme_neu (hinzugefuegt_am),
    CONSTRAINT fk_filme_reihe FOREIGN KEY (reihe_id) REFERENCES reihen (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fassungen (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    film_id INT UNSIGNED NOT NULL,
    art ENUM('kino','extended','directors_cut','unrated','remastered','imax','sonstige') NOT NULL DEFAULT 'kino',
    name VARCHAR(120) NOT NULL,
    laufzeit_min SMALLINT UNSIGNED NULL,
    standard TINYINT(1) NOT NULL DEFAULT 0,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_fassungen_film (film_id),
    CONSTRAINT fk_fassungen_film FOREIGN KEY (film_id) REFERENCES filme (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS serien (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tmdb_id INT UNSIGNED NULL,
    tvdb_id INT UNSIGNED NULL,
    imdb_id VARCHAR(20) NULL,
    titel VARCHAR(255) NOT NULL,
    originaltitel VARCHAR(255) NULL,
    sortiertitel VARCHAR(255) NOT NULL,
    jahr_von SMALLINT UNSIGNED NULL,
    jahr_bis SMALLINT UNSIGNED NULL,
    status ENUM('laufend','beendet','abgesetzt','geplant','unbekannt') NOT NULL DEFAULT 'unbekannt',
    beschreibung TEXT NULL,
    poster VARCHAR(255) NULL,
    hintergrund VARCHAR(255) NULL,
    logo VARCHAR(255) NULL,
    -- gewählte Episodenreihenfolge (NULL = Standard: Ausstrahlung); ohne Fremdschlüssel (Kreis serien ↔ reihenfolgen)
    reihenfolge_id INT UNSIGNED NULL,
    metadaten_am DATETIME NULL,
    hinzugefuegt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    geaendert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_serien_tmdb (tmdb_id),
    UNIQUE KEY uq_serien_tvdb (tvdb_id),
    KEY idx_serien_sort (sortiertitel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reihenfolgen (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    serie_id INT UNSIGNED NOT NULL,
    art ENUM('ausstrahlung','dvd','absolut','streaming','sonstige') NOT NULL DEFAULT 'ausstrahlung',
    quelle ENUM('tmdb','tvdb','eigen') NOT NULL DEFAULT 'tmdb',
    quelle_id VARCHAR(64) NULL,
    name VARCHAR(255) NOT NULL,
    beschreibung TEXT NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_reihenfolgen_quelle (serie_id, quelle, quelle_id),
    CONSTRAINT fk_reihenfolgen_serie FOREIGN KEY (serie_id) REFERENCES serien (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staffeln (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    reihenfolge_id INT UNSIGNED NOT NULL,
    nummer SMALLINT UNSIGNED NOT NULL,
    name VARCHAR(255) NULL,
    beschreibung TEXT NULL,
    poster VARCHAR(255) NULL,
    UNIQUE KEY uq_staffeln_nr (reihenfolge_id, nummer),
    CONSTRAINT fk_staffeln_reihenfolge FOREIGN KEY (reihenfolge_id) REFERENCES reihenfolgen (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS folgen (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    serie_id INT UNSIGNED NOT NULL,
    tmdb_id INT UNSIGNED NULL,
    tvdb_id INT UNSIGNED NULL,
    titel VARCHAR(255) NULL,
    beschreibung TEXT NULL,
    erstausstrahlung DATE NULL,
    laufzeit_min SMALLINT UNSIGNED NULL,
    standbild VARCHAR(255) NULL,
    hinzugefuegt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_folgen_serie (serie_id),
    UNIQUE KEY uq_folgen_tmdb (tmdb_id),
    CONSTRAINT fk_folgen_serie FOREIGN KEY (serie_id) REFERENCES serien (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Wo eine Folge in einer Reihenfolge steht (Staffel + Nummer). Eine Folge kann in jeder Reihenfolge anders stehen.
CREATE TABLE IF NOT EXISTS reihenfolge_folgen (
    reihenfolge_id INT UNSIGNED NOT NULL,
    folge_id INT UNSIGNED NOT NULL,
    staffel_id INT UNSIGNED NULL,
    nummer SMALLINT UNSIGNED NOT NULL,
    PRIMARY KEY (reihenfolge_id, folge_id),
    KEY idx_rf_staffel (staffel_id, nummer),
    CONSTRAINT fk_rf_reihenfolge FOREIGN KEY (reihenfolge_id) REFERENCES reihenfolgen (id) ON DELETE CASCADE,
    CONSTRAINT fk_rf_folge FOREIGN KEY (folge_id) REFERENCES folgen (id) ON DELETE CASCADE,
    CONSTRAINT fk_rf_staffel FOREIGN KEY (staffel_id) REFERENCES staffeln (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Universen legst du selbst an; sie enthalten Reihen, einzelne Filme und Serien (verwoben, jeweils mit eigener Position).
-- Genau eines von reihe_id/film_id/serie_id ist gesetzt (passend zu art) – prüft der Code.
CREATE TABLE IF NOT EXISTS universum_eintraege (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    universum_id INT UNSIGNED NOT NULL,
    art ENUM('reihe','film','serie') NOT NULL,
    reihe_id INT UNSIGNED NULL,
    film_id INT UNSIGNED NULL,
    serie_id INT UNSIGNED NULL,
    position DECIMAL(8,2) NULL,
    UNIQUE KEY uq_ue_reihe (universum_id, reihe_id),
    UNIQUE KEY uq_ue_film (universum_id, film_id),
    UNIQUE KEY uq_ue_serie (universum_id, serie_id),
    CONSTRAINT fk_ue_universum FOREIGN KEY (universum_id) REFERENCES universen (id) ON DELETE CASCADE,
    CONSTRAINT fk_ue_reihe FOREIGN KEY (reihe_id) REFERENCES reihen (id) ON DELETE CASCADE,
    CONSTRAINT fk_ue_film FOREIGN KEY (film_id) REFERENCES filme (id) ON DELETE CASCADE,
    CONSTRAINT fk_ue_serie FOREIGN KEY (serie_id) REFERENCES serien (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dateien: gehören entweder zu einer Fassung (Film) oder zu einer Folge. Qualität = Eigenschaften der Datei.
CREATE TABLE IF NOT EXISTS dateien (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    bibliothek_id INT UNSIGNED NOT NULL,
    pfad VARCHAR(1024) NOT NULL,
    pfad_hash BINARY(20) NOT NULL,
    groesse BIGINT UNSIGNED NOT NULL DEFAULT 0,
    geaendert DATETIME NULL,
    fassung_id INT UNSIGNED NULL,
    folge_id INT UNSIGNED NULL,
    container VARCHAR(40) NULL,
    dauer_ms INT UNSIGNED NULL,
    bitrate INT UNSIGNED NULL,
    video_codec VARCHAR(40) NULL,
    video_profil VARCHAR(60) NULL,
    breite SMALLINT UNSIGNED NULL,
    hoehe SMALLINT UNSIGNED NULL,
    bittiefe TINYINT UNSIGNED NULL,
    bildrate DECIMAL(7,3) NULL,
    hdr ENUM('sdr','hdr10','hdr10plus','hlg','dolby_vision') NOT NULL DEFAULT 'sdr',
    analysiert_am DATETIME NULL,
    fehlt_seit DATETIME NULL,
    hinzugefuegt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_dateien_pfad (pfad_hash),
    KEY idx_dateien_fassung (fassung_id),
    KEY idx_dateien_folge (folge_id),
    CONSTRAINT fk_dateien_bibliothek FOREIGN KEY (bibliothek_id) REFERENCES bibliotheken (id) ON DELETE CASCADE,
    CONSTRAINT fk_dateien_fassung FOREIGN KEY (fassung_id) REFERENCES fassungen (id) ON DELETE SET NULL,
    CONSTRAINT fk_dateien_folge FOREIGN KEY (folge_id) REFERENCES folgen (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tonspuren (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    datei_id INT UNSIGNED NOT NULL,
    strom_index SMALLINT UNSIGNED NOT NULL,
    codec VARCHAR(40) NULL,
    profil VARCHAR(60) NULL,
    sprache CHAR(3) NULL,
    kanaele TINYINT UNSIGNED NULL,
    layout VARCHAR(40) NULL,
    titel VARCHAR(255) NULL,
    standard TINYINT(1) NOT NULL DEFAULT 0,
    kommentar TINYINT(1) NOT NULL DEFAULT 0,
    UNIQUE KEY uq_tonspuren (datei_id, strom_index),
    CONSTRAINT fk_tonspuren_datei FOREIGN KEY (datei_id) REFERENCES dateien (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS untertitel (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    datei_id INT UNSIGNED NOT NULL,
    quelle ENUM('eingebettet','datei','opensubtitles') NOT NULL,
    strom_index SMALLINT UNSIGNED NULL,
    pfad VARCHAR(1024) NULL,
    format VARCHAR(20) NULL,
    sprache CHAR(3) NULL,
    titel VARCHAR(255) NULL,
    erzwungen TINYINT(1) NOT NULL DEFAULT 0,
    hoergeschaedigt TINYINT(1) NOT NULL DEFAULT 0,
    standard TINYINT(1) NOT NULL DEFAULT 0,
    KEY idx_untertitel_datei (datei_id),
    CONSTRAINT fk_untertitel_datei FOREIGN KEY (datei_id) REFERENCES dateien (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Intro/Abspann/Rückblick: erkannt (Audio-Fingerabdruck) oder manuell gesetzt bzw. korrigiert – manuell gewinnt immer
CREATE TABLE IF NOT EXISTS marker (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    datei_id INT UNSIGNED NOT NULL,
    art ENUM('intro','abspann','rueckblick','vorschau') NOT NULL,
    start_ms INT UNSIGNED NOT NULL,
    ende_ms INT UNSIGNED NOT NULL,
    quelle ENUM('erkannt','manuell') NOT NULL DEFAULT 'erkannt',
    sicherheit TINYINT UNSIGNED NULL,
    geaendert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_marker (datei_id, art),
    CONSTRAINT fk_marker_datei FOREIGN KEY (datei_id) REFERENCES dateien (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
