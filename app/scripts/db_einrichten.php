<?php
// Beim Containerstart (Compose-Stack): Datenbank und Zugang automatisch anlegen – ohne Passwörter in der .env.
// Ablauf wie bei Amberwave: MariaDB startet nur mit Root ohne Passwort (internes Stack-Netz). Hier werden Datenbank und
// Benutzer angelegt (geheimnisse/datenbank.json), danach bekommt Root ein zufälliges Passwort (geheimnisse/db_root_passwort).
// Wiederholbar: Fehlt nur die Datei oder nur die Datenbank, wird angeglichen. Bricht den Start nie ab.
declare(strict_types=1);
require_once __DIR__ . '/../includes/geheimnisse.php';

$k = konfig();
if (getenv('BLUEWAVE_AIO') === '1') {
    exit(0); // All-in-One: aio.sh legt alles über den Socket an
}
if ($k['db']['quelle'] === 'env') {
    echo "Datenbank: Zugang aus der .env\n";
    exit(0);
}

function root_verbinden(string $host, int $port): ?PDO
{
    $kandidaten = array_values(array_unique(array_filter([trim((string) getenv('DB_ROOT_PASSWORD')), geheimnis_lesen('db_root_passwort')], 'strlen')));
    $kandidaten[] = '';
    foreach ($kandidaten as $pw) {
        try {
            return new PDO("mysql:host=$host;port=$port;charset=utf8mb4", 'root', $pw, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
        } catch (Throwable $e) {
            $GLOBALS['letzter_fehler'] = $e->getMessage();
        }
    }
    return null;
}

$host = $k['db']['host'];
$port = (int) $k['db']['port'];

// Auf die Datenbank warten (erster Start von MariaDB dauert etwas)
$root = null;
for ($i = 0; $i < 60; $i++) {
    // Zugang schon da und funktioniert? Dann nur prüfen und fertig.
    if ($k['db']['quelle'] === 'datei') {
        try {
            new PDO("mysql:host=$host;port=$port;dbname={$k['db']['name']};charset=utf8mb4", $k['db']['user'], $k['db']['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
            echo "Datenbank: Zugang funktioniert\n";
            exit(0);
        } catch (Throwable $e) {
            // weiter: evtl. Datenbank neu (Ordner gelöscht) – dann mit Root angleichen
        }
    }
    $root = root_verbinden($host, $port);
    if ($root) {
        break;
    }
    sleep(2);
}
if (!$root) {
    fwrite(STDERR, 'Datenbank: kein Zugang als root – ' . ($GLOBALS['letzter_fehler'] ?? 'nicht erreichbar') . "\n");
    fwrite(STDERR, "Datenbank: Steht ein DB_ROOT_PASSWORD in der .env, muss es stimmen.\n");
    exit(0);
}

$d = @json_decode(geheimnis_lesen('datenbank.json'), true);
if (!is_array($d) || empty($d['passwort'])) {
    $d = ['name' => 'bluewave', 'user' => 'bluewave', 'passwort' => bin2hex(random_bytes(20))];
}
if (!preg_match('/^\w{1,64}$/', (string) $d['name']) || !preg_match('/^\w{1,32}$/', (string) $d['user'])) {
    fwrite(STDERR, "Datenbank: geheimnisse/datenbank.json ist ungültig – Datei löschen und neu starten.\n");
    exit(0);
}
try {
    $n = '`' . $d['name'] . '`';
    $u = $root->quote($d['user']) . '@' . $root->quote('%');
    $root->exec("CREATE DATABASE IF NOT EXISTS $n CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    $root->exec("CREATE USER IF NOT EXISTS $u IDENTIFIED BY " . $root->quote($d['passwort']));
    $root->exec("ALTER USER $u IDENTIFIED BY " . $root->quote($d['passwort']));
    $root->exec('GRANT ALL PRIVILEGES ON `' . str_replace('_', '\\_', $d['name']) . "`.* TO $u");
    $root->exec('FLUSH PRIVILEGES');
} catch (Throwable $e) {
    fwrite(STDERR, 'Datenbank: Anlegen fehlgeschlagen – ' . $e->getMessage() . "\n");
    exit(0);
}
if (!geheimnis_schreiben('datenbank.json', (string) json_encode($d))) {
    fwrite(STDERR, "Datenbank: Konnte geheimnisse/datenbank.json nicht schreiben – ist der Cache-Ordner beschreibbar?\n");
    exit(0);
}
echo "Datenbank: „{$d['name']}“ und Zugang angelegt\n";

// Root absichern: nur wenn er noch ohne Passwort offen ist und kein DB_ROOT_PASSWORD in der .env steht
if (trim((string) getenv('DB_ROOT_PASSWORD')) === '') {
    try {
        $offen = new PDO("mysql:host=$host;port=$port", 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
        $neu = bin2hex(random_bytes(16));
        if (geheimnis_schreiben('db_root_passwort', $neu)) { // erst die Datei, dann die Datenbank – Notfallzugang geht nie verloren
            foreach ($offen->query("SELECT DISTINCT Host FROM mysql.user WHERE User = 'root'")->fetchAll(PDO::FETCH_COLUMN) as $h) {
                $offen->exec('ALTER USER ' . $offen->quote('root') . '@' . $offen->quote((string) $h) . ' IDENTIFIED BY ' . $offen->quote($neu));
            }
            echo "Datenbank: Root abgesichert (Notfallzugang: geheimnisse/db_root_passwort)\n";
        }
    } catch (Throwable $e) {
        // schon abgesichert
    }
}
