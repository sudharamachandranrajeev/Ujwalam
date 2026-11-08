# SPDX-License-Identifier: GPL-3.0-or-later
<#
.SYNOPSIS
  Installs an unzipped Ujwalam alpha build for the current user (no admin rights), or rolls back to the previous one.

.DESCRIPTION
  Run from the unzipped folder:  powershell -ExecutionPolicy Bypass -File .\Install-Ujwalam.ps1
  1. Checks Node.js (release.json nodeMin, on PATH) and the Microsoft Visual C++ 2015-2022 x64 runtime (registry read).
     If one is missing it reports it and stops. It never installs anything.
  2. Verifies every file against SHA256SUMS.txt (missing, changed or extra files stop the install).
  3. Copies the build to <InstallRoot>\<version> (default %LOCALAPPDATA%\Ujwalam), verifies the copy again, then
     points current.txt at it; the version it replaces is kept and named in previous.txt.
  4. Copies Ujwalam.cmd to <InstallRoot>\Ujwalam.cmd (it runs the version in current.txt) and creates Start-menu and
     desktop shortcuts to it. User data stays in <InstallRoot>\data and is never touched.
  -Rollback swaps current.txt and previous.txt (both folders must exist). Nothing is ever deleted.

.PARAMETER InstallRoot   Default %LOCALAPPDATA%\Ujwalam.
.PARAMETER Rollback      Switch back to the previous version.
.PARAMETER Force         Reinstall a version that is already installed (the old folder is renamed, not deleted).
.PARAMETER NoShortcuts   Skip the shortcuts.
.PARAMETER StartMenuDir  Default: the user's Start menu Programs folder.
.PARAMETER DesktopDir    Default: the user's desktop.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot,
  [switch]$Rollback,
  [switch]$Force,
  [switch]$NoShortcuts,
  [string]$StartMenuDir,
  [string]$DesktopDir
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$ShortcutName = 'Ujwalam (alpha).lnk'
# LIVE start (D281): configures the stream targets (keys from Windows Credential Manager); nothing goes live until
# Start stream and the typed "yes, on air".
$LiveShortcutName = 'Ujwalam (alpha, LIVE).lnk'

function Say([string]$m) { Write-Host "[install] $m" }
function Fail([string]$m, [int]$code) { Write-Host "[install] STOP: $m"; exit $code }

if (-not $InstallRoot) {
  if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is not set; pass -InstallRoot' 2 }
  $InstallRoot = Join-Path $env:LOCALAPPDATA 'Ujwalam'
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$currentFile = Join-Path $InstallRoot 'current.txt'
$previousFile = Join-Path $InstallRoot 'previous.txt'

function Read-Pointer([string]$f) {
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
  $v = (Get-Content -LiteralPath $f -TotalCount 1)
  if ($null -eq $v) { return $null }
  $v = $v.Trim()
  if ($v -notmatch '^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$') { return $null }
  return $v
}

function Write-Pointer([string]$f, [string]$v) {
  $tmp = "$f.partial"
  [System.IO.File]::WriteAllText($tmp, "$v`r`n", (New-Object System.Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination $f -Force
}

# ---- rollback ------------------------------------------------------------------------------------------------------
if ($Rollback) {
  $cur = Read-Pointer $currentFile
  $prev = Read-Pointer $previousFile
  if (-not $prev) { Fail "no previous version recorded in $previousFile" 5 }
  if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $InstallRoot $prev) 'Ujwalam.cmd'))) { Fail "previous version folder $prev is missing" 5 }
  Write-Pointer $currentFile $prev
  if ($cur) { Write-Pointer $previousFile $cur }
  Say "rolled back: current $prev (was $cur); run Install-Ujwalam.ps1 -Rollback again to switch back"
  exit 0
}

# ---- package -------------------------------------------------------------------------------------------------------
$pkg = $PSScriptRoot
$releaseFile = Join-Path $pkg 'release.json'
if (-not (Test-Path -LiteralPath $releaseFile)) { Fail 'release.json not found next to this script: run it from the unzipped build folder' 2 }
$release = Get-Content -LiteralPath $releaseFile -Raw | ConvertFrom-Json
$version = [string]$release.version
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$') { Fail "release.json version '$version' is not 0.1.0-alpha.N" 2 }
Say "Ujwalam $version -> $InstallRoot\$version"

# ---- prerequisites (read only; nothing is installed) --------------------------------------------------------------
$problems = @()
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
  $problems += "Node.js $($release.nodeMin) or newer is not on PATH (install it from nodejs.org, then run this again)"
} else {
  $nv = (& $node.Source --version 2>$null)
  $have = [version]((([string]$nv).Trim().TrimStart('v') -split '-')[0])
  $need = [version]([string]$release.nodeMin)
  if ($have -lt $need) { $problems += "Node.js $have is too old: $need or newer is needed" } else { Say "Node.js $have (needs $need): ok" }
}
$vc = $null
foreach ($k in @('HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\X64')) {
  try { $p = Get-ItemProperty -LiteralPath $k -ErrorAction Stop; if ($p.Installed -eq 1) { $vc = $p; break } } catch { }
}
if (-not $vc) {
  $problems += 'Microsoft Visual C++ 2015-2022 Redistributable (x64) is not installed (download vc_redist.x64.exe from Microsoft, then run this again)'
} else {
  $vcv = [version]("{0}.{1}.{2}" -f $vc.Major, $vc.Minor, $vc.Bld)
  $min = $null
  if ($release.PSObject.Properties.Name -contains 'vcRuntimeMin' -and $release.vcRuntimeMin) { $min = [version]([string]$release.vcRuntimeMin) }
  if ($min -and $vcv -lt $min) { $problems += "Visual C++ runtime $vcv is older than $min (the host was built with that toolset): update vc_redist.x64.exe" }
  else { Say "Visual C++ x64 runtime $vcv$(if ($min) { " (needs $min)" }): ok" }
}
if ($problems.Count) { foreach ($p in $problems) { Write-Host "[install] MISSING: $p" }; Fail 'prerequisites missing; nothing was installed' 6 }

# ---- checksums ----------------------------------------------------------------------------------------------------
function Test-Sums([string]$root) {
  $sumsFile = Join-Path $root 'SHA256SUMS.txt'
  if (-not (Test-Path -LiteralPath $sumsFile)) { return @('SHA256SUMS.txt is missing') }
  $bad = @()
  $listed = @{}
  foreach ($line in Get-Content -LiteralPath $sumsFile) {
    if (-not $line.Trim()) { continue }
    if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { $bad += "bad line in SHA256SUMS.txt"; continue }
    $hash = $Matches[1]; $rel = $Matches[2]
    if ($rel -match '(^|/)\.\.(/|$)' -or $rel.StartsWith('/') -or $rel -match '^[A-Za-z]:') { $bad += "unsafe path $rel"; continue }
    $listed[$rel.ToLowerInvariant()] = $true
    $f = Join-Path $root ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { $bad += "missing $rel"; continue }
    # .NET SHA256, not Get-FileHash: the Utility module fails to load in Windows PowerShell 5.1 started from pwsh 7 (inherited PSModulePath).
    $fs = [System.IO.File]::OpenRead($f)
    try { $h = ([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($fs)) -replace '-', '').ToLowerInvariant() } finally { $fs.Dispose() }
    if ($h -ne $hash) { $bad += "changed $rel" }
  }
  $rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File -Force) {
    $rel = $f.FullName.Substring($rootFull.Length) -replace '\\', '/'
    if ($rel -eq 'SHA256SUMS.txt') { continue }
    if (-not $listed.ContainsKey($rel.ToLowerInvariant())) { $bad += "extra file $rel" }
  }
  return $bad
}

Say 'verifying SHA256SUMS.txt ...'
$bad = @(Test-Sums $pkg)
if ($bad.Count) { $bad | Select-Object -First 20 | ForEach-Object { Write-Host "[install]   $_" }; Fail "$($bad.Count) checksum problem(s) in the unzipped build; unzip it again" 7 }
Say 'checksums ok'

# ---- copy ---------------------------------------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
$target = Join-Path $InstallRoot $version
$pkgFull = [System.IO.Path]::GetFullPath($pkg).TrimEnd('\')
if ($pkgFull -ieq $target.TrimEnd('\')) { Fail 'run this from the unzipped build, not from the installed folder' 2 }
if (Test-Path -LiteralPath $target) {
  if (-not $Force) { Fail "$version is already installed in $target (use -Force to reinstall it; the old folder is kept, renamed)" 4 }
  $kept = "$target.replaced-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
  Move-Item -LiteralPath $target -Destination $kept
  Say "old $version folder kept as $kept"
}
$staging = Join-Path $InstallRoot ".staging-$version-$PID"
Copy-Item -LiteralPath $pkg -Destination $staging -Recurse
$bad = @(Test-Sums $staging)
if ($bad.Count) { Fail "the copy in $staging failed verification ($($bad[0])); it was left there for inspection" 7 }
Move-Item -LiteralPath $staging -Destination $target

$cur = Read-Pointer $currentFile
if ($cur -and $cur -ne $version) { Write-Pointer $previousFile $cur }
Write-Pointer $currentFile $version
Copy-Item -LiteralPath (Join-Path $pkg 'Ujwalam.cmd') -Destination (Join-Path $InstallRoot 'Ujwalam.cmd') -Force
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'data') | Out-Null
Say "installed: current $version$(if ($cur -and $cur -ne $version) { ", previous $cur (Install-Ujwalam.ps1 -Rollback switches back)" })"

# ---- shortcuts ----------------------------------------------------------------------------------------------------
if (-not $NoShortcuts) {
  if (-not $StartMenuDir) { $StartMenuDir = [Environment]::GetFolderPath('Programs') }
  if (-not $DesktopDir) { $DesktopDir = [Environment]::GetFolderPath('Desktop') }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($dir in @($StartMenuDir, $DesktopDir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $lnk = $shell.CreateShortcut((Join-Path $dir $ShortcutName))
    $lnk.TargetPath = Join-Path $InstallRoot 'Ujwalam.cmd'
    $lnk.Arguments = '--allow-devices' # capture card, facecam, mic (user, 2026-11-08, D282)
    $lnk.WorkingDirectory = $InstallRoot
    $lnk.Description = 'Ujwalam alpha with devices (runs the version in current.txt)'
    $lnk.Save()
    Say "shortcut: $(Join-Path $dir $ShortcutName)"
    $lnk = $shell.CreateShortcut((Join-Path $dir $LiveShortcutName))
    $lnk.TargetPath = Join-Path $InstallRoot 'Ujwalam.cmd'
    $lnk.Arguments = '--live --allow-devices'
    $lnk.WorkingDirectory = $InstallRoot
    $lnk.Description = 'Ujwalam alpha, stream targets set up (going live still needs Start stream and the typed yes, on air)'
    $lnk.Save()
    Say "shortcut: $(Join-Path $dir $LiveShortcutName)"
  }
}

# ---- older versions (reported, never deleted) ---------------------------------------------------------------------
$keep = @($version, (Read-Pointer $previousFile)) | Where-Object { $_ }
$older = Get-ChildItem -LiteralPath $InstallRoot -Directory | Where-Object { $_.Name -match '^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+' -and $keep -notcontains $_.Name }
if ($older) { Say "older folders you may remove by hand: $(($older | ForEach-Object { $_.Name }) -join ', ')" }
Say 'done. Start Ujwalam from the shortcut, or run Ujwalam.cmd in the install folder.'
exit 0
