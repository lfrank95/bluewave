<?php
// Ausweis des Servers: ein Schlüsselpaar (Ed25519), beim ersten Bedarf erzeugt und unter cache/geheimnisse abgelegt
// (damit in jeder Sicherung des Caches dabei, ohne Datenbank lesbar). Der öffentliche Schlüssel ist die feste Kennung des
// Servers – egal welche IP er hat. Der Windows-Client merkt sich diese Kennung und lässt sich beim Wiederfinden beweisen,
// dass es wirklich derselbe Server ist (Unterschrift über eine Zufallszahl und die Adresse, unter der er ihn anspricht).
declare(strict_types=1);
require_once __DIR__ . '/geheimnisse.php';

const AUSWEIS_ZWECK = 'bluewave-ausweis-v1';

/** Geheimer Schlüssel (64 Byte) – beim ersten Aufruf erzeugt */
function ausweis_geheim(): string
{
    static $sk = null;
    if ($sk !== null) {
        return $sk;
    }
    $roh = base64_decode(geheimnis_lesen('ausweis.key'), true);
    if ($roh === false || strlen($roh) !== SODIUM_CRYPTO_SIGN_SECRETKEYBYTES) {
        $roh = sodium_crypto_sign_secretkey(sodium_crypto_sign_keypair());
        geheimnis_schreiben('ausweis.key', base64_encode($roh));
    }
    return $sk = $roh;
}

function ausweis_oeffentlich(): string
{
    return sodium_crypto_sign_publickey_from_secretkey(ausweis_geheim());
}

/** Kurze, lesbare Kennung: BW-7K3F-92QX (Base32 ohne verwechselbare Zeichen) */
function ausweis_kennung(?string $pk = null): string
{
    $h = hash('sha256', $pk ?? ausweis_oeffentlich(), true);
    $abc = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    $bits = '';
    for ($i = 0; $i < 5; $i++) {
        $bits .= str_pad(decbin(ord($h[$i])), 8, '0', STR_PAD_LEFT);
    }
    $z = '';
    for ($i = 0; $i < 8; $i++) {
        $z .= $abc[bindec(substr($bits, $i * 5, 5))];
    }
    return 'BW-' . substr($z, 0, 4) . '-' . substr($z, 4, 4);
}

/** Für /ping: Schlüssel und Kennung (null, wenn sich der Ausweis nicht anlegen lässt – z. B. Cache schreibgeschützt) */
function ausweis_ping(): ?array
{
    try {
        $pk = ausweis_oeffentlich();
        return ['schluessel' => bin2hex($pk), 'kennung' => ausweis_kennung($pk)];
    } catch (Throwable $e) {
        return null;
    }
}

/** Host kleingeschrieben, ohne Standard-Port (so bilden ihn auch Browser und Node: URL.host) */
function ausweis_host_norm(string $host): string
{
    return (string) preg_replace('/:(80|443)$/', '', strtolower(trim($host)));
}

/** Beweis für die Zufallszahl des Fragenden, gebunden an den Host, unter dem er uns angesprochen hat */
function ausweis_beweis(string $zufall): array
{
    $pk = ausweis_oeffentlich();
    $host = ausweis_host_norm((string) ($_SERVER['HTTP_HOST'] ?? ''));
    $nachricht = AUSWEIS_ZWECK . '|' . $zufall . '|' . bin2hex($pk) . '|' . $host;
    return ['schluessel' => bin2hex($pk), 'kennung' => ausweis_kennung($pk), 'zufall' => $zufall, 'host' => $host,
        'unterschrift' => bin2hex(sodium_crypto_sign_detached($nachricht, ausweis_geheim()))];
}
