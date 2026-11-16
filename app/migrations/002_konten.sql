-- Konten, Sitzungen (Browser und fest angemeldete Geräte wie Fire TV), Anmeldeversuche, Einstellungen je Nutzer.
-- Keine Registrierung: Der Admin legt die Familie an. Keine Altersfreigaben (bewusst).

CREATE TABLE IF NOT EXISTS konten (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    benutzername VARCHAR(50) NOT NULL,
    anzeigename VARCHAR(100) NOT NULL,
    passwort_hash VARCHAR(255) NOT NULL,
    rolle ENUM('admin','nutzer') NOT NULL DEFAULT 'nutzer',
    aktiv TINYINT(1) NOT NULL DEFAULT 1,
    einstellungen JSON NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    letzter_login DATETIME NULL,
    UNIQUE KEY uq_konten_name (benutzername)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sitzungen (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    konto_id INT UNSIGNED NOT NULL,
    token_hash BINARY(32) NOT NULL,
    art ENUM('browser','geraet') NOT NULL DEFAULT 'browser',
    geraetename VARCHAR(100) NULL,
    ip VARCHAR(45) NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    zuletzt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ablauf_am DATETIME NULL,
    UNIQUE KEY uq_sitzungen_token (token_hash),
    KEY idx_sitzungen_konto (konto_id),
    CONSTRAINT fk_sitzungen_konto FOREIGN KEY (konto_id) REFERENCES konten (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Kopplungscodes für Fernseher: Fernseher zeigt Code, Nutzer bestätigt ihn am Handy/PC
CREATE TABLE IF NOT EXISTS kopplungen (
    code CHAR(6) NOT NULL PRIMARY KEY,
    geheimnis_hash BINARY(32) NOT NULL,
    geraetename VARCHAR(100) NOT NULL,
    konto_id INT UNSIGNED NULL,
    token VARCHAR(100) NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_kopplungen_zeit (erstellt_am)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_versuche (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    benutzername VARCHAR(50) NOT NULL,
    ip VARCHAR(45) NOT NULL,
    zeit DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_lv_name (benutzername, zeit),
    KEY idx_lv_ip (ip, zeit)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fortschritt je Nutzer: Weiterschauen, Gesehen-Status
CREATE TABLE IF NOT EXISTS wiedergabe (
    konto_id INT UNSIGNED NOT NULL,
    art ENUM('film','folge') NOT NULL,
    ziel_id INT UNSIGNED NOT NULL,
    datei_id INT UNSIGNED NULL,
    position_ms INT UNSIGNED NOT NULL DEFAULT 0,
    dauer_ms INT UNSIGNED NOT NULL DEFAULT 0,
    gesehen TINYINT(1) NOT NULL DEFAULT 0,
    gesehen_am DATETIME NULL,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (konto_id, art, ziel_id),
    KEY idx_wiedergabe_zuletzt (konto_id, aktualisiert_am),
    CONSTRAINT fk_wiedergabe_konto FOREIGN KEY (konto_id) REFERENCES konten (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
