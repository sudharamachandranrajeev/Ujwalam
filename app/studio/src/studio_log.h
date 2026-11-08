// SPDX-License-Identifier: GPL-3.0-or-later
// Studio log and crash capture (2026-11-08, docs/evidence/2026-11-08-studio-crash.md).
//
// The launcher passes UJWALAM_STUDIO_LOG_DIR (<data dir>/logs). Then:
//  - every qDebug/qInfo/qWarning/qCritical line goes to <dir>/studio-<UTC time>-p<pid>.log (one file per run, at most
//    kMaxBytes; past that one "log full" line and nothing more). The newest kKeep studio-*.log files are kept.
//  - the host's crash reporter (app/host/src/crash.cpp, text only: no memory dump, no register values) is installed
//    with the prefix "studio-crash-": an unhandled exception, abort(), a pure virtual call or a CRT invalid parameter
//    writes <dir>/studio-crash-<UTC time>-p<pid>.txt with the exception code, module+offset of the faulting address
//    and the stack (module+offset, then function/file/line from the PDB when it sits beside the exe).
// Without the variable (a studio started by hand, most tests) nothing is written and Qt's default output is kept.
// Text only, like the host log: no tokens, no launch key, no chat text.
#pragma once

#include <QString>

namespace studiolog {

constexpr qint64 kMaxBytes = 2 * 1024 * 1024;
constexpr int kKeep = 10;

struct Status {
	bool logging = false; // the log file is open
	bool crash = false;   // the crash reporter is on
	QString logFile;      // full path ('' when not logging)
	QString dir;
};

// Call first in main(), before QApplication. version: shown in the crash report.
Status install(const QString &version);

// Put the crash filter back on top (a DLL loaded later may have replaced it). True when it was still ours.
bool reassert();

// Tests only (UJWALAM_HEADLESS=1 and UJWALAM_STUDIO_TEST_CRASH=<kind>): crash on purpose. Kinds as the host's
// --test-crash: av, abort, cxx, purecall, invalid-parameter, stack-overflow. False for an unknown kind.
bool testCrash(const QString &kind);

} // namespace studiolog
