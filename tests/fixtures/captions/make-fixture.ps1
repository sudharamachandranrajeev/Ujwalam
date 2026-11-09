# SPDX-License-Identifier: GPL-3.0-or-later
# Generates the caption seam speech fixture with the Windows built-in speech synthesizer (System.Speech, no install).
# The wav is never committed (D312): tests/py/test_caption_seam.py runs this at test time, hidden, and caches the
# result in a gitignored folder. Text, voice and format come from speech-en.json; nothing private goes in either.
# Run in Windows PowerShell 5.1 (System.Speech is a .NET Framework assembly):
#   powershell.exe -NoProfile -NonInteractive -File tests/fixtures/captions/make-fixture.ps1 -Out <file.wav>
# Exit codes: 0 written, 3 System.Speech or the voice is not available, 1 any other error.
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$meta = Get-Content -Raw -Path (Join-Path $here 'speech-en.json') | ConvertFrom-Json
try {
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
} catch {
  Write-Error "System.Speech is not available: $($_.Exception.Message)" -ErrorAction Continue
  exit 3
}
try {
  try { $s.SelectVoice($meta.generator.voice) } catch {
    Write-Error "voice '$($meta.generator.voice)' is not installed" -ErrorAction Continue
    exit 3
  }
  $s.Rate = [int]$meta.generator.rate
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo([int]$meta.sampleRate, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $dir = Split-Path -Parent $Out
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $part = "$Out.part"
  $s.SetOutputToWaveFile($part, $fmt)
  $s.Speak([string]$meta.text)
  $s.SetOutputToNull()
  Move-Item -Force -Path $part -Destination $Out
} finally {
  $s.Dispose()
}
Write-Output "wrote $Out bytes=$((Get-Item $Out).Length)"
