// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-start.exe: starts Ujwalam with no console window (D191; 2026-11-08, docs/evidence/2026-11-08-studio-crash.md).
// The shortcuts point here instead of Ujwalam.cmd, which opened a terminal window that stayed open.
//
// A GUI-subsystem exe (no console of its own) that does what Ujwalam.cmd does:
//   - next to current.txt (the install root): runs the version named there; otherwise (a version folder or an unzipped
//     build) runs the build it sits in;
//   - runs  node.exe <build>\tools\package\run-installed.mjs <its own arguments, unchanged>  with CREATE_NO_WINDOW;
//   - the launcher's output (and its children's: host, live clipper, workers) goes to
//     <data root>\core\logs\launcher-<UTC time>-p<pid>.log, the data root being UJWALAM_DATA_ROOT or
//     %LOCALAPPDATA%\Ujwalam\data (as run-installed.mjs); stdin is NUL;
//   - sets UJWALAM_NO_CONSOLE=1 and UJWALAM_LAUNCH_LOG=<that file> for the launcher;
//   - waits for it and exits with its exit code.
// It shows nothing itself: no window, no message box (a box would take focus). A problem (no Node.js on PATH, a
// missing version folder) is written to the log file and ends with the same exit codes as Ujwalam.cmd (9, 3).
// Stop: close the studio window (D280). No Qt, no CRT beyond the basics, no network, no registry.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>

#include <string>

namespace {

std::wstring dirOf(const std::wstring &p)
{
	const size_t cut = p.find_last_of(L"\\/");
	return cut == std::wstring::npos ? std::wstring() : p.substr(0, cut);
}

bool isFile(const std::wstring &p)
{
	const DWORD a = GetFileAttributesW(p.c_str());
	return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

std::wstring env(const wchar_t *name)
{
	wchar_t buf[32768];
	const DWORD n = GetEnvironmentVariableW(name, buf, 32768);
	return n > 0 && n < 32768 ? std::wstring(buf, n) : std::wstring();
}

// current.txt: one line "0.1.0-alpha.N" (the same check as Install-Ujwalam.ps1 Read-Pointer). Empty when invalid.
std::wstring readPointer(const std::wstring &file)
{
	HANDLE h = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (h == INVALID_HANDLE_VALUE)
		return {};
	char buf[128] = {};
	DWORD got = 0;
	ReadFile(h, buf, sizeof(buf) - 1, &got, nullptr);
	CloseHandle(h);
	std::wstring v;
	for (DWORD i = 0; i < got; i++) {
		const char c = buf[i];
		if (c == '\r' || c == '\n')
			break;
		if (!((c >= '0' && c <= '9') || c == '.' || c == '-' || (c >= 'a' && c <= 'z')))
			return {};
		v += wchar_t(c);
	}
	// shape: digits.digits.digits-alpha.digits
	const size_t a = v.find(L"-alpha.");
	if (a == std::wstring::npos || a == 0 || a + 7 >= v.size())
		return {};
	int dots = 0;
	for (size_t i = 0; i < a; i++)
		if (v[i] == L'.')
			dots++;
		else if (v[i] < L'0' || v[i] > L'9')
			return {};
	for (size_t i = a + 7; i < v.size(); i++)
		if (v[i] < L'0' || v[i] > L'9')
			return {};
	return dots == 2 ? v : std::wstring();
}

// The arguments after argv[0], exactly as given (CommandLineToArgvW rules for the first token).
std::wstring tailArgs()
{
	const wchar_t *p = GetCommandLineW();
	if (*p == L'"') {
		p++;
		while (*p && *p != L'"')
			p++;
		if (*p)
			p++;
	} else
		while (*p && *p != L' ' && *p != L'\t')
			p++;
	while (*p == L' ' || *p == L'\t')
		p++;
	return p;
}

void say(HANDLE log, const std::string &s)
{
	if (log == INVALID_HANDLE_VALUE)
		return;
	DWORD w = 0;
	WriteFile(log, s.data(), DWORD(s.size()), &w, nullptr);
}

std::string utf8(const std::wstring &w)
{
	if (w.empty())
		return {};
	const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), nullptr, 0, nullptr, nullptr);
	std::string s(size_t(n), '\0');
	WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), s.data(), n, nullptr, nullptr);
	return s;
}

} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int)
{
	wchar_t self[MAX_PATH * 2];
	const DWORD sn = GetModuleFileNameW(nullptr, self, MAX_PATH * 2);
	const std::wstring here = dirOf(std::wstring(self, sn));

	// The log file first, so every problem below is written somewhere.
	std::wstring dataRoot = env(L"UJWALAM_DATA_ROOT");
	if (dataRoot.empty()) {
		const std::wstring la = env(L"LOCALAPPDATA");
		if (!la.empty())
			dataRoot = la + L"\\Ujwalam\\data";
	}
	HANDLE log = INVALID_HANDLE_VALUE;
	std::wstring logFile;
	if (!dataRoot.empty()) {
		const std::wstring logs = dataRoot + L"\\core\\logs";
		SHCreateDirectoryExW(nullptr, logs.c_str(), nullptr);
		SYSTEMTIME t;
		GetSystemTime(&t);
		wchar_t name[96];
		wsprintfW(name, L"\\launcher-%04u-%02u-%02uT%02u-%02u-%02u-p%lu.log", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, GetCurrentProcessId());
		logFile = logs + name;
		SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE}; // inherited by node as its stdout and stderr
		log = CreateFileW(logFile.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
	}

	std::wstring build = here;
	if (isFile(here + L"\\current.txt")) {
		const std::wstring ver = readPointer(here + L"\\current.txt");
		if (ver.empty()) {
			say(log, "[ujwalam-start] current.txt is empty or not a version: run Install-Ujwalam.ps1 again\n");
			return 3;
		}
		build = here + L"\\" + ver;
	}
	const std::wstring script = build + L"\\tools\\package\\run-installed.mjs";
	if (!isFile(script)) {
		say(log, "[ujwalam-start] " + utf8(script) + " is missing: run Install-Ujwalam.ps1 again, or Install-Ujwalam.ps1 -Rollback\n");
		return 3;
	}
	wchar_t node[MAX_PATH * 2];
	const std::wstring path = env(L"PATH"); // PATH only (as where.exe in Ujwalam.cmd), never this folder first
	if (path.empty() || !SearchPathW(path.c_str(), L"node.exe", nullptr, MAX_PATH * 2, node, nullptr)) {
		say(log, "[ujwalam-start] Node.js 22.13 or newer is needed on PATH; nothing was started.\n");
		return 9;
	}

	std::wstring cmd = L"\"" + std::wstring(node) + L"\" \"" + script + L"\"";
	const std::wstring rest = tailArgs();
	if (!rest.empty())
		cmd += L" " + rest;
	say(log, "[ujwalam-start] " + utf8(build) + " (no console window; close the studio window to stop)\n");

	SetEnvironmentVariableW(L"UJWALAM_NO_CONSOLE", L"1");
	SetEnvironmentVariableW(L"UJWALAM_LAUNCH_LOG", logFile.empty() ? nullptr : logFile.c_str());
	SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
	HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
	STARTUPINFOW si{};
	si.cb = sizeof(si);
	si.dwFlags = STARTF_USESTDHANDLES;
	si.hStdInput = nul;
	si.hStdOutput = log;
	si.hStdError = log;
	PROCESS_INFORMATION pi{};
	std::wstring line = cmd; // CreateProcessW may write into it
	const BOOL ok = CreateProcessW(nullptr, line.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, nullptr,
				       build.c_str(), &si, &pi);
	if (!ok) {
		say(log, "[ujwalam-start] Node.js could not be started (error " + std::to_string(GetLastError()) + ")\n");
		return 9;
	}
	CloseHandle(pi.hThread);
	if (nul != INVALID_HANDLE_VALUE)
		CloseHandle(nul);
	WaitForSingleObject(pi.hProcess, INFINITE);
	DWORD code = 1;
	GetExitCodeProcess(pi.hProcess, &code);
	CloseHandle(pi.hProcess);
	say(log, "[ujwalam-start] launcher ended (exit " + std::to_string(code) + ")\n");
	if (log != INVALID_HANDLE_VALUE)
		CloseHandle(log);
	return int(code);
}
