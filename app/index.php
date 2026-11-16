<?php
// Bluewave Web-App (PWA): eine Seite, alles Weitere lädt das JavaScript über die API.
declare(strict_types=1);
require_once __DIR__ . '/includes/config.php';
$v = htmlspecialchars(konfig()['version']);
header('Cache-Control: no-store');
?><!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#070b12">
    <meta name="robots" content="noindex">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>Bluewave</title>
    <link rel="icon" href="/img/logo.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/img/icon-512.png">
    <link rel="manifest" href="/manifest.webmanifest">
    <link rel="stylesheet" href="/css/app.css?v=<?= $v ?>">
    <script type="module" src="/js/app.js?v=<?= $v ?>"></script>
</head>
<body>
<div id="app"><div class="laden-start"><img src="/img/logo.svg" alt="" width="64" height="64"></div></div>
</body>
</html>
