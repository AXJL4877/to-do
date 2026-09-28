/* Timeline → media time（与 JS mediaTimeCore 对齐）。 */
#include "timemap.h"

#ifdef _WIN32

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

double quantize_timeline_t(double t, double fps) {
  const double f = (std::max)(1.0, fps);
  return std::floor(t * f + 1e-6) / f;
}

double media_time(const Clip &c, double timeline_t) {
  if (c.has_freeze) return c.freeze;
  const double local = (std::max)(0.0, timeline_t - c.start);
  const double spd = (std::max)(0.05, c.speed <= 0 ? 1.0 : c.speed);
  if (c.reverse) {
    const double span = c.out_point > c.in_point
      ? (c.out_point - c.in_point)
      : (std::max)(0.04, c.duration) * spd;
    return (std::max)(0.0, c.in_point + span - local * spd);
  }
  return (std::max)(0.0, c.in_point + local * spd);
}

namespace {

bool parse_string_raw(const std::string &s, size_t *i, std::string *out) {
  while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
  if (*i >= s.size() || s[*i] != '"') return false;
  ++(*i);
  out->clear();
  while (*i < s.size()) {
    const char c = s[*i];
    ++(*i);
    if (c == '"') return true;
    if (c == '\\') {
      if (*i >= s.size()) return false;
      out->push_back(s[*i]);
      ++(*i);
    } else {
      out->push_back(c);
    }
  }
  return false;
}

bool parse_number_raw(const std::string &s, size_t *i, double *out) {
  while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
  char *end = nullptr;
  *out = std::strtod(s.c_str() + *i, &end);
  if (end == s.c_str() + *i) return false;
  *i = static_cast<size_t>(end - s.c_str());
  return true;
}

bool parse_bool_raw(const std::string &s, size_t *i, bool *out) {
  while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
  if (s.compare(*i, 4, "true") == 0) { *out = true; *i += 4; return true; }
  if (s.compare(*i, 5, "false") == 0) { *out = false; *i += 5; return true; }
  return false;
}

bool skip_value_raw(const std::string &s, size_t *i) {
  while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
  if (*i >= s.size()) return false;
  if (s[*i] == '"') {
    std::string tmp;
    return parse_string_raw(s, i, &tmp);
  }
  if (s[*i] == '{' || s[*i] == '[') {
    const char open = s[*i];
    const char close = open == '{' ? '}' : ']';
    int depth = 0;
    do {
      if (s[*i] == '"') {
        std::string tmp;
        if (!parse_string_raw(s, i, &tmp)) return false;
        continue;
      }
      if (s[*i] == open) ++depth;
      else if (s[*i] == close) {
        if (--depth == 0) { ++(*i); return true; }
      }
      ++(*i);
    } while (*i < s.size());
    return false;
  }
  if (s.compare(*i, 4, "true") == 0) { *i += 4; return true; }
  if (s.compare(*i, 5, "false") == 0) { *i += 5; return true; }
  if (s.compare(*i, 4, "null") == 0) { *i += 4; return true; }
  double d = 0;
  return parse_number_raw(s, i, &d);
}

bool parse_times_array(const std::string &s, size_t *i, std::vector<double> *out) {
  while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
  if (*i >= s.size() || s[*i] != '[') return false;
  ++(*i);
  while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
  if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
  for (;;) {
    double n = 0;
    if (!parse_number_raw(s, i, &n)) return false;
    out->push_back(n);
    while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
    return false;
  }
}

bool parse_clip_fields(const std::string &s, size_t *i, Clip *c) {
  while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
  if (*i >= s.size() || s[*i] != '{') return false;
  ++(*i);
  for (;;) {
    while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    std::string key;
    if (!parse_string_raw(s, i, &key)) return false;
    while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
    if (*i >= s.size() || s[*i] != ':') return false;
    ++(*i);
    if (key == "start") {
      if (!parse_number_raw(s, i, &c->start)) return false;
    } else if (key == "duration") {
      if (!parse_number_raw(s, i, &c->duration)) return false;
    } else if (key == "inPoint") {
      if (!parse_number_raw(s, i, &c->in_point)) return false;
    } else if (key == "outPoint") {
      if (!parse_number_raw(s, i, &c->out_point)) return false;
    } else if (key == "speed") {
      if (!parse_number_raw(s, i, &c->speed)) return false;
    } else if (key == "reverse") {
      if (!parse_bool_raw(s, i, &c->reverse)) return false;
    } else if (key == "freeze") {
      if (!parse_number_raw(s, i, &c->freeze)) return false;
      c->has_freeze = true;
    } else {
      if (!skip_value_raw(s, i)) return false;
    }
    while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    return false;
  }
}

}  // namespace

int todo_cmd_timemap_eval_stdin() {
  std::string json;
  char buf[4096];
  while (std::fgets(buf, sizeof(buf), stdin)) json += buf;
  size_t i = 0;
  while (i < json.size() && (json[i] == ' ' || json[i] == '\t' || json[i] == '\r' || json[i] == '\n')) ++i;
  if (i >= json.size() || json[i] != '{') {
    std::puts("{\"ok\":false,\"error\":\"invalid json\"}");
    return 1;
  }
  ++i;
  Clip clip{};
  std::vector<double> times;
  for (;;) {
    while (i < json.size() && (json[i] == ' ' || json[i] == '\t' || json[i] == '\r' || json[i] == '\n')) ++i;
    if (i < json.size() && json[i] == '}') break;
    std::string key;
    if (!parse_string_raw(json, &i, &key)) {
      std::puts("{\"ok\":false,\"error\":\"bad key\"}");
      return 1;
    }
    while (i < json.size() && (json[i] == ' ' || json[i] == '\t' || json[i] == '\r' || json[i] == '\n')) ++i;
    if (i >= json.size() || json[i] != ':') {
      std::puts("{\"ok\":false,\"error\":\"bad colon\"}");
      return 1;
    }
    ++i;
    if (key == "clip") {
      if (!parse_clip_fields(json, &i, &clip)) {
        std::puts("{\"ok\":false,\"error\":\"bad clip\"}");
        return 1;
      }
    } else if (key == "times") {
      if (!parse_times_array(json, &i, &times)) {
        std::puts("{\"ok\":false,\"error\":\"bad times\"}");
        return 1;
      }
    } else {
      if (!skip_value_raw(json, &i)) {
        std::puts("{\"ok\":false,\"error\":\"skip failed\"}");
        return 1;
      }
    }
    while (i < json.size() && (json[i] == ' ' || json[i] == '\t' || json[i] == '\r' || json[i] == '\n')) ++i;
    if (i < json.size() && json[i] == ',') { ++i; continue; }
    if (i < json.size() && json[i] == '}') break;
  }

  std::printf("{\"ok\":true,\"values\":[");
  for (size_t k = 0; k < times.size(); ++k) {
    if (k) std::fputc(',', stdout);
    std::printf("%.17g", media_time(clip, times[k]));
  }
  std::puts("]}");
  return 0;
}

#endif
