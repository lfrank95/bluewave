<?php
// Hintergrundarbeit, die warten kann: erst optimierte Fassungen (Warteschlange), dann fehlende Vorschaubilder.
// Läuft höchstens einmal, mit niedrigster Priorität, und hält an, solange jemand schaut (Zuschauer haben Vorrang bei
// Grafik, Prozessor und Platten). Beendet sich, wenn nichts mehr zu tun ist; der Zeitplan startet ihn jede Minute neu.
declare(strict_types=1);
require_once __DIR__ . '/../includes/einstellungen.php';
require_once __DIR__ . '/../includes/vorarbeit.php';
require_once __DIR__ . '/../includes/optimiert.php';
require_once __DIR__ . '/../includes/vorschau.php';

$sperre = fopen(vorarbeit_datei('vorarbeit.lock'), 'c');
if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
    exit(0);
}
@set_time_limit(0);
$beginn = time();

function va_stand(array $s): void
{
    $s['t'] = time();
    bw_schreiben(vorarbeit_datei('vorarbeit.json'), (string) json_encode($s, JSON_UNESCAPED_UNICODE));
}

function va_protokoll(string $text): void
{
    echo date('c') . ' ' . $text . "\n";
}

/** Reste aufräumen: Vorschaubilder gelöschter Dateien, optimierte Kopien ohne Eintrag */
function va_aufraeumen(): void
{
    $ids = array_flip(array_map('intval', array_column(db_alle('SELECT id FROM dateien'), 'id')));
    foreach (glob(konfig()['pfade']['cache'] . '/vorschau/*', GLOB_ONLYDIR) ?: [] as $o) {
        $id = (int) basename($o);
        if ((string) $id === basename($o) && !isset($ids[$id])) {
            array_map('unlink', glob($o . '/*') ?: []);
            @rmdir($o);
        }
    }
    $bekannt = array_flip(array_filter(array_column(db_alle('SELECT pfad FROM optimiert WHERE pfad IS NOT NULL'), 'pfad')));
    foreach (glob(optimiert_ordner() . '/*.mp4') ?: [] as $f) {
        if (!isset($bekannt[$f]) && time() - (int) filemtime($f) > 86400) {
            @unlink($f);
        }
    }
}

try {
    va_aufraeumen();
} catch (Throwable $e) {
    va_protokoll('Aufräumen: ' . $e->getMessage());
}

while (time() - $beginn < 12 * 3600) {
    if (jemand_schaut()) {
        va_stand(['aufgabe' => null, 'pausiert' => true, 'text' => 'Pausiert – gerade läuft eine Wiedergabe']);
        sleep(20);
        continue;
    }

    // ---- 1. optimierte Fassungen ----
    $o = db_zeile("SELECT * FROM optimiert WHERE status IN ('laeuft', 'wartet') ORDER BY status = 'laeuft' DESC, erstellt_am, id LIMIT 1");
    if ($o) {
        $datei = db_zeile('SELECT * FROM dateien WHERE id = :d AND fehlt_seit IS NULL', ['d' => $o['datei_id']]);
        if (!$datei || !is_file((string) $datei['pfad'])) {
            db_tun("UPDATE optimiert SET status = 'fehler', fehler = 'Quelldatei fehlt' WHERE id = :id", ['id' => $o['id']]);
            continue;
        }
        db_tun("UPDATE optimiert SET status = 'laeuft', fortschritt = 0, fehler = NULL WHERE id = :id", ['id' => $o['id']]);
        $titel = basename((string) $datei['pfad']);
        va_protokoll("Optimiere {$titel} → {$o['hoehe']}p");
        $letzte = 0;
        $abbruch = optimiert_ordner() . '/.abbruch-' . $o['id'];
        try {
            $ok = optimiert_umwandeln($o, $datei, static function (float $anteil) use ($o, $titel, &$letzte, $abbruch): ?bool {
                if (time() - $letzte >= 5) {
                    $letzte = time();
                    if (is_file($abbruch) || !db_wert('SELECT id FROM optimiert WHERE id = :id', ['id' => $o['id']])) {
                        @unlink($abbruch);
                        return false;
                    }
                    db_tun('UPDATE optimiert SET fortschritt = :f WHERE id = :id', ['f' => round($anteil * 100, 2), 'id' => $o['id']]);
                    $pause = jemand_schaut();
                    va_stand(['aufgabe' => 'optimiert', 'titel' => $titel, 'hoehe' => (int) $o['hoehe'], 'anteil' => $anteil, 'pausiert' => $pause,
                        'text' => ($pause ? 'Pausiert: ' : '') . "Optimierte Fassung {$o['hoehe']}p: {$titel}"]);
                    return $pause ? null : true;
                }
                return jemand_schaut() ? null : true;
            });
            va_protokoll($ok ? 'fertig' : 'abgebrochen');
            if (!$ok && db_wert('SELECT id FROM optimiert WHERE id = :id', ['id' => $o['id']])) {
                db_tun("UPDATE optimiert SET status = 'wartet', fortschritt = 0 WHERE id = :id", ['id' => $o['id']]);
            }
        } catch (Throwable $e) {
            va_protokoll('Fehler: ' . $e->getMessage());
            db_tun("UPDATE optimiert SET status = 'fehler', fehler = :f WHERE id = :id", ['f' => mb_substr($e->getMessage(), 0, 2000), 'id' => $o['id']]);
        }
        continue;
    }

    // ---- 2. Vorschaubilder ----
    if (!empty(server_einstellungen(true)['vorschaubilder'])) {
        $naechste = null;
        $offen = 0;
        foreach (db_alle('SELECT * FROM dateien WHERE fehlt_seit IS NULL AND dauer_ms > 0 AND breite > 0 ORDER BY hinzugefuegt_am DESC, id DESC') as $d) {
            if (vorschau_info($d) === null && !vorschau_gescheitert($d)) {
                $offen++;
                $naechste ??= $d;
            }
        }
        if ($naechste) {
            $titel = basename((string) $naechste['pfad']);
            va_stand(['aufgabe' => 'vorschau', 'titel' => $titel, 'anteil' => 0, 'offen' => $offen, 'pausiert' => false, 'text' => "Vorschaubilder: {$titel}"]);
            try {
                $letzte = 0;
                $ok = vorschau_erzeugen($naechste, static function (float $anteil) use ($titel, $offen, &$letzte): bool {
                    if (jemand_schaut()) {
                        return false; // abbrechen, später neu anfangen (dauert pro Datei nur Sekunden bis Minuten)
                    }
                    if (time() - $letzte >= 3) {
                        $letzte = time();
                        va_stand(['aufgabe' => 'vorschau', 'titel' => $titel, 'anteil' => $anteil, 'offen' => $offen, 'pausiert' => false, 'text' => "Vorschaubilder: {$titel}"]);
                    }
                    return true;
                });
                if ($ok) {
                    va_protokoll("Vorschaubilder fertig: {$titel}");
                }
            } catch (Throwable $e) {
                va_protokoll("Vorschaubilder {$titel}: " . $e->getMessage());
                vorschau_fehler_merken($naechste, $e->getMessage());
            }
            continue;
        }
    }
    break; // nichts mehr zu tun
}
va_stand(['aufgabe' => null, 'pausiert' => false, 'text' => 'Nichts zu tun', 'ende' => time()]);
flock($sperre, LOCK_UN);
