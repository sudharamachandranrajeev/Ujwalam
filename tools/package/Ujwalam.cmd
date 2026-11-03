@echo off
rem SPDX-License-Identifier: GPL-2.0-or-later
rem Ujwalam alpha launcher (D133). Two places use this same file:
rem   %LOCALAPPDATA%\Ujwalam\Ujwalam.cmd       reads current.txt and runs that version's copy (the shortcuts point here)
rem   %LOCALAPPDATA%\Ujwalam\<version>\Ujwalam.cmd  (or an unzipped build) runs this version with system Node.js
rem Arguments pass through, e.g.  Ujwalam.cmd --mock --no-open --stop-on-stdin   or   Ujwalam.cmd diag
setlocal
set "UJ_HERE=%~dp0"
if not exist "%UJ_HERE%current.txt" goto run
set "UJ_VER="
set /p UJ_VER=<"%UJ_HERE%current.txt"
if "%UJ_VER%"=="" (
  echo [ujwalam] current.txt is empty: run Install-Ujwalam.ps1 again
  exit /b 3
)
if not exist "%UJ_HERE%%UJ_VER%\Ujwalam.cmd" (
  echo [ujwalam] version folder %UJ_VER% is missing: run Install-Ujwalam.ps1 again, or Install-Ujwalam.ps1 -Rollback
  exit /b 3
)
call "%UJ_HERE%%UJ_VER%\Ujwalam.cmd" %*
exit /b %ERRORLEVEL%

:run
"%SystemRoot%\System32\where.exe" node >nul 2>nul
if errorlevel 1 (
  echo [ujwalam] Node.js 22.13 or newer is needed on PATH; nothing was started.
  exit /b 9
)
node "%UJ_HERE%tools\package\run-installed.mjs" %*
exit /b %ERRORLEVEL%
