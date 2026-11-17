# Kleines Update des Bluewave-Clients: wartet, bis der Client beendet ist, ersetzt die geladenen Teile
# („app“: resources\app ohne mpv plus Texte im Programmordner, „mpv“: resources\app\mpv) und startet Bluewave neu.
# Der Client startet dieses Skript aus seinem Programmordner; die neuen Dateien liegen im Ordner $Stufe.
param(
  [Parameter(Mandatory = $true)][string]$Ziel,
  [Parameter(Mandatory = $true)][string]$Stufe,
  [string]$Version = '',
  [int[]]$Warten = @(),
  [switch]$OhneStart
)
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'bluewave-teilupdate.log'
function Log($t) { Add-Content -LiteralPath $log -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $t) }
Log "Start: $Ziel <- $Stufe ($Version)"

foreach ($id in $Warten) { try { Wait-Process -Id $id -Timeout 30 -ErrorAction SilentlyContinue } catch {} }
Get-Process -Name 'bluewave-engine', 'bluewave-mpv', 'bluewave-nvprofil' -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_ | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue } catch {}
  if (-not $_.HasExited) { try { $_ | Stop-Process -Force } catch {} }
}
Start-Sleep -Milliseconds 800

$ok = $true
function Spiegeln($von, $nach, $ohne) {
  if (-not (Test-Path -LiteralPath $von)) { return }
  $a = @($von, $nach, '/MIR', '/R:5', '/W:1', '/NJH', '/NJS', '/NP', '/NFL', '/NDL')
  if ($ohne) { $a += @('/XD', $ohne) }
  & robocopy @a | Out-Null
  $c = $LASTEXITCODE
  Log "robocopy $von -> $nach : $c"
  if ($c -ge 8) { $script:ok = $false }
}

$app = Join-Path $Ziel 'resources\app'
if (Test-Path -LiteralPath (Join-Path $Stufe 'app')) {
  # resources\app spiegeln, mpv dabei auslassen (eigener Teil); Texte im Programmordner ersetzen
  Spiegeln (Join-Path $Stufe 'app\resources\app') $app (Join-Path $app 'mpv')
  Get-ChildItem -LiteralPath (Join-Path $Stufe 'app') -File -ErrorAction SilentlyContinue | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $Ziel -Force }
}
if (Test-Path -LiteralPath (Join-Path $Stufe 'mpv')) {
  Spiegeln (Join-Path $Stufe 'mpv\resources\app\mpv') (Join-Path $app 'mpv') $null
}
if ($ok) {
  Copy-Item -LiteralPath (Join-Path $Stufe 'komponenten.json') -Destination (Join-Path $Ziel 'komponenten.json') -Force
  if ($Version) {
    $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BluewaveClient'
    if (Test-Path $k) { Set-ItemProperty -Path $k -Name DisplayVersion -Value $Version -ErrorAction SilentlyContinue }
  }
  Log 'fertig'
} else {
  # etwas ging schief: beim nächsten Start sucht der Client erneut und nimmt dann das volle Paket
  Remove-Item -LiteralPath (Join-Path $Ziel 'komponenten.json') -Force -ErrorAction SilentlyContinue
  Log 'FEHLER – komponenten.json entfernt, nächstes Update kommt als volles Paket'
}
if (-not $OhneStart) { Start-Process -FilePath (Join-Path $Ziel 'Bluewave Client.exe') -WorkingDirectory $Ziel }
Remove-Item -LiteralPath $Stufe -Recurse -Force -ErrorAction SilentlyContinue
