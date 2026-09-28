/* Keyframe sample + clip transform (aligned with src/lib/keyframeEval.ts). */
#include "keyframes.h"

#ifdef _WIN32

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

Clip::KfHandle default_handles_oh(const std::string &ease) {
  if (ease == "easeIn") return {0.42, 0};
  if (ease == "easeOut") return {0.15, 0.15};
  if (ease == "easeInOut") return {0.42, 0};
  if (ease == "hold") return {0.001, 0};
  /* bezier / linear / default */
  return {1.0 / 3.0, 1.0 / 3.0};
}

Clip::KfHandle default_handles_ih(const std::string &ease) {
  if (ease == "easeIn") return {-0.15, -0.15};
  if (ease == "easeOut") return {-0.42, 0};
  if (ease == "easeInOut") return {-0.42, 0};
  if (ease == "hold") return {-0.001, 0};
  return {-1.0 / 3.0, -1.0 / 3.0};
}

double ease_t(double t, const std::string &ease) {
  const double x = (std::max)(0.0, (std::min)(1.0, t));
  if (ease == "easeIn") return x * x;
  if (ease == "easeOut") return x * (2.0 - x);
  if (ease == "easeInOut") {
    return x < 0.5 ? 2.0 * x * x : 1.0 - std::pow(-2.0 * x + 2.0, 2.0) / 2.0;
  }
  if (ease == "hold") return 0.0;
  /* bezier / linear / default */
  return x;
}

double cubic1d(double p0, double p1, double p2, double p3, double u) {
  const double t = 1.0 - u;
  return t * t * t * p0 + 3.0 * t * t * u * p1 + 3.0 * t * u * u * p2 + u * u * u * p3;
}

double sample_bezier_segment(const Clip::Kf &a, const Clip::Kf &b, double tn) {
  const double t = (std::max)(0.0, (std::min)(1.0, tn));
  const std::string ease_a = a.ease.empty() ? "linear" : a.ease;
  const std::string ease_b = b.ease.empty() ? "linear" : b.ease;
  const Clip::KfHandle oh = a.has_oh
    ? a.oh
    : default_handles_oh(ease_a == "bezier" ? "easeInOut" : ease_a);
  const Clip::KfHandle ih = b.has_ih
    ? b.ih
    : default_handles_ih(ease_b == "bezier" ? "easeInOut" : ease_b);
  const double x1 = (std::max)(0.001, (std::min)(0.999, oh.x));
  const double y1 = oh.y;
  const double x2 = (std::max)(0.001, (std::min)(0.999, 1.0 + ih.x));
  const double y2 = 1.0 + ih.y;

  double lo = 0.0;
  double hi = 1.0;
  for (int i = 0; i < 24; ++i) {
    const double mid = (lo + hi) / 2.0;
    if (cubic1d(0.0, x1, x2, 1.0, mid) < t) lo = mid;
    else hi = mid;
  }
  const double u = (lo + hi) / 2.0;
  const double y = cubic1d(0.0, y1, y2, 1.0, u);
  return a.value + (b.value - a.value) * y;
}

}  // namespace

double sample_kf(const std::vector<Clip::Kf> &kfs, double local_t, double fallback) {
  if (kfs.empty()) return fallback;
  std::vector<Clip::Kf> sorted = kfs;
  std::sort(sorted.begin(), sorted.end(), [](const Clip::Kf &a, const Clip::Kf &b) {
    return a.t < b.t;
  });
  if (local_t <= sorted.front().t) return sorted.front().value;
  if (local_t >= sorted.back().t) return sorted.back().value;
  for (size_t i = 0; i + 1 < sorted.size(); ++i) {
    const auto &a = sorted[i];
    const auto &b = sorted[i + 1];
    if (local_t >= a.t && local_t <= b.t) {
      const double span = b.t - a.t;
      if (span <= 1e-6) return b.value;
      if (a.ease == "hold") return a.value;
      const double tn = (local_t - a.t) / span;
      if (a.ease == "bezier") return sample_bezier_segment(a, b, tn);
      const double u = ease_t(tn, a.ease.empty() ? "linear" : a.ease);
      return a.value + (b.value - a.value) * u;
    }
  }
  return fallback;
}

void clip_transform_at(const Clip &c, double timeline_t, double *x, double *y, double *sx, double *sy, double *rot, double *op) {
  const double local = (std::max)(0.0, timeline_t - c.start);
  *x = sample_kf(c.kf_x, local, c.x);
  *y = sample_kf(c.kf_y, local, c.y);
  *sx = sample_kf(c.kf_scale, local, c.scale_x);
  *sy = c.kf_scale_y.empty() ? sample_kf(c.kf_scale, local, c.scale_y) : sample_kf(c.kf_scale_y, local, c.scale_y);
  *rot = sample_kf(c.kf_rot, local, c.rotation);
  *op = sample_kf(c.kf_opacity, local, c.opacity);
}

/* --- kf-eval CLI helpers (minimal JSON, stdin → stdout) --- */

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

bool skip_value_raw(const std::string &s, size_t *i);

bool parse_handle_raw(const std::string &s, size_t *i, Clip::KfHandle *h) {
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
    if (key == "x") {
      if (!parse_number_raw(s, i, &h->x)) return false;
    } else if (key == "y") {
      if (!parse_number_raw(s, i, &h->y)) return false;
    } else {
      if (!skip_value_raw(s, i)) return false;
    }
    while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    return false;
  }
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

bool parse_kf_eval_array(const std::string &s, size_t *i, std::vector<Clip::Kf> *out) {
  while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
  if (*i >= s.size() || s[*i] != '[') return false;
  ++(*i);
  while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
  if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
  for (;;) {
    while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
    if (*i >= s.size() || s[*i] != '{') return false;
    ++(*i);
    Clip::Kf kf;
    bool got_t = false, got_v = false;
    for (;;) {
      while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
      if (*i < s.size() && s[*i] == '}') { ++(*i); break; }
      std::string key;
      if (!parse_string_raw(s, i, &key)) return false;
      while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
      if (*i >= s.size() || s[*i] != ':') return false;
      ++(*i);
      if (key == "t") {
        if (!parse_number_raw(s, i, &kf.t)) return false;
        got_t = true;
      } else if (key == "value") {
        if (!parse_number_raw(s, i, &kf.value)) return false;
        got_v = true;
      } else if (key == "ease") {
        if (!parse_string_raw(s, i, &kf.ease)) return false;
      } else if (key == "oh") {
        while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
        if (*i < s.size() && s[*i] == '{') {
          if (!parse_handle_raw(s, i, &kf.oh)) return false;
          kf.has_oh = true;
        } else {
          if (!skip_value_raw(s, i)) return false;
        }
      } else if (key == "ih") {
        while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
        if (*i < s.size() && s[*i] == '{') {
          if (!parse_handle_raw(s, i, &kf.ih)) return false;
          kf.has_ih = true;
        } else {
          if (!skip_value_raw(s, i)) return false;
        }
      } else {
        if (!skip_value_raw(s, i)) return false;
      }
      while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
      if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
      if (*i < s.size() && s[*i] == '}') { ++(*i); break; }
      return false;
    }
    if (got_t && got_v) out->push_back(kf);
    while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
    return false;
  }
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

}  // namespace

int todo_cmd_kf_eval_stdin() {
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
  std::vector<Clip::Kf> kfs;
  std::vector<double> times;
  double fallback = 0;
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
    if (key == "keyframes") {
      if (!parse_kf_eval_array(json, &i, &kfs)) {
        std::puts("{\"ok\":false,\"error\":\"bad keyframes\"}");
        return 1;
      }
    } else if (key == "times") {
      if (!parse_times_array(json, &i, &times)) {
        std::puts("{\"ok\":false,\"error\":\"bad times\"}");
        return 1;
      }
    } else if (key == "fallback") {
      if (!parse_number_raw(json, &i, &fallback)) {
        std::puts("{\"ok\":false,\"error\":\"bad fallback\"}");
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
    const double v = sample_kf(kfs, times[k], fallback);
    std::printf("%.17g", v);
  }
  std::puts("]}");
  return 0;
}

#endif
