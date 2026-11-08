# Defender detection of the host build (D249)

Date: 2026-11-08. Status: mitigation built and tested; false-positive report and exclusion pending (user).

## What happened

- Full CI on 337fcc3 failed in test-host: `app/host/tests/host-twitch-bandwidth-test.test.mjs`, two tests,
  `Error: spawn UNKNOWN` (errno -4094) from `launchHost`.
- A rerun said `host exe not found: ...\out\host\build\ujwalam-host.exe`: the file was gone.
- `Get-MpThreatDetection` shows two detections at 2026-11-08 01:18:04 and 01:18:10, resource
  `file:_C:\AI\Claude\Ujwalam\out\host\build\ujwalam-host.exe`, threat 2147731250 =
  `Trojan:Win32/Bearfoos.A!ml`, severity 5, action succeeded (quarantined).

## Assessment

- `!ml` is a generic machine-learning verdict, not a signature for known malware.
- The exe is built locally by MSVC from this repo's sources; it was unsigned and had no version resource.
- The failing test reads a stream key from Windows Credential Manager and pushes it to a loopback RTMP server, a
  pattern that resembles a credential stealer. That this triggered the verdict is UNVERIFIED.

## Mitigation (in the repo)

- `app/host/src/ujwalam-host.rc`: version resource (product, description, licence, version 0.1.0.0).
- `app/host/src/ujwalam-host.manifest`: asInvoker (never elevated), Windows 10/11 supported OS.
- `app/host/CMakeLists.txt`: both added to the target.

Check after rebuild:

```
(Get-Item out/host/build/ujwalam-host.exe).VersionInfo
FileDescription : Ujwalam studio engine (libobs host, local JSON-RPC on 127.0.0.1)
ProductName     : Ujwalam
FileVersion     : 0.1.0.0
LegalCopyright  : GPL-3.0-or-later

node --test app/host/tests/host-twitch-bandwidth-test.test.mjs
ℹ pass 2
ℹ fail 0
```

No new detection after this run (latest detection still 01:18:10; checked 01:23:54).

## User actions (chosen 2026-11-08)

1. False-positive report: https://www.microsoft.com/wdsi/filesubmission, "Software developer", file
   `out\host\build\ujwalam-host.exe`, detection name `Trojan:Win32/Bearfoos.A!ml`, "incorrectly detected".
2. Exclusion for the build folder only, from an elevated PowerShell:
   `Add-MpPreference -ExclusionPath 'C:\AI\Claude\Ujwalam\out\host\build'`

The agent never changes Defender settings itself.

## Open

- Code signing (P17 installer work).
- If Defender flags the rebuilt exe again before the exclusion is in place, run the host tests one at a time while
  watching `Get-MpThreatDetection` to find the triggering behaviour.

## Files

- `app/host/src/ujwalam-host.rc`, `app/host/src/ujwalam-host.manifest`, `app/host/CMakeLists.txt`
- `docs/plan/2026-10-29-v1-decisions.md` (D249), `docs/evidence/2026-11-08-defender-host.md`
