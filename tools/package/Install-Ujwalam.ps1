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

  Live install (LU6, D349): when a program under <InstallRoot> is running (found by its path, never by its name), the
  install never replaces a file the running copy uses. The new version goes into its own folder next to the running
  one; current.txt points the next start at it; a top-level launcher file that is in use is kept. Then the new version
  is handed to the running Ujwalam's update queue (only when its service-swap feature flag is on): nothing live ->
  the services are updated at once; live -> each service waits for one click on Apply now and the video engine (host)
  is staged for the stop. Without the flag, the new version runs from the next start.

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
# The default shortcut is the LIVE start (user, 2026-11-11, D354; was D281's separate LIVE shortcut): it configures
# the stream targets (keys from Windows Credential Manager); nothing goes live until the user clicks Start stream.
$ShortcutName = 'Ujwalam (alpha).lnk'
# Practice start: no stream targets, Start stream refused (the old default).
$PracticeShortcutName = 'Ujwalam (alpha, practice).lnk'
# Shortcut from earlier installs, replaced by the default one.
$OldLiveShortcutName = 'Ujwalam (alpha, LIVE).lnk'

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

# ---- running install (LU6, D349) -----------------------------------------------------------------------------------
# Processes whose program or command line lies under $dir (the install guard by path: never by process name, which
# would also catch test or development copies elsewhere). System.Management, not Get-CimInstance: the CIM module can
# fail to load in Windows PowerShell 5.1 started from pwsh 7 (inherited PSModulePath).
# Paths are compared after Norm-Path: '/' read as '\', repeated separators as one (a command line may name the install
# as C:/Users/.../Ujwalam/... or with escaped backslashes); always case-insensitive (Codex review of D349).
function Norm-Path([string]$s) {
  if (-not $s) { return '' }
  return [regex]::Replace($s.Replace('/', '\'), '(?<=.)\\{2,}', '\')
}
function Get-RunningUnder([string]$dir) {
  $d = Norm-Path ([System.IO.Path]::GetFullPath($dir).TrimEnd('\') + '\')
  $found = @()
  try {
    Add-Type -AssemblyName System.Management
    $q = New-Object System.Management.ManagementObjectSearcher('SELECT ProcessId, Name, ExecutablePath, CommandLine FROM Win32_Process')
    foreach ($p in $q.Get()) {
      $id = [int]$p['ProcessId']
      if ($id -eq $PID) { continue }
      $exe = Norm-Path ([string]$p['ExecutablePath']); $cmd = Norm-Path ([string]$p['CommandLine'])
      if ($exe.StartsWith($d, [StringComparison]::OrdinalIgnoreCase) -or $cmd.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $found += [pscustomobject]@{ Id = $id; Name = [string]$p['Name']; Exe = $exe; Cmd = $cmd }
      }
    }
  } catch { Fail "could not list running programs to check whether Ujwalam runs ($($_.Exception.Message)); nothing was installed" 8 }
  return $found
}

# A top-level file is in use when a running program is that file or names it on its command line; a folder (ending in
# '\') when a running program lies under it or names a path under it.
function Test-InUse($procs, [string]$file) {
  $file = Norm-Path $file
  foreach ($p in $procs) {
    if ($p.Exe -and ($p.Exe -ieq $file)) { return $true }
    if ($file.EndsWith('\') -and $p.Exe -and $p.Exe.StartsWith($file, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($p.Cmd -and $p.Cmd.IndexOf($file, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  }
  return $false
}

function Get-Sha256([string]$f) {
  $fs = [System.IO.File]::OpenRead($f)
  try { return ([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($fs)) -replace '-', '').ToLowerInvariant() } finally { $fs.Dispose() }
}

# Hands the installed new version to the running launcher (services/supervisor/install-channel.mjs): one JSON line out,
# one back. $null when there is no channel (flag off, an older version, or Ujwalam is just closing).
function Send-LiveInstall([string]$root, [int]$timeoutMs) {
  $chanFile = Join-Path $InstallRoot 'data\core\live\install-channel.json'
  if (-not (Test-Path -LiteralPath $chanFile -PathType Leaf)) { return $null }
  try { $ch = Get-Content -LiteralPath $chanFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  if ($ch.v -ne 1 -or [string]$ch.pipe -notmatch '^ujwalam-install-[0-9a-f]{32}$' -or [string]$ch.token -notmatch '^[0-9a-f]{64}$') { return $null }
  $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', [string]$ch.pipe, [System.IO.Pipes.PipeDirection]::InOut)
  try {
    try { $pipe.Connect(5000) } catch { return $null }
    $enc = New-Object System.Text.UTF8Encoding $false
    $w = New-Object System.IO.StreamWriter($pipe, $enc)
    $w.AutoFlush = $true
    $r = New-Object System.IO.StreamReader($pipe, $enc)
    $w.WriteLine((@{ t = 'ujwalam-install'; token = [string]$ch.token; root = $root } | ConvertTo-Json -Compress))
    $task = $r.ReadLineAsync()
    if (-not $task.Wait($timeoutMs)) { return [pscustomobject]@{ ok = $false; reason = 'the running Ujwalam did not answer in time' } }
    if (-not $task.Result) { return [pscustomobject]@{ ok = $false; reason = 'the running Ujwalam closed the connection' } }
    return ($task.Result | ConvertFrom-Json)
  } catch { return [pscustomobject]@{ ok = $false; reason = $_.Exception.Message } } finally { $pipe.Dispose() }
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
# LU6 (D349): is Ujwalam running from this install? Then nothing it uses is replaced (live install).
$running = @(Get-RunningUnder $InstallRoot | Where-Object { -not ($_.Cmd -and $_.Cmd.IndexOf((Norm-Path ($pkgFull + '\')), [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.Cmd -match 'Install-Ujwalam\.ps1') })
$live = $running.Count -gt 0
if ($live) { Say "Ujwalam is running from $InstallRoot ($($running.Count) program(s)): live install. Nothing the running copy uses is replaced; $version goes next to it." }
if (Test-Path -LiteralPath $target) {
  if ($live -and @(Get-RunningUnder $target).Count -gt 0) { Fail "$version is the version that is running now; nothing was changed (close Ujwalam first to reinstall it)" 4 }
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

# Top-level launcher files, BEFORE current.txt changes (Codex review of D349): a failure stops the install with
# current.txt still naming the version that worked. Live install: a file the running copy uses (ujwalam-start.exe it
# runs from, Ujwalam.cmd a console runs; cmd.exe reads a running batch file again after each call) is never replaced.
# It is kept only when that is certain: a running program is or names it, or Windows refuses it with a sharing
# violation. Any other failure (disk full, access denied, a missing file) stops with an error. A replacement goes
# through a temp file in the same folder and one rename, so a half-written launcher never takes the old one's place.
$keptTop = @()
function Copy-Top([string]$name, [bool]$required) {
  $src = Join-Path $pkg $name
  $dst = Join-Path $InstallRoot $name
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
    if ($required) { Fail "$name is missing from the unzipped build; current.txt was not changed" 10 }
    return
  }
  $tmp = "$dst.$PID.new"
  try {
    # Inside the try: reading a file another program holds open is a sharing violation too.
    if ((Test-Path -LiteralPath $dst -PathType Leaf) -and ((Get-Sha256 $src) -eq (Get-Sha256 $dst))) { return }
    if ($live -and (Test-Path -LiteralPath $dst) -and (Test-InUse $running $dst)) { $script:keptTop += $name; return }
    [System.IO.File]::Copy($src, $tmp, $true)
    if (Test-Path -LiteralPath $dst -PathType Leaf) { [System.IO.File]::Replace($tmp, $dst, $null) } else { [System.IO.File]::Move($tmp, $dst) }
  } catch {
    try { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } } catch { }
    $e = $_.Exception
    while ($e.InnerException -and -not ($e -is [System.IO.IOException])) { $e = $e.InnerException }
    $code = $e.HResult -band 0xFFFF
    # ERROR_SHARING_VIOLATION (32) or ERROR_LOCK_VIOLATION (33): another program has it open; certain to be in use.
    if ($live -and ($e -is [System.IO.IOException]) -and ($code -eq 32 -or $code -eq 33)) { $script:keptTop += $name; return }
    Fail "could not replace $dst ($($e.Message.Trim())); current.txt was not changed, the new version folder $version stays for a retry" 10
  }
}
Copy-Top 'Ujwalam.cmd' $true
# The shortcuts' target: a windowless exe that runs the version in current.txt (no console window, D191; 2026-11-08).
Copy-Top 'ujwalam-start.exe' $true
# The shortcuts' icon (app/studio/res/ujwalam.ico), kept in the install root so it survives version switches.
Copy-Top 'ujwalam.ico' $false
$cur = Read-Pointer $currentFile
if ($cur -and $cur -ne $version) { Write-Pointer $previousFile $cur }
Write-Pointer $currentFile $version
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'data') | Out-Null
Say "installed: current $version$(if ($cur -and $cur -ne $version) { ", previous $cur (Install-Ujwalam.ps1 -Rollback switches back)" })"
foreach ($k in $keptTop) { Say "kept $k in $InstallRoot`: the running Ujwalam uses it (it still starts the version in current.txt); run this installer again after Ujwalam has closed to replace it" }

# ---- hand-over to the running Ujwalam (LU6, D349) -----------------------------------------------------------------
if ($live) {
  Say "handing $version to the running Ujwalam's update queue ..."
  $reply = Send-LiveInstall $target 600000
  if ($null -eq $reply) {
    Say 'the running Ujwalam does not take live updates (feature flag service-swap is off, or it is an older version): the new version runs from the next start.'
  } elseif (-not $reply.ok) {
    Say "the running Ujwalam did not take it ($($reply.reason)): the new version runs from the next start."
  } else {
    foreach ($x in @($reply.results)) { if ($x) { Say "  $($x.text)" } }
    foreach ($x in @($reply.skipped)) { if ($x) { Say "  $($x.text)" } }
    Say 'the next start runs the new version in full.'
  }
}

# ---- shortcuts ----------------------------------------------------------------------------------------------------
if (-not $NoShortcuts) {
  if (-not $StartMenuDir) { $StartMenuDir = [Environment]::GetFolderPath('Programs') }
  if (-not $DesktopDir) { $DesktopDir = [Environment]::GetFolderPath('Desktop') }
  $shell = New-Object -ComObject WScript.Shell
  $iconFile = Join-Path $InstallRoot 'ujwalam.ico'
  $iconLoc = if (Test-Path -LiteralPath $iconFile) { "$iconFile,0" } else { (Join-Path $InstallRoot 'ujwalam-start.exe') + ',0' }
  foreach ($dir in @($StartMenuDir, $DesktopDir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $lnk = $shell.CreateShortcut((Join-Path $dir $ShortcutName))
    $lnk.TargetPath = Join-Path $InstallRoot 'ujwalam-start.exe'
    $lnk.Arguments = '--live --allow-devices' # capture card, facecam, mic (D282); stream targets set up (D354)
    $lnk.WorkingDirectory = $InstallRoot
    $lnk.IconLocation = $iconLoc
    $lnk.Description = 'Ujwalam alpha, stream targets set up (going live still needs a Start stream click)'
    $lnk.Save()
    Say "shortcut: $(Join-Path $dir $ShortcutName)"
    $lnk = $shell.CreateShortcut((Join-Path $dir $PracticeShortcutName))
    $lnk.TargetPath = Join-Path $InstallRoot 'ujwalam-start.exe'
    $lnk.Arguments = '--allow-devices'
    $lnk.WorkingDirectory = $InstallRoot
    $lnk.IconLocation = $iconLoc
    $lnk.Description = 'Ujwalam alpha, practice: devices, no streaming (runs the version in current.txt)'
    $lnk.Save()
    Say "shortcut: $(Join-Path $dir $PracticeShortcutName)"
    $old = Join-Path $dir $OldLiveShortcutName
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force; Say "removed old shortcut: $old" }
  }
}

# ---- older versions (reported, never deleted) ---------------------------------------------------------------------
$keep = @($version, (Read-Pointer $previousFile)) | Where-Object { $_ }
$older = Get-ChildItem -LiteralPath $InstallRoot -Directory | Where-Object { $_.Name -match '^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+' -and $keep -notcontains $_.Name }
# Live install: the folder the running copy uses is never offered for removal.
if ($live) { $older = $older | Where-Object { -not (Test-InUse $running ($_.FullName.TrimEnd('\') + '\')) } }
if ($older) { Say "older folders you may remove by hand: $(($older | ForEach-Object { $_.Name }) -join ', ')" }
Say 'done. Start Ujwalam from the shortcut (no console window; close the studio window to stop), or run Ujwalam.cmd in the install folder from a terminal.'
exit 0
