/* EditGraph parse + path helpers (extracted from todo_export.cpp). */
#include "editgraph.h"

#ifdef _WIN32

#include <windows.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

std::wstring utf8_to_wide(const std::string &utf8) {
  if (utf8.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), nullptr, 0);
  if (n <= 0) return {};
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), out.data(), n);
  return out;
}

std::string wide_to_utf8(const std::wstring &w) {
  if (w.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  if (n <= 0) return {};
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), out.data(), n, nullptr, nullptr);
  return out;
}

bool read_file_utf8(const wchar_t *path, std::string *out) {
  FILE *fp = _wfopen(path, L"rb");
  if (!fp) return false;
  if (std::fseek(fp, 0, SEEK_END) != 0) { std::fclose(fp); return false; }
  const long sz = std::ftell(fp);
  if (sz < 0 || sz > 32 * 1024 * 1024) { std::fclose(fp); return false; }
  if (std::fseek(fp, 0, SEEK_SET) != 0) { std::fclose(fp); return false; }
  out->assign(static_cast<size_t>(sz), '\0');
  const size_t n = std::fread(out->data(), 1, static_cast<size_t>(sz), fp);
  std::fclose(fp);
  if (n != static_cast<size_t>(sz)) return false;
  if (out->size() >= 3 &&
      static_cast<unsigned char>((*out)[0]) == 0xEF &&
      static_cast<unsigned char>((*out)[1]) == 0xBB &&
      static_cast<unsigned char>((*out)[2]) == 0xBF) {
    out->erase(0, 3);
  }
  return true;
}

bool file_exists_w(const wchar_t *p) {
  const DWORD a = GetFileAttributesW(p);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

namespace {

bool is_absolute_path_utf8(const std::string &p) {
  if (p.size() >= 2 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) && p[1] == ':') return true;
  if (p.size() >= 2 && p[0] == '\\' && p[1] == '\\') return true;
  return false;
}

std::string lower_ext(const std::string &path) {
  const auto slash = path.find_last_of("/\\");
  const auto base = slash == std::string::npos ? path : path.substr(slash + 1);
  const auto dot = base.find_last_of('.');
  if (dot == std::string::npos) return {};
  std::string e = base.substr(dot);
  for (char &c : e) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return e;
}

/* --- minimal JSON helpers (EditGraph subset) --- */

void skip_ws(const std::string &s, size_t *i) {
  while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
}

bool parse_string(const std::string &s, size_t *i, std::string *out) {
  /* GCC 16 miscompiles s[*i++] when i is size_t* (advances the pointer, not *i). */
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '"') return false;
  ++(*i);
  out->clear();
  while (*i < s.size()) {
    const char c = s[*i];
    ++(*i);
    if (c == '"') return true;
    if (c == '\\') {
      if (*i >= s.size()) return false;
      const char e = s[*i];
      ++(*i);
      if (e == '"' || e == '\\' || e == '/') out->push_back(e);
      else if (e == 'n') out->push_back('\n');
      else if (e == 'r') out->push_back('\r');
      else if (e == 't') out->push_back('\t');
      else if (e == 'u' && *i + 3 < s.size()) {
        unsigned code = 0;
        for (int k = 0; k < 4; ++k) {
          const char h = s[*i];
          ++(*i);
          code <<= 4;
          if (h >= '0' && h <= '9') code |= static_cast<unsigned>(h - '0');
          else if (h >= 'a' && h <= 'f') code |= static_cast<unsigned>(h - 'a' + 10);
          else if (h >= 'A' && h <= 'F') code |= static_cast<unsigned>(h - 'A' + 10);
          else return false;
        }
        if (code < 0x80) out->push_back(static_cast<char>(code));
        else if (code < 0x800) {
          out->push_back(static_cast<char>(0xC0 | (code >> 6)));
          out->push_back(static_cast<char>(0x80 | (code & 0x3F)));
        } else {
          out->push_back(static_cast<char>(0xE0 | (code >> 12)));
          out->push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
          out->push_back(static_cast<char>(0x80 | (code & 0x3F)));
        }
      } else return false;
    } else {
      out->push_back(c);
    }
  }
  return false;
}

bool parse_number(const std::string &s, size_t *i, double *out) {
  skip_ws(s, i);
  char *end = nullptr;
  *out = std::strtod(s.c_str() + *i, &end);
  if (end == s.c_str() + *i) return false;
  *i = static_cast<size_t>(end - s.c_str());
  return true;
}

bool parse_bool(const std::string &s, size_t *i, bool *out) {
  skip_ws(s, i);
  if (s.compare(*i, 4, "true") == 0) { *out = true; *i += 4; return true; }
  if (s.compare(*i, 5, "false") == 0) { *out = false; *i += 5; return true; }
  return false;
}

bool skip_value(const std::string &s, size_t *i) {
  skip_ws(s, i);
  if (*i >= s.size()) return false;
  if (s[*i] == '"') {
    std::string tmp;
    return parse_string(s, i, &tmp);
  }
  if (s[*i] == '{') {
    int depth = 0;
    do {
      if (s[*i] == '"') {
        std::string tmp;
        if (!parse_string(s, i, &tmp)) return false;
        continue;
      }
      if (s[*i] == '{') ++depth;
      else if (s[*i] == '}') { if (--depth == 0) { ++(*i); return true; } }
      ++(*i);
    } while (*i < s.size());
    return false;
  }
  if (s[*i] == '[') {
    int depth = 0;
    do {
      if (s[*i] == '"') {
        std::string tmp;
        if (!parse_string(s, i, &tmp)) return false;
        continue;
      }
      if (s[*i] == '[') ++depth;
      else if (s[*i] == ']') { if (--depth == 0) { ++(*i); return true; } }
      ++(*i);
    } while (*i < s.size());
    return false;
  }
  if (s.compare(*i, 4, "true") == 0) { *i += 4; return true; }
  if (s.compare(*i, 5, "false") == 0) { *i += 5; return true; }
  if (s.compare(*i, 4, "null") == 0) { *i += 4; return true; }
  double d = 0;
  return parse_number(s, i, &d);
}

bool parse_text_obj(const std::string &s, size_t *i, Clip *c) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '{') return false;
  ++(*i);
  for (;;) {
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    std::string key;
    if (!parse_string(s, i, &key)) return false;
    skip_ws(s, i);
    if (*i >= s.size() || s[*i] != ':') return false;
    ++(*i);
    if (key == "content") {
      if (!parse_string(s, i, &c->text_content)) return false;
    } else if (key == "fontFamily") {
      if (!parse_string(s, i, &c->text_font)) return false;
    } else if (key == "fontSize") {
      if (!parse_number(s, i, &c->text_size)) return false;
    } else if (key == "color") {
      if (!parse_string(s, i, &c->text_color)) return false;
    } else if (key == "align") {
      if (!parse_string(s, i, &c->text_align)) return false;
    } else if (key == "bilingual") {
      if (!parse_string(s, i, &c->text_bilingual)) return false;
    } else if (key == "strokeWidth") {
      if (!parse_number(s, i, &c->text_stroke_w)) return false;
    } else if (key == "strokeColor") {
      if (!parse_string(s, i, &c->text_stroke_color)) return false;
    } else {
      if (!skip_value(s, i)) return false;
    }
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    return false;
  }
}

bool parse_effects_array(const std::string &s, size_t *i, Clip *c) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '[') return false;
  ++(*i);
  skip_ws(s, i);
  if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
  for (;;) {
    skip_ws(s, i);
    if (*i >= s.size() || s[*i] != '{') return false;
    ++(*i);
    std::string type;
    double strength = 0;
    bool enabled = true;
    for (;;) {
      skip_ws(s, i);
      if (*i < s.size() && s[*i] == '}') { ++(*i); break; }
      std::string key;
      if (!parse_string(s, i, &key)) return false;
      skip_ws(s, i);
      if (*i >= s.size() || s[*i] != ':') return false;
      ++(*i);
      if (key == "type") {
        if (!parse_string(s, i, &type)) return false;
      } else if (key == "strength") {
        if (!parse_number(s, i, &strength)) return false;
      } else if (key == "enabled") {
        if (!parse_bool(s, i, &enabled)) return false;
      } else {
        if (!skip_value(s, i)) return false;
      }
      skip_ws(s, i);
      if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
      if (*i < s.size() && s[*i] == '}') { ++(*i); break; }
      return false;
    }
    if (enabled && strength > 0) {
      if (type == "blur") c->fx_blur = (std::max)(c->fx_blur, strength);
      else if (type == "sharpen") c->fx_sharpen = (std::max)(c->fx_sharpen, strength);
      else if (type == "filter") c->fx_filter = (std::max)(c->fx_filter, strength);
    }
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
    return false;
  }
}

bool parse_mask_points(const std::string &s, size_t *i, std::vector<Clip::Pt> *out) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '[') return false;
  ++(*i);
  skip_ws(s, i);
  if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
  for (;;) {
    skip_ws(s, i);
    if (*i >= s.size() || s[*i] != '{') return false;
    ++(*i);
    Clip::Pt pt;
    bool got_x = false, got_y = false;
    for (;;) {
      skip_ws(s, i);
      if (*i < s.size() && s[*i] == '}') { ++(*i); break; }
      std::string key;
      if (!parse_string(s, i, &key)) return false;
      skip_ws(s, i);
      if (*i >= s.size() || s[*i] != ':') return false;
      ++(*i);
      if (key == "x") {
        double n = 0;
        if (!parse_number(s, i, &n)) return false;
        pt.x = n; got_x = true;
      } else if (key == "y") {
        double n = 0;
        if (!parse_number(s, i, &n)) return false;
        pt.y = n; got_y = true;
      } else {
        if (!skip_value(s, i)) return false;
      }
      skip_ws(s, i);
      if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
      if (*i < s.size() && s[*i] == '}') { ++(*i); break; }
      return false;
    }
    if (got_x && got_y) out->push_back(pt);
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
    return false;
  }
}

bool parse_mask_obj(const std::string &s, size_t *i, Clip *c) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '{') return false;
  ++(*i);
  for (;;) {
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    std::string key;
    if (!parse_string(s, i, &key)) return false;
    skip_ws(s, i);
    if (*i >= s.size() || s[*i] != ':') return false;
    ++(*i);
    if (key == "type") {
      if (!parse_string(s, i, &c->mask_type)) return false;
    } else if (key == "feather") {
      if (!parse_number(s, i, &c->mask_feather)) return false;
    } else if (key == "expand") {
      if (!parse_number(s, i, &c->mask_expand)) return false;
    } else if (key == "invert") {
      if (!parse_bool(s, i, &c->mask_invert)) return false;
    } else if (key == "points") {
      if (!parse_mask_points(s, i, &c->mask_points)) return false;
    } else {
      if (!skip_value(s, i)) return false;
    }
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    return false;
  }
}

bool parse_chroma_obj(const std::string &s, size_t *i, Clip *c) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '{') return false;
  ++(*i);
  for (;;) {
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    std::string key;
    if (!parse_string(s, i, &key)) return false;
    skip_ws(s, i);
    if (*i >= s.size() || s[*i] != ':') return false;
    ++(*i);
    if (key == "enabled") {
      if (!parse_bool(s, i, &c->chroma_on)) return false;
    } else if (key == "tolerance") {
      if (!parse_number(s, i, &c->chroma_tol)) return false;
    } else if (key == "color") {
      std::string hex;
      if (!parse_string(s, i, &hex)) return false;
      if (hex.size() >= 7 && hex[0] == '#') {
        auto h = [](char ch) -> int {
          if (ch >= '0' && ch <= '9') return ch - '0';
          if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
          if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
          return 0;
        };
        c->chroma_r = h(hex[1]) * 16 + h(hex[2]);
        c->chroma_g = h(hex[3]) * 16 + h(hex[4]);
        c->chroma_b = h(hex[5]) * 16 + h(hex[6]);
      }
    } else {
      if (!skip_value(s, i)) return false;
    }
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    return false;
  }
}

bool parse_transition_obj(const std::string &s, size_t *i, std::string *type, double *dur) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '{') return false;
  ++(*i);
  for (;;) {
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    std::string key;
    if (!parse_string(s, i, &key)) return false;
    skip_ws(s, i);
    if (*i >= s.size() || s[*i] != ':') return false;
    ++(*i);
    if (key == "type") {
      if (!parse_string(s, i, type)) return false;
    } else if (key == "duration") {
      if (!parse_number(s, i, dur)) return false;
    } else {
      if (!skip_value(s, i)) return false;
    }
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    return false;
  }
}

bool parse_kf_handle_obj(const std::string &s, size_t *i, Clip::KfHandle *h) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '{') return false;
  ++(*i);
  for (;;) {
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    std::string key;
    if (!parse_string(s, i, &key)) return false;
    skip_ws(s, i);
    if (*i >= s.size() || s[*i] != ':') return false;
    ++(*i);
    if (key == "x") {
      if (!parse_number(s, i, &h->x)) return false;
    } else if (key == "y") {
      if (!parse_number(s, i, &h->y)) return false;
    } else {
      if (!skip_value(s, i)) return false;
    }
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    return false;
  }
}

bool parse_kf_array(const std::string &s, size_t *i, std::vector<Clip::Kf> *out) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '[') return false;
  ++(*i);
  skip_ws(s, i);
  if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
  for (;;) {
    skip_ws(s, i);
    if (*i >= s.size() || s[*i] != '{') return false;
    ++(*i);
    Clip::Kf kf;
    bool got_t = false, got_v = false;
    for (;;) {
      skip_ws(s, i);
      if (*i < s.size() && s[*i] == '}') { ++(*i); break; }
      std::string key;
      if (!parse_string(s, i, &key)) return false;
      skip_ws(s, i);
      if (*i >= s.size() || s[*i] != ':') return false;
      ++(*i);
      if (key == "t") {
        double n = 0;
        if (!parse_number(s, i, &n)) return false;
        kf.t = n; got_t = true;
      } else if (key == "value") {
        double n = 0;
        if (!parse_number(s, i, &n)) return false;
        kf.value = n; got_v = true;
      } else if (key == "ease") {
        if (!parse_string(s, i, &kf.ease)) return false;
      } else if (key == "oh") {
        skip_ws(s, i);
        if (*i < s.size() && s[*i] == '{') {
          if (!parse_kf_handle_obj(s, i, &kf.oh)) return false;
          kf.has_oh = true;
        } else {
          if (!skip_value(s, i)) return false;
        }
      } else if (key == "ih") {
        skip_ws(s, i);
        if (*i < s.size() && s[*i] == '{') {
          if (!parse_kf_handle_obj(s, i, &kf.ih)) return false;
          kf.has_ih = true;
        } else {
          if (!skip_value(s, i)) return false;
        }
      } else {
        if (!skip_value(s, i)) return false;
      }
      skip_ws(s, i);
      if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
      if (*i < s.size() && s[*i] == '}') { ++(*i); break; }
      return false;
    }
    if (got_t && got_v) out->push_back(kf);
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
    return false;
  }
}

bool parse_keyframes_obj(const std::string &s, size_t *i, Clip *c) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '{') return false;
  ++(*i);
  for (;;) {
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    std::string key;
    if (!parse_string(s, i, &key)) return false;
    skip_ws(s, i);
    if (*i >= s.size() || s[*i] != ':') return false;
    ++(*i);
    std::vector<Clip::Kf> *dst = nullptr;
    if (key == "x") dst = &c->kf_x;
    else if (key == "y") dst = &c->kf_y;
    else if (key == "scale") dst = &c->kf_scale;
    else if (key == "scaleY") dst = &c->kf_scale_y;
    else if (key == "rotation") dst = &c->kf_rot;
    else if (key == "opacity") dst = &c->kf_opacity;
    if (dst) {
      if (!parse_kf_array(s, i, dst)) return false;
    } else {
      if (!skip_value(s, i)) return false;
    }
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    return false;
  }
}

bool parse_clip_obj(const std::string &s, size_t *i, Clip *c) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '{') return false;
  ++(*i);
  for (;;) {
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    std::string key;
    if (!parse_string(s, i, &key)) return false;
    skip_ws(s, i);
    if (*i >= s.size() || s[*i] != ':') return false;
    ++(*i);
    if (key == "mediaPath") {
      if (!parse_string(s, i, &c->media_path)) return false;
    } else if (key == "trackId") {
      if (!parse_string(s, i, &c->track_id)) return false;
    } else if (key == "kind") {
      if (!parse_string(s, i, &c->kind)) return false;
    } else if (key == "start") {
      if (!parse_number(s, i, &c->start)) return false;
    } else if (key == "duration") {
      if (!parse_number(s, i, &c->duration)) return false;
    } else if (key == "inPoint") {
      if (!parse_number(s, i, &c->in_point)) return false;
    } else if (key == "outPoint") {
      if (!parse_number(s, i, &c->out_point)) return false;
    } else if (key == "enabled") {
      if (!parse_bool(s, i, &c->enabled)) return false;
    } else if (key == "speed") {
      if (!parse_number(s, i, &c->speed)) return false;
    } else if (key == "reverse") {
      if (!parse_bool(s, i, &c->reverse)) return false;
    } else if (key == "x") {
      if (!parse_number(s, i, &c->x)) return false;
    } else if (key == "y") {
      if (!parse_number(s, i, &c->y)) return false;
    } else if (key == "scaleX") {
      if (!parse_number(s, i, &c->scale_x)) return false;
    } else if (key == "scaleY") {
      if (!parse_number(s, i, &c->scale_y)) return false;
    } else if (key == "rotation") {
      if (!parse_number(s, i, &c->rotation)) return false;
    } else if (key == "opacity") {
      if (!parse_number(s, i, &c->opacity)) return false;
    } else if (key == "cropL") {
      if (!parse_number(s, i, &c->crop_l)) return false;
    } else if (key == "cropR") {
      if (!parse_number(s, i, &c->crop_r)) return false;
    } else if (key == "cropT") {
      if (!parse_number(s, i, &c->crop_t)) return false;
    } else if (key == "cropB") {
      if (!parse_number(s, i, &c->crop_b)) return false;
    } else if (key == "exposure") {
      if (!parse_number(s, i, &c->exposure)) return false;
    } else if (key == "contrast") {
      if (!parse_number(s, i, &c->contrast)) return false;
    } else if (key == "saturation") {
      if (!parse_number(s, i, &c->saturation)) return false;
    } else if (key == "temperature") {
      if (!parse_number(s, i, &c->temperature)) return false;
    } else if (key == "tint") {
      if (!parse_number(s, i, &c->tint)) return false;
    } else if (key == "blend") {
      if (!parse_string(s, i, &c->blend)) return false;
    } else if (key == "text") {
      if (!parse_text_obj(s, i, c)) return false;
    } else if (key == "effects") {
      if (!parse_effects_array(s, i, c)) return false;
    } else if (key == "mask") {
      if (!parse_mask_obj(s, i, c)) return false;
    } else if (key == "chromaKey") {
      if (!parse_chroma_obj(s, i, c)) return false;
    } else if (key == "transitionIn") {
      if (!parse_transition_obj(s, i, &c->trans_in_type, &c->trans_in_dur)) return false;
    } else if (key == "transitionOut") {
      if (!parse_transition_obj(s, i, &c->trans_out_type, &c->trans_out_dur)) return false;
    } else if (key == "keyframes") {
      if (!parse_keyframes_obj(s, i, c)) return false;
    } else {
      if (!skip_value(s, i)) return false;
    }
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    return false;
  }
}

bool parse_track_obj(const std::string &s, size_t *i, Track *t) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '{') return false;
  ++(*i);
  for (;;) {
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    std::string key;
    if (!parse_string(s, i, &key)) return false;
    skip_ws(s, i);
    if (*i >= s.size() || s[*i] != ':') return false;
    ++(*i);
    if (key == "id") {
      if (!parse_string(s, i, &t->id)) return false;
    } else if (key == "kind") {
      if (!parse_string(s, i, &t->kind)) return false;
    } else if (key == "muted") {
      if (!parse_bool(s, i, &t->muted)) return false;
    } else {
      if (!skip_value(s, i)) return false;
    }
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == '}') { ++(*i); return true; }
    return false;
  }
}

bool parse_array_of_clips(const std::string &s, size_t *i, std::vector<Clip> *out) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '[') return false;
  ++(*i);
  skip_ws(s, i);
  if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
  for (;;) {
    Clip c;
    if (!parse_clip_obj(s, i, &c)) return false;
    out->push_back(std::move(c));
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
    return false;
  }
}

bool parse_array_of_tracks(const std::string &s, size_t *i, std::vector<Track> *out) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '[') return false;
  ++(*i);
  skip_ws(s, i);
  if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
  int idx = 0;
  for (;;) {
    Track t;
    t.index = idx++;
    if (!parse_track_obj(s, i, &t)) return false;
    out->push_back(std::move(t));
    skip_ws(s, i);
    if (*i < s.size() && s[*i] == ',') { ++(*i); continue; }
    if (*i < s.size() && s[*i] == ']') { ++(*i); return true; }
    return false;
  }
}

}  // namespace

bool usable_path(const std::string &p) {
  if (p.empty() || p.find('\0') != std::string::npos) return false;
  if (p.rfind("blob:", 0) == 0 || p.rfind("data:", 0) == 0) return false;
  if (!is_absolute_path_utf8(p)) return false;
  const std::wstring w = utf8_to_wide(p);
  return !w.empty() && file_exists_w(w.c_str());
}

bool is_still_image(const std::string &kind, const std::string &media_path) {
  if (kind == "image") return true;
  const std::string e = lower_ext(media_path);
  return e == ".png" || e == ".jpg" || e == ".jpeg" || e == ".webp" ||
         e == ".bmp" || e == ".gif" || e == ".tif" || e == ".tiff";
}

bool parse_edit_graph(const std::string &s, EditGraph *g) {
  size_t i = 0;
  skip_ws(s, &i);
  if (i >= s.size() || s[i] != '{') return false;
  ++i;
  for (;;) {
    skip_ws(s, &i);
    if (i < s.size() && s[i] == '}') return true;
    std::string key;
    if (!parse_string(s, &i, &key)) return false;
    skip_ws(s, &i);
    if (i >= s.size() || s[i] != ':') return false;
    ++i;
    if (key == "clips") {
      if (!parse_array_of_clips(s, &i, &g->clips)) return false;
    } else if (key == "tracks") {
      if (!parse_array_of_tracks(s, &i, &g->tracks)) return false;
    } else if (key == "settings") {
      skip_ws(s, &i);
      if (i >= s.size() || s[i] != '{') return false;
      ++i;
      for (;;) {
        skip_ws(s, &i);
        if (i < s.size() && s[i] == '}') { ++i; break; }
        std::string sk;
        if (!parse_string(s, &i, &sk)) return false;
        skip_ws(s, &i);
        if (i >= s.size() || s[i] != ':') return false;
        ++i;
        double n = 0;
        if (sk == "width") {
          if (!parse_number(s, &i, &n)) return false;
          g->width = static_cast<int>(n);
        } else if (sk == "height") {
          if (!parse_number(s, &i, &n)) return false;
          g->height = static_cast<int>(n);
        } else if (sk == "fps") {
          if (!parse_number(s, &i, &n)) return false;
          g->fps = n;
        } else {
          if (!skip_value(s, &i)) return false;
        }
        skip_ws(s, &i);
        if (i < s.size() && s[i] == ',') { ++i; continue; }
        if (i < s.size() && s[i] == '}') { ++i; break; }
        return false;
      }
    } else if (key == "workIn") {
      if (!parse_number(s, &i, &g->work_in)) return false;
    } else if (key == "workOut") {
      if (!parse_number(s, &i, &g->work_out)) return false;
    } else if (key == "rangeOnly") {
      if (!parse_bool(s, &i, &g->range_only)) return false;
    } else if (key == "audioOnly") {
      if (!parse_bool(s, &i, &g->audio_only)) return false;
    } else {
      if (!skip_value(s, &i)) return false;
    }
    skip_ws(s, &i);
    if (i < s.size() && s[i] == ',') { ++i; continue; }
    if (i < s.size() && s[i] == '}') return true;
    return false;
  }
}

#endif
