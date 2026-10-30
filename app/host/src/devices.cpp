// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: list-only device enumeration. See devices.h for what is (and is never) called.
#include "devices.h"

#include <windows.h>

#include <dshow.h>
#include <mmdeviceapi.h>
#include <propkeydef.h> // DEFINE_PROPERTYKEY (not pulled in under WIN32_LEAN_AND_MEAN)
#include <functiondiscoverykeys_devpkey.h>

#include <algorithm>
#include <cwctype>
#include <thread>

namespace devices {

namespace {

std::string utf8(const wchar_t *w)
{
	if (!w || !*w)
		return {};
	int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
	if (n <= 1)
		return {};
	std::string s((size_t)n - 1, '\0');
	WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
	return s;
}

// win-dshow encode_dstr: "#" -> "#22", then ":" -> "#3A" (plugins/win-dshow/encode-dstr.hpp)
std::string obs_encode(const std::string &in)
{
	std::string a;
	for (char c : in)
		a += c == '#' ? std::string("#22") : std::string(1, c);
	std::string b;
	for (char c : a)
		b += c == ':' ? std::string("#3A") : std::string(1, c);
	return b;
}

std::string hr_text(const char *what, HRESULT hr)
{
	char buf[64];
	snprintf(buf, sizeof(buf), "%s: 0x%08lx", what, (unsigned long)hr);
	return buf;
}

template<class T> struct Com {
	T *p = nullptr;
	~Com()
	{
		if (p)
			p->Release();
	}
	T **put() { return &p; }
	T *operator->() const { return p; }
	explicit operator bool() const { return p != nullptr; }
};

void dshow_category(const CLSID &cat, const char *kind, List &out)
{
	Com<ICreateDevEnum> de;
	HRESULT hr = CoCreateInstance(CLSID_SystemDeviceEnum, nullptr, CLSCTX_INPROC_SERVER, IID_ICreateDevEnum,
				      (void **)de.put());
	if (FAILED(hr)) {
		out.errors.push_back(hr_text(kind, hr));
		return;
	}
	Com<IEnumMoniker> em;
	hr = de->CreateClassEnumerator(cat, em.put(), 0);
	if (hr == S_FALSE || !em) // empty category
		return;
	if (FAILED(hr)) {
		out.errors.push_back(hr_text(kind, hr));
		return;
	}
	for (;;) {
		Com<IMoniker> m;
		if (em->Next(1, m.put(), nullptr) != S_OK)
			break;
		Com<IPropertyBag> bag;
		// Property storage only: the filter object is not created.
		if (FAILED(m->BindToStorage(nullptr, nullptr, IID_IPropertyBag, (void **)bag.put())))
			continue;
		Entry e;
		e.kind = kind;
		VARIANT v;
		VariantInit(&v);
		if (SUCCEEDED(bag->Read(L"FriendlyName", &v, nullptr)) && v.vt == VT_BSTR)
			e.name = utf8(v.bstrVal);
		VariantClear(&v);
		VariantInit(&v);
		if (SUCCEEDED(bag->Read(L"DevicePath", &v, nullptr)) && v.vt == VT_BSTR)
			e.path = utf8(v.bstrVal);
		VariantClear(&v);
		if (e.name.empty())
			continue;
		e.obs_id = obs_encode(e.name) + ":" + obs_encode(e.path);
		out.entries.push_back(std::move(e));
	}
}

void wasapi_flow(EDataFlow flow, const char *kind, List &out)
{
	Com<IMMDeviceEnumerator> en;
	HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_INPROC_SERVER,
				      __uuidof(IMMDeviceEnumerator), (void **)en.put());
	if (FAILED(hr)) {
		out.errors.push_back(hr_text(kind, hr));
		return;
	}
	Com<IMMDeviceCollection> col;
	hr = en->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, col.put());
	if (FAILED(hr)) {
		out.errors.push_back(hr_text(kind, hr));
		return;
	}
	UINT n = 0;
	col->GetCount(&n);
	for (UINT i = 0; i < n; i++) {
		Com<IMMDevice> d;
		if (FAILED(col->Item(i, d.put())))
			continue;
		Entry e;
		e.kind = kind;
		LPWSTR id = nullptr;
		if (SUCCEEDED(d->GetId(&id)) && id) {
			e.path = utf8(id);
			CoTaskMemFree(id);
		}
		Com<IPropertyStore> ps;
		// Read-only property store: no audio client is created (IMMDevice::Activate is never called).
		if (SUCCEEDED(d->OpenPropertyStore(STGM_READ, ps.put()))) {
			PROPVARIANT pv;
			PropVariantInit(&pv);
			if (SUCCEEDED(ps->GetValue(PKEY_Device_FriendlyName, &pv)) && pv.vt == VT_LPWSTR)
				e.name = utf8(pv.pwszVal);
			PropVariantClear(&pv);
		}
		if (e.path.empty())
			continue;
		e.obs_id = e.path;
		out.entries.push_back(std::move(e));
	}
}

std::string lower(const std::string &s)
{
	std::string r = s;
	std::transform(r.begin(), r.end(), r.begin(), [](unsigned char c) { return (char)std::tolower(c); });
	return r;
}

// "\\?\usb#vid_x&pid_y&mi_00#7&abc&0&0000#{65e8773d-...}\global" -> "\\?\usb#vid_x&pid_y&mi_00#7&abc&0&0000"
std::string instance_part(const std::string &path)
{
	std::string p = lower(path);
	size_t k = p.rfind("#{");
	return k == std::string::npos ? "" : p.substr(0, k);
}

bool kind_fits(const std::string &project_kind, const std::string &entry_kind)
{
	if (project_kind == "capture-card" || project_kind == "camera")
		return entry_kind == "video";
	if (project_kind == "microphone")
		return entry_kind == "audio-input";
	if (project_kind == "audio-output")
		return entry_kind == "audio-output";
	return false;
}

} // namespace

List enumerate()
{
	List out;
	// Own MTA thread: the RPC worker's COM state is never changed.
	std::thread t([&out] {
		HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
		if (FAILED(hr)) {
			out.errors.push_back(hr_text("CoInitializeEx", hr));
			return;
		}
		dshow_category(CLSID_VideoInputDeviceCategory, "video", out);
		dshow_category(CLSID_AudioInputDeviceCategory, "dshow-audio", out);
		wasapi_flow(eCapture, "audio-input", out);
		wasapi_flow(eRender, "audio-output", out);
		CoUninitialize();
	});
	t.join();
	return out;
}

json::Value to_json(const List &l)
{
	json::Value a = json::Value::array();
	for (auto &e : l.entries) {
		json::Value o = json::Value::object();
		o.set("kind", e.kind);
		o.set("name", e.name);
		o.set("path", e.path);
		o.set("obsId", e.obs_id);
		a.push(std::move(o));
	}
	json::Value errs = json::Value::array();
	for (auto &e : l.errors)
		errs.push(e);
	json::Value r = json::Value::object();
	r.set("devices", std::move(a));
	r.set("errors", std::move(errs));
	r.set("opened", false); // listing never opens a device (see devices.h)
	return r;
}

Match resolve(const json::Value &device, const List &l)
{
	Match m;
	const json::Value *kind = device.find("kind");
	const json::Value *match = device.find("match");
	std::string pk = kind && kind->is_string() ? kind->as_string() : "";
	auto field = [&](const char *k) -> std::string {
		const json::Value *v = match ? match->find(k) : nullptr;
		return v && v->is_string() ? v->as_string() : "";
	};
	std::string dsid = field("directShowId"), did = field("deviceId"), name = field("name");
	std::vector<const Entry *> cand;
	for (auto &e : l.entries)
		if (kind_fits(pk, e.kind))
			cand.push_back(&e);
	if (cand.empty() && pk != "capture-card" && pk != "camera" && pk != "microphone" && pk != "audio-output") {
		m.problem = "unknown device kind";
		return m;
	}
	auto exact = [&](const std::string &want, const char *by) {
		if (want.empty() || m.entry)
			return;
		for (auto *e : cand)
			if ((!e->path.empty() && lower(e->path) == lower(want)) || lower(e->obs_id) == lower(want)) {
				m.entry = e;
				m.matched_by = by;
				return;
			}
	};
	exact(dsid, "directShowId");
	exact(did, "deviceId");
	for (const std::string *want : {&dsid, &did}) {
		if (m.entry)
			break;
		std::string wi = instance_part(*want);
		if (wi.empty())
			continue;
		for (auto *e : cand)
			if (instance_part(e->path) == wi) {
				m.entry = e;
				m.matched_by = "deviceInstance";
				break;
			}
	}
	if (!m.entry && !name.empty()) {
		const Entry *hit = nullptr;
		int n = 0;
		for (auto *e : cand)
			if (e->name == name) {
				hit = e;
				n++;
			}
		if (n == 1) {
			m.entry = hit;
			m.matched_by = "name";
		} else if (n > 1) {
			m.problem = "name matches more than one device";
			return m;
		}
	}
	if (!m.entry)
		m.problem = "no connected device matches";
	return m;
}

bool module_mapped(const wchar_t *dll)
{
	return GetModuleHandleW(dll) != nullptr;
}

} // namespace devices
