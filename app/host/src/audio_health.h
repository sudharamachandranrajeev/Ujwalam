// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: audio health watchdog (D297 proposed; docs/evidence/2026-11-08-game-audio-loss.md).
//
// Why: on 2026-11-08 the game audio (a win-wasapi input on the capture card) started, lost its RTWQ work queue
// ~110 ms later and never came back for a 25-minute recording; the recording had the mic only. The root cause fix is
// the host's RtwqStartup reference (obs_runtime.h). This is the defence on the live path: pure resilience, no
// behaviour change while audio flows, so it ships without a feature flag; data/audio/health.json "enabled" is the
// switch, and the numbers come from that file (the launcher copies them into the host config "audioHealth").
//
// Every check_interval_ms the ticker calls Studio::audio_watch_tick(): a project device audio source that has sent
// no audio packet for no_data_ms is reported missing (log line, host.status audioHealth warning "<Name> audio
// missing", an event in audioHealth.events) and replaced by a fresh source with the same settings, at most
// max_recreates times per load. Studio::audio_health() is the readiness view the control page shows before a
// stream or a recording.
#pragma once

#include <obs.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <thread>

namespace ahealth {

class Ticker {
public:
	Ticker(uint32_t interval_ms, std::function<void()> tick);
	~Ticker(); // stops and joins
	void stop();

private:
	void *ev_ = nullptr; // HANDLE (manual reset; set = stop)
	std::thread th_;
};

// --test-hooks only: registers source type "ujw_test_audio", an audio-only input that sends 10 ms packets of
// silence (48 kHz stereo float) from its own thread, opening no device. obs_source_update with {"stall": true}
// stops the packets of that one instance (a dead device). Like win-wasapi, a create on a thread with no explicit COM
// apartment fails (the plugin returns no data). set_test_create_mode: what the next creates do: Ok (sends), Fail (the
// create fails as a WASAPI constructor that throws), Silent (created, sends nothing: a replacement that never works).
enum class TestCreate { Ok = 0, Fail = 1, Silent = 2 };
void register_test_audio_type();
void set_test_create_mode(TestCreate m);

} // namespace ahealth
