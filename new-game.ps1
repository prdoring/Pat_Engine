#Requires -Version 5
<#
.SYNOPSIS
  Scaffold a new game from this Pat_Engine baseline.
.DESCRIPTION
  Copies engine/ editors/ server/ data/ game/ + docs into the target, excluding
  .git, node_modules, and data/.backups. Renames the package, runs `git init` +
  an initial commit, and `npm install` (the only dep is `ws`). Refuses a
  non-empty target unless -Force.
.PARAMETER NameOrPath
  A bare name (creates ..\<name> next to the engine) or a full/relative path.
.EXAMPLE
  .\new-game.ps1 MyGame
.EXAMPLE
  .\new-game.ps1 C:\Games\MyGame -NoInstall -Force
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$NameOrPath,
  [switch]$NoInstall,
  [switch]$NoGit,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot

# A bare name (no path separators) lands next to the engine; a path is used as-is.
if ($NameOrPath -match '[\\/]') { $dest = $NameOrPath }
else { $dest = Join-Path (Split-Path $src -Parent) $NameOrPath }

$parent = Split-Path $dest -Parent
if (-not $parent) { $parent = (Get-Location).Path }
if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
$parent = (Resolve-Path $parent).Path
$name = Split-Path $dest -Leaf
$dest = Join-Path $parent $name

if ($dest -eq $src) { throw "Target is the engine itself. Choose a different name/path." }

# npm-safe package name from the folder name.
$pkgName = ($name.ToLower() -replace '[^a-z0-9._-]', '-') -replace '^[._-]+', ''
if (-not $pkgName) { $pkgName = 'my-game' }

if ((Test-Path $dest) -and -not $Force) {
  if (Get-ChildItem -Force -Path $dest -ErrorAction SilentlyContinue) {
    throw "Target exists and is not empty: $dest  (use -Force to copy into it)"
  }
}

Write-Host "Scaffolding new game:"
Write-Host "  from : $src"
Write-Host "  to   : $dest"
Write-Host "  name : $pkgName"

New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Copy the baseline, excluding VCS / deps / editor backups.
# robocopy /XD takes dir paths (top-level) and bare names (any depth). Exit < 8 = success.
$exGit = Join-Path $src '.git'
$exMod = Join-Path $src 'node_modules'
robocopy $src $dest /E /XD $exGit $exMod .backups /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
$global:LASTEXITCODE = 0

# Rename the package.
$pkg = Join-Path $dest 'package.json'
if (Test-Path $pkg) {
  $content = Get-Content -Raw $pkg
  $content = [regex]::Replace($content, '"name"\s*:\s*"[^"]*"', "`"name`": `"$pkgName`"", 1)
  Set-Content -NoNewline -Path $pkg -Value $content
}

# Fresh git history.
if (-not $NoGit -and (Get-Command git -ErrorAction SilentlyContinue)) {
  git -C $dest init -q -b main 2>$null
  if ($LASTEXITCODE -ne 0) { git -C $dest init -q 2>$null }
  git -C $dest add -A 2>$null
  git -C $dest commit -q -m "Initial commit: $pkgName (scaffolded from Pat_Engine)" 2>$null
  if ($LASTEXITCODE -eq 0) { Write-Host "  git  : initialized (branch main, initial commit)" }
  else { Write-Host "  git  : initialized (no commit — set git user.name/email, then commit)" }
  $global:LASTEXITCODE = 0
}

# Install deps.
if (-not $NoInstall -and (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "Installing dependencies (npm install)..."
  Push-Location $dest
  try { npm install --silent } catch { Write-Warning "npm install failed — run it manually in $dest" }
  Pop-Location
  $global:LASTEXITCODE = 0
}

Write-Host ""
Write-Host "Done. Next:"
Write-Host "  cd `"$dest`""
if ($NoInstall) { Write-Host "  npm install" }
Write-Host "  npm start        # http://localhost:6970  (editor: /editor)"
Write-Host ""
Write-Host "Make it yours: replace data\*.json and game\* — see AGENTS.md section 8."
