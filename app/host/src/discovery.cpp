// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: discovery file with an owner-only DACL. See discovery.h.
#include "discovery.h"
#include "json.h"

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <vector>

namespace fs = std::filesystem;

namespace discovery {

namespace {

std::wstring widen(const std::string &s)
{
	if (s.empty())
		return L"";
	int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
	std::wstring w(n, L'\0');
	MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
	return w;
}

// Current user SID as a string (S-1-5-...), empty on failure.
std::wstring user_sid_string(std::vector<uint8_t> &sid_buf)
{
	HANDLE tok = nullptr;
	if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok))
		return L"";
	DWORD len = 0;
	GetTokenInformation(tok, TokenUser, nullptr, 0, &len);
	std::vector<uint8_t> buf(len);
	std::wstring out;
	if (GetTokenInformation(tok, TokenUser, buf.data(), len, &len)) {
		auto *tu = (TOKEN_USER *)buf.data();
		DWORD sl = GetLengthSid(tu->User.Sid);
		sid_buf.assign((uint8_t *)tu->User.Sid, (uint8_t *)tu->User.Sid + sl);
		LPWSTR s = nullptr;
		if (ConvertSidToStringSidW(tu->User.Sid, &s)) {
			out = s;
			LocalFree(s);
		}
	}
	CloseHandle(tok);
	return out;
}

struct OwnerOnlySD {
	PSECURITY_DESCRIPTOR sd = nullptr;
	SECURITY_ATTRIBUTES sa = {sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE};
	std::vector<uint8_t> sid;
	bool ok = false;
	OwnerOnlySD()
	{
		std::wstring s = user_sid_string(sid);
		if (s.empty())
			return;
		// D:P = protected DACL (no inherited ACEs); one ACE: full access for the current user only.
		std::wstring sddl = L"D:P(A;;FA;;;" + s + L")";
		if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &sd, nullptr))
			return;
		sa.lpSecurityDescriptor = sd;
		ok = true;
	}
	~OwnerOnlySD()
	{
		if (sd)
			LocalFree(sd);
	}
};

bool check_dacl(PSECURITY_DESCRIPTOR sd, PACL dacl, const std::vector<uint8_t> &sid, std::string &err)
{
	SECURITY_DESCRIPTOR_CONTROL ctl = 0;
	DWORD rev = 0;
	if (!GetSecurityDescriptorControl(sd, &ctl, &rev) || !(ctl & SE_DACL_PROTECTED)) {
		err = "DACL not protected";
		return false;
	}
	if (!dacl) {
		err = "no DACL (everyone has access)";
		return false;
	}
	ACL_SIZE_INFORMATION info = {};
	if (!GetAclInformation(dacl, &info, sizeof(info), AclSizeInformation)) {
		err = "GetAclInformation failed";
		return false;
	}
	if (info.AceCount == 0) {
		err = "empty DACL";
		return false;
	}
	for (DWORD i = 0; i < info.AceCount; i++) {
		void *ace = nullptr;
		if (!GetAce(dacl, i, &ace)) {
			err = "GetAce failed";
			return false;
		}
		auto *hdr = (ACE_HEADER *)ace;
		if (hdr->AceType != ACCESS_ALLOWED_ACE_TYPE) {
			err = "unexpected ACE type";
			return false;
		}
		auto *a = (ACCESS_ALLOWED_ACE *)ace;
		if (!EqualSid((PSID)&a->SidStart, (PSID)sid.data())) {
			err = "ACE for another principal";
			return false;
		}
	}
	return true;
}

bool verify_handle(HANDLE h, const std::vector<uint8_t> &sid, std::string &err)
{
	PACL dacl = nullptr;
	PSECURITY_DESCRIPTOR sd = nullptr;
	if (GetSecurityInfo(h, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &dacl, nullptr, &sd) !=
	    ERROR_SUCCESS) {
		err = "GetSecurityInfo failed";
		return false;
	}
	bool ok = check_dacl(sd, dacl, sid, err);
	LocalFree(sd);
	return ok;
}

} // namespace

bool verify_owner_only(const std::string &path, std::string &err)
{
	std::vector<uint8_t> sid;
	if (user_sid_string(sid).empty()) {
		err = "cannot read current user SID";
		return false;
	}
	HANDLE h = CreateFileW(widen(path).c_str(), READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
			       nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
	if (h == INVALID_HANDLE_VALUE) {
		err = "cannot open for READ_CONTROL";
		return false;
	}
	bool ok = verify_handle(h, sid, err);
	CloseHandle(h);
	return ok;
}

bool write_secret_file(const std::string &path, const std::string &text, std::string &err)
{
	OwnerOnlySD od;
	if (!od.ok) {
		err = "ACL_FAILED: cannot build owner-only security descriptor";
		return false;
	}
	uint8_t rnd[4];
	LARGE_INTEGER qpc;
	QueryPerformanceCounter(&qpc);
	memcpy(rnd, &qpc.LowPart, 4);
	char suffix[64];
	snprintf(suffix, sizeof(suffix), ".%lu.%02x%02x%02x%02x.tmp", GetCurrentProcessId(), rnd[0], rnd[1], rnd[2],
		 rnd[3]);
	std::wstring tmp = widen(path + suffix);
	HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE | READ_CONTROL, 0, &od.sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
			       nullptr);
	if (h == INVALID_HANDLE_VALUE) {
		err = "cannot create temp file (" + std::to_string(GetLastError()) + ")";
		return false;
	}
	// Verify the DACL before any secret byte is written.
	if (!verify_handle(h, od.sid, err)) {
		CloseHandle(h);
		DeleteFileW(tmp.c_str());
		err = "ACL_FAILED: " + err;
		return false;
	}
	DWORD written = 0;
	bool ok = WriteFile(h, text.data(), (DWORD)text.size(), &written, nullptr) && written == text.size() &&
		  FlushFileBuffers(h);
	CloseHandle(h);
	if (!ok) {
		DeleteFileW(tmp.c_str());
		err = "write failed";
		return false;
	}
	std::wstring dst = widen(path);
	bool moved = false;
	for (int i = 0; i < 50 && !moved; i++) {
		if (MoveFileExW(tmp.c_str(), dst.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
			moved = true;
		else
			Sleep(10); // a reader holding the file open makes the replace fail briefly
	}
	if (!moved) {
		DeleteFileW(tmp.c_str());
		err = "rename failed (" + std::to_string(GetLastError()) + ")";
		return false;
	}
	if (!verify_owner_only(path, err)) {
		err = "ACL_FAILED after rename: " + err;
		return false;
	}
	return true;
}

void remove_if_ours(const std::string &path, unsigned long pid)
{
	std::ifstream f(fs::u8path(path), std::ios::binary);
	if (!f)
		return;
	std::stringstream ss;
	ss << f.rdbuf();
	f.close();
	json::ParseResult r = json::parse(ss.str());
	const json::Value *p = r.ok ? r.value.find("pid") : nullptr;
	if (p && p->is_int() && (unsigned long)p->as_int() == pid)
		DeleteFileW(widen(path).c_str());
}

bool ensure_dir(const std::string &dir, std::string &err)
{
	fs::path p = fs::u8path(dir);
	std::error_code ec;
	if (fs::is_directory(p, ec))
		return true;
	if (p.has_parent_path() && !fs::is_directory(p.parent_path(), ec))
		fs::create_directories(p.parent_path(), ec);
	OwnerOnlySD od;
	if (!od.ok) {
		err = "cannot build owner-only security descriptor";
		return false;
	}
	if (!CreateDirectoryW(p.wstring().c_str(), &od.sa) && GetLastError() != ERROR_ALREADY_EXISTS) {
		err = "cannot create directory (" + std::to_string(GetLastError()) + ")";
		return false;
	}
	return true;
}

} // namespace discovery
