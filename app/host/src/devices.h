// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: list-only device enumeration and project device matching.
//
// Listing never opens or activates a device:
//   DirectShow (video and audio capture categories): ICreateDevEnum::CreateClassEnumerator, then
//     IMoniker::BindToStorage(IPropertyBag) to read FriendlyName and DevicePath. IMoniker::BindToObject (which
//     instantiates the capture filter) is never called.
//   WASAPI endpoints (capture and render): IMMDeviceEnumerator::EnumAudioEndpoints, IMMDevice::GetId and
//     IMMDevice::OpenPropertyStore(STGM_READ) for the friendly name. IMMDevice::Activate (which creates an audio
//     client) is never called.
// No libobs module is involved (win-dshow and win-wasapi stay unloaded without --allow-devices).
// Each call runs on its own short-lived thread in the COM multithreaded apartment.
#pragma once

#include "json.h"

#include <string>
#include <vector>

namespace devices {

struct Entry {
	std::string kind; // "video" (DirectShow video capture), "dshow-audio" (DirectShow audio capture),
			  // "audio-input" (WASAPI capture endpoint), "audio-output" (WASAPI render endpoint)
	std::string name; // friendly name
	std::string path; // DirectShow DevicePath (may be empty) or WASAPI endpoint id
	std::string obs_id; // win-dshow "video_device_id"/"audio_device_id" (encoded "name:path"), or the endpoint id
};

struct List {
	std::vector<Entry> entries;
	std::vector<std::string> errors; // per category, short; never fatal
};

List enumerate();
json::Value to_json(const List &l);

// Project device -> list entry. Order (first hit wins):
//   1. match.directShowId equals a DirectShow DevicePath or win-dshow id (case-insensitive) matchedBy "directShowId"
//   2. match.deviceId equals a DevicePath, endpoint id or win-dshow id (case-insensitive)    matchedBy "deviceId"
//   3. match.directShowId / match.deviceId equal a DevicePath with the trailing
//      interface class segment ("#{guid}\...") removed on both sides              matchedBy "deviceInstance" (UNVERIFIED)
//   4. match.name equals the friendly name of exactly one entry                   matchedBy "name"
// Only entries of the kinds that fit the project device kind are considered: capture-card and camera -> video;
// microphone -> audio-input; audio-output -> audio-output.
struct Match {
	const Entry *entry = nullptr;
	std::string matched_by;
	std::string problem; // when entry is null
};
Match resolve(const json::Value &device, const List &l);

// A list entry as enumerate() makes it (obs_id = win-dshow "name:path" for DirectShow kinds, the path otherwise).
// Used for the --test-hooks fake device lists (devices.testSet), so they match exactly like real ones.
Entry make_entry(const std::string &kind, const std::string &name, const std::string &path);

// True if the DirectShow video category was listed without an error (an empty category is not an error). A list
// whose video category failed proves nothing about a device being gone.
bool video_listed(const List &l);

// Hot-plug binding of one capture source (D328). After every device list change each capture source is reconciled:
//   bound and its entry (same obs_id, a fitting kind) still listed      -> None (sticky: a second device with the same
//                                                                           name never moves a working source)
//   bound, entry gone, video category not listed (enumeration error)    -> None (never unbind on a failed listing)
//   bound, entry gone, resolve() finds another entry                    -> Bind (moved to another USB port)
//   bound, entry gone, nothing matches                                  -> Lose (waiting; the source is kept)
//   waiting, resolve() finds an entry                                   -> Bind
//   waiting, nothing (or more than one by name)                         -> None, problem updated
struct Binding {
	std::string bound_id; // the win-dshow id the source was given ("" = none)
	bool waiting = true;
};
struct Step {
	enum Act { None, Bind, Lose } act = None;
	std::string obs_id, matched_by, problem;
};
Step reconcile(const json::Value &device, const Binding &cur, const List &l);

// Plain-English text for a capture layer waiting for its device (studio layer list, host.status, add result).
std::string waiting_message(const json::Value &device, const std::string &problem);

// Audio monitoring output (what "monitor" layers play through, e.g. headphones). Finds exactly one audio-output
// entry whose friendly name equals `name` (case-insensitive) and passes its endpoint id to
// obs_set_audio_monitoring_device. Returns {"device", "id"} on success; {"problem"} otherwise (libobs keeps the
// Windows default output).
json::Value set_monitoring_output(const std::string &name, const List &l);

// True if the named DLL is mapped into this process (GetModuleHandleW). Used to prove device modules are absent.
bool module_mapped(const wchar_t *dll);

} // namespace devices
