// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: last-chance crash reporter (2026-11-05, docs/evidence/2026-11-05-host-shutdown-av.md).
//
// Why: the host is started by Node, and libuv sets SEM_NOGPFAULTERRORBOX, which the host inherits. So Windows Error
// Reporting writes nothing for a host crash, and the one-in-84 access violation of 2026-11-05 left no evidence.
//
// What: on an unhandled exception (SetUnhandledExceptionFilter, not a vectored handler: vectored handlers also see
// first-chance exceptions that drivers and plugins handle themselves), on abort() (SIGABRT), on a pure virtual call
// and on a CRT invalid parameter, the host writes one TEXT report to <data dir>/logs/crash-<UTC time>-p<pid>.txt:
// kind, exception code, faulting address as module+offset, thread id, the unwound stack of the faulting thread as
// module+offset, then the same stack with dbghelp symbols (function, source file name and line) when PDBs are present,
// host version, time, and the host log file name. One line also goes to stderr (the launcher's host log).
//
// Privacy (decision 2026-11-05): NO minidump. Process memory holds stream keys and tokens. The report never contains
// register values, memory contents, strings read from process memory, or any address that is not code in a loaded
// module or in the null page; other addresses are shown as "<withheld>" with the memory state and type only.
// Module and source names are base names (no folders).
//
// Safety: everything is set up at install (file name prefix, buffers, a dedicated reporter thread that waits on an
// event, dbghelp initialised). The crashing thread only copies the exception record and context into a static slot,
// wakes the reporter thread and waits at most 20 s, so a crash on an exhausted stack or inside a lock the report needs
// cannot hang the process forever. The report is written with WriteFile (no CRT stdio, no heap in the first two
// sections); the symbol section uses dbghelp and comes last, so the module+offset stack is on disk first. One report
// per process; a second crashing thread waits for the first report and then lets the process end.
//
// Files: at most 10 crash-*.txt files in the logs folder. When 10 are present, no new report file is written (the
// stderr line still is) and nothing is ever deleted; the host log says so at start.
//
// Exit codes are unchanged: the filter returns EXCEPTION_CONTINUE_SEARCH (after the previous filter, the CRT's, has
// had its turn), the SIGABRT handler returns into abort(), the invalid parameter handler ends with the same
// __fastfail(FAST_FAIL_INVALID_ARG) the CRT default uses, and the pure call handler returns into the CRT's abort().
#pragma once

#include <string>

namespace crash {

constexpr int kMaxReports = 10;

struct Config {
	std::string logs_dir;    // <data dir>/logs (UTF-8; must exist)
	std::string version;     // host version (App::version)
	std::string log_file;    // base name of this run's host log, named in the report
	std::string runtime_dir; // OBS runtime (bin/64bit and obs-plugins/64bit are searched for PDBs)
	// The studio shell uses the same reporter (2026-11-08, docs/evidence/2026-11-08-studio-crash.md): its reports are
	// studio-crash-*.txt in its own logs folder, its lines say "ujwalam-studio". The host keeps the defaults.
	std::string file_prefix = "crash-";  // report file name prefix; also counted for kMaxReports
	std::string program = "ujwalam-host"; // names the program in the report and the stderr line
	std::string log_label = "host log";   // "<label>: <log_file>" line in the report
};

struct Status {
	bool on = false;      // handlers installed
	bool writing = false; // a report file will be written (false: kMaxReports files present or bad folder)
	bool symbols = false; // dbghelp initialised
	int existing = 0;     // crash-*.txt files found at install
};

Status install(const Config &c);

// After a module that might install its own filter has loaded (libobs, plugins, CEF): put ours back on top. Returns
// false when another filter had replaced it (logged by the caller).
bool reassert();

// --test-crash <kind> (only with --test-hooks; tests only). Kinds: av (null write on a second thread), abort, cxx
// (uncaught C++ exception), purecall, invalid-parameter, stack-overflow. Returns false for an unknown kind; otherwise
// it does not return.
bool test_trigger(const std::string &kind);

} // namespace crash
