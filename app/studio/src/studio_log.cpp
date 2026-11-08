// SPDX-License-Identifier: GPL-3.0-or-later
// Studio log and crash capture. Design and limits: studio_log.h.
#include "studio_log.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QStringList>

#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>

#ifdef Q_OS_WIN
#include "../../host/src/crash.h"
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <share.h>
#include <windows.h>
#endif

namespace studiolog {
namespace {

std::mutex g_mu;
FILE *g_file = nullptr;
qint64 g_bytes = 0;
bool g_full = false;
QtMessageHandler g_prev = nullptr;

const char *levelName(QtMsgType t)
{
	switch (t) {
	case QtDebugMsg:
		return "debug";
	case QtInfoMsg:
		return "info";
	case QtWarningMsg:
		return "warn";
	case QtCriticalMsg:
		return "error";
	case QtFatalMsg:
		return "fatal";
	}
	return "info";
}

void write(const QByteArray &line)
{
	std::lock_guard<std::mutex> lock(g_mu);
	if (!g_file || g_full)
		return;
	if (g_bytes + line.size() > kMaxBytes) {
		const char full[] = "studio log full: nothing more is written to this file\n";
		std::fwrite(full, 1, sizeof(full) - 1, g_file);
		std::fflush(g_file);
		g_full = true;
		return;
	}
	std::fwrite(line.constData(), 1, size_t(line.size()), g_file);
	std::fflush(g_file); // a crash right after must not lose the last lines
	g_bytes += line.size();
}

void handler(QtMsgType type, const QMessageLogContext &ctx, const QString &msg)
{
	QByteArray line = QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs).toUtf8();
	line += ' ';
	line += levelName(type);
	line += ": ";
	QString m = msg;
	m.replace(QLatin1Char('\r'), QLatin1Char(' ')).replace(QLatin1Char('\n'), QLatin1Char(' '));
	line += m.toUtf8();
	if (type >= QtWarningMsg && ctx.category && std::strcmp(ctx.category, "default") != 0) {
		line += " [";
		line += ctx.category;
		line += ']';
	}
	line += '\n';
	write(line);
	if (g_prev)
		g_prev(type, ctx, msg); // stderr as before (the launcher ignores it; a hand start shows it)
}

void prune(QDir dir, int keep)
{
	QStringList old = dir.entryList({QStringLiteral("studio-*.log")}, QDir::Files, QDir::Name);
	while (old.size() > keep) // names start with the UTC time, so the oldest sort first
		dir.remove(old.takeFirst());
}

} // namespace

Status install(const QString &version)
{
	Status st;
	const QString raw = qEnvironmentVariable("UJWALAM_STUDIO_LOG_DIR");
	if (raw.isEmpty())
		return st;
	QDir dir(raw);
	if (!dir.exists() && !QDir().mkpath(raw))
		return st;
	st.dir = dir.absolutePath();
	const QString stamp = QDateTime::currentDateTimeUtc().toString(QStringLiteral("yyyy-MM-ddTHH-mm-ss"));
	const qint64 pid = QCoreApplication::applicationPid();
	const QString name = QStringLiteral("studio-%1-p%2.log").arg(stamp).arg(pid);
	prune(dir, kKeep - 1);
	st.logFile = dir.absoluteFilePath(name);
#ifdef Q_OS_WIN
	// shared for reading (a diagnostics bundle or an editor may read it while the studio runs); _wfopen_s is not
	g_file = _wfsopen(reinterpret_cast<const wchar_t *>(QDir::toNativeSeparators(st.logFile).utf16()), L"ab", _SH_DENYWR);
#else
	g_file = std::fopen(st.logFile.toUtf8().constData(), "ab");
#endif
	if (g_file) {
		st.logging = true;
		g_prev = qInstallMessageHandler(handler);
	} else
		st.logFile.clear();
#ifdef Q_OS_WIN
	crash::Config c;
	c.logs_dir = QDir::toNativeSeparators(st.dir).toStdString();
	c.version = version.toStdString();
	c.log_file = name.toStdString();
	c.file_prefix = "studio-crash-";
	c.program = "ujwalam-studio";
	c.log_label = "studio log";
	const crash::Status cs = crash::install(c);
	st.crash = cs.on;
	qInfo("studio %s started (pid %lld); crash reporter %s%s, symbols %s, %d earlier reports", qPrintable(version), pid, cs.on ? "on" : "off",
	      cs.writing ? "" : " but NO report file will be written (too many studio-crash-*.txt in logs/)", cs.symbols ? "on" : "off", cs.existing);
#else
	qInfo("studio %s started (pid %lld)", qPrintable(version), pid);
#endif
	return st;
}

bool reassert()
{
#ifdef Q_OS_WIN
	return crash::reassert();
#else
	return true;
#endif
}

bool testCrash(const QString &kind)
{
#ifdef Q_OS_WIN
	return crash::test_trigger(kind.toStdString());
#else
	Q_UNUSED(kind);
	return false;
#endif
}

} // namespace studiolog
