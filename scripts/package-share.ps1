# Build a share-safe zip of PartyQueue with NO credentials.
# Excludes: .env, data/, node_modules/, logs, local backups, git metadata.
#
# Usage (from repo root or anywhere):
#   powershell -ExecutionPolicy Bypass -File scripts\package-share.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\package-share.ps1 -OutDir C:\APPS\PartyQueue-backups

param(
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) {
  $OutDir = Join-Path (Split-Path -Parent $Root) "PartyQueue-backups"
}

$pkg = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$zipName = "PartyQueue-share-v$version-$stamp.zip"
$zipPath = Join-Path $OutDir $zipName

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("pq-share-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Force -Path $staging | Out-Null

try {
  $excludeDirs = @(
    "node_modules",
    "data",
    ".git",
    ".cursor"
  )
  $excludeFiles = @(
    ".env",
    "*.log",
    "npm-debug.log*"
  )

  Get-ChildItem -Path $Root -Force | ForEach-Object {
    $name = $_.Name
    if ($excludeDirs -contains $name) { return }
    if ($name -eq ".env") { return }
    if ($name -like "*.log") { return }
    Copy-Item -Path $_.FullName -Destination (Join-Path $staging $name) -Recurse -Force
  }

  # Belt-and-suspenders: never ship secrets even if something slipped through.
  $envCopy = Join-Path $staging ".env"
  if (Test-Path $envCopy) { Remove-Item $envCopy -Force }
  $dataCopy = Join-Path $staging "data"
  if (Test-Path $dataCopy) { Remove-Item $dataCopy -Recurse -Force }

  # Ensure recipients get the example env, not a real one.
  $example = Join-Path $Root ".env.example"
  if (Test-Path $example) {
    Copy-Item $example (Join-Path $staging ".env.example") -Force
  }

  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force

  $sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
  Write-Output "Share-safe package created:"
  Write-Output "  $zipPath"
  Write-Output "  size: ${sizeMb} MB"
  Write-Output "  excluded: .env, data/, node_modules/, .git"
  Write-Output "Recipients configure APIs in Settings (or copy .env.example -> .env)."
}
finally {
  if (Test-Path $staging) {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
}
