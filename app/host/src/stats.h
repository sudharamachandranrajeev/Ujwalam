// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: health numbers for host.status. libobs render stats, process CPU and memory, and NVIDIA GPU /
// NVENC load through NVML (nvml.dll from System32, loaded at runtime; absent = fields null, never an error).
// Also reads (never writes) the Windows per-app graphics preference for the host exe.
#pragma once

#include "json.h"

#include <string>

namespace stats {

void init();     // loads NVML if present; call after obs_startup
void shutdown(); // nvmlShutdown

// {fps, targetFps, avgFrameTimeMs, renderLagged, renderTotal, encodeSkipped, encodeTotal}
json::Value render();
// Process CPU percent of the whole machine (os_cpu_usage_info), 0..100. -1 before the first sample.
double cpu_pct();
// {workingSetMB, privateMB}
json::Value memory();
// {available, index, name, gpuPct, memPct, encoderPct, encoderSessions, encoderAvgFps, encoderAvgLatencyUs,
//  memUsedMB, memTotalMB}. NVML device 0 (the only NVIDIA GPU on this machine; multi-GPU mapping UNVERIFIED).
json::Value gpu();
// NVENC sessions open on the GPU right now (all processes), -1 if NVML is unavailable.
int encoder_sessions();

// HKCU\Software\Microsoft\DirectX\UserGpuPreferences value for exe_path (read only).
// {exe, set, value, gpuPreference: 0 default | 1 power saving | 2 high performance | null}
json::Value gpu_preference(const std::wstring &exe_path);

} // namespace stats
