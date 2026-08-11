# Snapshot PartyQueue data/ (credentials + party state). Not share-safe.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\backup-data.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\backup-data.ps1 -Source Unraid
#   powershell -ExecutionPolicy Bypass -File scripts\backup-data.ps1 -Source Local

param(
  [ValidateSet("Unraid", "Local")]
  [string]$Source = "Unraid",
  [string]$UnraidDataShare = "\\10.10.1.30\appdata\PartyQueue\data",
  [string]$OutDir = "",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) {
  $OutDir = Join-Path (Split-Path -Parent $Root) "PartyQueue-backups"
}

if (-not $Version) {
  $Version = (Get-Content (Join-Path $Root "package.json") -Raw |
    ConvertFrom-Json).version
}

$dataSource = if ($Source -eq "Local") {
  Join-Path $Root "data"
} else {
  $UnraidDataShare
}

if (-not (Test-Path $dataSource -PathType Container)) {
  throw "Data directory not found: $dataSource"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$zipName = "PartyQueue-data-v$Version-$stamp.zip"
$zipPath = Join-Path $OutDir $zipName

$staging = Join-Path ([System.IO.Path]::GetTempPath()) (
  "pq-data-" + [guid]::NewGuid().ToString("n")
)
New-Item -ItemType Directory -Force -Path $staging | Out-Null

try {
  Copy-Item -Path (Join-Path $dataSource "*") -Destination $staging -Recurse -Force
  if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force
  $item = Get-Item -LiteralPath $zipPath
  Write-Host "Data backup created:"
  Write-Host "  $($item.FullName)"
  Write-Host ("  size: {0:N2} MB" -f ($item.Length / 1MB))
  Write-Host "  source: $dataSource"
  Write-Host "Restore: stop PartyQueue, extract into data/, chown 1000:1000 on Unraid, start."
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
