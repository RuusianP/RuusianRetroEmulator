# =============================================================================
# Ruusian Retro Emulator — one-line installer for Windows (PowerShell)
#
# Usage (one line):
#   iwr -useb https://raw.githubusercontent.com/RuusianP/RuusianRetroEmulator/main/install.ps1 | iex
#
# Ensures Node.js 18+ and git are installed (via winget, falling back to
# chocolatey), then runs the cross-platform installer.
# =============================================================================

$ErrorActionPreference = 'Stop'

$AppName   = 'Ruusian Retro Emulator'
$InstallUrl = 'https://raw.githubusercontent.com/RuusianP/RuusianRetroEmulator/main/install.js'

function Write-Info($msg)  { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Fail($msg)  { Write-Host "  $msg" -ForegroundColor Red; exit 1 }

function Test-Command($name) {
  try { Get-Command $name -ErrorAction Stop | Out-Null; return $true }
  catch { return $false }
}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Node-Ok {
  if (-not (Test-Command 'node')) { return $false }
  try {
    node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
    return $true
  } catch { return $false }
}

function Install-Node {
  if (Node-Ok) {
    $v = & node -v
    Write-Info "Node.js $v detected."
    return
  }
  Write-Warn "Node.js 18+ is required — installing it …"
  if (Test-Command 'winget') {
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Fail "winget failed to install Node.js." }
  } elseif (Test-Command 'choco') {
    choco install nodejs-lts -y
  } else {
    Write-Fail "Neither winget nor chocolatey is available. Install Node.js 18+ from https://nodejs.org and re-run."
  }
  Refresh-Path
  if (-not (Node-Ok)) { Write-Fail "Node.js was not installed successfully. Open a new terminal and re-run the installer." }
  Write-Info "Node.js $(& node -v) installed."
}

function Install-Git {
  if (Test-Command 'git') { return }
  Write-Warn "git is missing — installing it …"
  if (Test-Command 'winget') {
    winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Fail "winget failed to install git." }
  } elseif (Test-Command 'choco') {
    choco install git -y
  } else {
    Write-Fail "Could not install git. Install it from https://git-scm.com and re-run."
  }
  Refresh-Path
  if (-not (Test-Command 'git')) { Write-Fail "git was not installed successfully. Open a new terminal and re-run." }
}

function Main {
  Write-Host "$AppName — installer"
  Write-Host ""
  Write-Info "Detected environment: Windows ($($PSVersionTable.PSVersion))"

  Install-Node
  Install-Git

  $tmp = Join-Path $env:TEMP ('ruusian-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $script = Join-Path $tmp 'install.js'

  Write-Info "Downloading the installer …"
  try {
    Invoke-WebRequest -Uri $InstallUrl -OutFile $script -UseBasicParsing
  } catch {
    Write-Fail "Failed to download the installer: $($_.Exception.Message)"
  }

  & node $script $args
}

Main
