// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: logging (stdout + file + in-memory ring for log.tail). libobs messages arrive through
// base_set_log_handler.
#include "log.h"

#include <util/base.h>

#include <windows.h>

#include <cctype>
#include <cstdarg>
#include <cstdio>
#include <deque>
#include <mutex>

namespace hlog {

static FILE *g_file = nullptr;
static std::mutex g_m;
static bool g_obs = false;
static std::deque<std::string> g_ring; // guarded by g_m
static unsigned long long g_total = 0;

// Token-shaped runs (32+ hex characters) never reach the ring.
static std::string redact_hex(const std::string &s)
{
	std::string out;
	out.reserve(s.size());
	size_t i = 0;
	while (i < s.size()) {
		size_t j = i;
		while (j < s.size() && std::isxdigit((unsigned char)s[j]))
			j++;
		if (j - i >= 32) {
			out += "<redacted-hex>";
			i = j;
		} else if (j > i) {
			out.append(s, i, j - i);
			i = j;
		} else {
			out += s[i++];
		}
	}
	return out;
}

static void ring_push(const std::string &line) // caller holds g_m
{
	std::string l = redact_hex(line.size() > kRingLineMax ? line.substr(0, kRingLineMax) : line);
	if (g_ring.size() >= kRingLines)
		g_ring.pop_front();
	g_ring.push_back(std::move(l));
	g_total++;
}

std::vector<std::string> tail(size_t n, unsigned long long *total)
{
	std::lock_guard<std::mutex> l(g_m);
	if (n > g_ring.size())
		n = g_ring.size();
	std::vector<std::string> r(g_ring.end() - (std::ptrdiff_t)n, g_ring.end());
	if (total)
		*total = g_total;
	return r;
}

std::string utc_now()
{
	FILETIME ft;
	GetSystemTimePreciseAsFileTime(&ft);
	SYSTEMTIME st;
	FileTimeToSystemTime(&ft, &st);
	char buf[64];
	snprintf(buf, sizeof(buf), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", st.wYear, st.wMonth, st.wDay, st.wHour,
		 st.wMinute, st.wSecond, st.wMilliseconds);
	return buf;
}

static void write_line(const char *tag, const char *msg, bool to_stdout)
{
	std::lock_guard<std::mutex> l(g_m);
	std::string ts = utc_now();
	ring_push(ts + " " + tag + ": " + msg);
	if (to_stdout) {
		fprintf(stdout, "%s %s: %s\n", ts.c_str(), tag, msg);
		fflush(stdout);
	}
	if (g_file) {
		fprintf(g_file, "%s %s: %s\n", ts.c_str(), tag, msg);
		fflush(g_file);
	}
}

static void obs_handler(int lvl, const char *msg, va_list args, void *)
{
	char buf[8192];
	vsnprintf(buf, sizeof(buf), msg, args);
	const char *tag = lvl <= LOG_ERROR ? "error" : lvl <= LOG_WARNING ? "warn" : lvl <= LOG_INFO ? "info" : "debug";
	write_line(tag, buf, lvl <= LOG_INFO);
}

void open_file(const std::string &path)
{
	std::lock_guard<std::mutex> l(g_m);
	if (g_file)
		fclose(g_file);
	g_file = _fsopen(path.c_str(), "w", _SH_DENYWR);
}

void close_file()
{
	std::lock_guard<std::mutex> l(g_m);
	if (g_file)
		fclose(g_file);
	g_file = nullptr;
}

void install_obs_handler()
{
	base_set_log_handler(obs_handler, nullptr);
	g_obs = true;
}

static void vlog(const char *tag, int obs_level, const char *fmt, va_list args)
{
	char buf[8192];
	vsnprintf(buf, sizeof(buf), fmt, args);
	if (g_obs)
		blog(obs_level, "[host] %s", buf);
	else
		write_line(tag, buf, true);
}

void info(const char *fmt, ...)
{
	va_list a;
	va_start(a, fmt);
	vlog("info", LOG_INFO, fmt, a);
	va_end(a);
}

void warn(const char *fmt, ...)
{
	va_list a;
	va_start(a, fmt);
	vlog("warn", LOG_WARNING, fmt, a);
	va_end(a);
}

void error(const char *fmt, ...)
{
	va_list a;
	va_start(a, fmt);
	vlog("error", LOG_ERROR, fmt, a);
	va_end(a);
}

} // namespace hlog
