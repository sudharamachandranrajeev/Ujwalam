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
  4. Copies ujwalam-start.exe and Ujwalam.cmd to <InstallRoot> (both run the version in current.txt) and creates
     Start-menu and desktop shortcuts to ujwalam-start.exe, which starts Ujwalam with no console window and writes the
     launcher's output to <InstallRoot>\data\core\logs\launcher-*.log (D191; Ujwalam.cmd stays for a terminal).
     User data stays in <InstallRoot>\data and is never touched.
  -Rollback swaps current.txt and previous.txt (both folders must exist). Nothing is ever deleted.

.PARAMETER InstallRoot   Default %LOCALAPPDATA%\Ujwalam.
.PARAMETER Rollback      Switch back to the previous version.
.PARAMETER Force         Reinstall a version that is already installed (the old folder is renamed, not deleted).
.PARAMETER NoShortcuts   Skip the shortcuts.
.PARAMETER StartMenuDir  Default: the user's Start menu Programs folder.
.PARAMETER DesktopDir    Default: the user's desktop.
.PARAMETER ClipsWhenRecording  Clips after a recording: ask (ask each time), after (make clips when it stops),
                         while (find moments while recording, edit them into clips when it stops) or off.
.PARAMETER ClipsWhenLive       The same for a live stream.
.PARAMETER RecordingsFolder    Where recordings are saved ('' = the default). Used from the next start.
.PARAMETER ClipsFolder         Where finished clips are saved ('' = the default).
.PARAMETER ClipMaker           Folder that holds services\clip and its Python venv (the zip ships no Python);
                         written to data\ujwalam.json as clipRoot ('' removes it).
.PARAMETER SettingsOnly  Only apply the settings above; install nothing.
  The settings are the same ones as Settings in the studio window (data\core\settings.json, D284). Only the settings
  you pass are changed; everything else in the data folder is left as it is.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot,
  [switch]$Rollback,
  [switch]$Force,
  [switch]$NoShortcuts,
  [string]$StartMenuDir,
  [string]$DesktopDir,
  [ValidateSet('ask', 'after', 'while', 'off')][string]$ClipsWhenRecording,
  [ValidateSet('ask', 'after', 'while', 'off')][string]$ClipsWhenLive,
  [string]$RecordingsFolder,
  [string]$ClipsFolder,
  [string]$ClipMaker,
  [switch]$SettingsOnly
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
# ---- settings (D284) ------------------------------------------------------------------------------------------------
function Read-JsonFile([string]$f) {
  $h = [ordered]@{}
  if (Test-Path -LiteralPath $f) {
    $o = Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = $p.Value }
  }
  return $h
}
function Write-JsonFile([string]$f, $h) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $f) | Out-Null
  $tmp = "$f.tmp"
  [IO.File]::WriteAllText($tmp, ($h | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $f -Force
}
function Test-Folder([string]$name, [string]$dir) {
  if ($dir -eq '') { return }
  if (-not [IO.Path]::IsPathRooted($dir) -or $dir.StartsWith('\\')) { Fail "$name must be a full path on this PC (like D:\Videos\Ujwalam)" 2 }
  $full = [IO.Path]::GetFullPath($dir).TrimEnd('\') + '\'
  $inst = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
  if ($full.StartsWith($inst, [StringComparison]::OrdinalIgnoreCase) -and -not $full.StartsWith((Join-Path $inst 'data\'), [StringComparison]::OrdinalIgnoreCase)) { Fail "$name may not be inside the install folder" 2 }
}
# Only the settings passed are written: -ClipMaker alone leaves settings.json alone (no file = the studio's first-run
# welcome still asks how to make clips).
$appSettingsGiven = $PSBoundParameters.ContainsKey('ClipsWhenRecording') -or $PSBoundParameters.ContainsKey('ClipsWhenLive') -or
  $PSBoundParameters.ContainsKey('RecordingsFolder') -or $PSBoundParameters.ContainsKey('ClipsFolder')
$settingsGiven = $appSettingsGiven -or $PSBoundParameters.ContainsKey('ClipMaker')
if ($appSettingsGiven) {
  Test-Folder 'RecordingsFolder' $RecordingsFolder
  Test-Folder 'ClipsFolder' $ClipsFolder
  $sf = Join-Path $InstallRoot 'data\core\settings.json'
  $s = Read-JsonFile $sf
  $clips = [ordered]@{ recording = 'ask'; live = 'ask' }
  if ($s.Contains('clips') -and $s['clips']) { foreach ($p in $s['clips'].PSObject.Properties) { $clips[$p.Name] = $p.Value } }
  $folders = [ordered]@{ recordings = $null; clips = $null }
  if ($s.Contains('folders') -and $s['folders']) { foreach ($p in $s['folders'].PSObject.Properties) { $folders[$p.Name] = $p.Value } }
  if ($PSBoundParameters.ContainsKey('ClipsWhenRecording')) { $clips['recording'] = $ClipsWhenRecording }
  if ($PSBoundParameters.ContainsKey('ClipsWhenLive')) { $clips['live'] = $ClipsWhenLive }
  if ($PSBoundParameters.ContainsKey('RecordingsFolder')) { $folders['recordings'] = $(if ($RecordingsFolder) { $RecordingsFolder } else { $null }) }
  if ($PSBoundParameters.ContainsKey('ClipsFolder')) { $folders['clips'] = $(if ($ClipsFolder) { $ClipsFolder } else { $null }) }
  $s['$comment'] = 'Ujwalam settings (Settings in the studio window). D284.'
  $s['clips'] = $clips
  $s['folders'] = $folders
  Write-JsonFile $sf $s
  Say "settings: clips when recording $($clips['recording']), when live $($clips['live']); recordings $(if ($folders['recordings']) { $folders['recordings'] } else { 'default' }); clips $(if ($folders['clips']) { $folders['clips'] } else { 'default' })"
}
if ($PSBoundParameters.ContainsKey('ClipMaker')) {
  if ($ClipMaker -and -not (Test-Path -LiteralPath (Join-Path $ClipMaker 'services\clip\clipper.py'))) { Fail "ClipMaker: no services\clip\clipper.py in $ClipMaker" 2 }
  $uf = Join-Path $InstallRoot 'data\ujwalam.json'
  $u = Read-JsonFile $uf
  if ($ClipMaker) { $u['clipRoot'] = $ClipMaker } elseif ($u.Contains('clipRoot')) { $u.Remove('clipRoot') }
  Write-JsonFile $uf $u
  Say "clip maker: $(if ($ClipMaker) { $ClipMaker } else { 'not set' })"
}
if ($SettingsOnly) {
  if (-not $settingsGiven) { Fail 'SettingsOnly needs at least one setting' 2 }
  exit 0
}

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
# The shortcuts' target: a windowless exe that runs the version in current.txt (no console window, D191; 2026-11-08).
Copy-Item -LiteralPath (Join-Path $pkg 'ujwalam-start.exe') -Destination (Join-Path $InstallRoot 'ujwalam-start.exe') -Force
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
    $lnk.TargetPath = Join-Path $InstallRoot 'ujwalam-start.exe'
    $lnk.Arguments = '--allow-devices' # capture card, facecam, mic (user, 2026-11-08, D282)
    $lnk.WorkingDirectory = $InstallRoot
    $lnk.Description = 'Ujwalam alpha with devices (runs the version in current.txt)'
    $lnk.Save()
    Say "shortcut: $(Join-Path $dir $ShortcutName)"
    $lnk = $shell.CreateShortcut((Join-Path $dir $LiveShortcutName))
    $lnk.TargetPath = Join-Path $InstallRoot 'ujwalam-start.exe'
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
Say 'done. Start Ujwalam from the shortcut (no console window; close the studio window to stop), or run Ujwalam.cmd in the install folder from a terminal.'
exit 0
