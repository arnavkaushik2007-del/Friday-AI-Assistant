# Starts FRIDAY as a background app: server hidden, then an app-style window with no tabs.
# Safe to run twice - it reuses a server that is already up.
param([switch]$NoWindow)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path (Join-Path $logDir 'app.log') -Append | Out-Null

function Get-Token {
  $cfgPath = Join-Path $root 'friday.config.json'
  if (-not (Test-Path $cfgPath)) { return $null }
  try { return (Get-Content $cfgPath -Raw | ConvertFrom-Json).token } catch { return $null }
}

function Get-Port {
  $cfgPath = Join-Path $root 'friday.config.json'
  if (Test-Path $cfgPath) {
    try { $p = (Get-Content $cfgPath -Raw | ConvertFrom-Json).port; if ($p) { return [int]$p } } catch { }
  }
  return 4173
}

$port = Get-Port
$token = Get-Token
$url = "http://localhost:$port/"
if ($token) { $url = "http://localhost:$port/?t=$token" }

function Test-Friday {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/health" -Headers @{ 'x-friday-token' = $token } -TimeoutSec 3
    return $r.StatusCode -eq 200
  } catch { return $false }
}

if (-not (Test-Friday)) {
  Write-Host '  starting FRIDAY in the background...'
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = 'node.exe' }
  Start-Process -FilePath $node -ArgumentList 'server.js', '--no-open' -WorkingDirectory $root -WindowStyle Hidden
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 750
    if (Test-Friday) { $ready = $true; break }
  }
  if (-not $ready) {
    Write-Host '  FRIDAY did not start. Log: data\app.log'
    Stop-Transcript | Out-Null
    exit 1
  }
}

if ($NoWindow) { Write-Host '  server ready'; Stop-Transcript | Out-Null; exit 0 }

# An app-style window: no tabs, no address bar, its own profile so the mic permission sticks.
$browsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$browser = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1
$profileDir = Join-Path $logDir 'app-profile'

if ($browser) {
  $args = @(
    "--app=$url",
    "--user-data-dir=$profileDir",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,ChromeWhatsNewUI',
    '--window-size=520,900'
  )
  Start-Process -FilePath $browser -ArgumentList $args
  Write-Host "  window opened  ($([System.IO.Path]::GetFileName($browser)))"
} else {
  Start-Process $url
  Write-Host '  no Chrome/Edge found - opened in the default browser'
}

Stop-Transcript | Out-Null
