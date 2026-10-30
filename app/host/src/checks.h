// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: input checks shared by the studio (host test format) and the project v1 planner.
// Every failure throws rpc::Error(INVALID_PARAMS) with a short message that never echoes long input.
#pragma once

#include "json.h"
#include "rpc_server.h"

#include <cstdint>
#include <initializer_list>
#include <regex>
#include <string>

namespace chk {

inline void only_keys(const json::Value &o, std::initializer_list<const char *> keys, const std::string &what)
{
	if (!o.is_object())
		throw rpc::Error(rpc::INVALID_PARAMS, what + " must be an object");
	for (auto &m : o.members()) {
		bool ok = false;
		for (const char *k : keys)
			if (m.first == k)
				ok = true;
		if (!ok)
			throw rpc::Error(rpc::INVALID_PARAMS, what + ": unknown field " + json::Value(m.first.substr(0, 32)).dump());
	}
}

inline int64_t get_int(const json::Value &o, const char *k, int64_t def, int64_t lo, int64_t hi, const std::string &what)
{
	const json::Value *v = o.find(k);
	if (!v)
		return def;
	if (!v->is_int() || v->as_int() < lo || v->as_int() > hi)
		throw rpc::Error(rpc::INVALID_PARAMS, what + ": bad " + k);
	return v->as_int();
}

inline double get_num(const json::Value &o, const char *k, double def, double lo, double hi, const std::string &what)
{
	const json::Value *v = o.find(k);
	if (!v)
		return def;
	if (!v->is_number() || v->as_double() < lo || v->as_double() > hi)
		throw rpc::Error(rpc::INVALID_PARAMS, what + ": bad " + k);
	return v->as_double();
}

inline std::string get_str(const json::Value &o, const char *k, const std::string &def, size_t max, const std::string &what)
{
	const json::Value *v = o.find(k);
	if (!v)
		return def;
	if (!v->is_string() || v->as_string().size() > max)
		throw rpc::Error(rpc::INVALID_PARAMS, what + ": bad " + k);
	return v->as_string();
}

inline bool get_bool(const json::Value &o, const char *k, bool def, const std::string &what)
{
	const json::Value *v = o.find(k);
	if (!v)
		return def;
	if (!v->is_bool())
		throw rpc::Error(rpc::INVALID_PARAMS, what + ": bad " + k);
	return v->as_bool();
}

inline void require(const json::Value &o, std::initializer_list<const char *> keys, const std::string &what)
{
	for (const char *k : keys)
		if (!o.find(k))
			throw rpc::Error(rpc::INVALID_PARAMS, what + ": missing " + k);
}

} // namespace chk
