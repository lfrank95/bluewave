# Prüft den gebauten Windows-Client auf echtem Windows (GitHub Actions, windows-latest):
# Dateiangaben aller eigenen Programmdateien, mpv und Ton-Engine laufen, Selbsttest Videofenster (mpv per --wid),
# der Client startet ohne Fehler, stilles Update (/aktualisieren) ohne Klicks.
param([Parameter(Mandatory)] [string] $Ordner, [Parameter(Mandatory)] [string] $Paket)
$ErrorActionPreference = 'Stop'
$app = Join-Path $Ordner 'resources\app'

Write-Host '== Dateiangaben'
$dateien = @(Get-Item $Paket) + @(Get-ChildItem $Ordner -Recurse -Include 'Bluewave*.exe', 'bluewave-*.exe' | Where-Object { $_.Name -ne 'bluewave-mpv.exe' })   # mpv trägt seine eigenen Angaben
$fehlt = @()
foreach ($f in $dateien) {
  $i = $f.VersionInfo
  Write-Host ("  {0}: {1} | {2} | {3} | {4}" -f $f.Name, $i.CompanyName, $i.FileDescription, $i.ProductVersion, $i.LegalCopyright)
  if (-not $i.CompanyName -or -not $i.FileDescription -or -not $i.ProductVersion -or $i.LegalCopyright -notmatch '©') { $fehlt += $f.Name }
}
if ($dateien.Count -lt 4) { Write-Host "::error title=Windows-Client::nur $($dateien.Count) Programmdateien gefunden"; exit 1 }
if ($fehlt) { Write-Host "::error title=Windows-Client::unvollständige Dateiangaben: $($fehlt -join ', ')"; exit 1 }

Write-Host '== mpv'
$mpv = Join-Path $app 'mpv\bluewave-mpv.exe'
$v = & $mpv --no-config --version 2>&1 | Select-Object -First 1
Write-Host "  $v"
if ($v -notmatch '^mpv ') { Write-Host "::error title=mpv::mpv.exe startet nicht ($v)"; exit 1 }
& $mpv --no-config --vo=null --ao=null --frames=20 'av://lavfi:testsrc=duration=2:size=320x180' 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Write-Host "::error title=mpv::Testbild lässt sich nicht abspielen ($LASTEXITCODE)"; exit 1 }
$geraete = & $mpv --no-config --ao=wasapi --audio-device=help 2>&1
Write-Host "  Tongeräte laut mpv: $(($geraete | Select-String "'wasapi/").Count)"

Write-Host '== NV-Profil (Smooth Motion lesen; der Läufer hat keine NVIDIA-Karte)'
$nv = & (Join-Path $app 'engine\bluewave-nvprofil.exe') status bluewave-mpv.exe 2>&1
Write-Host "  $nv"
if ("$nv" -notmatch '"nvidia":') { Write-Host "::error title=NV-Profil::keine Antwort"; exit 1 }

Write-Host '== Ton-Engine'
$eng = Join-Path $app 'engine\bluewave-engine.exe'
$aus = "{`"c`":`"geraete`"}`n{`"c`":`"beenden`"}`n" | & $eng 2>&1
$aus | Select-Object -First 3 | ForEach-Object { Write-Host "  $($_.ToString().Substring(0, [Math]::Min(200, $_.ToString().Length)))" }
if (-not ($aus -match '"e":"bereit"') -or -not ($aus -match '"e":"geraete"')) { Write-Host "::error title=Engine::Engine antwortet nicht"; exit 1 }

Write-Host '== Selbsttest Videofenster (mpv per --wid in Electron)'
$daten = Join-Path $env:RUNNER_TEMP 'bwdaten'
New-Item -ItemType Directory -Force $daten | Out-Null
$env:BW_DATEN = $daten
$env:BW_TEST_VIDEO = 'av://lavfi:testsrc2=duration=30:size=1280x720:rate=24'
$p = Start-Process -FilePath (Join-Path $Ordner 'Bluewave Client.exe') -PassThru
# Bildschirmfoto der Stelle, an der der Client das Bildfenster meldet: Farben (Testbild) oder nur Schwarz?
Add-Type -AssemblyName System.Drawing
$gesehen = @{}
$bilder = @{}
$bis = (Get-Date).AddSeconds(70)
while (-not $p.HasExited -and (Get-Date) -lt $bis) {
  Start-Sleep -Milliseconds 400
  $cl = Join-Path $daten 'log\client.log'
  if (-not (Test-Path $cl)) { continue }
  foreach ($z in (Get-Content $cl | Select-String 'SELBSTTEST-BEREIT (\w+) (-?\d+) (-?\d+) (\d+) (\d+)')) {
    $m = $z.Matches[0].Groups; $art = $m[1].Value
    if ($gesehen[$art]) { continue }
    $gesehen[$art] = $true
    Start-Sleep -Milliseconds 800
    $x = [int]$m[2].Value + 30; $y = [int]$m[3].Value + 30; $w = [int]$m[4].Value - 60; $h = [int]$m[5].Value - 60
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
    $farben = @{}; $hell = 0; $n = 0
    for ($i = 0; $i -lt $w; $i += 17) { for ($j = 0; $j -lt $h; $j += 17) {
      $c = $bmp.GetPixel($i, $j); $n++
      if (($c.R + $c.G + $c.B) -gt 90) { $hell++ }
      $farben[(($c.R -shr 5) * 64) + (($c.G -shr 5) * 8) + ($c.B -shr 5)] = 1 } }
    $bmp.Save((Join-Path $env:RUNNER_TEMP "bildfenster-$art.png"))
    $g.Dispose(); $bmp.Dispose()
    $bilder[$art] = @{ farben = $farben.Count; hell = [math]::Round(100 * $hell / [math]::Max(1, $n)) }
    Write-Host "  Bild im Fenster ($art): $($farben.Count) Farbstufen, $($bilder[$art].hell) % hell"
  }
}
if (-not $p.WaitForExit(20000)) { $p | Stop-Process -Force; Write-Host "::error title=Selbsttest::Client nicht fertig" }
Remove-Item Env:\BW_TEST_VIDEO
foreach ($k in $bilder.Keys) { Write-Host "::notice title=Bildfenster $k::$($bilder[$k].farben) Farbstufen, $($bilder[$k].hell) % hell" }
$neu = $bilder['BildfensterDurch']
$probe = $bilder['Probe']
if (-not $probe -or $probe.farben -lt 8) { Write-Host "::warning title=Selbsttest::Bildschirmfoto taugt hier nicht (Gegenprobe $($probe.farben) Farbstufen) – Bildprüfung übersprungen" }
elseif (-not $neu -or $neu.farben -lt 8 -or $neu.hell -lt 15) { Write-Host "::error title=Selbsttest::im Bildfenster ist kein Bild zu sehen ($($neu.farben) Farbstufen)"; $bildFehler = $true }
$log = Get-Content (Join-Path $daten 'log\client.log') -Raw
$zeile = ($log -split "`n" | Select-String 'SELBSTTEST' | Select-Object -Last 1)
($log -split "`n" | Select-String 'SELBSTTEST-(VERGLEICH|SCHRITT)') | ForEach-Object { Write-Host "  $_" }
Write-Host "  $zeile"
if (Test-Path (Join-Path $daten 'log\mpv.log')) { Get-Content (Join-Path $daten 'log\mpv.log') | Select-Object -Last 8 | ForEach-Object { Write-Host "  mpv: $_" } }
if ($log -match 'ABSTURZ') { Write-Host "::error title=Selbsttest::Absturz im Client"; Write-Host $log; exit 1 }
if ("$zeile" -notmatch 'SELBSTTEST OK' -or $bildFehler) { Write-Host "::error title=Selbsttest::mpv im Videofenster: $zeile"; Write-Host $log; exit 1 }
Write-Host "::notice title=Selbsttest::$zeile"

Write-Host '== RIFE: 7-Zip, VapourSynth in mpv, Einrichtung und Einbindung (ohne NVIDIA-Karte: Bilder verdoppeln)'
$z = Join-Path $app 'engine\7zr.exe'
if (-not (Test-Path $z)) { Write-Host "::error title=RIFE::7zr.exe fehlt"; exit 1 }
$zaus = (& $z 2>&1 | Out-String)
if ($zaus -notmatch '7-Zip') { Write-Host "::error title=RIFE::7zr.exe antwortet nicht"; exit 1 }
$vfh = (& (Join-Path $app 'mpv\bluewave-mpv.exe') --vf=help 2>&1 | Out-String)
if ($vfh -notmatch 'vapoursynth') { Write-Host "::error title=RIFE::mpv kennt den Filter vapoursynth nicht" } else { Write-Host '  mpv: Filter vapoursynth vorhanden' }
Remove-Item -Recurse -Force (Join-Path $daten 'log') -ErrorAction SilentlyContinue
$env:BW_RIFE_ORDNER = Join-Path $env:RUNNER_TEMP 'bwrife'
$env:BW_TEST_RIFE = 'av://lavfi:testsrc2=duration=60:size=1280x720:rate=24000/1001'
$p = Start-Process -FilePath (Join-Path $Ordner 'Bluewave Client.exe') -PassThru
if (-not $p.WaitForExit(240000)) { $p | Stop-Process -Force; Write-Host "::error title=RIFE::Selbsttest nach 4 min nicht fertig" }
Remove-Item Env:\BW_TEST_RIFE
$log = Get-Content (Join-Path $daten 'log\client.log') -Raw
$zeile = ($log -split "`n" | Select-String 'SELBSTTEST RIFE' | Select-Object -Last 1)
Write-Host "  $zeile"
($log -split "`n" | Select-String 'RIFE' | Select-Object -Last 20) | ForEach-Object { Write-Host "  $_" }
if (Test-Path (Join-Path $daten 'log\mpv.log')) { Get-Content (Join-Path $daten 'log\mpv.log') | Select-Object -Last 10 | ForEach-Object { Write-Host "  mpv: $_" } }
Get-ChildItem $env:BW_RIFE_ORDNER -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  rife: $($_.Name)" }
if ("$zeile" -notmatch 'SELBSTTEST RIFE OK') { Write-Host "::error title=RIFE::$zeile"; exit 1 }
Write-Host "::notice title=RIFE::$zeile"
Get-Process -Name 'bluewave-mpv' -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host '== Kleines Update (teilupdate.ps1: app ersetzen, mpv bleibt)'
if (-not (Test-Path (Join-Path $Ordner 'komponenten.json'))) { Write-Host "::error title=Teilupdate::komponenten.json fehlt im Programmordner"; exit 1 }
$inst = Join-Path $env:RUNNER_TEMP 'bwinst'
$stufe = Join-Path $env:RUNNER_TEMP 'bwstufe'
Copy-Item -LiteralPath $Ordner -Destination $inst -Recurse
New-Item -ItemType Directory -Force (Join-Path $stufe 'app\resources') | Out-Null
Copy-Item -LiteralPath (Join-Path $inst 'resources\app') -Destination (Join-Path $stufe 'app\resources\app') -Recurse
Remove-Item -Recurse -Force (Join-Path $stufe 'app\resources\app\mpv')
Set-Content (Join-Path $stufe 'app\resources\app\neu.txt') 'neu'
Remove-Item -Force (Join-Path $stufe 'app\resources\app\suche.js')
Set-Content (Join-Path $stufe 'app\LIESMICH.txt') 'neue Fassung'
Set-Content (Join-Path $stufe 'komponenten.json') '{"version":"9.9.9","basis":"x","komponenten":{}}'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'teilupdate.ps1') -Ziel $inst -Stufe $stufe -Version '9.9.9' -OhneStart
$ia = Join-Path $inst 'resources\app'
$pruef = @{
  'neue Datei da' = (Test-Path (Join-Path $ia 'neu.txt'))
  'alte Datei weg' = -not (Test-Path (Join-Path $ia 'suche.js'))
  'mpv unverändert' = (Test-Path (Join-Path $ia 'mpv\bluewave-mpv.exe'))
  'Text ersetzt' = ((Get-Content (Join-Path $inst 'LIESMICH.txt') -Raw) -match 'neue Fassung')
  'Stand übernommen' = ((Get-Content (Join-Path $inst 'komponenten.json') -Raw) -match '9.9.9')
  'Stufe aufgeräumt' = -not (Test-Path $stufe)
}
$pruef.GetEnumerator() | ForEach-Object { Write-Host "  $($_.Key): $($_.Value)" }
if ($pruef.Values -contains $false) { Get-Content (Join-Path $env:TEMP 'bluewave-teilupdate.log') -ErrorAction SilentlyContinue | Write-Host; Write-Host "::error title=Teilupdate::nicht alles ersetzt"; exit 1 }
Remove-Item -Recurse -Force $inst

Write-Host '== Client startet (Einrichtung, ohne Server)'
Remove-Item -Recurse -Force (Join-Path $daten 'log') -ErrorAction SilentlyContinue
$p = Start-Process -FilePath (Join-Path $Ordner 'Bluewave Client.exe') -PassThru
Start-Sleep -Seconds 15
$log = Get-Content (Join-Path $daten 'log\client.log') -Raw
Get-Process -Name 'Bluewave Client', 'bluewave-engine' -ErrorAction SilentlyContinue | Stop-Process -Force
($log -split "`n" | Select-Object -First 12) | ForEach-Object { Write-Host "  $_" }
if ($log -notmatch 'Bluewave Windows-Client .* gestartet' -or $log -notmatch 'Engine gestartet') { Write-Host "::error title=Client::Start unvollständig"; exit 1 }
if ($log -match 'ABSTURZ|FEHLER unhandled') { Write-Host "::error title=Client::Fehler beim Start"; Write-Host $log; exit 1 }
Remove-Item Env:\BW_DATEN

Write-Host '== Stilles Update (/aktualisieren)'
$ort = "$env:LOCALAPPDATA\Programs\Bluewave"
New-Item -ItemType Directory -Force $ort | Out-Null
Copy-Item "$env:WINDIR\System32\whoami.exe" "$ort\Bluewave Client.exe"
Set-Content "$ort\alt.txt" 'alte Version'
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BluewaveClient'
New-Item -Force $k | Out-Null
Set-ItemProperty $k InstallLocation $ort
Set-ItemProperty $k DisplayVersion '0.0.1'
$p = Start-Process -FilePath $Paket -ArgumentList '/aktualisieren' -PassThru
if (-not $p.WaitForExit(240000)) { Write-Host "::error title=Stilles Update::Installer nach 4 Minuten nicht fertig (wartet er auf einen Klick?)"; exit 1 }
Start-Sleep -Seconds 5
$v = (Get-ItemProperty $k).DisplayVersion
$pkg = Get-Content "$ort\resources\app\package.json" -Raw | ConvertFrom-Json
$laeuft = Get-Process -Name 'Bluewave Client' -ErrorAction SilentlyContinue
Write-Host "  Eintrag: $v · Paket: $($pkg.version) · alt.txt noch da: $(Test-Path "$ort\alt.txt") · Client gestartet: $([bool]$laeuft)"
Get-Process -Name 'Bluewave Client', 'bluewave-engine', 'bluewave-mpv' -ErrorAction SilentlyContinue | Stop-Process -Force
if ($v -ne $pkg.version -or $v -eq '0.0.1') { Write-Host "::error title=Stilles Update::Version nicht aktualisiert ($v)"; exit 1 }
if (Test-Path "$ort\alt.txt") { Write-Host "::error title=Stilles Update::alte Dateien nicht ersetzt"; exit 1 }
if (-not $laeuft) { Write-Host "::error title=Stilles Update::Client nach dem Update nicht gestartet"; exit 1 }
if (-not (Test-Path "$ort\resources\app\mpv\bluewave-mpv.exe")) { Write-Host "::error title=Stilles Update::mpv fehlt in der Installation"; exit 1 }
Write-Host "::notice title=Windows-Client::geprüft – Dateiangaben, mpv, Engine, Videofenster, Start, stilles Update auf $v"
