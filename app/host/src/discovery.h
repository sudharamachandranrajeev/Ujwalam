// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: discovery file (host.json) and owner-only secret files.
//
//   { "port": N, "pid": N, "startedAt": ISO, "token": hex | null, "systemToken": hex | null }
//
// Same rules as services/event-core/api/discovery.mjs: written atomically (temp file created with a protected DACL
// that grants the current user only, BEFORE any secret is written; DACL read back and verified; content written and
// flushed; renamed over the target) and removed on clean shutdown if it is still ours. If the DACL cannot be applied
// or verified, the write is refused (fail closed). When the launcher passes the token by environment, the token
// fields are null.
#pragma once

#include <string>

namespace discovery {

// Writes text to path atomically with an owner-only, protected DACL. Returns false (err set) when it cannot protect.
bool write_secret_file(const std::string &path, const std::string &text, std::string &err);

// True if the file's DACL is protected and every ACE grants the current user only.
bool verify_owner_only(const std::string &path, std::string &err);

// Removes path if its "pid" field equals pid (best effort).
void remove_if_ours(const std::string &path, unsigned long pid);

// Creates dir (and parents) if missing; a directory created here gets the owner-only DACL.
bool ensure_dir(const std::string &dir, std::string &err);

} // namespace discovery
