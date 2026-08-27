# P4.5 Packaging: one-command release build for Windows.
#
# Produces release/DevForgeStudio containing:
#   - dist/            built UI (vite) + self-runnable server bundle (server.cjs)
#   - node_modules/    production dependencies needed by server.cjs
#   - Start DevForge Studio.cmd   double-click launcher (starts server, opens browser)
#   - README.txt
#
# Optional switches:
#   -DesktopShortcut   create a desktop shortcut pointing at the launcher
#   -AutoStart         also place the shortcut in the user's Startup folder
#   -SignPfx <path>    PFX certificate used with signtool to sign output files
#                      (best-effort; skipped silently when signtool is absent)
#   -SignPassword <p>  password for the PFX
#
# Usage:  powershell -File scripts/package.ps1 [-DesktopShortcut] [-AutoStart]
param(
  [switch]$DesktopShortcut,
  [switch]$AutoStart,
  [string]$SignPfx,
  [string]$SignPassword
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root 'release'
$appDir = Join-Path $release 'DevForgeStudio'

Write-Host "== Building UI + server bundle ==";
Push-Location $root
try {
  npx vite build
  if ($LASTEXITCODE -ne 0) { throw 'vite build failed' }
  npx esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs
  if ($LASTEXITCODE -ne 0) { throw 'esbuild failed' }
} finally {
  Pop-Location
}

if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

Write-Host "== Assembling $appDir =="
Copy-Item (Join-Path $root 'dist') (Join-Path $appDir 'dist') -Recurse

# Minimal runtime manifest so `npm install --omit=dev` pulls ONLY what
# server.cjs can require() at runtime.
$runtimeDeps = @{
  cors        = '*'
  diff        = '*'
  dotenv      = '*'
  express     = '*'
  ignore      = '*'
  'pdf-parse' = '*'
}
$manifest = @{
  name    = 'devforge-studio'
  private = $true
  version = '1.0.0'
  dependencies = $runtimeDeps
} | ConvertTo-Json -Depth 4
Set-Content -Path (Join-Path $appDir 'package.json') -Value $manifest -Encoding UTF8

Write-Host '== Installing production dependencies (this needs Node + npm) =='
Push-Location $appDir
try {
  npm install --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw 'npm install in release folder failed' }
} finally {
  Pop-Location
}

$launcher = @'
@echo off
title DevForge Studio
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found on PATH.
  echo Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
start "DevForge Server" /min cmd /c "node dist\server.cjs"
timeout /t 2 /nobreak >nul
start http://127.0.0.1:3000
'@
Set-Content -Path (Join-Path $appDir 'Start DevForge Studio.cmd') -Value $launcher -Encoding ASCII

$readme = @"
DevForge Studio — local-first agentic coding studio
====================================================

Requirements: Node.js on PATH, and Ollama running locally for models.

Run:
  Double-click "Start DevForge Studio.cmd"
  (or:  node dist\server.cjs  then open http://127.0.0.1:3000 )

LAN access (tablet/phone on same network), opt-in:
  set DEVFORGE_HOST=lan
  node dist\server.cjs
  -> copy the printed URL including its auth token onto your other device.

Everything stays on this machine. No cloud calls are made.
"@
Set-Content -Path (Join-Path $appDir 'README.txt') -Value $readme -Encoding UTF8

# ---- Optional signing (best-effort) --------------------------------------
if ($SignPfx) {
  $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($signtool) {
    Write-Host '== Signing output files =='
    & signtool.exe sign /fd SHA256 /f $SignPfx /p $SignPassword (Join-Path $appDir 'dist\server.cjs') | Out-Null
  } else {
    Write-Warning 'signtool.exe not found — skipping signing (install the Windows SDK).'
  }
}

# ---- Shortcuts ------------------------------------------------------------
function New-LauncherShortcut($destinationPath) {
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($destinationPath)
  $sc.TargetPath = (Join-Path $appDir 'Start DevForge Studio.cmd')
  $sc.WorkingDirectory = $appDir
  $sc.Description = 'DevForge Studio (local AI coding studio)'
  $sc.Save()
}

if ($DesktopShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  New-LauncherShortcut (Join-Path $desktop 'DevForge Studio.lnk')
  Write-Host 'Desktop shortcut created.'
}
if ($AutoStart) {
  $startup = [Environment]::GetFolderPath('Startup')
  New-LauncherShortcut (Join-Path $startup 'DevForge Studio.lnk')
  Write-Host 'Startup shortcut created (server auto-starts at login).'
}

Write-Host ''
Write-Host "✅ Packaged into $appDir"
Write-Host '   Double-click "Start DevForge Studio.cmd" to launch.'
