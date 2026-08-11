param(
  [switch]$AllowDirty,
  [string]$UnraidHost = "10.10.1.30",
  [string]$UnraidUser = "root",
  [string]$RemoteShare = "\\10.10.1.30\appdata\PartyQueue",
  [string]$RemotePath = "/mnt/user/appdata/PartyQueue",
  [string]$IdentityFile = "$HOME\.ssh\partyqueue_unraid_ed25519",
  [string]$BaseUrl = "http://10.10.1.30:8088",
  # Kept for callers that still pass -HealthUrl; derived from BaseUrl otherwise.
  [string]$HealthUrl = ""
)

if (-not $HealthUrl) {
  $HealthUrl = "$BaseUrl/api/health"
}
$ReadyUrl = "$BaseUrl/api/ready"
$RoomsUrl = "$BaseUrl/api/rooms"
$AppUrl = "$BaseUrl/"

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
  # Dockerfile client-build stage needs scripts/build-client.mjs (and keeps
  # future script deps in sync without listing each file).
  Invoke-Robocopy (Join-Path $staging "scripts") (Join-Path $RemoteShare "scripts")
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
  # chown keeps the mounted data volume writable by the container's non-root
  # node user (uid/gid 1000) introduced with the hardened Dockerfile.
  $remoteCommand =
    "cd $RemotePath && mkdir -p data && chown -R 1000:1000 data && " +
    "docker compose build --no-cache && docker compose up -d"
  & ssh -i $IdentityFile -o BatchMode=yes $target $remoteCommand
  if ($LASTEXITCODE -ne 0) {
    throw "The Unraid Docker rebuild failed."
  }

  Write-Host "Waiting for PartyQueue v$expectedVersion (liveness) ..."
  $deadline = (Get-Date).AddMinutes(2)
  $health = $null
  $live = $false
  do {
    Start-Sleep -Seconds 2
    try {
      $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
      if ($health.ok -and $health.version -eq $expectedVersion) {
        $live = $true
        break
      }
    } catch {
      # The container may still be starting.
    }
  } while ((Get-Date) -lt $deadline)

  if (-not $live) {
    $actualVersion = if ($health -and $health.version) { $health.version } else { "unavailable" }
    throw "Health verification failed: expected v$expectedVersion, got $actualVersion."
  }

  Write-Host "Checking readiness + party control plane ..."
  $readyDeadline = (Get-Date).AddMinutes(2)
  $ready = $null
  $partyOk = $false
  do {
    try {
      $ready = Invoke-RestMethod -Uri $ReadyUrl -TimeoutSec 5
      if (
        $ready.version -eq $expectedVersion -and
        $ready.ready -eq $true -and
        $ready.partyReady -eq $true
      ) {
        $partyOk = $true
        break
      }
    } catch {
      # 503 while data volume / startup settles.
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $readyDeadline)

  if (-not $partyOk) {
    $detail = if ($ready) {
      "ready=$($ready.ready) partyReady=$($ready.partyReady) " +
      "dataWritable=$($ready.checks.dataWritable) " +
      "spotifyConfigured=$($ready.checks.spotifyConfigured) " +
      "sonos=$($ready.checks.sonos) " +
      "sonosHostConfigured=$($ready.checks.sonosHostConfigured)"
    } else {
      "ready endpoint unavailable"
    }
    throw "Readiness verification failed for v$expectedVersion ($detail)."
  }

  # Smoke: UI shell + rooms. Rooms may 503 if Sonos is briefly offline; allow
  # that only when a speaker host is configured (rediscovery path exists).
  try {
    $app = Invoke-WebRequest -Uri $AppUrl -TimeoutSec 5 -UseBasicParsing
    if ($app.StatusCode -ne 200) {
      throw "App shell returned HTTP $($app.StatusCode)."
    }
  } catch {
    throw "App shell smoke failed: $($_.Exception.Message)"
  }

  try {
    $roomsResponse = Invoke-WebRequest -Uri $RoomsUrl -TimeoutSec 8 -UseBasicParsing
    if ($roomsResponse.StatusCode -ne 200) {
      throw "Rooms smoke returned HTTP $($roomsResponse.StatusCode)."
    }
  } catch {
    if ($ready.checks.sonosHostConfigured) {
      Write-Warning "Rooms smoke failed but SONOS_HOST is configured; continuing. $($_.Exception.Message)"
    } else {
      throw "Rooms / Sonos smoke failed (no SONOS_HOST configured): $($_.Exception.Message)"
    }
  }

  Write-Host "Deployed PartyQueue v$expectedVersion successfully (live + partyReady)."
  return
} finally {
  Set-Location $repo
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
