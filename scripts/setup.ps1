# FRIDAY - one time setup for Windows.
#   powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
# Installs the local brain (Ollama, portable), a bilingual female voice (Piper),
# downloads the model, then starts FRIDAY. No admin rights, no account, no subscription.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  !   $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  F R I D A Y  -  setup" -ForegroundColor White
Write-Host "  ----------------------------------------" -ForegroundColor DarkCyan

# ---- 1. node ----
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "  Node.js is required. Install it from https://nodejs.org (LTS), then run this again." -ForegroundColor Red
  exit 1
}
Ok ("node " + (node --version))

# ---- 2. folders ----
foreach ($d in @('tools', 'tools\bin', 'tools\ollama', 'tools\piper\voices', 'data', 'data\media', 'data\models')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null
}

# ---- 3. brain runtime (Ollama, portable zip, no installer) ----
$ollamaExe = Join-Path $root 'tools\ollama\ollama.exe'
if (-not (Test-Path $ollamaExe)) {
  Say 'Downloading the local brain (about 1.5 GB, one time)...'
  $zip = Join-Path $env:TEMP 'ollama-windows-amd64.zip'
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri 'https://ollama.com/download/ollama-windows-amd64.zip' -OutFile $zip
  Say 'Unpacking...'
  Expand-Archive -Path $zip -DestinationPath (Join-Path $root 'tools\ollama') -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path $ollamaExe)) { Write-Host "  Could not unpack Ollama." -ForegroundColor Red; exit 1 }
  Ok 'brain runtime installed'
} else {
  Ok 'brain runtime already installed'
}

# ---- 4. start the brain if it is not already answering ----
$modelsDir = Join-Path $root 'data\models'
$env:OLLAMA_MODELS = $modelsDir
$alive = $false
try { $alive = (Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200 } catch { $alive = $false }

if (-not $alive) {
  Say 'Starting the brain...'
  Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden -WorkingDirectory (Join-Path $root 'tools\ollama')
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 700
    try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $alive = $true; break } } catch {}
  }
  if ($alive) { Ok 'brain is up' } else { Warn 'brain did not start; FRIDAY will try again when it opens' }
}

# ---- 5. model ----
if ($alive) {
  $model = 'qwen2.5:3b-instruct'
  $cfgPath = Join-Path $root 'friday.config.json'
  if (Test-Path $cfgPath) {
    try { $model = (Get-Content $cfgPath -Raw | ConvertFrom-Json).model } catch {}
  }
  $have = $false
  try {
    $tags = (Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -UseBasicParsing).Content | ConvertFrom-Json
    $have = ($tags.models | Where-Object { $_.name -like "$model*" }).Count -gt 0
  } catch {}
  if ($have) {
    Ok "model $model ready"
  } else {
    Say "Downloading model $model (about 2 GB, one time)..."
    & $ollamaExe pull $model
    Ok 'model ready'
  }
}

# ---- 6. voice (Piper, offline neural, female Hindi + English) ----
$piperExe = Join-Path $root 'tools\piper\piper\piper.exe'
if (-not (Test-Path $piperExe)) {
  Say 'Downloading the offline voice engine...'
  $pz = Join-Path $env:TEMP 'piper_windows.zip'
  Invoke-WebRequest -Uri 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip' -OutFile $pz
  Expand-Archive -Path $pz -DestinationPath (Join-Path $root 'tools\piper') -Force
  Remove-Item $pz -Force -ErrorAction SilentlyContinue
  Ok 'voice engine installed'
} else {
  Ok 'voice engine already installed'
}

$voices = @(
  @{ file = 'hi_IN-priyamvada-medium.onnx'; url = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx' },
  @{ file = 'en_US-amy-medium.onnx'; url = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx' }
)
$progress = $ProgressPreference
$ProgressPreference = 'SilentlyContinue'
foreach ($v in $voices) {
  $dest = Join-Path $root ("tools\piper\voices\" + $v.file)
  if (Test-Path $dest) { continue }
  Say ("Downloading voice " + $v.file + " ...")
  Invoke-WebRequest -Uri $v.url -OutFile $dest
  Invoke-WebRequest -Uri ($v.url + '.json') -OutFile ($dest + '.json')
}
$ProgressPreference = $progress
Ok 'voices ready (Hindi + English, female)'

Write-Host "  ----------------------------------------" -ForegroundColor DarkCyan
Write-Host "  Setup complete. Starting FRIDAY..." -ForegroundColor White
Write-Host ""

# ---- 7. go ----
node server.js
