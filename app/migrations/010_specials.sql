-- Specials/Extras (Staffel 0) je Serie ausblenden: NULL = wie in den Nutzereinstellungen, 0 = zeigen, 1 = ausblenden
ALTER TABLE serien ADD COLUMN IF NOT EXISTS specials_ausblenden TINYINT(1) NULL;
