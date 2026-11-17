-- Reihen frei benennen (gesperrt gegen TMDB) und eigene Poster/Hintergründe für Reihen und Universen
ALTER TABLE metadaten_eigen MODIFY art ENUM('film','serie','reihe') NOT NULL;
ALTER TABLE eigene_poster MODIFY art ENUM('film','serie','staffel','reihe','universum') NOT NULL;
