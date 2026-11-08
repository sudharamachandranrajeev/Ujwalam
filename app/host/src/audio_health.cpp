// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: audio health watchdog ticker and the test audio source. See audio_health.h.
#include "audio_health.h"

#include <util/platform.h>

#include <windows.h>

#include <vector>

namespace ahealth {

Ticker::Ticker(uint32_t interval_ms, std::function<void()> tick)
{
	HANDLE ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	ev_ = ev;
	if (!ev)
		return;
	th_ = std::thread([ev, interval_ms, tick = std::move(tick)]() {
		SetThreadDescription(GetCurrentThread(), L"ujw: audio watchdog");
		while (WaitForSingleObject(ev, interval_ms) == WAIT_TIMEOUT) {
			try {
				tick();
			} catch (...) {
				// a model change raced the tick; the next tick looks again
			}
		}
	});
}

void Ticker::stop()
{
	if (ev_)
		SetEvent((HANDLE)ev_);
	if (th_.joinable())
		th_.join();
}

Ticker::~Ticker()
{
	stop();
	if (ev_)
		CloseHandle((HANDLE)ev_);
}

namespace {

constexpr uint32_t kRate = 48000, kFrames = 480; // 10 ms

struct FakeAudio {
	obs_source_t *src = nullptr;
	std::atomic<bool> quit{false}, stall{false};
	std::thread th;
};

void *fake_create(obs_data_t *, obs_source_t *src)
{
	auto *f = new FakeAudio();
	f->src = src; // "stall" in copied settings is ignored: a new instance always sends
	f->th = std::thread([f]() {
		SetThreadDescription(GetCurrentThread(), L"ujw: test audio");
		std::vector<float> zero(kFrames, 0.0f);
		while (!f->quit) {
			if (!f->stall) {
				obs_source_audio a = {};
				a.data[0] = reinterpret_cast<const uint8_t *>(zero.data());
				a.data[1] = reinterpret_cast<const uint8_t *>(zero.data());
				a.frames = kFrames;
				a.speakers = SPEAKERS_STEREO;
				a.format = AUDIO_FORMAT_FLOAT_PLANAR;
				a.samples_per_sec = kRate;
				a.timestamp = os_gettime_ns();
				obs_source_output_audio(f->src, &a);
			}
			Sleep(10);
		}
	});
	return f;
}

void fake_destroy(void *p)
{
	auto *f = static_cast<FakeAudio *>(p);
	f->quit = true;
	if (f->th.joinable())
		f->th.join();
	delete f;
}

void fake_update(void *p, obs_data_t *s)
{
	static_cast<FakeAudio *>(p)->stall = obs_data_get_bool(s, "stall");
}

const char *fake_name(void *)
{
	return "Ujwalam test audio";
}

} // namespace

void register_test_audio_type()
{
	static bool done = false;
	if (done)
		return;
	done = true;
	obs_source_info i = {};
	i.id = "ujw_test_audio";
	i.type = OBS_SOURCE_TYPE_INPUT;
	i.output_flags = OBS_SOURCE_AUDIO;
	i.get_name = fake_name;
	i.create = fake_create;
	i.destroy = fake_destroy;
	i.update = fake_update;
	obs_register_source(&i);
}

} // namespace ahealth
