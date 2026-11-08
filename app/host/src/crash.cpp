// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: last-chance crash reporter. Design, privacy rules and limits: crash.h.
#include "crash.h"

#include <windows.h>
#include <dbghelp.h>

#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <stdexcept>
#include <thread>

namespace crash {
namespace {

constexpr int kMaxFrames = 64;
constexpr DWORD kWaitMs = 20000; // the crashing thread waits at most this long for the report

enum Kind : int { K_EXCEPTION, K_ABORT, K_PURECALL, K_INVALID_PARAMETER };

// ---- state set up at install; the crash path only reads it (and fills g_slot once)
struct Slot {
	CONTEXT ctx; // DECLSPEC_ALIGN(16)
	EXCEPTION_RECORD rec;
	bool has_rec;
	int kind;
	DWORD tid;
	SYSTEMTIME at;
};
Slot g_slot;
wchar_t g_dir[MAX_PATH * 2]; // logs folder, with a trailing backslash
size_t g_dir_len = 0;
char g_version[64];
char g_log_name[260];
char g_prefix[32];    // report file name prefix (Config::file_prefix)
char g_program[32];   // "ujwalam-host" or "ujwalam-studio" (Config::program)
char g_log_label[32]; // "host log" (Config::log_label)
char g_file_name[128]; // <prefix><time>-p<pid>.txt
wchar_t g_sympath[4096];
DWORD g_pid = 0, g_main_tid = 0, g_reporter_tid = 0;
bool g_writing = false, g_symbols = false;
HANDLE g_err = nullptr, g_go = nullptr, g_done = nullptr, g_thread = nullptr;
LPTOP_LEVEL_EXCEPTION_FILTER g_prev = nullptr;
volatile LONG g_claimed = 0;
thread_local bool t_in_filter = false;

DWORD64 g_pcs[kMaxFrames];
int g_npcs = 0;
alignas(SYMBOL_INFOW) unsigned char g_symbuf[sizeof(SYMBOL_INFOW) + 512 * sizeof(wchar_t)];
IMAGEHLP_MODULEW64 g_mod;
IMAGEHLP_LINEW64 g_line;
wchar_t g_wname[MAX_PATH];

// ---- line writer: fixed buffer, WriteFile, no CRT stdio, no heap
struct Out {
	HANDLE file = INVALID_HANDLE_VALUE;
	char line[1024];
	size_t n = 0;
};
Out g_out;

void put(Out &o, const char *s)
{
	while (*s && o.n < sizeof(o.line) - 2)
		o.line[o.n++] = *s++;
}

void put_hex(Out &o, uint64_t v, int digits = 1)
{
	char b[17];
	int i = 16;
	b[16] = 0;
	do {
		b[--i] = "0123456789abcdef"[v & 15];
		v >>= 4;
	} while ((v || 16 - i < digits) && i > 0);
	put(o, "0x");
	put(o, b + i);
}

void put_dec(Out &o, uint64_t v, int digits = 1)
{
	char b[21];
	int i = 20;
	b[20] = 0;
	do {
		b[--i] = (char)('0' + v % 10);
		v /= 10;
	} while ((v || 20 - i < digits) && i > 0);
	put(o, b + i);
}

const wchar_t *base_name(const wchar_t *p)
{
	const wchar_t *b = p;
	for (; *p; p++)
		if (*p == L'\\' || *p == L'/')
			b = p + 1;
	return b;
}

void put_w(Out &o, const wchar_t *w)
{
	char b[520];
	int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, b, (int)sizeof(b), nullptr, nullptr);
	if (n <= 0)
		put(o, "?");
	else
		put(o, b);
}

void endl(Out &o)
{
	o.line[o.n++] = '\n';
	DWORD w = 0;
	if (o.file != INVALID_HANDLE_VALUE)
		WriteFile(o.file, o.line, (DWORD)o.n, &w, nullptr);
	o.n = 0;
}

void flush(Out &o)
{
	if (o.file != INVALID_HANDLE_VALUE)
		FlushFileBuffers(o.file);
}

void put_time(Out &o, const SYSTEMTIME &t, bool for_file)
{
	put_dec(o, t.wYear, 4);
	put(o, "-");
	put_dec(o, t.wMonth, 2);
	put(o, "-");
	put_dec(o, t.wDay, 2);
	put(o, "T");
	put_dec(o, t.wHour, 2);
	put(o, for_file ? "-" : ":");
	put_dec(o, t.wMinute, 2);
	put(o, for_file ? "-" : ":");
	put_dec(o, t.wSecond, 2);
	put(o, for_file ? "-" : ".");
	put_dec(o, t.wMilliseconds, 3);
	put(o, "Z");
}

const char *code_name(DWORD c)
{
	switch (c) {
	case EXCEPTION_ACCESS_VIOLATION: return "access violation";
	case EXCEPTION_IN_PAGE_ERROR: return "in-page error";
	case EXCEPTION_STACK_OVERFLOW: return "stack overflow";
	case EXCEPTION_ILLEGAL_INSTRUCTION: return "illegal instruction";
	case EXCEPTION_PRIV_INSTRUCTION: return "privileged instruction";
	case EXCEPTION_INT_DIVIDE_BY_ZERO: return "integer divide by zero";
	case EXCEPTION_INT_OVERFLOW: return "integer overflow";
	case EXCEPTION_ARRAY_BOUNDS_EXCEEDED: return "array bounds exceeded";
	case EXCEPTION_DATATYPE_MISALIGNMENT: return "datatype misalignment";
	case EXCEPTION_NONCONTINUABLE_EXCEPTION: return "noncontinuable exception";
	case EXCEPTION_BREAKPOINT: return "breakpoint";
	case EXCEPTION_INVALID_HANDLE: return "invalid handle";
	case 0xC0000374: return "heap corruption";
	case 0xC0000409: return "stack buffer overrun / fail-fast";
	case 0xE06D7363: return "uncaught C++ exception";
	default: return "other";
	}
}

const char *kind_name(int k)
{
	switch (k) {
	case K_EXCEPTION: return "unhandled exception";
	case K_ABORT: return "abort() (SIGABRT)";
	case K_PURECALL: return "pure virtual function call";
	case K_INVALID_PARAMETER: return "CRT invalid parameter";
	default: return "?";
	}
}

// An address as module+offset when it is in a loaded image, exact when it is in the null page, otherwise withheld
// (its value could be made of data bytes) with the memory state and type only. Never reads the memory it describes.
void describe(Out &o, DWORD64 a)
{
	if (a < 0x10000) {
		put_hex(o, a);
		put(o, " (null page)");
		return;
	}
	MEMORY_BASIC_INFORMATION mbi;
	if (!VirtualQuery((LPCVOID)a, &mbi, sizeof(mbi))) {
		put(o, "<withheld> (not a user-mode address)");
		return;
	}
	if (mbi.State == MEM_COMMIT && mbi.Type == MEM_IMAGE && mbi.AllocationBase) {
		DWORD n = GetModuleFileNameW((HMODULE)mbi.AllocationBase, g_wname, MAX_PATH);
		if (n && n < MAX_PATH)
			put_w(o, base_name(g_wname));
		else
			put(o, "<image>");
		put(o, "+");
		put_hex(o, a - (DWORD64)mbi.AllocationBase);
		return;
	}
	put(o, "<withheld> (");
	put(o, mbi.State == MEM_COMMIT ? "committed" : mbi.State == MEM_RESERVE ? "reserved" : mbi.State == MEM_FREE ? "free" : "?");
	if (mbi.State != MEM_FREE)
		put(o, mbi.Type == MEM_PRIVATE ? " private" : mbi.Type == MEM_MAPPED ? " mapped" : mbi.Type == MEM_IMAGE ? " image" : "");
	if (mbi.State == MEM_COMMIT && (mbi.Protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)))
		put(o, " executable");
	if (mbi.State == MEM_COMMIT && (mbi.Protect & PAGE_GUARD))
		put(o, " guard");
	put(o, ")");
}

bool in_image(DWORD64 a)
{
	MEMORY_BASIC_INFORMATION mbi;
	return a >= 0x10000 && VirtualQuery((LPCVOID)a, &mbi, sizeof(mbi)) && mbi.State == MEM_COMMIT && mbi.Type == MEM_IMAGE;
}

// ---- report sections. Each runs under its own __try (guarded), so a fault in one leaves the others on disk.
void sec_open()
{
	Out &o = g_out;
	o.file = INVALID_HANDLE_VALUE;
	o.n = 0;
	put(o, g_prefix);
	put_time(o, g_slot.at, true);
	put(o, "-p");
	put_dec(o, g_pid);
	put(o, ".txt");
	size_t i = 0;
	for (; i < o.n && i + 1 < sizeof(g_file_name); i++)
		g_file_name[i] = o.line[i];
	g_file_name[i] = 0;
	o.n = 0;
	if (!g_writing || g_dir_len + i + 1 >= sizeof(g_dir) / sizeof(g_dir[0]))
		return;
	wchar_t path[sizeof(g_dir) / sizeof(g_dir[0])];
	size_t k = 0;
	for (; k < g_dir_len; k++)
		path[k] = g_dir[k];
	for (size_t j = 0; g_file_name[j]; j++)
		path[k++] = (wchar_t)(unsigned char)g_file_name[j];
	path[k] = 0;
	o.file = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
}

void sec_stderr()
{
	if (!g_err || g_err == INVALID_HANDLE_VALUE)
		return;
	Out e; // stack; file stays invalid, written by hand below
	put(e, g_program);
	put(e, ": CRASH (");
	put(e, kind_name(g_slot.kind));
	if (g_slot.has_rec) {
		put(e, " ");
		put_hex(e, g_slot.rec.ExceptionCode, 8);
		put(e, " ");
		put(e, code_name(g_slot.rec.ExceptionCode));
	}
	put(e, ") on thread ");
	put_dec(e, g_slot.tid);
	if (g_out.file != INVALID_HANDLE_VALUE) {
		put(e, "; report: logs/");
		put(e, g_file_name);
	} else if (!g_writing) {
		put(e, "; report not written: ");
		put_dec(e, kMaxReports);
		put(e, " ");
		put(e, g_prefix);
		put(e, "*.txt files are already in logs/ (move them away to get new reports)");
	} else {
		put(e, "; report file could not be created");
	}
	e.line[e.n++] = '\n';
	DWORD w = 0;
	WriteFile(g_err, e.line, (DWORD)e.n, &w, nullptr);
}

void sec_header()
{
	Out &o = g_out;
	put(o, g_program);
	put(o, " crash report (text only: no memory dump, no register values, no memory contents)");
	endl(o);
	put(o, "version: ");
	put(o, g_version);
	endl(o);
	put(o, "time: ");
	put_time(o, g_slot.at, false);
	endl(o);
	put(o, "pid: ");
	put_dec(o, g_pid);
	endl(o);
	put(o, "thread: ");
	put_dec(o, g_slot.tid);
	put(o, g_slot.tid == g_main_tid ? " (main thread)" : " (not the main thread)");
	endl(o);
	put(o, "kind: ");
	put(o, kind_name(g_slot.kind));
	endl(o);
	if (g_slot.has_rec) {
		put(o, "code: ");
		put_hex(o, g_slot.rec.ExceptionCode, 8);
		put(o, " (");
		put(o, code_name(g_slot.rec.ExceptionCode));
		put(o, ")");
		endl(o);
		put(o, "flags: ");
		put(o, (g_slot.rec.ExceptionFlags & EXCEPTION_NONCONTINUABLE) ? "noncontinuable" : "continuable");
		endl(o);
	}
	put(o, g_log_label);
	put(o, ": ");
	put(o, g_log_name[0] ? g_log_name : "-");
	endl(o);
	flush(o);
}

void sec_where()
{
	Out &o = g_out;
	const EXCEPTION_RECORD &r = g_slot.rec;
	if (g_slot.has_rec) {
		put(o, "address: ");
		describe(o, (DWORD64)r.ExceptionAddress);
		endl(o);
		if ((r.ExceptionCode == EXCEPTION_ACCESS_VIOLATION || r.ExceptionCode == EXCEPTION_IN_PAGE_ERROR) &&
		    r.NumberParameters >= 2) {
			ULONG_PTR op = r.ExceptionInformation[0];
			put(o, "access: ");
			put(o, op == 0 ? "read" : op == 1 ? "write" : op == 8 ? "execute (DEP)" : "?");
			put(o, " at ");
			describe(o, (DWORD64)r.ExceptionInformation[1]);
			endl(o);
		}
		if (r.ExceptionCode == 0xC0000409 && r.NumberParameters >= 1) {
			put(o, "fast-fail code: ");
			put_dec(o, (uint64_t)r.ExceptionInformation[0]);
			endl(o);
		}
	}
	// Unwind the faulting thread from its context (RtlVirtualUnwind; no dbghelp, no heap).
	CONTEXT c = g_slot.ctx;
	g_npcs = 0;
	for (int i = 0; i < kMaxFrames; i++) {
		DWORD64 pc = c.Rip;
		if (!pc)
			break;
		g_pcs[g_npcs++] = pc;
		DWORD64 sp = c.Rsp, base = 0;
		PRUNTIME_FUNCTION fn = RtlLookupFunctionEntry(pc, &base, nullptr);
		if (fn) {
			PVOID hd = nullptr;
			DWORD64 ef = 0;
			RtlVirtualUnwind(UNW_FLAG_NHANDLER, base, pc, fn, &c, &hd, &ef, nullptr);
		} else { // leaf function, or a jump to a bad address: the return address is on top of the stack
			c.Rip = *(const DWORD64 *)c.Rsp;
			c.Rsp += 8;
		}
		if (c.Rsp < sp || (c.Rsp == sp && c.Rip == pc))
			break; // no progress
	}
	put(o, "stack (faulting thread, module+offset, ");
	put_dec(o, g_npcs);
	put(o, " frames):");
	endl(o);
	for (int i = 0; i < g_npcs; i++) {
		put(o, "  #");
		put_dec(o, i, 2);
		put(o, " ");
		describe(o, g_pcs[i]);
		endl(o);
	}
	flush(o);
}

void sec_symbols()
{
	Out &o = g_out;
	if (!g_symbols) {
		put(o, "symbols: dbghelp not initialised");
		endl(o);
		return;
	}
	HANDLE proc = GetCurrentProcess();
	SymRefreshModuleList(proc); // modules loaded after install (obs.dll, plugins)
	put(o, "stack (symbols from PDBs; source file names only):");
	endl(o);
	for (int i = 0; i < g_npcs; i++) {
		put(o, "  #");
		put_dec(o, i, 2);
		put(o, " ");
		DWORD64 pc = g_pcs[i];
		if (!in_image(pc)) {
			put(o, "<withheld>");
			endl(o);
			continue;
		}
		DWORD64 q = i > 0 ? pc - 1 : pc; // a return address points after the call
		g_mod = {};
		g_mod.SizeOfStruct = sizeof(g_mod);
		if (SymGetModuleInfoW64(proc, q, &g_mod))
			put_w(o, g_mod.ModuleName);
		else
			put(o, "?");
		auto *si = reinterpret_cast<SYMBOL_INFOW *>(g_symbuf);
		ZeroMemory(g_symbuf, sizeof(g_symbuf));
		si->SizeOfStruct = sizeof(SYMBOL_INFOW);
		si->MaxNameLen = 511;
		DWORD64 disp = 0;
		if (SymFromAddrW(proc, q, &disp, si)) {
			put(o, "!");
			put_w(o, si->Name);
			put(o, "+");
			put_hex(o, pc - si->Address);
			if (g_mod.SymType == SymExport)
				put(o, " [no PDB: nearest export, may be wrong]");
		} else {
			put(o, "!? (no symbol)");
		}
		g_line = {};
		g_line.SizeOfStruct = sizeof(g_line);
		DWORD ld = 0;
		if (SymGetLineFromAddrW64(proc, q, &ld, &g_line) && g_line.FileName) {
			put(o, " (");
			put_w(o, base_name(g_line.FileName));
			put(o, ":");
			put_dec(o, g_line.LineNumber);
			put(o, ")");
		}
		endl(o);
	}
	flush(o);
}

bool guarded(void (*fn)())
{
	__try {
		fn();
		return true;
	} __except (EXCEPTION_EXECUTE_HANDLER) {
		return false;
	}
}

void report()
{
	guarded(sec_open);
	guarded(sec_stderr);
	if (!guarded(sec_header) || !guarded(sec_where)) {
		g_out.n = 0;
		put(g_out, "(a report section failed)");
		endl(g_out);
	}
	if (!guarded(sec_symbols)) {
		g_out.n = 0;
		put(g_out, "(the symbol section failed)");
		endl(g_out);
	}
	put(g_out, "end of report");
	endl(g_out);
	flush(g_out);
	if (g_out.file != INVALID_HANDLE_VALUE)
		CloseHandle(g_out.file);
	g_out.file = INVALID_HANDLE_VALUE;
}

DWORD WINAPI reporter_main(void *)
{
	WaitForSingleObject(g_go, INFINITE);
	report();
	SetEvent(g_done);
	return 0;
}

void run(int kind, const EXCEPTION_RECORD *rec, const CONTEXT *ctx)
{
	DWORD me = GetCurrentThreadId();
	if (me == g_reporter_tid)
		return;
	if (InterlockedCompareExchange(&g_claimed, 1, 0) != 0) { // one report per process; let it finish first
		if (g_done)
			WaitForSingleObject(g_done, kWaitMs);
		return;
	}
	g_slot.kind = kind;
	g_slot.tid = me;
	g_slot.has_rec = rec != nullptr;
	if (rec)
		g_slot.rec = *rec;
	g_slot.ctx = *ctx;
	GetSystemTime(&g_slot.at);
	if (g_thread && g_go && g_done) {
		SetEvent(g_go);
		WaitForSingleObject(g_done, kWaitMs);
	} else {
		report();
		if (g_done)
			SetEvent(g_done);
	}
}

LONG WINAPI on_unhandled(EXCEPTION_POINTERS *ep)
{
	if (t_in_filter) // re-entered through a chained filter
		return EXCEPTION_CONTINUE_SEARCH;
	t_in_filter = true;
	run(K_EXCEPTION, ep->ExceptionRecord, ep->ContextRecord);
	// The CRT's filter (it turns an uncaught C++ exception into terminate(), as before) or nothing.
	LONG r = g_prev ? g_prev(ep) : EXCEPTION_CONTINUE_SEARCH;
	t_in_filter = false;
	return r;
}

void __cdecl on_sigabrt(int)
{
	CONTEXT c;
	RtlCaptureContext(&c);
	run(K_ABORT, nullptr, &c);
	// Returning continues abort() exactly as without a handler.
}

void __cdecl on_purecall()
{
	CONTEXT c;
	RtlCaptureContext(&c);
	run(K_PURECALL, nullptr, &c);
	// Returning: the CRT calls abort(), as without a handler.
}

void __cdecl on_invalid_parameter(const wchar_t *, const wchar_t *, const wchar_t *, unsigned, uintptr_t)
{
	CONTEXT c;
	RtlCaptureContext(&c);
	run(K_INVALID_PARAMETER, nullptr, &c);
	__fastfail(FAST_FAIL_INVALID_ARG); // what the CRT default handler does
}

std::wstring widen(const std::string &s)
{
	if (s.empty())
		return {};
	int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
	std::wstring w((size_t)n, L'\0');
	MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
	return w;
}

void copy_cut(char *dst, size_t cap, const std::string &s)
{
	size_t n = s.size() < cap - 1 ? s.size() : cap - 1;
	for (size_t i = 0; i < n; i++)
		dst[i] = s[i];
	dst[n] = 0;
}

// ---- test triggers (--test-crash, only with --test-hooks)
__declspec(noinline) void test_av()
{
	volatile int *p = nullptr;
	*p = 1;
}

__declspec(noinline) int test_recurse(volatile int d)
{
	volatile char pad[4096];
	pad[0] = (char)d;
	if (d < 0x7fffffff)
		return test_recurse(d + 1) + pad[0];
	return pad[0];
}

} // namespace

Status install(const Config &c)
{
	Status st;
	g_pid = GetCurrentProcessId();
	g_main_tid = GetCurrentThreadId();
	copy_cut(g_version, sizeof(g_version), c.version);
	copy_cut(g_log_name, sizeof(g_log_name), c.log_file);
	copy_cut(g_prefix, sizeof(g_prefix), c.file_prefix.empty() ? std::string("crash-") : c.file_prefix);
	copy_cut(g_program, sizeof(g_program), c.program.empty() ? std::string("ujwalam-host") : c.program);
	copy_cut(g_log_label, sizeof(g_log_label), c.log_label.empty() ? std::string("log") : c.log_label);
	g_err = GetStdHandle(STD_ERROR_HANDLE);

	std::wstring dir = widen(c.logs_dir);
	for (wchar_t &ch : dir)
		if (ch == L'/')
			ch = L'\\';
	if (!dir.empty() && dir.back() != L'\\')
		dir += L'\\';
	if (!dir.empty() && dir.size() + 100 < sizeof(g_dir) / sizeof(g_dir[0])) {
		for (size_t i = 0; i < dir.size(); i++)
			g_dir[i] = dir[i];
		g_dir[dir.size()] = 0;
		g_dir_len = dir.size();
		WIN32_FIND_DATAW fd;
		HANDLE h = FindFirstFileW((dir + widen(g_prefix) + L"*.txt").c_str(), &fd);
		if (h != INVALID_HANDLE_VALUE) {
			do {
				if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
					st.existing++;
			} while (FindNextFileW(h, &fd));
			FindClose(h);
		}
		g_writing = st.existing < kMaxReports;
	}

	// dbghelp: PDBs next to the host exe and in the OBS runtime. Never a symbol server (no _NT_SYMBOL_PATH).
	std::wstring sp;
	if (!c.runtime_dir.empty()) {
		std::wstring rt = widen(c.runtime_dir);
		sp = rt + L"\\bin\\64bit;" + rt + L"\\obs-plugins\\64bit";
	}
	wchar_t exe[MAX_PATH];
	DWORD en = GetModuleFileNameW(nullptr, exe, MAX_PATH);
	if (en && en < MAX_PATH) {
		std::wstring e(exe, en);
		size_t cut = e.find_last_of(L"\\/");
		if (cut != std::wstring::npos)
			sp += (sp.empty() ? L"" : L";") + e.substr(0, cut);
	}
	for (wchar_t &ch : sp)
		if (ch == L'/')
			ch = L'\\';
	if (sp.size() < sizeof(g_sympath) / sizeof(g_sympath[0])) {
		for (size_t i = 0; i < sp.size(); i++)
			g_sympath[i] = sp[i];
		g_sympath[sp.size()] = 0;
	}
	SymSetOptions(SYMOPT_UNDNAME | SYMOPT_DEFERRED_LOADS | SYMOPT_LOAD_LINES | SYMOPT_FAIL_CRITICAL_ERRORS |
		      SYMOPT_NO_PROMPTS | SYMOPT_IGNORE_NT_SYMPATH);
	g_symbols = SymInitializeW(GetCurrentProcess(), g_sympath[0] ? g_sympath : nullptr, TRUE) != FALSE;
	st.symbols = g_symbols;

	g_go = CreateEventW(nullptr, FALSE, FALSE, nullptr);
	g_done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	if (g_go && g_done)
		g_thread = CreateThread(nullptr, 256 * 1024, reporter_main, nullptr, STACK_SIZE_PARAM_IS_A_RESERVATION,
					&g_reporter_tid);
	if (g_thread)
		SetThreadDescription(g_thread, L"ujwalam-crash-reporter");

	g_prev = SetUnhandledExceptionFilter(on_unhandled);
	signal(SIGABRT, on_sigabrt);
	_set_purecall_handler(on_purecall);
	_set_invalid_parameter_handler(on_invalid_parameter);
	st.on = true;
	st.writing = g_writing;
	return st;
}

bool reassert()
{
	LPTOP_LEVEL_EXCEPTION_FILTER p = SetUnhandledExceptionFilter(on_unhandled);
	return p == on_unhandled;
}

bool test_trigger(const std::string &kind)
{
	if (kind == "av") {
		std::thread t(test_av);
		t.join();
	} else if (kind == "abort") {
		abort();
	} else if (kind == "cxx") {
		throw std::runtime_error("test-crash cxx");
	} else if (kind == "purecall") {
		_purecall();
	} else if (kind == "invalid-parameter") {
		_invalid_parameter_noinfo();
	} else if (kind == "stack-overflow") {
		test_recurse(0);
	} else {
		return false;
	}
	return true;
}

} // namespace crash
