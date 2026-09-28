/* B2 todo-preview-engine.exe — JSON-line protocol v1 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <dxgi1_2.h>

#include "editgraph.h"
#include "native_supports.h"
#include "preview_clock.h"
#include "preview_window.h"
#include "quantize.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <io.h>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3d11.lib")

static const size_t kMaxLine = 16ull * 1024ull * 1024ull;

static PreviewClock g_clock;
static PreviewWindow g_win;
static std::atomic<bool> g_inited{false};
static std::atomic<bool> g_visible_on{false};
static std::atomic<bool> g_suspended{false};
static std::atomic<bool> g_quit{false};
static std::atomic<uint64_t> g_cmd_count{0};
static std::atomic<uint64_t> g_seek_count{0};
static std::atomic<uint64_t> g_seek_total_us{0};
static std::chrono::steady_clock::time_point g_start_tp;

static std::shared_ptr<const EditGraph> g_timeline;
static std::mutex g_timeline_mu;
static std::set<std::string> g_unsupported;
static std::mutex g_unsup_mu;
static std::mutex g_out_mu;

static std::string g_adapter_name;
static std::string g_adapter_luid;
static int g_feature_level = 0;
static bool g_mt_protected = false;

static void emit_raw(const std::string &line) {
  std::lock_guard<std::mutex> lock(g_out_mu);
  std::fwrite(line.data(), 1, line.size(), stdout);
  if (line.empty() || line.back() != '\n') std::fputc('\n', stdout);
  std::fflush(stdout);
}

static std::string json_escape(const std::string &s) {
  std::string o;
  o.reserve(s.size() + 8);
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o.push_back('\\'); o.push_back(static_cast<char>(c)); }
    else if (c == '\n') o += "\\n";
    else if (c == '\r') o += "\\r";
    else if (c == '\t') o += "\\t";
    else if (c < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof(buf), "\\u%04x", c);
      o += buf;
    } else o.push_back(static_cast<char>(c));
  }
  return o;
}

static void emit_error(const char *code, const std::string &msg, int id = -1) {
  std::ostringstream oss;
  oss << "{\"ev\":\"error\",\"code\":\"" << json_escape(code) << "\",\"msg\":\"" << json_escape(msg) << "\"";
  if (id >= 0) oss << ",\"id\":" << id;
  oss << "}";
  emit_raw(oss.str());
}

static void emit_ack(int id) {
  if (id < 0) return;
  emit_raw("{\"ev\":\"ack\",\"id\":" + std::to_string(id) + "}");
}

static void emit_playhead() {
  const int64_t fr = g_clock.current_frame();
  const bool playing = g_clock.is_playing();
  const uint64_t serial = g_clock.current_serial();
  std::ostringstream oss;
  oss << "{\"ev\":\"playhead\",\"frame\":" << fr
      << ",\"playing\":" << (playing ? "true" : "false")
      << ",\"serial\":" << serial << "}";
  emit_raw(oss.str());
}

/* --- minimal JSON field extractors (object root) --- */
static void skip_ws(const std::string &s, size_t *i) {
  while (*i < s.size() && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\r' || s[*i] == '\n')) ++(*i);
}

static bool parse_string_val(const std::string &s, size_t *i, std::string *out) {
  skip_ws(s, i);
  if (*i >= s.size() || s[*i] != '"') return false;
  ++(*i);
  out->clear();
  while (*i < s.size()) {
    char c = s[*i]; ++(*i);
    if (c == '"') return true;
    if (c == '\\' && *i < s.size()) {
      char e = s[*i]; ++(*i);
      if (e == 'n') out->push_back('\n');
      else if (e == 'r') out->push_back('\r');
      else if (e == 't') out->push_back('\t');
      else out->push_back(e);
    } else out->push_back(c);
  }
  return false;
}

static bool find_key(const std::string &s, const char *key, size_t *pos) {
  const std::string pat = std::string("\"") + key + "\"";
  size_t i = 0;
  while (i < s.size()) {
    size_t at = s.find(pat, i);
    if (at == std::string::npos) return false;
    size_t j = at + pat.size();
    skip_ws(s, &j);
    if (j < s.size() && s[j] == ':') { *pos = j + 1; return true; }
    i = at + 1;
  }
  return false;
}

static bool get_string(const std::string &s, const char *key, std::string *out) {
  size_t p = 0;
  if (!find_key(s, key, &p)) return false;
  return parse_string_val(s, &p, out);
}

static bool get_number(const std::string &s, const char *key, double *out) {
  size_t p = 0;
  if (!find_key(s, key, &p)) return false;
  skip_ws(s, &p);
  char *end = nullptr;
  const double v = std::strtod(s.c_str() + p, &end);
  if (end == s.c_str() + p) return false;
  *out = v;
  return true;
}

static bool get_int64(const std::string &s, const char *key, int64_t *out) {
  double d = 0;
  if (!get_number(s, key, &d)) return false;
  *out = static_cast<int64_t>(d);
  return true;
}

static bool get_int(const std::string &s, const char *key, int *out) {
  double d = 0;
  if (!get_number(s, key, &d)) return false;
  *out = static_cast<int>(d);
  return true;
}

static bool get_bool(const std::string &s, const char *key, bool *out) {
  size_t p = 0;
  if (!find_key(s, key, &p)) return false;
  skip_ws(s, &p);
  if (s.compare(p, 4, "true") == 0) { *out = true; return true; }
  if (s.compare(p, 5, "false") == 0) { *out = false; return true; }
  return false;
}

static bool get_nullable_string(const std::string &s, const char *key, std::string *out, bool *is_null) {
  size_t p = 0;
  *is_null = false;
  if (!find_key(s, key, &p)) return false;
  skip_ws(s, &p);
  if (s.compare(p, 4, "null") == 0) { *is_null = true; out->clear(); return true; }
  return parse_string_val(s, &p, out);
}

static uint64_t parse_luid_string(const std::string &s) {
  if (s.empty()) return 0;
  return std::strtoull(s.c_str(), nullptr, 0);
}

struct ITodoD3D11Multithread : public IUnknown {
  virtual void STDMETHODCALLTYPE Enter() = 0;
  virtual void STDMETHODCALLTYPE Leave() = 0;
  virtual BOOL STDMETHODCALLTYPE SetMultithreadProtected(BOOL b) = 0;
  virtual BOOL STDMETHODCALLTYPE GetMultithreadProtected() = 0;
};
static const GUID kIID_MT =
  {0x9B7E4E00, 0x342C, 0x4106, {0xA1, 0x9F, 0x4F, 0x27, 0x04, 0xF6, 0x89, 0xF0}};

static bool pick_adapter(uint64_t override_luid, IDXGIAdapter1 **out_adapter,
                         std::string *name, std::string *luid_str, int *feature_level, bool *mt_ok) {
  *out_adapter = nullptr;
  *mt_ok = false;
  IDXGIFactory1 *factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void **)&factory)) || !factory) return false;

  struct Cand { IDXGIAdapter1 *ad; SIZE_T vram; UINT flags; std::string name; LUID luid; };
  std::vector<Cand> list;
  for (UINT i = 0;; ++i) {
    IDXGIAdapter1 *ad = nullptr;
    if (factory->EnumAdapters1(i, &ad) == DXGI_ERROR_NOT_FOUND) break;
    DXGI_ADAPTER_DESC1 desc{};
    ad->GetDesc1(&desc);
    Cand c;
    c.ad = ad; c.vram = desc.DedicatedVideoMemory; c.flags = desc.Flags; c.luid = desc.AdapterLuid;
    int n = WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, nullptr, 0, nullptr, nullptr);
    c.name.assign(n > 0 ? n - 1 : 0, '\0');
    if (n > 1) WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, c.name.data(), n, nullptr, nullptr);
    list.push_back(c);
  }

  Cand *chosen = nullptr;
  if (override_luid) {
    for (auto &c : list) {
      uint64_t v = (uint64_t(uint32_t(c.luid.HighPart)) << 32) | uint32_t(c.luid.LowPart);
      if (v == override_luid) { chosen = &c; break; }
    }
  }
  if (!chosen) {
    SIZE_T best = 0;
    for (auto &c : list) {
      if (c.flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
      if (c.vram == 0) continue;
      if (!chosen || c.vram > best) { chosen = &c; best = c.vram; }
    }
  }
  if (!chosen) {
    for (auto &c : list) if (c.ad) c.ad->Release();
    factory->Release();
    return false;
  }

  ID3D11Device *dev = nullptr;
  ID3D11DeviceContext *ctx = nullptr;
  D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
  const D3D_FEATURE_LEVEL levels[] = {
    D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0
  };
  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
  HRESULT hr = D3D11CreateDevice(chosen->ad, D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags,
    levels, 4, D3D11_SDK_VERSION, &dev, &fl, &ctx);
  if (FAILED(hr)) {
    flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    hr = D3D11CreateDevice(chosen->ad, D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags,
      levels, 4, D3D11_SDK_VERSION, &dev, &fl, &ctx);
  }
  if (SUCCEEDED(hr) && dev) {
    *feature_level = static_cast<int>(fl);
    ITodoD3D11Multithread *mt = nullptr;
    if (SUCCEEDED(dev->QueryInterface(kIID_MT, (void **)&mt)) && mt) {
      mt->SetMultithreadProtected(TRUE);
      *mt_ok = mt->GetMultithreadProtected() != FALSE;
      mt->Release();
    }
    if (ctx) ctx->Release();
    dev->Release();
  } else {
    *feature_level = 0;
  }

  char lbuf[32];
  std::snprintf(lbuf, sizeof(lbuf), "0x%08X%08X",
    (unsigned)chosen->luid.HighPart, (unsigned)chosen->luid.LowPart);
  *name = chosen->name;
  *luid_str = lbuf;
  *out_adapter = chosen->ad;
  chosen->ad = nullptr;
  for (auto &c : list) if (c.ad) c.ad->Release();
  factory->Release();
  return true;
}

static void apply_visibility() {
  const bool show = g_visible_on.load() && !g_suspended.load();
  g_win.post_visible(show);
}

static void refresh_unsupported() {
  std::shared_ptr<const EditGraph> snap;
  {
    std::lock_guard<std::mutex> lock(g_timeline_mu);
    snap = g_timeline;
  }
  std::set<std::string> next;
  if (snap) {
    const double t = t_from_frame(g_clock.current_frame(), g_clock.fps.load());
    auto ids = native_unsupported_clip_ids(*snap, t);
    next.insert(ids.begin(), ids.end());
  }
  bool changed = false;
  {
    std::lock_guard<std::mutex> lock(g_unsup_mu);
    if (next != g_unsupported) {
      g_unsupported.swap(next);
      changed = true;
    }
  }
  if (!changed) return;
  std::ostringstream oss;
  oss << "{\"ev\":\"unsupported\",\"clipIds\":[";
  {
    std::lock_guard<std::mutex> lock(g_unsup_mu);
    bool first = true;
    for (const auto &id : g_unsupported) {
      if (!first) oss << ',';
      first = false;
      oss << '"' << json_escape(id) << '"';
    }
  }
  oss << "],\"reason\":\"native_supports\"}";
  emit_raw(oss.str());
}

static void handle_cmd(const std::string &line) {
  g_cmd_count.fetch_add(1, std::memory_order_relaxed);
  int id = -1;
  {
    double idd = 0;
    if (get_number(line, "id", &idd)) id = static_cast<int>(idd);
  }
  std::string cmd;
  if (!get_string(line, "cmd", &cmd)) {
    emit_error("bad_json", "missing cmd", id);
    return;
  }

  if (cmd == "init") {
    if (g_inited.load()) {
      emit_error("init_twice", "init already called", id);
      return;
    }
    int64_t hwnd64 = 0;
    if (!get_int64(line, "hwnd", &hwnd64) || hwnd64 == 0) {
      emit_error("bad_args", "init requires hwnd", id);
      return;
    }
    double fps = 30;
    get_number(line, "fps", &fps);
    int budget = 0;
    get_int(line, "budgetMB", &budget);
    (void)budget;
    std::string luid_s;
    bool luid_null = true;
    get_nullable_string(line, "adapterLuid", &luid_s, &luid_null);
    uint64_t override_luid = luid_null ? 0 : parse_luid_string(luid_s);

    HWND owner = reinterpret_cast<HWND>(static_cast<uintptr_t>(hwnd64));
    if (!IsWindow(owner)) {
      emit_error("bad_hwnd", "owner hwnd invalid", id);
      return;
    }

    IDXGIAdapter1 *ad = nullptr;
    if (!pick_adapter(override_luid, &ad, &g_adapter_name, &g_adapter_luid, &g_feature_level, &g_mt_protected)) {
      emit_error("no_adapter", "DXGI adapter select failed", id);
      return;
    }
    if (ad) ad->Release();

    g_clock.set_fps(fps);
    if (!g_win.start(owner)) {
      emit_error("window_fail", "popup window create failed", id);
      return;
    }
    g_inited.store(true);
    emit_ack(id);
    {
      std::ostringstream oss;
      oss << "{\"ev\":\"ready\",\"adapter\":\"" << json_escape(g_adapter_name)
          << "\",\"luid\":\"" << json_escape(g_adapter_luid)
          << "\",\"featureLevel\":" << g_feature_level
          << ",\"mtProtected\":" << (g_mt_protected ? "true" : "false") << "}";
      emit_raw(oss.str());
    }
    return;
  }

  if (cmd == "rect") {
    int x = 0, y = 0, w = 0, h = 0;
    if (!get_int(line, "x", &x) || !get_int(line, "y", &y) ||
        !get_int(line, "w", &w) || !get_int(line, "h", &h)) {
      emit_error("bad_args", "rect requires x,y,w,h", id);
      return;
    }
    if (w <= 0 || h <= 0) {
      emit_error("bad_rect", "w and h must be > 0", id);
      return;
    }
    if (!g_inited.load()) {
      emit_error("not_inited", "call init first", id);
      return;
    }
    g_win.post_rect(x, y, w, h);
    emit_ack(id);
    return;
  }

  if (cmd == "visible") {
    bool on = false;
    if (!get_bool(line, "on", &on)) {
      emit_error("bad_args", "visible requires on", id);
      return;
    }
    g_visible_on.store(on);
    apply_visibility();
    emit_ack(id);
    return;
  }

  if (cmd == "suspend") {
    g_suspended.store(true);
    g_win.post_visible(false); /* SW_HIDE via ShowWindow */
    emit_ack(id);
    return;
  }

  if (cmd == "resume") {
    g_suspended.store(false);
    apply_visibility();
    emit_ack(id);
    return;
  }

  if (cmd == "timeline") {
    std::string json;
    if (!get_string(line, "json", &json)) {
      emit_error("bad_args", "timeline requires json string", id);
      return;
    }
    auto next = std::make_shared<EditGraph>();
    if (!parse_edit_graph(json, next.get())) {
      emit_error("bad_timeline", "EditGraph parse failed", id);
      return;
    }
    {
      std::lock_guard<std::mutex> lock(g_timeline_mu);
      g_timeline = next;
    }
    if (next->fps > 1e-6) g_clock.set_fps(next->fps);
    emit_ack(id);
    refresh_unsupported();
    return;
  }

  if (cmd == "seek") {
    const auto t0 = std::chrono::steady_clock::now();
    int64_t fr = 0;
    if (!get_int64(line, "frame", &fr)) {
      emit_error("bad_args", "seek requires frame", id);
      return;
    }
    g_clock.seek(fr);
    g_seek_count.fetch_add(1, std::memory_order_relaxed);
    const auto us = std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now() - t0).count();
    g_seek_total_us.fetch_add(static_cast<uint64_t>(us < 0 ? 0 : us), std::memory_order_relaxed);
    emit_ack(id);
    emit_playhead();
    refresh_unsupported();
    return;
  }

  if (cmd == "play") {
    g_clock.play();
    emit_ack(id);
    emit_playhead();
    return;
  }

  if (cmd == "pause") {
    g_clock.pause();
    emit_ack(id);
    emit_playhead();
    return;
  }

  if (cmd == "stats") {
    const auto uptime = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - g_start_tp).count();
    std::ostringstream oss;
    oss << "{\"ev\":\"stats\",\"data\":{"
        << "\"cmdCount\":" << g_cmd_count.load()
        << ",\"seekCount\":" << g_seek_count.load()
        << ",\"seekTotalUs\":" << g_seek_total_us.load()
        << ",\"serial\":" << g_clock.current_serial()
        << ",\"uptimeMs\":" << uptime
        << ",\"windowVisible\":" << (g_win.is_window_visible() ? "true" : "false")
        << ",\"suspended\":" << (g_suspended.load() ? "true" : "false")
        << "}}";
    emit_raw(oss.str());
    emit_ack(id);
    return;
  }

  if (cmd == "quit") {
    emit_ack(id);
    g_quit.store(true);
    return;
  }

  emit_error("unknown_cmd", "unknown cmd: " + cmd, id);
}

static void parent_watch_thread() {
  const char *env = std::getenv("TODO_PARENT_PID");
  if (!env || !env[0]) return;
  const DWORD pid = static_cast<DWORD>(std::strtoul(env, nullptr, 10));
  if (!pid) return;
  HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (!h) return;
  WaitForSingleObject(h, INFINITE);
  CloseHandle(h);
  g_quit.store(true);
}

static void playhead_thread() {
  while (!g_quit.load()) {
    if (g_clock.is_playing()) emit_playhead();
    Sleep(33); /* ~30Hz */
  }
}

static void set_dpi() {
  using Fn = HRESULT(WINAPI *)(DPI_AWARENESS_CONTEXT);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (user32) {
    auto p = reinterpret_cast<Fn>(GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
    if (p) {
      if (SUCCEEDED(p(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))) return;
      p(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE);
      return;
    }
  }
  SetProcessDPIAware();
}

int main() {
  set_dpi();
  g_start_tp = std::chrono::steady_clock::now();
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  g_clock.set_fps(30); /* init CRITICAL_SECTION before worker threads */

  std::thread(parent_watch_thread).detach();
  std::thread(playhead_thread).detach();

  HANDLE stdinH = GetStdHandle(STD_INPUT_HANDLE);
  std::string buf;
  buf.reserve(4096);
  char tmp[64 * 1024];

  while (!g_quit.load()) {
    DWORD avail = 0;
    if (!PeekNamedPipe(stdinH, nullptr, 0, nullptr, &avail, nullptr)) {
      /* console mode or pipe closed */
      DWORD rd = 0;
      if (!ReadFile(stdinH, tmp, sizeof(tmp), &rd, nullptr) || rd == 0) break;
      buf.append(tmp, rd);
    } else if (avail == 0) {
      Sleep(1);
      continue;
    } else {
      DWORD rd = 0;
      const DWORD n = avail > sizeof(tmp) ? sizeof(tmp) : avail;
      if (!ReadFile(stdinH, tmp, n, &rd, nullptr) || rd == 0) break;
      buf.append(tmp, rd);
    }

    if (buf.size() > kMaxLine) {
      emit_error("line_too_long", "line exceeds 16MB");
      buf.clear();
      continue;
    }

    size_t nl;
    while ((nl = buf.find('\n')) != std::string::npos) {
      std::string line = buf.substr(0, nl);
      buf.erase(0, nl + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.empty()) continue;
      if (line.size() > kMaxLine) {
        emit_error("line_too_long", "line exceeds 16MB");
        continue;
      }
      size_t i = 0;
      skip_ws(line, &i);
      if (i >= line.size() || line[i] != '{') {
        emit_error("bad_json", "expected JSON object");
        continue;
      }
      handle_cmd(line);
      if (g_quit.load()) break;
    }
  }

  g_quit.store(true);
  g_win.stop();
  return 0;
}
