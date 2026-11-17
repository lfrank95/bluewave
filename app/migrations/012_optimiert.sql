-- Optimierte Fassungen: vorab umgewandelte Kopien (z. B. 1080p H.264) für unterwegs – spielen dann direkt, Spulen sofort
CREATE TABLE IF NOT EXISTS optimiert (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    datei_id INT UNSIGNED NOT NULL,
    hoehe SMALLINT UNSIGNED NOT NULL,
    bitrate_k INT UNSIGNED NOT NULL,
    status ENUM('wartet','laeuft','fertig','fehler') NOT NULL DEFAULT 'wartet',
    fortschritt DECIMAL(5,2) NOT NULL DEFAULT 0,
    pfad VARCHAR(1024) NULL,
    groesse BIGINT UNSIGNED NULL,
    breite SMALLINT UNSIGNED NULL,
    fehler TEXT NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fertig_am DATETIME NULL,
    UNIQUE KEY uq_optimiert (datei_id, hoehe),
    KEY idx_optimiert_status (status),
    CONSTRAINT fk_optimiert_datei FOREIGN KEY (datei_id) REFERENCES dateien (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
