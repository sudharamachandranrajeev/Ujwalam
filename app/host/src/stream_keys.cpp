// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: stream keys from the Windows Credential Manager. See stream_keys.h.
#include "stream_keys.h"

#include <windows.h>
#include <wincred.h>

#include <regex>

namespace streamkeys {

bool valid_ref(const std::string &ref)
{
	static const std::regex re("^Ujwalam/stream/[a-z0-9-]{1,32}$");
	return ref.size() <= 64 && std::regex_match(ref, re);
}

const char *read_name(Read r)
{
	switch (r) {
	case Read::Ok:
		return "ok";
	case Read::NotFound:
		return "not-found";
	case Read::BadRef:
		return "bad-target-name";
	case Read::BadValue:
		return "bad-value (empty, or not printable ASCII)";
	case Read::TooLong:
		return "too-long";
	case Read::Error:
		return "credential-read-error";
	}
	return "?";
}

void wipe(void *p, size_t n)
{
	if (p && n)
		SecureZeroMemory(p, n);
}

static bool blank(wchar_t c)
{
	return c == L' ' || c == L'\t' || c == L'\r' || c == L'\n';
}

Read read(const std::string &ref, char *out, size_t cap, size_t &len)
{
	len = 0;
	if (!out || cap < 2)
		return Read::Error;
	wipe(out, cap);
	if (!valid_ref(ref))
		return Read::BadRef;
	wchar_t target[80] = {};
	for (size_t i = 0; i < ref.size(); i++) // ASCII only (valid_ref)
		target[i] = (wchar_t)(unsigned char)ref[i];
	PCREDENTIALW cred = nullptr;
	if (!CredReadW(target, CRED_TYPE_GENERIC, 0, &cred))
		return GetLastError() == ERROR_NOT_FOUND ? Read::NotFound : Read::Error;
	Read r = Read::Ok;
	const wchar_t *w = reinterpret_cast<const wchar_t *>(cred->CredentialBlob);
	size_t n = cred->CredentialBlobSize / sizeof(wchar_t);
	if (!w || (cred->CredentialBlobSize % sizeof(wchar_t)) != 0) {
		r = Read::BadValue;
	} else {
		size_t b = 0, e = n;
		while (b < e && blank(w[b]))
			b++;
		while (e > b && blank(w[e - 1]))
			e--;
		if (e == b)
			r = Read::BadValue;
		else if (e - b >= cap)
			r = Read::TooLong;
		for (size_t i = b; r == Read::Ok && i < e; i++) {
			wchar_t c = w[i];
			if (c < 0x21 || c > 0x7e) {
				r = Read::BadValue;
				break;
			}
			out[len++] = (char)c;
		}
	}
	// The blob is ours until CredFree: zero it so the secret does not linger in freed heap memory.
	if (cred->CredentialBlob && cred->CredentialBlobSize)
		wipe(cred->CredentialBlob, cred->CredentialBlobSize);
	CredFree(cred);
	if (r != Read::Ok) {
		wipe(out, cap);
		len = 0;
	}
	return r;
}

Read check(const std::string &ref)
{
	char buf[kCap];
	size_t len = 0;
	Read r = read(ref, buf, sizeof(buf), len);
	wipe(buf, sizeof(buf));
	return r;
}

} // namespace streamkeys
