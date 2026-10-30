// SPDX-License-Identifier: GPL-2.0-or-later
// ujwalam-host: minimal strict JSON parser and serializer. See json.h.
#include "json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>

namespace json {

const Value *Value::find(const std::string &key) const
{
	if (t_ != Type::Object)
		return nullptr;
	for (auto &m : o_)
		if (m.first == key)
			return &m.second;
	return nullptr;
}

Value *Value::find(const std::string &key)
{
	if (t_ != Type::Object)
		return nullptr;
	for (auto &m : o_)
		if (m.first == key)
			return &m.second;
	return nullptr;
}

Value &Value::set(const std::string &key, Value v)
{
	if (t_ == Type::Null)
		t_ = Type::Object;
	for (auto &m : o_) {
		if (m.first == key) {
			m.second = std::move(v);
			return m.second;
		}
	}
	o_.emplace_back(key, std::move(v));
	return o_.back().second;
}

Value &Value::push(Value v)
{
	if (t_ == Type::Null)
		t_ = Type::Array;
	a_.push_back(std::move(v));
	return a_.back();
}

void escape_string(const std::string &s, std::string &out)
{
	out.push_back('"');
	for (unsigned char c : s) {
		switch (c) {
		case '"': out += "\\\""; break;
		case '\\': out += "\\\\"; break;
		case '\b': out += "\\b"; break;
		case '\f': out += "\\f"; break;
		case '\n': out += "\\n"; break;
		case '\r': out += "\\r"; break;
		case '\t': out += "\\t"; break;
		default:
			if (c < 0x20 || c == 0x7f) {
				char buf[8];
				snprintf(buf, sizeof(buf), "\\u%04x", c);
				out += buf;
			} else {
				out.push_back((char)c);
			}
		}
	}
	out.push_back('"');
}

void Value::dump_to(std::string &out) const
{
	switch (t_) {
	case Type::Null: out += "null"; break;
	case Type::Bool: out += b_ ? "true" : "false"; break;
	case Type::Int: out += std::to_string(i_); break;
	case Type::Double: {
		if (!std::isfinite(d_)) {
			out += "null";
			break;
		}
		char buf[40];
		snprintf(buf, sizeof(buf), "%.17g", d_);
		// keep it a JSON number that reads back as a double (and short when exact)
		char shortbuf[40];
		snprintf(shortbuf, sizeof(shortbuf), "%.6g", d_);
		if (std::strtod(shortbuf, nullptr) == d_)
			out += shortbuf;
		else
			out += buf;
		break;
	}
	case Type::String: escape_string(s_, out); break;
	case Type::Array:
		out.push_back('[');
		for (size_t i = 0; i < a_.size(); i++) {
			if (i)
				out.push_back(',');
			a_[i].dump_to(out);
		}
		out.push_back(']');
		break;
	case Type::Object:
		out.push_back('{');
		for (size_t i = 0; i < o_.size(); i++) {
			if (i)
				out.push_back(',');
			escape_string(o_[i].first, out);
			out.push_back(':');
			o_[i].second.dump_to(out);
		}
		out.push_back('}');
		break;
	}
}

std::string Value::dump() const
{
	std::string out;
	dump_to(out);
	return out;
}

bool valid_utf8(const std::string &s)
{
	const unsigned char *p = (const unsigned char *)s.data();
	size_t n = s.size(), i = 0;
	while (i < n) {
		unsigned c = p[i];
		if (c < 0x80) {
			i++;
			continue;
		}
		size_t len;
		uint32_t cp, min;
		if ((c & 0xE0) == 0xC0) {
			len = 2;
			cp = c & 0x1F;
			min = 0x80;
		} else if ((c & 0xF0) == 0xE0) {
			len = 3;
			cp = c & 0x0F;
			min = 0x800;
		} else if ((c & 0xF8) == 0xF0) {
			len = 4;
			cp = c & 0x07;
			min = 0x10000;
		} else {
			return false;
		}
		if (i + len > n)
			return false;
		for (size_t k = 1; k < len; k++) {
			if ((p[i + k] & 0xC0) != 0x80)
				return false;
			cp = (cp << 6) | (p[i + k] & 0x3F);
		}
		if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))
			return false;
		i += len;
	}
	return true;
}

class Parser {
public:
	Parser(const std::string &t, int max_depth) : s_(t), max_depth_(max_depth) {}

	bool run(Value &out, std::string &err)
	{
		ws();
		if (!value(out, 0)) {
			err = err_.empty() ? "invalid json" : err_;
			return false;
		}
		ws();
		if (pos_ != s_.size()) {
			err = "trailing characters";
			return false;
		}
		return true;
	}

private:
	const std::string &s_;
	size_t pos_ = 0;
	int max_depth_;
	std::string err_;

	bool fail(const char *e)
	{
		if (err_.empty())
			err_ = e;
		return false;
	}
	void ws()
	{
		while (pos_ < s_.size() && (s_[pos_] == ' ' || s_[pos_] == '\t' || s_[pos_] == '\n' || s_[pos_] == '\r'))
			pos_++;
	}
	bool lit(const char *w)
	{
		size_t n = strlen(w);
		if (s_.compare(pos_, n, w) != 0)
			return fail("invalid literal");
		pos_ += n;
		return true;
	}

	bool value(Value &out, int depth)
	{
		if (depth > max_depth_)
			return fail("nesting too deep");
		if (pos_ >= s_.size())
			return fail("unexpected end");
		char c = s_[pos_];
		switch (c) {
		case 'n':
			out = Value();
			return lit("null");
		case 't':
			out = Value(true);
			return lit("true");
		case 'f':
			out = Value(false);
			return lit("false");
		case '"': {
			std::string str;
			if (!string(str))
				return false;
			out = Value(std::move(str));
			return true;
		}
		case '[': return array(out, depth);
		case '{': return object(out, depth);
		default:
			if (c == '-' || (c >= '0' && c <= '9'))
				return number(out);
			return fail("unexpected character");
		}
	}

	static void put_utf8(std::string &o, uint32_t cp)
	{
		if (cp < 0x80) {
			o.push_back((char)cp);
		} else if (cp < 0x800) {
			o.push_back((char)(0xC0 | (cp >> 6)));
			o.push_back((char)(0x80 | (cp & 0x3F)));
		} else if (cp < 0x10000) {
			o.push_back((char)(0xE0 | (cp >> 12)));
			o.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
			o.push_back((char)(0x80 | (cp & 0x3F)));
		} else {
			o.push_back((char)(0xF0 | (cp >> 18)));
			o.push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
			o.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
			o.push_back((char)(0x80 | (cp & 0x3F)));
		}
	}

	bool hex4(uint32_t &v)
	{
		if (pos_ + 4 > s_.size())
			return fail("bad escape");
		v = 0;
		for (int i = 0; i < 4; i++) {
			char h = s_[pos_++];
			v <<= 4;
			if (h >= '0' && h <= '9')
				v |= (uint32_t)(h - '0');
			else if (h >= 'a' && h <= 'f')
				v |= (uint32_t)(h - 'a' + 10);
			else if (h >= 'A' && h <= 'F')
				v |= (uint32_t)(h - 'A' + 10);
			else
				return fail("bad escape");
		}
		return true;
	}

	bool string(std::string &out)
	{
		pos_++; // opening quote
		size_t start_raw = pos_;
		(void)start_raw;
		while (true) {
			if (pos_ >= s_.size())
				return fail("unterminated string");
			unsigned char c = (unsigned char)s_[pos_];
			if (c == '"') {
				pos_++;
				break;
			}
			if (c < 0x20)
				return fail("control character in string");
			if (c != '\\') {
				out.push_back((char)c);
				pos_++;
				continue;
			}
			pos_++;
			if (pos_ >= s_.size())
				return fail("bad escape");
			char e = s_[pos_++];
			switch (e) {
			case '"': out.push_back('"'); break;
			case '\\': out.push_back('\\'); break;
			case '/': out.push_back('/'); break;
			case 'b': out.push_back('\b'); break;
			case 'f': out.push_back('\f'); break;
			case 'n': out.push_back('\n'); break;
			case 'r': out.push_back('\r'); break;
			case 't': out.push_back('\t'); break;
			case 'u': {
				uint32_t cp;
				if (!hex4(cp))
					return false;
				if (cp >= 0xD800 && cp <= 0xDBFF) {
					if (pos_ + 2 > s_.size() || s_[pos_] != '\\' || s_[pos_ + 1] != 'u')
						return fail("lone surrogate");
					pos_ += 2;
					uint32_t lo;
					if (!hex4(lo))
						return false;
					if (lo < 0xDC00 || lo > 0xDFFF)
						return fail("lone surrogate");
					cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
				} else if (cp >= 0xDC00 && cp <= 0xDFFF) {
					return fail("lone surrogate");
				}
				put_utf8(out, cp);
				break;
			}
			default: return fail("bad escape");
			}
		}
		if (!valid_utf8(out))
			return fail("invalid utf-8");
		return true;
	}

	bool number(Value &out)
	{
		size_t start = pos_;
		bool is_int = true;
		if (s_[pos_] == '-')
			pos_++;
		if (pos_ >= s_.size())
			return fail("bad number");
		if (s_[pos_] == '0') {
			pos_++;
		} else if (s_[pos_] >= '1' && s_[pos_] <= '9') {
			while (pos_ < s_.size() && isdigit((unsigned char)s_[pos_]))
				pos_++;
		} else {
			return fail("bad number");
		}
		if (pos_ < s_.size() && s_[pos_] == '.') {
			is_int = false;
			pos_++;
			if (pos_ >= s_.size() || !isdigit((unsigned char)s_[pos_]))
				return fail("bad number");
			while (pos_ < s_.size() && isdigit((unsigned char)s_[pos_]))
				pos_++;
		}
		if (pos_ < s_.size() && (s_[pos_] == 'e' || s_[pos_] == 'E')) {
			is_int = false;
			pos_++;
			if (pos_ < s_.size() && (s_[pos_] == '+' || s_[pos_] == '-'))
				pos_++;
			if (pos_ >= s_.size() || !isdigit((unsigned char)s_[pos_]))
				return fail("bad number");
			while (pos_ < s_.size() && isdigit((unsigned char)s_[pos_]))
				pos_++;
		}
		std::string t = s_.substr(start, pos_ - start);
		if (is_int) {
			errno = 0;
			char *end = nullptr;
			long long v = std::strtoll(t.c_str(), &end, 10);
			if (errno == 0 && end && *end == 0) {
				out = Value((int64_t)v);
				return true;
			}
		}
		char *end = nullptr;
		double d = std::strtod(t.c_str(), &end);
		if (!end || *end != 0 || !std::isfinite(d))
			return fail("bad number");
		out = Value(d);
		return true;
	}

	bool array(Value &out, int depth)
	{
		pos_++;
		out = Value::array();
		ws();
		if (pos_ < s_.size() && s_[pos_] == ']') {
			pos_++;
			return true;
		}
		while (true) {
			ws();
			Value v;
			if (!value(v, depth + 1))
				return false;
			out.a_.push_back(std::move(v));
			ws();
			if (pos_ >= s_.size())
				return fail("unterminated array");
			if (s_[pos_] == ',') {
				pos_++;
				continue;
			}
			if (s_[pos_] == ']') {
				pos_++;
				return true;
			}
			return fail("expected , or ]");
		}
	}

	bool object(Value &out, int depth)
	{
		pos_++;
		out = Value::object();
		ws();
		if (pos_ < s_.size() && s_[pos_] == '}') {
			pos_++;
			return true;
		}
		while (true) {
			ws();
			if (pos_ >= s_.size() || s_[pos_] != '"')
				return fail("expected key");
			std::string key;
			if (!string(key))
				return false;
			if (out.find(key))
				return fail("duplicate key");
			ws();
			if (pos_ >= s_.size() || s_[pos_] != ':')
				return fail("expected :");
			pos_++;
			ws();
			Value v;
			if (!value(v, depth + 1))
				return false;
			out.o_.emplace_back(std::move(key), std::move(v));
			ws();
			if (pos_ >= s_.size())
				return fail("unterminated object");
			if (s_[pos_] == ',') {
				pos_++;
				continue;
			}
			if (s_[pos_] == '}') {
				pos_++;
				return true;
			}
			return fail("expected , or }");
		}
	}
};

ParseResult parse(const std::string &text, int max_depth)
{
	ParseResult r;
	if (!valid_utf8(text)) {
		r.error = "invalid utf-8";
		return r;
	}
	Parser p(text, max_depth);
	r.ok = p.run(r.value, r.error);
	if (!r.ok)
		r.value = Value();
	return r;
}

} // namespace json
