// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: stream keys (and per-account ingest URLs) from the Windows Credential Manager (Alpha 0).
//
// The host reads them itself, in-process, with advapi32 CredReadW on a GENERIC credential whose target name matches
// ^Ujwalam/stream/[a-z0-9-]{1,32}$ (stored by `node services/event-core/cli.mjs credential set --target <name>`,
// UTF-16LE blob). A value is copied straight from the credential blob into a caller-owned fixed buffer (no heap
// string, no std::string copies), the blob is zeroed before CredFree, and the caller wipes its buffer with wipe().
// Nothing here logs a value, returns one through RPC, or puts one on argv or in the environment. Error results are
// enum codes; messages built from them carry the target name only.
#pragma once

#include <cstddef>
#include <string>

namespace streamkeys {

constexpr size_t kCap = 1024; // buffer size callers use: up to kCap-1 characters plus NUL

enum class Read { Ok, NotFound, BadRef, BadValue, TooLong, Error };

bool valid_ref(const std::string &ref);
const char *read_name(Read r); // "ok", "not-found", ... (no value, no target)

// Reads the credential `ref` into out[cap] (NUL-terminated, printable ASCII, surrounding whitespace trimmed).
// len receives the length. On any result other than Ok, out is all zeros.
Read read(const std::string &ref, char *out, size_t cap, size_t &len);

// Reads into a scratch buffer and wipes it: true if `ref` holds a usable value.
Read check(const std::string &ref);

void wipe(void *p, size_t n); // SecureZeroMemory (not optimised away)

} // namespace streamkeys
