/* EditGraph v1 → ffmpeg (equivalent to electron/exportSequence.cjs). */
#include "todo_export.h"

#ifdef _WIN32

#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "todo_engine.h"
#include "editgraph.h"
#include "timemap.h"
#include "keyframes.h"
#include "layers.h"

namespace {

void json_escape_out(const char *s) {
  std::fputc('"', stdout);
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(s); *p; ++p) {
    if (*p == '"' || *p == '\\') std::printf("\\%c", *p);
    else if (*p < 32) std::printf("\\u%04x", *p);
    else std::fputc(*p, stdout);
  }
  std::fputc('"', stdout);
}

int fail_json(const char *message) {
  std::printf("{\"ok\":false,\"error\":");
  json_escape_out(message);
  std::puts("}");
  return 1;
}

int ok_json(const char *path_utf8) {
  std::printf("{\"ok\":true,\"backend\":\"todo-cpp-ffmpeg\",\"path\":");
  json_escape_out(path_utf8);
  std::puts("}");
  return 0;
}

std::wstring quote_arg(const std::wstring &a) {
  if (a.find_first_of(L" \t\"") == std::wstring::npos) return a;
  std::wstring out = L"\"";
  for (wchar_t c : a) {
    if (c == L'"') out += L"\\\"";
    else out += c;
  }
  out += L'"';
  return out;
}

std::wstring find_ffmpeg() {
  wchar_t env[MAX_PATH * 4];
  const DWORD n = GetEnvironmentVariableW(L"FFMPEG", env, MAX_PATH * 4);
  if (n > 0 && n < MAX_PATH * 4 && file_exists_w(env)) return env;

  wchar_t mod[MAX_PATH];
  const DWORD m = GetModuleFileNameW(nullptr, mod, MAX_PATH);
  if (m > 0 && m < MAX_PATH) {
    std::wstring dir(mod, mod + m);
    const auto slash = dir.find_last_of(L"\\/");
    if (slash != std::wstring::npos) {
      const std::wstring beside = dir.substr(0, slash + 1) + L"ffmpeg.exe";
      if (file_exists_w(beside.c_str())) return beside;
    }
  }

  wchar_t local[MAX_PATH];
  const DWORD l = GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH);
  if (l > 0 && l < MAX_PATH) {
    std::wstring winget = std::wstring(local) + L"\\Microsoft\\WinGet\\Links\\ffmpeg.exe";
    if (file_exists_w(winget.c_str())) return winget;
  }

  wchar_t found[MAX_PATH];
  if (SearchPathW(nullptr, L"ffmpeg.exe", nullptr, MAX_PATH, found, nullptr)) return found;
  if (SearchPathW(nullptr, L"ffmpeg", nullptr, MAX_PATH, found, nullptr)) return found;
  return {};
}

bool ensure_parent_dirs(const std::wstring &file_path) {
  const auto slash = file_path.find_last_of(L"\\/");
  if (slash == std::wstring::npos || slash == 0) return true;
  std::wstring dir = file_path.substr(0, slash);
  for (size_t i = 0; i < dir.size(); ++i) {
    if (dir[i] == L'/' || dir[i] == L'\\') {
      if (i == 0) continue;
      if (i == 2 && dir[1] == L':') continue;
      const std::wstring part = dir.substr(0, i);
      CreateDirectoryW(part.c_str(), nullptr);
    }
  }
  CreateDirectoryW(dir.c_str(), nullptr);
  return true;
}

struct InputMeta {
  std::string path;
  bool loop = false;
  double t = 0;
};

int run_ffmpeg(const std::wstring &ffmpeg, const std::vector<std::wstring> &args) {
  std::wstring cmd = quote_arg(ffmpeg);
  for (const auto &a : args) {
    cmd.push_back(L' ');
    cmd += quote_arg(a);
  }

  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
  if (nul == INVALID_HANDLE_VALUE) return -1;

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = nul;
  si.hStdOutput = nul;
  si.hStdError = nul;
  PROCESS_INFORMATION pi{};

  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(L'\0');

  /* lpApplicationName=NULL：避免带 %06d 的 image2 序列参数时启动失败 */
  const BOOL ok = CreateProcessW(
    nullptr,
    buf.data(),
    nullptr, nullptr, TRUE,
    CREATE_NO_WINDOW,
    nullptr, nullptr, &si, &pi);
  CloseHandle(nul);
  if (!ok) return -1;

  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return static_cast<int>(code);
}

std::string fmt_num(double v) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.6g", v);
  return buf;
}

}  // namespace

static int compose_graph_rgb(const EditGraph &g, double time_sec, std::vector<uint8_t> *canvas, int *out_w, int *out_h, int *out_layers);
static bool write_bmp_file(const wchar_t *path, int w, int h, const uint8_t *rgb);

int todo_cmd_export(const wchar_t *graph_path, const wchar_t *out_path) {
  if (!graph_path || !out_path || !graph_path[0] || !out_path[0]) {
    return fail_json("export requires editGraph.json and out.mp4");
  }

  std::string json;
  if (!read_file_utf8(graph_path, &json)) return fail_json("cannot read editGraph.json");

  EditGraph g;
  if (!parse_edit_graph(json, &g)) return fail_json("invalid EditGraph JSON");

  int w = (std::max)(16, static_cast<int>(std::lround(g.width)) & ~1);
  int h = (std::max)(16, static_cast<int>(std::lround(g.height)) & ~1);
  const double fps = (std::max)(1.0, g.fps);
  const bool audio_only = g.audio_only;
  const bool range_only = g.range_only;
  double work_in = (std::max)(0.0, g.work_in);
  double work_out = (std::max)(work_in + 0.05, g.work_out);

  std::vector<Clip> clips;
  for (const auto &c : g.clips) {
    if (!c.enabled) continue;
    if (!usable_path(c.media_path)) continue;
    clips.push_back(c);
  }

  auto track_of = [&](const std::string &id) -> const Track * {
    for (const auto &t : g.tracks) if (t.id == id) return &t;
    return nullptr;
  };

  std::vector<Clip> video_clips;
  for (const auto &c : clips) {
    const Track *t = track_of(c.track_id);
    if (!t || t->kind != "video") continue;
    std::string k = c.kind;
    if (k.empty()) k = is_still_image(c.kind, c.media_path) ? "image" : "video";
    if (k == "video" || k == "image") video_clips.push_back(c);
  }
  std::sort(video_clips.begin(), video_clips.end(), [&](const Clip &a, const Clip &b) {
    const Track *ta = track_of(a.track_id);
    const Track *tb = track_of(b.track_id);
    const int ia = ta ? ta->index : 0;
    const int ib = tb ? tb->index : 0;
    if (ia != ib) return ia > ib;
    return a.start < b.start;
  });

  std::vector<Clip> audio_clips;
  for (const auto &c : clips) {
    const Track *t = track_of(c.track_id);
    if (!t || t->kind != "audio" || t->muted) continue;
    if (is_still_image(c.kind, c.media_path) || c.kind == "image") continue;
    audio_clips.push_back(c);
  }

  double timeline_end = 0;
  for (const auto &c : clips) timeline_end = (std::max)(timeline_end, c.start + c.duration);
  if (!(timeline_end > 0)) timeline_end = range_only ? work_out : 1.0;
  const double out_dur = (std::max)(0.1, timeline_end);

  /* Video: compose each frame (same rules as preview) then ffmpeg encode. */
  if (!audio_only) {
    if (video_clips.empty() && audio_clips.empty()) {
      return fail_json("没有可导出的媒体片段（需本机 path）");
    }
    const double t0 = range_only ? work_in : 0.0;
    const double t1 = range_only ? work_out : out_dur;
    const int nframes = (std::max)(1, static_cast<int>(std::ceil((t1 - t0) * fps)));

    wchar_t tmp_root[MAX_PATH];
    GetTempPathW(MAX_PATH, tmp_root);
    std::wstring frame_dir = std::wstring(tmp_root) + L"todo-compose-export-" + std::to_wstring(GetCurrentProcessId());
    CreateDirectoryW(frame_dir.c_str(), nullptr);

    std::vector<uint8_t> canvas;
    for (int fi = 0; fi < nframes; ++fi) {
      const double t = t0 + (fi + 0.0) / fps;
      int cw = 0, ch = 0, layers = 0;
      compose_graph_rgb(g, t, &canvas, &cw, &ch, &layers);
      wchar_t name[64];
      std::swprintf(name, 64, L"\\%06d.bmp", fi);
      const std::wstring fp = frame_dir + name;
      if (!write_bmp_file(fp.c_str(), cw, ch, canvas.data())) {
        return fail_json("compose frame write failed");
      }
    }

    std::vector<InputMeta> inputs;
    std::vector<std::string> filters;
    std::vector<std::string> audio_labs;
    for (size_t i = 0; i < audio_clips.size(); ++i) {
      const Clip &c = audio_clips[i];
      /* input 0 = BMP 序列；音频从 1 起 */
      const int idx = static_cast<int>(i + 1);
      inputs.push_back({c.media_path, false, 0});
      const double start = (std::max)(0.0, c.start);
      const double dur = (std::max)(0.04, c.duration);
      const double in_point = (std::max)(0.0, c.in_point);
      const int delay_ms = static_cast<int>(std::lround(start * 1000.0));
      const std::string lab = "a" + std::to_string(i);
      filters.push_back(
        "[" + std::to_string(idx) + ":a]atrim=start=" + fmt_num(in_point) + ":duration=" + fmt_num(dur) +
        ",asetpts=PTS-STARTPTS,adelay=" + std::to_string(delay_ms) + "|" + std::to_string(delay_ms) +
        ":all=1[" + lab + "]");
      audio_labs.push_back("[" + lab + "]");
    }
    if (audio_labs.size() == 1) filters.push_back(audio_labs[0] + "anull[aout]");
    else if (audio_labs.size() > 1) {
      std::string mix;
      for (const auto &l : audio_labs) mix += l;
      mix += "amix=inputs=" + std::to_string(audio_labs.size()) + ":duration=longest:dropout_transition=0[aout]";
      filters.push_back(mix);
    }

    std::vector<std::wstring> args;
    args.push_back(L"-y");
    args.push_back(L"-hide_banner");
    args.push_back(L"-loglevel");
    args.push_back(L"error");
    args.push_back(L"-framerate");
    args.push_back(utf8_to_wide(fmt_num(fps)));
    args.push_back(L"-f");
    args.push_back(L"image2");
    args.push_back(L"-i");
    args.push_back(frame_dir + L"\\%06d.bmp");
    for (const auto &inp : inputs) {
      args.push_back(L"-i");
      args.push_back(utf8_to_wide(inp.path));
    }
    if (!filters.empty()) {
      std::string fc;
      for (size_t i = 0; i < filters.size(); ++i) {
        if (i) fc += ';';
        fc += filters[i];
      }
      args.push_back(L"-filter_complex");
      args.push_back(utf8_to_wide(fc));
    }
    args.push_back(L"-map");
    args.push_back(L"0:v");
    args.push_back(L"-c:v");
    args.push_back(L"libx264");
    args.push_back(L"-pix_fmt");
    args.push_back(L"yuv420p");
    args.push_back(L"-preset");
    args.push_back(L"veryfast");
    if (!audio_labs.empty()) {
      args.push_back(L"-map");
      args.push_back(L"[aout]");
      args.push_back(L"-c:a");
      args.push_back(L"aac");
      args.push_back(L"-b:a");
      args.push_back(L"192k");
    } else {
      args.push_back(L"-an");
    }
    args.push_back(L"-t");
    args.push_back(utf8_to_wide(fmt_num((std::max)(0.05, t1 - t0))));
    args.push_back(L"-movflags");
    args.push_back(L"+faststart");
    args.push_back(std::wstring(out_path));

    ensure_parent_dirs(out_path);
    const std::wstring ffmpeg = find_ffmpeg();
    if (ffmpeg.empty()) return fail_json("找不到 ffmpeg（PATH / WinGet Links / native/bin / FFMPEG）");
    const int code = run_ffmpeg(ffmpeg, args);

    /* cleanup frames */
    WIN32_FIND_DATAW fd;
    const std::wstring glob = frame_dir + L"\\*.bmp";
    HANDLE h = FindFirstFileW(glob.c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) {
      do {
        DeleteFileW((frame_dir + L"\\" + fd.cFileName).c_str());
      } while (FindNextFileW(h, &fd));
      FindClose(h);
    }
    RemoveDirectoryW(frame_dir.c_str());

    if (code < 0) return fail_json("无法启动 ffmpeg");
    if (code != 0 || !file_exists_w(out_path)) {
      char msg[128];
      std::snprintf(msg, sizeof(msg), "ffmpeg 退出码 %d", code);
      return fail_json(msg);
    }
    std::printf("{\"ok\":true,\"backend\":\"todo-cpp-compose-ffmpeg\",\"path\":");
    json_escape_out(wide_to_utf8(out_path).c_str());
    std::puts("}");
    return 0;
  }

  std::vector<InputMeta> inputs;
  std::vector<std::string> filters;
  std::vector<std::pair<std::string, int>> path_to_input;

  auto push_input = [&](const std::string &file_path, bool loop, double t) {
    const int idx = static_cast<int>(inputs.size());
    inputs.push_back({file_path, loop, t});
    path_to_input.push_back({file_path, idx});
    return idx;
  };
  auto find_input = [&](const std::string &file_path) -> int {
    for (const auto &p : path_to_input) if (p.first == file_path) return p.second;
    return -1;
  };

  /* audio_only path continues with filter_complex below */

  if (!audio_only) {
    filters.push_back("color=c=black:s=" + std::to_string(w) + "x" + std::to_string(h) +
                      ":d=" + fmt_num(out_dur) + ":r=" + fmt_num(fps) + "[base]");
    std::string last = "base";
    if (video_clips.empty()) {
      filters.push_back("[base]null[vout]");
    } else {
      for (size_t i = 0; i < video_clips.size(); ++i) {
        const Clip &c = video_clips[i];
        const double start = (std::max)(0.0, c.start);
        const double dur = (std::max)(0.04, c.duration);
        const double in_point = (std::max)(0.0, c.in_point);
        const bool still = is_still_image(c.kind, c.media_path);
        const int idx = push_input(c.media_path, still, still ? dur + 0.05 : 0);
        const std::string lab = "vc" + std::to_string(i);
        const std::string delayed = "vd" + std::to_string(i);
        const std::string next = (i + 1 == video_clips.size()) ? "vout" : ("vo" + std::to_string(i));
        if (still) {
          filters.push_back(
            "[" + std::to_string(idx) + ":v]setpts=PTS-STARTPTS,"
            "scale=" + std::to_string(w) + ":" + std::to_string(h) + ":force_original_aspect_ratio=decrease,"
            "pad=" + std::to_string(w) + ":" + std::to_string(h) + ":(ow-iw)/2:(oh-ih)/2,setsar=1,fps=" +
            fmt_num(fps) + ",trim=duration=" + fmt_num(dur) + ",setpts=PTS-STARTPTS[" + lab + "]");
        } else {
          filters.push_back(
            "[" + std::to_string(idx) + ":v]trim=start=" + fmt_num(in_point) + ":duration=" + fmt_num(dur) +
            ",setpts=PTS-STARTPTS,"
            "scale=" + std::to_string(w) + ":" + std::to_string(h) + ":force_original_aspect_ratio=decrease,"
            "pad=" + std::to_string(w) + ":" + std::to_string(h) + ":(ow-iw)/2:(oh-ih)/2,setsar=1,fps=" +
            fmt_num(fps) + "[" + lab + "]");
        }
        filters.push_back("[" + lab + "]tpad=start_duration=" + fmt_num(start) + "[" + delayed + "]");
        filters.push_back("[" + last + "][" + delayed + "]overlay=eof_action=pass[" + next + "]");
        last = next;
      }
    }
  }

  std::vector<std::string> audio_labs;
  for (size_t i = 0; i < audio_clips.size(); ++i) {
    const Clip &c = audio_clips[i];
    int idx = find_input(c.media_path);
    if (idx < 0) {
      idx = push_input(c.media_path, false, 0);
    }
    const double start = (std::max)(0.0, c.start);
    const double dur = (std::max)(0.04, c.duration);
    const double in_point = (std::max)(0.0, c.in_point);
    const int delay_ms = static_cast<int>(std::lround(start * 1000.0));
    const std::string lab = "a" + std::to_string(i);
    filters.push_back(
      "[" + std::to_string(idx) + ":a]atrim=start=" + fmt_num(in_point) + ":duration=" + fmt_num(dur) +
      ",asetpts=PTS-STARTPTS,adelay=" + std::to_string(delay_ms) + "|" + std::to_string(delay_ms) +
      ":all=1[" + lab + "]");
    audio_labs.push_back("[" + lab + "]");
  }

  if (audio_labs.size() == 1) {
    filters.push_back(audio_labs[0] + "anull[aout]");
  } else if (audio_labs.size() > 1) {
    std::string mix;
    for (const auto &l : audio_labs) mix += l;
    mix += "amix=inputs=" + std::to_string(audio_labs.size()) + ":duration=longest:dropout_transition=0[aout]";
    filters.push_back(mix);
  }

  if (audio_only && audio_labs.empty()) {
    return fail_json("没有可导出的音频片段（需本机 path）");
  }
  if (!audio_only && video_clips.empty() && audio_labs.empty()) {
    return fail_json("没有可导出的媒体片段（需本机 path）");
  }

  std::vector<std::wstring> args;
  args.push_back(L"-y");
  args.push_back(L"-hide_banner");
  args.push_back(L"-loglevel");
  args.push_back(L"error");

  for (const auto &inp : inputs) {
    if (inp.loop) {
      args.push_back(L"-loop");
      args.push_back(L"1");
      args.push_back(L"-framerate");
      args.push_back(utf8_to_wide(fmt_num(fps)));
      args.push_back(L"-t");
      args.push_back(utf8_to_wide(fmt_num((std::max)(0.05, inp.t > 0 ? inp.t : 1.0))));
    }
    args.push_back(L"-i");
    args.push_back(utf8_to_wide(inp.path));
  }

  if (!filters.empty()) {
    std::string fc;
    for (size_t i = 0; i < filters.size(); ++i) {
      if (i) fc += ';';
      fc += filters[i];
    }
    args.push_back(L"-filter_complex");
    args.push_back(utf8_to_wide(fc));
  }

  if (audio_only) {
    args.push_back(L"-map");
    args.push_back(L"[aout]");
    args.push_back(L"-c:a");
    args.push_back(L"aac");
    args.push_back(L"-b:a");
    args.push_back(L"192k");
    args.push_back(L"-vn");
  } else {
    args.push_back(L"-map");
    args.push_back(L"[vout]");
    args.push_back(L"-c:v");
    args.push_back(L"libx264");
    args.push_back(L"-pix_fmt");
    args.push_back(L"yuv420p");
    args.push_back(L"-preset");
    args.push_back(L"veryfast");
    if (!audio_labs.empty()) {
      args.push_back(L"-map");
      args.push_back(L"[aout]");
      args.push_back(L"-c:a");
      args.push_back(L"aac");
      args.push_back(L"-b:a");
      args.push_back(L"192k");
    } else {
      args.push_back(L"-an");
    }
  }

  if (range_only) {
    args.push_back(L"-ss");
    args.push_back(utf8_to_wide(fmt_num(work_in)));
    args.push_back(L"-t");
    args.push_back(utf8_to_wide(fmt_num((std::max)(0.05, work_out - work_in))));
  } else {
    args.push_back(L"-t");
    args.push_back(utf8_to_wide(fmt_num(out_dur)));
  }

  args.push_back(L"-movflags");
  args.push_back(L"+faststart");
  args.push_back(std::wstring(out_path));

  ensure_parent_dirs(out_path);

  const std::wstring ffmpeg = find_ffmpeg();
  if (ffmpeg.empty()) {
    return fail_json("找不到 ffmpeg（PATH / WinGet Links / native/bin / FFMPEG）");
  }
  const int code = run_ffmpeg(ffmpeg, args);
  if (code < 0) {
    return fail_json("无法启动 ffmpeg");
  }
  if (code != 0 || !file_exists_w(out_path)) {
    char msg[128];
    std::snprintf(msg, sizeof(msg), "ffmpeg 退出码 %d", code);
    return fail_json(msg);
  }

  return ok_json(wide_to_utf8(out_path).c_str());
}

static bool write_bmp_file(const wchar_t *path, int w, int h, const uint8_t *rgb) {
  FILE *fp = _wfopen(path, L"wb");
  if (!fp) return false;
  const int row = (w * 3 + 3) & ~3;
  const int pixel_bytes = row * h;
  const int file_size = 54 + pixel_bytes;
  unsigned char hdr[54] = {0};
  hdr[0] = 'B'; hdr[1] = 'M';
  hdr[2] = file_size & 255; hdr[3] = (file_size >> 8) & 255;
  hdr[4] = (file_size >> 16) & 255; hdr[5] = (file_size >> 24) & 255;
  hdr[10] = 54; hdr[14] = 40;
  hdr[18] = w & 255; hdr[19] = (w >> 8) & 255; hdr[20] = (w >> 16) & 255; hdr[21] = (w >> 24) & 255;
  hdr[22] = h & 255; hdr[23] = (h >> 8) & 255; hdr[24] = (h >> 16) & 255; hdr[25] = (h >> 24) & 255;
  hdr[26] = 1; hdr[28] = 24;
  if (std::fwrite(hdr, 1, 54, fp) != 54) { std::fclose(fp); return false; }
  std::vector<unsigned char> line(static_cast<size_t>(row), 0);
  for (int y = h - 1; y >= 0; --y) {
    const uint8_t *src = rgb + static_cast<size_t>(y) * w * 3;
    for (int x = 0; x < w; ++x) {
      line[static_cast<size_t>(x) * 3 + 0] = src[x * 3 + 2];
      line[static_cast<size_t>(x) * 3 + 1] = src[x * 3 + 1];
      line[static_cast<size_t>(x) * 3 + 2] = src[x * 3 + 0];
    }
    if (std::fwrite(line.data(), 1, static_cast<size_t>(row), fp) != static_cast<size_t>(row)) {
      std::fclose(fp);
      return false;
    }
  }
  std::fclose(fp);
  return true;
}

/** Letterbox src into layer WxH, then affine blit onto dst with monitor-matched transform. */
static void letterbox_onto(
  uint8_t *dst, int dw, int dh,
  const uint8_t *src, int sw, int sh) {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  const double s = (std::min)(static_cast<double>(dw) / sw, static_cast<double>(dh) / sh);
  const int nw = (std::max)(1, static_cast<int>(std::lround(sw * s)));
  const int nh = (std::max)(1, static_cast<int>(std::lround(sh * s)));
  const int ox = (dw - nw) / 2;
  const int oy = (dh - nh) / 2;
  for (int y = 0; y < nh; ++y) {
    const int sy = (std::min)(sh - 1, static_cast<int>(std::lround((y + 0.5) * sh / nh - 0.5)));
    uint8_t *drow = dst + static_cast<size_t>(oy + y) * dw * 3;
    const uint8_t *srow = src + static_cast<size_t>(sy) * sw * 3;
    for (int x = 0; x < nw; ++x) {
      const int sx = (std::min)(sw - 1, static_cast<int>(std::lround((x + 0.5) * sw / nw - 0.5)));
      const int di = (ox + x) * 3;
      const int si = sx * 3;
      drow[di] = srow[si];
      drow[di + 1] = srow[si + 1];
      drow[di + 2] = srow[si + 2];
    }
  }
}

static void apply_color_grade(uint8_t *rgb, int n_pixels,
  double exposure, double contrast, double saturation, double temperature, double tint) {
  const double brightness = 1.0 + exposure * 0.22;
  const double cont = 1.0 + contrast * 0.35;
  const double sat = 1.0 + saturation * 0.45;
  const double warm = temperature * 0.08;
  const double green = tint * 0.06;
  for (int i = 0; i < n_pixels; ++i) {
    double r = rgb[i * 3 + 0] / 255.0;
    double g = rgb[i * 3 + 1] / 255.0;
    double b = rgb[i * 3 + 2] / 255.0;
    r *= brightness; g *= brightness; b *= brightness;
    r = (r - 0.5) * cont + 0.5;
    g = (g - 0.5) * cont + 0.5;
    b = (b - 0.5) * cont + 0.5;
    const double y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = y + (r - y) * sat;
    g = y + (g - y) * sat;
    b = y + (b - y) * sat;
    r += warm; b -= warm;
    g += green;
    auto clamp8 = [](double v) -> uint8_t {
      if (v < 0) return 0;
      if (v > 1) return 255;
      return static_cast<uint8_t>(v * 255.0 + 0.5);
    };
    rgb[i * 3 + 0] = clamp8(r);
    rgb[i * 3 + 1] = clamp8(g);
    rgb[i * 3 + 2] = clamp8(b);
  }
}

static void blend_pixel(uint8_t *dst, const uint8_t *src, double opacity, const std::string &blend) {
  opacity = (std::max)(0.0, (std::min)(1.0, opacity));
  if (opacity < 1e-4) return;
  double sr = src[0] / 255.0, sg = src[1] / 255.0, sb = src[2] / 255.0;
  double dr = dst[0] / 255.0, dg = dst[1] / 255.0, db = dst[2] / 255.0;
  double or_ = sr, og = sg, ob = sb;
  if (blend == "multiply") {
    or_ = dr * sr; og = dg * sg; ob = db * sb;
  } else if (blend == "screen") {
    or_ = 1 - (1 - dr) * (1 - sr);
    og = 1 - (1 - dg) * (1 - sg);
    ob = 1 - (1 - db) * (1 - sb);
  } else if (blend == "add") {
    or_ = (std::min)(1.0, dr + sr);
    og = (std::min)(1.0, dg + sg);
    ob = (std::min)(1.0, db + sb);
  }
  dst[0] = static_cast<uint8_t>((dr * (1 - opacity) + or_ * opacity) * 255.0 + 0.5);
  dst[1] = static_cast<uint8_t>((dg * (1 - opacity) + og * opacity) * 255.0 + 0.5);
  dst[2] = static_cast<uint8_t>((db * (1 - opacity) + ob * opacity) * 255.0 + 0.5);
}

static bool hex_rgb(const std::string &s, int *r, int *g, int *b) {
  if (s.size() < 7 || s[0] != '#') return false;
  auto h = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  const int v[6] = { h(s[1]), h(s[2]), h(s[3]), h(s[4]), h(s[5]), h(s[6]) };
  for (int i = 0; i < 6; ++i) if (v[i] < 0) return false;
  *r = v[0] * 16 + v[1];
  *g = v[2] * 16 + v[3];
  *b = v[4] * 16 + v[5];
  return true;
}

/** 轻量盒式模糊（特效 blur）；半径限制以免拖慢导出。 */
static void box_blur_rgb(uint8_t *rgb, int w, int h, int radius) {
  radius = (std::max)(1, (std::min)(radius, 8));
  std::vector<uint8_t> tmp(static_cast<size_t>(w) * h * 3);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      int sr = 0, sg = 0, sb = 0, n = 0;
      for (int dx = -radius; dx <= radius; ++dx) {
        const int xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const size_t i = (static_cast<size_t>(y) * w + xx) * 3;
        sr += rgb[i]; sg += rgb[i + 1]; sb += rgb[i + 2];
        ++n;
      }
      const size_t o = (static_cast<size_t>(y) * w + x) * 3;
      tmp[o] = static_cast<uint8_t>(sr / (std::max)(1, n));
      tmp[o + 1] = static_cast<uint8_t>(sg / (std::max)(1, n));
      tmp[o + 2] = static_cast<uint8_t>(sb / (std::max)(1, n));
    }
  }
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      int sr = 0, sg = 0, sb = 0, n = 0;
      for (int dy = -radius; dy <= radius; ++dy) {
        const int yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const size_t i = (static_cast<size_t>(yy) * w + x) * 3;
        sr += tmp[i]; sg += tmp[i + 1]; sb += tmp[i + 2];
        ++n;
      }
      const size_t o = (static_cast<size_t>(y) * w + x) * 3;
      rgb[o] = static_cast<uint8_t>(sr / (std::max)(1, n));
      rgb[o + 1] = static_cast<uint8_t>(sg / (std::max)(1, n));
      rgb[o + 2] = static_cast<uint8_t>(sb / (std::max)(1, n));
    }
  }
}

static void apply_clip_look(uint8_t *rgb, int n_pixels, int w, int h, const Clip &c) {
  const double contrast = c.contrast + c.fx_sharpen * 0.35 + c.fx_filter * 0.12;
  const double saturation = c.saturation + c.fx_filter * 0.22;
  apply_color_grade(rgb, n_pixels, c.exposure, contrast, saturation, c.temperature, c.tint);
  if (c.fx_blur > 0.02 && w > 0 && h > 0) {
    const int r = static_cast<int>(std::lround(c.fx_blur * 8.0));
    if (r > 0) box_blur_rgb(rgb, w, h, r);
  }
}


/** 裁剪：按边距比例清零（与监视器 crop 一致）。 */
static void apply_crop(uint8_t *rgb, int w, int h, const Clip &c) {
  const double cl = (std::max)(0.0, (std::min)(0.49, c.crop_l));
  const double cr = (std::max)(0.0, (std::min)(0.49, c.crop_r));
  const double ct = (std::max)(0.0, (std::min)(0.49, c.crop_t));
  const double cb = (std::max)(0.0, (std::min)(0.49, c.crop_b));
  if (cl + cr + ct + cb < 1e-6) return;
  const int x0 = static_cast<int>(std::lround(cl * w));
  const int x1 = static_cast<int>(std::lround((1.0 - cr) * w));
  const int y0 = static_cast<int>(std::lround(ct * h));
  const int y1 = static_cast<int>(std::lround((1.0 - cb) * h));
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const size_t i = (static_cast<size_t>(y) * w + x) * 3;
      rgb[i] = rgb[i + 1] = rgb[i + 2] = 0;
    }
  }
}

static bool point_in_poly(double x, double y, const std::vector<Clip::Pt> &pts) {
  if (pts.size() < 3) return false;
  bool inside = false;
  for (size_t i = 0, j = pts.size() - 1; i < pts.size(); j = i++) {
    const double xi = pts[i].x, yi = pts[i].y;
    const double xj = pts[j].x, yj = pts[j].y;
    const bool hit = ((yi > y) != (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) == 0 ? 1e-12 : (yj - yi)) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

static double soft_edge(double d, double feather) {
  if (feather <= 1e-6) return d >= 0 ? 1.0 : 0.0;
  const double t = d / feather;
  if (t <= -1) return 0;
  if (t >= 1) return 1;
  return 0.5 + 0.5 * t;
}

static double mask_alpha_uv(const Clip &c, double u, double v) {
  if (c.mask_type.empty()) return 1.0;
  const double expand = (std::max)(-0.9, (std::min)(2.0, c.mask_expand));
  const double half = 0.35 * (1.0 + expand);
  const double feather = (std::max)(0.0, c.mask_feather) * 0.25;
  double a = 1.0;
  if (c.mask_type == "rect") {
    const double dx = half - std::fabs(u - 0.5);
    const double dy = half - std::fabs(v - 0.5);
    a = soft_edge((std::min)(dx, dy), feather);
  } else if (c.mask_type == "ellipse") {
    const double nx = (u - 0.5) / (std::max)(1e-6, half);
    const double ny = (v - 0.5) / (std::max)(1e-6, half);
    const double d = 1.0 - std::sqrt(nx * nx + ny * ny);
    a = soft_edge(d, feather * 2);
  } else if (c.mask_type == "linear") {
    const double mid = 0.5 - expand * 0.25;
    a = soft_edge(mid - v, feather + 0.05);
  } else if (c.mask_type == "pen" || c.mask_type == "text") {
    if (c.mask_points.size() >= 3) {
      a = point_in_poly(u, v, c.mask_points) ? 1.0 : 0.0;
      if (feather > 1e-6 && a > 0.5) {
        /* ponytail: pen/text 不做距离场羽化，仅硬边 */
      }
    } else if (c.mask_type == "text") {
      a = (std::fabs(u - 0.5) < half && std::fabs(v - 0.5) < half * 0.35) ? 1.0 : 0.0;
    } else {
      a = 1.0;
    }
  } else {
    a = 1.0;
  }
  if (c.mask_invert) a = 1.0 - a;
  return (std::max)(0.0, (std::min)(1.0, a));
}

static void apply_mask(uint8_t *rgb, int w, int h, const Clip &c) {
  if (c.mask_type.empty()) return;
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const double a = mask_alpha_uv(c, (x + 0.5) / w, (y + 0.5) / h);
      if (a >= 0.999) continue;
      const size_t i = (static_cast<size_t>(y) * w + x) * 3;
      rgb[i] = static_cast<uint8_t>(rgb[i] * a + 0.5);
      rgb[i + 1] = static_cast<uint8_t>(rgb[i + 1] * a + 0.5);
      rgb[i + 2] = static_cast<uint8_t>(rgb[i + 2] * a + 0.5);
    }
  }
}

static void apply_chroma(uint8_t *rgb, int n_pixels, const Clip &c) {
  if (!c.chroma_on) return;
  const double tr = c.chroma_r / 255.0, tg = c.chroma_g / 255.0, tb = c.chroma_b / 255.0;
  const double tol = (std::max)(0.02, (std::min)(1.0, c.chroma_tol));
  for (int i = 0; i < n_pixels; ++i) {
    const double r = rgb[i * 3] / 255.0;
    const double g = rgb[i * 3 + 1] / 255.0;
    const double b = rgb[i * 3 + 2] / 255.0;
    const double d = std::sqrt((r - tr) * (r - tr) + (g - tg) * (g - tg) + (b - tb) * (b - tb));
    if (d <= tol) {
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = 0;
    } else if (d < tol * 1.6) {
      const double a = (d - tol) / (tol * 0.6);
      rgb[i * 3] = static_cast<uint8_t>(rgb[i * 3] * a + 0.5);
      rgb[i * 3 + 1] = static_cast<uint8_t>(rgb[i * 3 + 1] * a + 0.5);
      rgb[i * 3 + 2] = static_cast<uint8_t>(rgb[i * 3 + 2] * a + 0.5);
    }
  }
}

/** 片内转场：入/出段调透明度、闪黑白、擦除、推移（与时间线 transitionIn/Out 同字段）。 */
static void apply_transition(
  uint8_t *layer, int w, int h, const Clip &c, double time_sec,
  double *x, double *op) {
  const double local = (std::max)(0.0, time_sec - c.start);
  const double dur = (std::max)(0.04, c.duration);
  auto run = [&](const std::string &type, double u, bool is_out) {
    u = (std::max)(0.0, (std::min)(1.0, u));
    const std::string t = type.empty() ? "dissolve" : type;
    if (t == "dissolve") {
      *op *= is_out ? (1.0 - u) : u;
    } else if (t == "fadeBlack") {
      const double mix = is_out ? u : (1.0 - u);
      for (int i = 0; i < w * h; ++i) {
        layer[i * 3] = static_cast<uint8_t>(layer[i * 3] * (1.0 - mix) + 0.5);
        layer[i * 3 + 1] = static_cast<uint8_t>(layer[i * 3 + 1] * (1.0 - mix) + 0.5);
        layer[i * 3 + 2] = static_cast<uint8_t>(layer[i * 3 + 2] * (1.0 - mix) + 0.5);
      }
    } else if (t == "fadeWhite") {
      const double mix = is_out ? u : (1.0 - u);
      for (int i = 0; i < w * h; ++i) {
        layer[i * 3] = static_cast<uint8_t>(layer[i * 3] * (1.0 - mix) + 255.0 * mix + 0.5);
        layer[i * 3 + 1] = static_cast<uint8_t>(layer[i * 3 + 1] * (1.0 - mix) + 255.0 * mix + 0.5);
        layer[i * 3 + 2] = static_cast<uint8_t>(layer[i * 3 + 2] * (1.0 - mix) + 255.0 * mix + 0.5);
      }
    } else if (t == "wipe") {
      const double edge = is_out ? (1.0 - u) : u;
      for (int y = 0; y < h; ++y) {
        for (int xpx = 0; xpx < w; ++xpx) {
          if ((xpx + 0.5) / w <= edge) continue;
          const size_t i = (static_cast<size_t>(y) * w + xpx) * 3;
          layer[i] = layer[i + 1] = layer[i + 2] = 0;
        }
      }
    } else if (t == "push") {
      *x += is_out ? u : -(1.0 - u);
    } else {
      *op *= is_out ? (1.0 - u) : u;
    }
  };
  if (c.trans_in_dur > 1e-4 && local < c.trans_in_dur) {
    run(c.trans_in_type, local / c.trans_in_dur, false);
  }
  if (c.trans_out_dur > 1e-4 && local > dur - c.trans_out_dur) {
    run(c.trans_out_type, (local - (dur - c.trans_out_dur)) / c.trans_out_dur, true);
  }
}

/** GDI 把字幕画到居中透明层（黑底=透明），再交给 blit 做变换。 */
static void paint_text_layer(uint8_t *layer, int w, int h, const Clip &c) {
  std::string body = c.text_content;
  if (!c.text_bilingual.empty()) {
    if (!body.empty()) body += "\n";
    body += c.text_bilingual;
  }
  if (body.empty()) return;

  BITMAPINFO bmi{};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = w;
  bmi.bmiHeader.biHeight = -h;
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  bmi.bmiHeader.biCompression = BI_RGB;
  void *bits = nullptr;
  HDC screen = GetDC(nullptr);
  if (!screen) return;
  HDC dc = CreateCompatibleDC(screen);
  HBITMAP dib = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!dc || !dib || !bits) {
    if (dib) DeleteObject(dib);
    if (dc) DeleteDC(dc);
    ReleaseDC(nullptr, screen);
    return;
  }
  HGDIOBJ old_bm = SelectObject(dc, dib);
  RECT full{ 0, 0, w, h };
  FillRect(dc, &full, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));

  const int px = (std::max)(8, static_cast<int>(std::lround(c.text_size)));
  const std::wstring font_w = utf8_to_wide(c.text_font.empty() ? "Segoe UI" : c.text_font);
  HFONT font = CreateFontW(
    -px, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
    DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
    CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, font_w.c_str());
  HGDIOBJ old_font = SelectObject(dc, font);
  SetBkMode(dc, TRANSPARENT);

  UINT fmt = DT_CENTER | DT_WORDBREAK | DT_NOPREFIX;
  if (c.text_align == "left") fmt = DT_LEFT | DT_WORDBREAK | DT_NOPREFIX;
  else if (c.text_align == "right") fmt = DT_RIGHT | DT_WORDBREAK | DT_NOPREFIX;

  const int box_w = (std::max)(40, w * 4 / 5);
  const int box_h = (std::max)(px * 3, h / 3);
  RECT tr{
    (w - box_w) / 2,
    (h - box_h) / 2,
    (w - box_w) / 2 + box_w,
    (h - box_h) / 2 + box_h,
  };

  const std::wstring text_w = utf8_to_wide(body);
  int sr = 0, sg = 0, sb = 0;
  int fr = 245, fg = 242, fb = 236;
  hex_rgb(c.text_stroke_color, &sr, &sg, &sb);
  hex_rgb(c.text_color, &fr, &fg, &fb);
  const int sw = (std::max)(0, static_cast<int>(std::lround(c.text_stroke_w)));
  if (sw > 0) {
    SetTextColor(dc, RGB(sr, sg, sb));
    for (int dy = -sw; dy <= sw; ++dy) {
      for (int dx = -sw; dx <= sw; ++dx) {
        if (dx == 0 && dy == 0) continue;
        RECT r2 = tr;
        OffsetRect(&r2, dx, dy);
        DrawTextW(dc, text_w.c_str(), -1, &r2, fmt);
      }
    }
  }
  SetTextColor(dc, RGB(fr, fg, fb));
  DrawTextW(dc, text_w.c_str(), -1, &tr, fmt);

  const auto *bgra = static_cast<const uint8_t *>(bits);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const size_t si = (static_cast<size_t>(y) * w + x) * 4;
      const int b = bgra[si], g = bgra[si + 1], r = bgra[si + 2];
      if ((r | g | b) == 0) continue;
      const size_t di = (static_cast<size_t>(y) * w + x) * 3;
      layer[di] = static_cast<uint8_t>(r);
      layer[di + 1] = static_cast<uint8_t>(g);
      layer[di + 2] = static_cast<uint8_t>(b);
    }
  }

  SelectObject(dc, old_font);
  SelectObject(dc, old_bm);
  if (font) DeleteObject(font);
  DeleteObject(dib);
  DeleteDC(dc);
  ReleaseDC(nullptr, screen);
}

static void blit_layer_transformed(
  uint8_t *dst, int dw, int dh,
  const uint8_t *layer,
  double x_n, double y_n, double scale_x, double scale_y, double rot_deg, double opacity,
  const std::string &blend) {
  opacity = (std::max)(0.0, (std::min)(1.0, opacity));
  if (opacity < 1e-4) return;
  const double cx = dw / 2.0 + x_n * dw / 2.0;
  const double cy = dh / 2.0 + y_n * dh / 2.0;
  const double rad = rot_deg * 3.14159265358979323846 / 180.0;
  const double cr = std::cos(rad);
  const double sr = std::sin(rad);
  const double isx = scale_x != 0 ? 1.0 / scale_x : 0;
  const double isy = scale_y != 0 ? 1.0 / scale_y : 0;
  for (int y = 0; y < dh; ++y) {
    for (int x = 0; x < dw; ++x) {
      const double dx = x + 0.5 - cx;
      const double dy = y + 0.5 - cy;
      const double lx = (cr * dx + sr * dy) * isx + dw / 2.0;
      const double ly = (-sr * dx + cr * dy) * isy + dh / 2.0;
      const int ix = static_cast<int>(std::floor(lx));
      const int iy = static_cast<int>(std::floor(ly));
      if (ix < 0 || iy < 0 || ix >= dw || iy >= dh) continue;
      const size_t si = (static_cast<size_t>(iy) * dw + ix) * 3;
      const int sr0 = layer[si], sg = layer[si + 1], sb = layer[si + 2];
      if (sr0 == 0 && sg == 0 && sb == 0) continue;
      const size_t di = (static_cast<size_t>(y) * dw + x) * 3;
      blend_pixel(dst + di, layer + si, opacity, blend);
    }
  }
}

struct PreparedLayer {
  std::vector<uint8_t> rgb;
  float x = 0, y = 0, sx = 1, sy = 1, rot = 0, op = 1;
  int blend = 0; // 0 normal 1 multiply 2 screen 3 add
};

static int blend_code(const std::string &b) {
  if (b == "multiply") return 1;
  if (b == "screen") return 2;
  if (b == "add") return 3;
  return 0;
}

/** D3D11 真合成：层纹理 + 逆变换采样 + 混合，读回 RGB。失败返回 false。 */
static bool gpu_composite_layers(int w, int h, const std::vector<PreparedLayer> &layers, std::vector<uint8_t> *out) {
  if (layers.empty()) {
    out->assign(static_cast<size_t>(w) * h * 3, 0);
    return true;
  }
  ID3D11Device *device = nullptr;
  ID3D11DeviceContext *ctx = nullptr;
  D3D_FEATURE_LEVEL level;
  const D3D_FEATURE_LEVEL levels[] = { D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0 };
  if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, levels, 2, D3D11_SDK_VERSION, &device, &level, &ctx))
      || !device || !ctx) {
    return false;
  }

  const char *vs_src =
    "struct VSIn{float2 p:POSITION;float2 u:TEXCOORD0;};"
    "struct VSOut{float4 p:SV_POSITION;float2 u:TEXCOORD0;};"
    "VSOut main(VSIn i){VSOut o;o.p=float4(i.p,0,1);o.u=i.u;return o;}";
  const char *ps_src =
    "cbuffer CB:register(b0){float2 center;float2 invScale;float cosR;float sinR;float opacity;int blendMode;float2 invSize;float2 pad;};"
    "Texture2D srcTex:register(t0);Texture2D dstTex:register(t1);SamplerState samp:register(s0);"
    "float4 main(float4 p:SV_POSITION,float2 u:TEXCOORD0):SV_TARGET{"
    "float2 pix=float2(p.x,p.y);"
    "float2 d=pix-center;"
    "float2 loc=float2(cosR*d.x+sinR*d.y,-sinR*d.x+cosR*d.y);"
    "loc=loc*invScale+float2(0.5/invSize.x,0.5/invSize.y);"
    "float2 uv=loc*invSize;"
    "float3 dest=dstTex.Sample(samp,u).rgb;"
    "if(uv.x<0||uv.y<0||uv.x>1||uv.y>1) return float4(dest,1);"
    "float3 s=srcTex.Sample(samp,uv).rgb;"
    "if(dot(s,s)<1e-6) return float4(dest,1);"
    "float3 o=s;"
    "if(blendMode==1) o=dest*s;"
    "else if(blendMode==2) o=1-(1-dest)*(1-s);"
    "else if(blendMode==3) o=saturate(dest+s);"
    "o=lerp(dest,o,saturate(opacity));"
    "return float4(o,1);}";

  ID3DBlob *vsb = nullptr, *psb = nullptr, *err = nullptr;
  if (FAILED(D3DCompile(vs_src, std::strlen(vs_src), nullptr, nullptr, nullptr, "main", "vs_4_0", 0, 0, &vsb, &err))) {
    if (err) err->Release();
    ctx->Release(); device->Release();
    return false;
  }
  if (FAILED(D3DCompile(ps_src, std::strlen(ps_src), nullptr, nullptr, nullptr, "main", "ps_4_0", 0, 0, &psb, &err))) {
    if (err) err->Release();
    vsb->Release();
    ctx->Release(); device->Release();
    return false;
  }
  ID3D11VertexShader *vs = nullptr;
  ID3D11PixelShader *ps = nullptr;
  device->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr, &vs);
  device->CreatePixelShader(psb->GetBufferPointer(), psb->GetBufferSize(), nullptr, &ps);
  D3D11_INPUT_ELEMENT_DESC ied[] = {
    { "POSITION", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0 },
    { "TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 8, D3D11_INPUT_PER_VERTEX_DATA, 0 },
  };
  ID3D11InputLayout *layout = nullptr;
  device->CreateInputLayout(ied, 2, vsb->GetBufferPointer(), vsb->GetBufferSize(), &layout);
  vsb->Release();
  psb->Release();
  if (!vs || !ps || !layout) {
    if (vs) vs->Release(); if (ps) ps->Release(); if (layout) layout->Release();
    ctx->Release(); device->Release();
    return false;
  }

  const float quad[] = {
    -1, -1, 0, 1,
     1, -1, 1, 1,
    -1,  1, 0, 0,
    -1,  1, 0, 0,
     1, -1, 1, 1,
     1,  1, 1, 0,
  };
  D3D11_BUFFER_DESC vbd{};
  vbd.ByteWidth = sizeof(quad);
  vbd.Usage = D3D11_USAGE_IMMUTABLE;
  vbd.BindFlags = D3D11_BIND_VERTEX_BUFFER;
  D3D11_SUBRESOURCE_DATA vinit{ quad, 0, 0 };
  ID3D11Buffer *vb = nullptr;
  device->CreateBuffer(&vbd, &vinit, &vb);

  struct CBData {
    float center[2];
    float invScale[2];
    float cosR, sinR, opacity;
    int blendMode;
    float invSize[2];
    float pad[2];
  };
  D3D11_BUFFER_DESC cbd{};
  cbd.ByteWidth = (sizeof(CBData) + 15) & ~15;
  cbd.Usage = D3D11_USAGE_DYNAMIC;
  cbd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  cbd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  ID3D11Buffer *cb = nullptr;
  device->CreateBuffer(&cbd, nullptr, &cb);

  D3D11_SAMPLER_DESC sd{};
  sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  ID3D11SamplerState *samp = nullptr;
  device->CreateSamplerState(&sd, &samp);

  auto make_rt = [&](ID3D11Texture2D **tex, ID3D11RenderTargetView **rtv, ID3D11ShaderResourceView **srv) -> bool {
    D3D11_TEXTURE2D_DESC td{};
    td.Width = w; td.Height = h; td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(device->CreateTexture2D(&td, nullptr, tex)) || !*tex) return false;
    if (FAILED(device->CreateRenderTargetView(*tex, nullptr, rtv))) return false;
    if (FAILED(device->CreateShaderResourceView(*tex, nullptr, srv))) return false;
    return true;
  };

  ID3D11Texture2D *rtA = nullptr, *rtB = nullptr;
  ID3D11RenderTargetView *rtvA = nullptr, *rtvB = nullptr;
  ID3D11ShaderResourceView *srvA = nullptr, *srvB = nullptr;
  if (!make_rt(&rtA, &rtvA, &srvA) || !make_rt(&rtB, &rtvB, &srvB) || !vb || !cb || !samp) {
    if (vb) vb->Release(); if (cb) cb->Release(); if (samp) samp->Release();
    if (rtA) rtA->Release(); if (rtB) rtB->Release();
    if (rtvA) rtvA->Release(); if (rtvB) rtvB->Release();
    if (srvA) srvA->Release(); if (srvB) srvB->Release();
    vs->Release(); ps->Release(); layout->Release();
    ctx->Release(); device->Release();
    return false;
  }

  const float clear[4] = { 0, 0, 0, 1 };
  ctx->ClearRenderTargetView(rtvA, clear);
  ctx->ClearRenderTargetView(rtvB, clear);
  bool useA = true;

  D3D11_VIEWPORT vp{};
  vp.Width = static_cast<float>(w);
  vp.Height = static_cast<float>(h);
  vp.MaxDepth = 1;
  ctx->RSSetViewports(1, &vp);
  ctx->IASetInputLayout(layout);
  ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  UINT stride = 16, offset = 0;
  ctx->IASetVertexBuffers(0, 1, &vb, &stride, &offset);
  ctx->VSSetShader(vs, nullptr, 0);
  ctx->PSSetShader(ps, nullptr, 0);
  ctx->PSSetSamplers(0, 1, &samp);
  ctx->PSSetConstantBuffers(0, 1, &cb);

  D3D11_TEXTURE2D_DESC ltd{};
  ltd.Width = w; ltd.Height = h; ltd.MipLevels = 1; ltd.ArraySize = 1;
  ltd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  ltd.SampleDesc.Count = 1;
  ltd.Usage = D3D11_USAGE_DYNAMIC;
  ltd.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  ltd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;

  for (const auto &L : layers) {
    ID3D11Texture2D *srcTex = nullptr;
    if (FAILED(device->CreateTexture2D(&ltd, nullptr, &srcTex)) || !srcTex) continue;
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(ctx->Map(srcTex, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) {
      srcTex->Release();
      continue;
    }
    auto *dstp = static_cast<uint8_t *>(mapped.pData);
    for (int y = 0; y < h; ++y) {
      uint8_t *row = dstp + y * mapped.RowPitch;
      const uint8_t *src = L.rgb.data() + static_cast<size_t>(y) * w * 3;
      for (int x = 0; x < w; ++x) {
        row[x * 4 + 0] = src[x * 3 + 0];
        row[x * 4 + 1] = src[x * 3 + 1];
        row[x * 4 + 2] = src[x * 3 + 2];
        row[x * 4 + 3] = 255;
      }
    }
    ctx->Unmap(srcTex, 0);
    ID3D11ShaderResourceView *srcSrv = nullptr;
    device->CreateShaderResourceView(srcTex, nullptr, &srcSrv);

    ID3D11RenderTargetView *outRtv = useA ? rtvB : rtvA;
    ID3D11ShaderResourceView *dstSrv = useA ? srvA : srvB;
    ctx->OMSetRenderTargets(1, &outRtv, nullptr);

    D3D11_MAPPED_SUBRESOURCE cmb{};
    ctx->Map(cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &cmb);
    auto *c = static_cast<CBData *>(cmb.pData);
    c->center[0] = static_cast<float>(w) * 0.5f + L.x * static_cast<float>(w) * 0.5f;
    c->center[1] = static_cast<float>(h) * 0.5f + L.y * static_cast<float>(h) * 0.5f;
    c->invScale[0] = L.sx != 0 ? 1.0f / L.sx : 0;
    c->invScale[1] = L.sy != 0 ? 1.0f / L.sy : 0;
    const float rad = L.rot * 3.14159265f / 180.0f;
    c->cosR = std::cos(rad);
    c->sinR = std::sin(rad);
    c->opacity = L.op;
    c->blendMode = L.blend;
    c->invSize[0] = 1.0f / static_cast<float>(w);
    c->invSize[1] = 1.0f / static_cast<float>(h);
    c->pad[0] = c->pad[1] = 0;
    ctx->Unmap(cb, 0);

    ID3D11ShaderResourceView *srvs[2] = { srcSrv, dstSrv };
    ctx->PSSetShaderResources(0, 2, srvs);
    ctx->Draw(6, 0);
    ID3D11ShaderResourceView *nulls[2] = { nullptr, nullptr };
    ctx->PSSetShaderResources(0, 2, nulls);
    if (srcSrv) srcSrv->Release();
    srcTex->Release();
    useA = !useA;
  }

  ID3D11Texture2D *finalTex = useA ? rtA : rtB;
  D3D11_TEXTURE2D_DESC stad{};
  stad.Width = w; stad.Height = h; stad.MipLevels = 1; stad.ArraySize = 1;
  stad.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  stad.SampleDesc.Count = 1;
  stad.Usage = D3D11_USAGE_STAGING;
  stad.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ID3D11Texture2D *staging = nullptr;
  device->CreateTexture2D(&stad, nullptr, &staging);
  if (!staging) {
    vb->Release(); cb->Release(); samp->Release();
    rtA->Release(); rtB->Release(); rtvA->Release(); rtvB->Release(); srvA->Release(); srvB->Release();
    vs->Release(); ps->Release(); layout->Release();
    ctx->Release(); device->Release();
    return false;
  }
  ctx->CopyResource(staging, finalTex);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  if (FAILED(ctx->Map(staging, 0, D3D11_MAP_READ, 0, &mapped))) {
    staging->Release();
    vb->Release(); cb->Release(); samp->Release();
    rtA->Release(); rtB->Release(); rtvA->Release(); rtvB->Release(); srvA->Release(); srvB->Release();
    vs->Release(); ps->Release(); layout->Release();
    ctx->Release(); device->Release();
    return false;
  }
  out->assign(static_cast<size_t>(w) * h * 3, 0);
  const auto *src = static_cast<const uint8_t *>(mapped.pData);
  for (int y = 0; y < h; ++y) {
    const uint8_t *row = src + y * mapped.RowPitch;
    uint8_t *dst = out->data() + static_cast<size_t>(y) * w * 3;
    for (int x = 0; x < w; ++x) {
      dst[x * 3 + 0] = row[x * 4 + 0];
      dst[x * 3 + 1] = row[x * 4 + 1];
      dst[x * 3 + 2] = row[x * 4 + 2];
    }
  }
  ctx->Unmap(staging, 0);
  staging->Release();
  vb->Release(); cb->Release(); samp->Release();
  rtA->Release(); rtB->Release(); rtvA->Release(); rtvB->Release(); srvA->Release(); srvB->Release();
  vs->Release(); ps->Release(); layout->Release();
  ctx->Release(); device->Release();
  return true;
}

static bool g_compose_used_gpu = false;

static int compose_graph_rgb(const EditGraph &g, double time_sec, std::vector<uint8_t> *canvas, int *out_w, int *out_h, int *out_layers) {
  g_compose_used_gpu = false;
  const int w = (std::max)(16, static_cast<int>(std::lround(g.width)) & ~1);
  const int h = (std::max)(16, static_cast<int>(std::lround(g.height)) & ~1);
  const std::vector<LayerRef> visible = collect_visible_layers(g, time_sec);

  std::vector<PreparedLayer> prepared;
  std::vector<uint8_t> layer(static_cast<size_t>(w) * h * 3, 0);
  for (const LayerRef &lr : visible) {
    const Clip &c = *lr.clip;

    std::fill(layer.begin(), layer.end(), 0);
    const bool is_text = (c.kind == "text") || !c.text_content.empty();
    if (is_text) {
      paint_text_layer(layer.data(), w, h, c);
    } else {
      const bool still = is_still_image(c.kind, c.media_path);
      const double media_t = still ? 0.0 : clip_media_time(c, time_sec);
      const std::wstring path_w = utf8_to_wide(c.media_path);
      TodoProbeInfo info{};
      if (todo_probe(path_w.c_str(), 8000, &info) != TODO_OK || !info.has_video || info.width <= 0) continue;
      const int need = info.width * info.height * 3;
      std::vector<uint8_t> rgb(static_cast<size_t>(need));
      int rw = 0, rh = 0;
      if (todo_decode_rgb24(path_w.c_str(), media_t, 12000, rgb.data(), need, &rw, &rh) != TODO_OK) continue;
      letterbox_onto(layer.data(), w, h, rgb.data(), rw, rh);
      apply_clip_look(layer.data(), w * h, w, h, c);
      apply_chroma(layer.data(), w * h, c);
    }
    apply_crop(layer.data(), w, h, c);
    apply_mask(layer.data(), w, h, c);

    double x, y, sx, sy, rot, op;
    clip_transform_at(c, time_sec, &x, &y, &sx, &sy, &rot, &op);
    apply_transition(layer.data(), w, h, c, time_sec, &x, &op);

    PreparedLayer pl;
    pl.rgb = layer;
    pl.x = static_cast<float>(x);
    pl.y = static_cast<float>(y);
    pl.sx = static_cast<float>(sx);
    pl.sy = static_cast<float>(sy);
    pl.rot = static_cast<float>(rot);
    pl.op = static_cast<float>((std::max)(0.0, (std::min)(1.0, op)));
    pl.blend = blend_code(c.blend);
    prepared.push_back(std::move(pl));
  }

  if (gpu_composite_layers(w, h, prepared, canvas)) {
    g_compose_used_gpu = true;
  } else {
    canvas->assign(static_cast<size_t>(w) * h * 3, 0);
    for (const auto &pl : prepared) {
      blit_layer_transformed(
        canvas->data(), w, h, pl.rgb.data(),
        pl.x, pl.y, pl.sx, pl.sy, pl.rot, pl.op,
        pl.blend == 1 ? "multiply" : pl.blend == 2 ? "screen" : pl.blend == 3 ? "add" : "normal");
    }
  }

  if (out_w) *out_w = w;
  if (out_h) *out_h = h;
  if (out_layers) *out_layers = static_cast<int>(prepared.size());
  return 0;
}

int todo_cmd_compose(const wchar_t *graph_path, double time_sec, const wchar_t *out_bmp) {
  if (!graph_path || !out_bmp || !graph_path[0] || !out_bmp[0]) {
    return fail_json("compose requires editGraph.json time out.bmp");
  }
  if (!(time_sec >= 0)) return fail_json("invalid time");

  std::string json;
  if (!read_file_utf8(graph_path, &json)) return fail_json("cannot read editGraph.json");
  EditGraph g;
  if (!parse_edit_graph(json, &g)) return fail_json("invalid EditGraph JSON");

  std::vector<uint8_t> canvas;
  int w = 0, h = 0, layers = 0;
  compose_graph_rgb(g, time_sec, &canvas, &w, &h, &layers);
  if (!g_compose_used_gpu) return fail_json("d3d11 gpu composite failed");

  ensure_parent_dirs(out_bmp);
  if (!write_bmp_file(out_bmp, w, h, canvas.data())) return fail_json("cannot write compose bmp");

  std::printf(
    "{\"ok\":true,\"backend\":\"todo-cpp-d3d11-compose\",\"gpuComposite\":true,\"width\":%d,\"height\":%d,\"time\":%.6f,\"layers\":%d,\"path\":",
    w, h, time_sec, layers);
  json_escape_out(wide_to_utf8(out_bmp).c_str());
  std::puts("}");
  return 0;
}

#endif

