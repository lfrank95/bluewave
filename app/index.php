<?php
// Vorläufige Startseite: Systemstatus (Datenbank, Ordner, Transkodieren). Die eigentliche App folgt.
declare(strict_types=1);
require_once __DIR__ . '/includes/hilfen.php';
$heim = bw_ist_heimnetz();
$v = htmlspecialchars(konfig()['version']);
header('Cache-Control: no-store');
?><!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#070b12">
    <meta name="robots" content="noindex">
    <title>Bluewave</title>
    <link rel="icon" href="/img/logo.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/css/app.css?v=<?= $v ?>">
    <script src="/js/status.js?v=<?= $v ?>" defer></script>
</head>
<body>
<header class="kopf">
    <img src="/img/logo.svg" alt="" width="36" height="36">
    <h1>Bluewave</h1>
    <span class="version"><?= $v ?></span>
</header>
<main class="seite">
<?php if (!$heim): ?>
    <section class="glass-panel">
        <h2>Noch nicht von unterwegs</h2>
        <p class="leise">Bluewave läuft. Die Verwaltung ist bis zur fertigen Anmeldung nur direkt im Heimnetz erreichbar.</p>
    </section>
<?php else: ?>
    <section class="glass-panel" id="transkodieren">
        <div class="zeile-kopf">
            <h2>Transkodieren</h2>
            <span class="abzeichen" id="hw-profil">…</span>
        </div>
        <p class="leise" id="hw-geraet"></p>
        <ul class="warnungen" id="hw-warnungen"></ul>
        <div class="faehigkeiten" id="hw-faehigkeiten"></div>
        <div class="knoepfe">
            <button class="knopf" id="hw-erkennen" type="button">Neu erkennen</button>
            <button class="knopf haupt" id="hw-test" type="button">Transkodierung testen</button>
        </div>
        <div id="hw-test-ergebnis"></div>
        <p class="leise klein">Das Profil stellst du in der Unraid-Vorlage bzw. in der .env ein (HWACCEL). Hier siehst du, was tatsächlich läuft.</p>
    </section>
    <section class="glass-panel">
        <h2>System</h2>
        <dl class="liste" id="system"></dl>
    </section>
    <section class="glass-panel">
        <h2>Ordner</h2>
        <ul class="ordner" id="ordner"></ul>
    </section>
<?php endif; ?>
</main>
</body>
</html>
