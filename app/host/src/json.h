// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: minimal strict JSON (RFC 8259) value, parser and serializer.
//
// Strict on input: no comments, no trailing commas, no duplicate object keys, valid UTF-8 only, lone surrogates
// refused, nesting depth limited. Integers that fit int64 stay integers; anything with a fraction or exponent is a
// double. Object keys keep insertion order (objects are small; lookup is linear).
#pragma once

#include <cstdint>
#include <initializer_list>
#include <string>
#include <utility>
#include <vector>

namespace json {

enum class Type { Null, Bool, Int, Double, String, Array, Object };

class Value {
public:
	using Array = std::vector<Value>;
	using Member = std::pair<std::string, Value>;
	using Object = std::vector<Member>;

	Value() = default;
	Value(std::nullptr_t) {}
	Value(bool b) : t_(Type::Bool), b_(b) {}
	Value(int i) : t_(Type::Int), i_(i) {}
	Value(unsigned i) : t_(Type::Int), i_(i) {}
	Value(int64_t i) : t_(Type::Int), i_(i) {}
	Value(uint64_t i) : t_(Type::Int), i_((int64_t)i) {}
	Value(long i) : t_(Type::Int), i_(i) {}
	Value(unsigned long i) : t_(Type::Int), i_((int64_t)i) {}
	Value(double d) : t_(Type::Double), d_(d) {}
	Value(const char *s) : t_(Type::String), s_(s ? s : "") {}
	Value(std::string s) : t_(Type::String), s_(std::move(s)) {}
	Value(Array a) : t_(Type::Array), a_(std::move(a)) {}

	static Value object() { Value v; v.t_ = Type::Object; return v; }
	static Value array() { Value v; v.t_ = Type::Array; return v; }

	Type type() const { return t_; }
	bool is_null() const { return t_ == Type::Null; }
	bool is_bool() const { return t_ == Type::Bool; }
	bool is_int() const { return t_ == Type::Int; }
	bool is_number() const { return t_ == Type::Int || t_ == Type::Double; }
	bool is_string() const { return t_ == Type::String; }
	bool is_array() const { return t_ == Type::Array; }
	bool is_object() const { return t_ == Type::Object; }

	bool as_bool() const { return b_; }
	int64_t as_int() const { return t_ == Type::Double ? (int64_t)d_ : i_; }
	double as_double() const { return t_ == Type::Int ? (double)i_ : d_; }
	const std::string &as_string() const { return s_; }
	const Array &as_array() const { return a_; }
	Array &as_array() { return a_; }
	const Object &members() const { return o_; }

	// Object access. find() returns nullptr when absent (or when this is not an object).
	const Value *find(const std::string &key) const;
	Value *find(const std::string &key);
	// Sets (replacing an existing key). Turns a Null value into an Object.
	Value &set(const std::string &key, Value v);
	// Array append. Turns a Null value into an Array.
	Value &push(Value v);
	size_t size() const { return t_ == Type::Array ? a_.size() : t_ == Type::Object ? o_.size() : 0; }

	std::string dump() const;

private:
	Type t_ = Type::Null;
	bool b_ = false;
	int64_t i_ = 0;
	double d_ = 0;
	std::string s_;
	Array a_;
	Object o_;
	void dump_to(std::string &out) const;
	friend class Parser;
};

struct ParseResult {
	bool ok = false;
	Value value;
	std::string error; // short, never echoes input
};

ParseResult parse(const std::string &text, int max_depth = 64);

// True if s is valid UTF-8 (no overlongs, no surrogates, <= U+10FFFF).
bool valid_utf8(const std::string &s);

void escape_string(const std::string &s, std::string &out);

} // namespace json
