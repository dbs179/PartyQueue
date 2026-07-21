param(
  [switch]$AllowDirty,
  [string]$UnraidHost = "10.10.1.30",
  [string]$UnraidUser = "root",
  [string]$RemoteShare = "\\10.10.1.30\appdata\PartyQueue",
  [string]$RemotePath = "/mnt/user/appdata/PartyQueue",
  [string]$IdentityFile = "$HOME\.ssh\partyqueue_unraid_ed25519",
  [string]$HealthUrl = "http://10.10.1.30:8088/api/health"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$staging = Join-Path ([System.IO.Path]::GetTempPath()) (
  "partyqueue-deploy-" + [guid]::NewGuid().ToString("N")
)
$archive = "$staging.zip"

function Invoke-Robocopy {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  & robocopy $Source $Destination /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -gt 7) {
    throw "Robocopy failed for $Source with exit code $LASTEXITCODE."
  }
}

try {
  Set-Location $repo

  $trackedChanges = git status --porcelain --untracked-files=no
  if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect the Git working tree."
  }
  if ($trackedChanges -and -not $AllowDirty) {
    throw "Deployment requires a clean tracked working tree. Commit changes first."
  }
  if ($trackedChanges) {
    Write-Warning "Deploying HEAD only; uncommitted changes are excluded."
  }
  if (-not (Test-Path $RemoteShare -PathType Container)) {
    throw "Unraid appdata share is unavailable: $RemoteShare"
  }
  if (-not (Test-Path $IdentityFile -PathType Leaf)) {
    throw "Unraid deployment key is missing: $IdentityFile"
  }

  New-Item -ItemType Directory -Path $staging | Out-Null
  git archive --format=zip --output="$archive" HEAD
  if ($LASTEXITCODE -ne 0) {
    throw "Could not archive the committed PartyQueue source."
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $staging -Force

  $expectedVersion = (Get-Content (Join-Path $staging "package.json") -Raw |
      ConvertFrom-Json).version
  if (-not $expectedVersion) {
    throw "The committed package version is missing."
  }

  Write-Host "Uploading PartyQueue v$expectedVersion to $RemoteShare ..."
  Invoke-Robocopy (Join-Path $staging "src") (Join-Path $RemoteShare "src")
  Invoke-Robocopy (Join-Path $staging "public") (Join-Path $RemoteShare "public")
  foreach ($file in @(
      ".dockerignore",
      "Dockerfile",
      "docker-compose.yml",
      "package.json",
      "package-lock.json"
    )) {
    Copy-Item -LiteralPath (Join-Path $staging $file) `
      -Destination (Join-Path $RemoteShare $file) -Force
  }

  Write-Host "Rebuilding PartyQueue on Unraid ..."
  $target = "$UnraidUser@$UnraidHost"
  $remoteCommand =
    "cd $RemotePath && docker compose build --no-cache && docker compose up -d"
  & ssh -i $IdentityFile -o BatchMode=yes $target $remoteCommand
  if ($LASTEXITCODE -ne 0) {
    throw "The Unraid Docker rebuild failed."
  }

  Write-Host "Waiting for PartyQueue v$expectedVersion ..."
  $deadline = (Get-Date).AddMinutes(2)
  $deployed = $false
  do {
    Start-Sleep -Seconds 2
    try {
      $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
      if ($health.ok -and $health.version -eq $expectedVersion) {
        $deployed = $true
        break
      }
    } catch {
      # The container may still be starting.
    }
  } while ((Get-Date) -lt $deadline)

  if ($deployed) {
    Write-Host "Deployed PartyQueue v$expectedVersion successfully."
    return
  }
  $actualVersion = if ($health.version) { $health.version } else { "unavailable" }
  throw "Health verification failed: expected v$expectedVersion, got $actualVersion."
} finally {
  Set-Location $repo
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
