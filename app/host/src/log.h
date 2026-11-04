// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: logging. libobs messages and host messages go to stdout and to the log file.
// Never log tokens, stream keys or request params.
#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace hlog {

// In-memory ring of the last kRingLines log lines (everything that goes to the log file, incl. libobs debug),
// each cut to kRingLineMax bytes. Runs of 32+ hex characters (token-shaped) are replaced by "<redacted-hex>" in
// the ring, so log.tail cannot hand out a token even if one was logged by mistake.
constexpr size_t kRingLines = 1000;
constexpr size_t kRingLineMax = 1024;
// The newest n lines (oldest first); total = lines written since start (so a caller can see what was dropped).
std::vector<std::string> tail(size_t n, unsigned long long *total = nullptr);

void open_file(const std::string &path);
void close_file();
void install_obs_handler(); // base_set_log_handler; the first libobs call (triggers the obs.dll delay-load)

void info(const char *fmt, ...);
void warn(const char *fmt, ...);
void error(const char *fmt, ...);

std::string utc_now(); // ISO-8601 UTC with milliseconds

} // namespace hlog
