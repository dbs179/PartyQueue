# Build a share-safe zip of PartyQueue with NO credentials.
# Uses an explicit allow-list: unexpected local files are never copied.
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
  $includeDirs = @(
    ".github",
    "e2e",
    "public",
    "scripts",
    "src",
    "test"
  )
  $includeFiles = @(
    ".dockerignore",
    ".env.example",
    ".gitignore",
    "docker-compose.yml",
    "Dockerfile",
    "LICENSE",
    "package.json",
    "package-lock.json",
    "playwright.config.mjs",
    "README.md"
  )

  foreach ($name in $includeDirs) {
    $source = Join-Path $Root $name
    if (Test-Path $source -PathType Container) {
      Copy-Item -Path $source -Destination (Join-Path $staging $name) -Recurse -Force
    }
  }

  foreach ($name in $includeFiles) {
    $source = Join-Path $Root $name
    if (Test-Path $source -PathType Leaf) {
      Copy-Item -Path $source -Destination (Join-Path $staging $name) -Force
    }
  }

  # Only ship shared default banners (match .gitignore whitelist). Keep local
  # event art / uploads / retouch files out of share zips.
  $bannerAllow = @(
    "pc-banner-vinyl.jpg",
    "pc-banner-speakers.jpg",
    "pc-banner-backyard.jpg",
    "pc-banner-karaoke.jpg",
    "pc-banner-records.jpg",
    "md-banner-vinyl.jpg",
    "md-banner-speakers.jpg",
    "md-banner-backyard.jpg",
    "md-banner-karaoke.jpg",
    "md-banner-records.jpg"
  )
  $bannerDir = Join-Path $staging "public\banners"
  if (Test-Path $bannerDir) {
    Get-ChildItem -Path $bannerDir -File -Force | Where-Object {
      $bannerAllow -notcontains $_.Name
    } | Remove-Item -Force
  }

  # Fail closed if a future allow-listed directory contains a credential store
  # or generated diagnostic artifact.
  $forbiddenNames = @(
    ".env",
    ".env.*",
    "*.env",
    "*.env.*",
    "data",
    "node_modules",
    ".git",
    ".cursor",
    "test-results",
    "playwright-report",
    ".tmp-*",
    ".override-*",
    "*.log",
    "*.trace",
    "*.zip"
  )
  $unsafe = Get-ChildItem -Path $staging -Force -Recurse | Where-Object {
    $item = $_
    if ($item.Name -eq ".env.example") { return $false }
    $forbiddenNames | Where-Object { $item.Name -like $_ } | Select-Object -First 1
  }
  if ($unsafe) {
    $relative = $unsafe | ForEach-Object {
      $_.FullName.Substring($staging.Length).TrimStart("\", "/")
    }
    throw "Share package rejected forbidden path(s): $($relative -join ', ')"
  }

  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force

  $sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
  Write-Output "Share-safe package created:"
  Write-Output "  $zipPath"
  Write-Output "  size: ${sizeMb} MB"
  Write-Output "  policy: explicit source allow-list; credentials and diagnostics excluded"
  Write-Output "Recipients configure APIs in Settings (or copy .env.example -> .env)."
}
finally {
  if (Test-Path $staging) {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
}
