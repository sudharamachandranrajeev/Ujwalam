// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: global hotkeys. See hotkeys.h.
#include "hotkeys.h"
#include "log.h"

#include <windows.h>

#include <cctype>
#include <sstream>

namespace {

std::string lower(std::string s)
{
	for (char &c : s)
		c = (char)tolower((unsigned char)c);
	return s;
}

std::string trim(const std::string &s)
{
	size_t a = s.find_first_not_of(" \t"), b = s.find_last_not_of(" \t");
	return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

} // namespace

bool Hotkeys::parse_combo(const std::string &combo, unsigned &mods, unsigned &vk)
{
	mods = 0;
	vk = 0;
	if (combo.empty() || combo.size() > 40)
		return false;
	std::vector<std::string> parts;
	std::stringstream ss(combo);
	std::string p;
	while (std::getline(ss, p, '+'))
		parts.push_back(lower(trim(p)));
	if (parts.size() < 2)
		return false;
	for (size_t i = 0; i + 1 < parts.size(); i++) {
		const std::string &m = parts[i];
		unsigned f = m == "ctrl" || m == "control" ? MOD_CONTROL : m == "alt" ? MOD_ALT : m == "shift" ? MOD_SHIFT
			   : m == "win" ? MOD_WIN : 0;
		if (!f || (mods & f))
			return false; // unknown or repeated modifier
		mods |= f;
	}
	if (!(mods & (MOD_CONTROL | MOD_ALT | MOD_WIN)))
		return false; // Shift+key alone would swallow typing system-wide
	const std::string &k = parts.back();
	if (k.size() == 1 && ((k[0] >= 'a' && k[0] <= 'z') || (k[0] >= '0' && k[0] <= '9'))) {
		vk = (unsigned)toupper((unsigned char)k[0]); // VK_A..VK_Z and VK_0..VK_9 equal their ASCII codes
		return true;
	}
	if (k.size() >= 2 && k.size() <= 3 && k[0] == 'f') {
		int n = 0;
		for (size_t i = 1; i < k.size(); i++) {
			if (!isdigit((unsigned char)k[i]))
				return false;
			n = n * 10 + (k[i] - '0');
		}
		if (n >= 1 && n <= 24) {
			vk = VK_F1 + (unsigned)(n - 1);
			return true;
		}
	}
	return false;
}

Hotkeys::~Hotkeys()
{
	stop();
}

void Hotkeys::start(const std::vector<std::pair<std::string, std::string>> &bindings, Handler h, bool register_keys)
{
	stop();
	std::vector<Binding> init;
	for (auto &b : bindings) {
		Binding x;
		x.name = b.first;
		x.combo = b.second;
		init.push_back(x);
	}
	handler_ = std::move(h);
	if (!register_keys) {
		std::lock_guard<std::mutex> l(m_);
		for (auto &x : init)
			x.error = "hotkeys are off (host config hotkeys.enabled)";
		b_ = init;
		return;
	}
	HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	t_ = std::thread([this, &init, ready] { run(&init, ready); });
	WaitForSingleObject(ready, 10000);
	CloseHandle(ready);
	std::lock_guard<std::mutex> l(m_);
	started_ = true;
}

void Hotkeys::run(std::vector<Binding> *init, void *ready_event)
{
	MSG msg;
	PeekMessageW(&msg, nullptr, WM_USER, WM_USER, PM_NOREMOVE); // create this thread's message queue
	std::vector<Binding> b = *init;
	for (size_t i = 0; i < b.size(); i++) {
		Binding &x = b[i];
		if (x.combo.empty()) {
			x.error = "off";
			continue;
		}
		if (!parse_combo(x.combo, x.mods, x.vk)) {
			x.error = "invalid combo (modifiers Ctrl, Alt, Shift, Win plus A-Z, 0-9 or F1-F24)";
			hlog::warn("hotkey %s (%s) not registered: %s", x.name.c_str(), x.combo.c_str(), x.error.c_str());
			continue;
		}
		if (RegisterHotKey(nullptr, (int)(i + 1), x.mods | MOD_NOREPEAT, x.vk)) {
			x.registered = true;
			hlog::info("hotkey %s: %s", x.name.c_str(), x.combo.c_str());
		} else {
			DWORD e = GetLastError();
			x.error = e == ERROR_HOTKEY_ALREADY_REGISTERED ? "already registered (another program or binding holds it)"
								       : "RegisterHotKey failed (error " + std::to_string(e) + ")";
			hlog::warn("hotkey %s (%s) not registered: %s", x.name.c_str(), x.combo.c_str(), x.error.c_str());
		}
	}
	{
		std::lock_guard<std::mutex> l(m_);
		b_ = b;
		tid_ = GetCurrentThreadId();
	}
	SetEvent((HANDLE)ready_event); // init and ready_event belong to start(), which returns after this
	while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
		if (msg.message == WM_HOTKEY && msg.wParam >= 1)
			dispatch((size_t)msg.wParam - 1, "hotkey");
	}
	std::lock_guard<std::mutex> l(m_);
	for (size_t i = 0; i < b_.size(); i++)
		if (b_[i].registered) {
			UnregisterHotKey(nullptr, (int)(i + 1));
			b_[i].registered = false;
		}
}

void Hotkeys::dispatch(size_t index, const char *via)
{
	std::string name;
	{
		std::lock_guard<std::mutex> l(m_);
		if (index >= b_.size())
			return;
		b_[index].presses++;
		name = b_[index].name;
	}
	hlog::info("hotkey %s (%s)", name.c_str(), via);
	try {
		if (handler_)
			handler_(name, via);
	} catch (const std::exception &e) {
		hlog::error("hotkey %s handler failed: %s", name.c_str(), e.what());
	} catch (...) {
		hlog::error("hotkey %s handler failed", name.c_str());
	}
}

bool Hotkeys::trigger(const std::string &name)
{
	size_t idx = (size_t)-1;
	{
		std::lock_guard<std::mutex> l(m_);
		for (size_t i = 0; i < b_.size(); i++)
			if (b_[i].name == name)
				idx = i;
	}
	if (idx == (size_t)-1)
		return false;
	dispatch(idx, "trigger");
	return true;
}

void Hotkeys::stop()
{
	unsigned long tid = 0;
	{
		std::lock_guard<std::mutex> l(m_);
		tid = tid_;
	}
	if (t_.joinable()) {
		if (tid)
			PostThreadMessageW(tid, WM_QUIT, 0, 0);
		t_.join();
	}
	std::lock_guard<std::mutex> l(m_);
	tid_ = 0;
	started_ = false;
}

json::Value Hotkeys::status() const
{
	std::lock_guard<std::mutex> l(m_);
	json::Value o = json::Value::object();
	o.set("enabled", started_);
	json::Value a = json::Value::array();
	for (auto &b : b_) {
		json::Value x = json::Value::object();
		x.set("name", b.name);
		x.set("combo", b.combo.empty() ? json::Value() : json::Value(b.combo));
		x.set("registered", b.registered);
		x.set("error", b.error.empty() ? json::Value() : json::Value(b.error));
		x.set("presses", b.presses);
		a.push(std::move(x));
	}
	o.set("bindings", std::move(a));
	return o;
}
