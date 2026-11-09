// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: audio health watchdog ticker and the test audio source. See audio_health.h.
#include "audio_health.h"
#include "log.h"

#include <util/platform.h>

#include <objbase.h>
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
		// The tick may create a replacement device source: win-wasapi's constructor calls CoCreateInstance
		// (MMDeviceEnumerator) on the calling thread, and its pointers are used later from its own MTA capture and
		// reconnect threads. An explicit MTA here makes that independent of whether some other thread happens to
		// keep the process's MTA alive (implicit MTA). Balanced with CoUninitialize when the ticker stops; sources
		// created here keep working after that (each WASAPI source's own threads stay in the MTA).
		const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
		if (FAILED(com))
			hlog::error("audio watchdog: CoInitializeEx(MTA) failed: 0x%08lX; a source restart may fail",
				    (unsigned long)com);
		while (WaitForSingleObject(ev, interval_ms) == WAIT_TIMEOUT) {
			try {
				tick();
			} catch (...) {
				// a model change raced the tick; the next tick looks again
			}
		}
		if (SUCCEEDED(com))
			CoUninitialize();
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

std::atomic<int> g_create_mode{(int)TestCreate::Ok};

struct FakeAudio {
	obs_source_t *src = nullptr;
	std::atomic<bool> quit{false}, stall{false}, hang_destroy{false};
	std::thread th;
};

// Like win-wasapi's constructor (CoCreateInstance on the calling thread): no explicit COM apartment on the creating
// thread = the create fails (nullptr; libobs still returns a source, with no data). Implicit MTA counts as none, so
// the test does not depend on what other threads of the process happen to do.
bool explicit_com()
{
	APTTYPE t;
	APTTYPEQUALIFIER q;
	if (FAILED(CoGetApartmentType(&t, &q)))
		return false;
	return q != APTTYPEQUALIFIER_IMPLICIT_MTA;
}

void *fake_create(obs_data_t *, obs_source_t *src)
{
	if (!explicit_com()) {
		hlog::warn("ujw_test_audio: created on a thread without COM; failing like win-wasapi (CO_E_NOTINITIALIZED)");
		return nullptr;
	}
	const int mode = g_create_mode.load();
	if (mode == (int)TestCreate::Fail)
		return nullptr;
	auto *f = new FakeAudio();
	f->src = src; // "stall" in copied settings is ignored: a new instance sends unless the create mode is silent
	f->stall = mode == (int)TestCreate::Silent;
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
	if (f->hang_destroy) {
		// Test hook (audio.testHangDestroy, --test-hooks only): a destroy that never returns, on libobs's
		// destruction thread. Only the shutdown guard (TerminateProcess) ends the process after this.
		hlog::warn("ujw_test_audio: destroy hangs on purpose (test hook hangDestroy)");
		for (;;)
			Sleep(INFINITE);
	}
	delete f;
}

void fake_update(void *p, obs_data_t *s)
{
	auto *f = static_cast<FakeAudio *>(p);
	f->stall = obs_data_get_bool(s, "stall");
	f->hang_destroy = obs_data_get_bool(s, "hangDestroy");
}

const char *fake_name(void *)
{
	return "Ujwalam test audio";
}

} // namespace

void set_test_create_mode(TestCreate m)
{
	g_create_mode = (int)m;
}

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
