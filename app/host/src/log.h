// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: logging. libobs messages and host messages go to stdout and to the log file.
// Never log tokens, stream keys or request params.
#pragma once

#include <string>

namespace hlog {

void open_file(const std::string &path);
void close_file();
void install_obs_handler(); // base_set_log_handler; the first libobs call (triggers the obs.dll delay-load)

void info(const char *fmt, ...);
void warn(const char *fmt, ...);
void error(const char *fmt, ...);

std::string utc_now(); // ISO-8601 UTC with milliseconds

} // namespace hlog
