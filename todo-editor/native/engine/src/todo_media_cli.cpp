/* CLI: todo-media-engine probe|frame|export|play-session ... */
#include "todo_engine.h"
#include "todo_export.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#endif

static void json_escape(const char *s) {
  std::fputc('"', stdout);
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(s); *p; ++p) {
    if (*p == '"' || *p == '\\') std::printf("\\%c", *p);
    else if (*p < 32) std::printf("\\u%04x", *p);
    else std::fputc(*p, stdout);
  }
  std::fputc('"', stdout);
}

static int fail_json(const char *code, const char *message) {
  std::printf("{\"ok\":false,\"error\":{\"code\":");
  json_escape(code);
  std::printf(",\"message\":");
  json_escape(message);
  std::puts("}}");
  return 1;
}

static const char *status_code(TodoStatus s) {
  switch (s) {
    case TODO_OK: return "OK";
    case TODO_ERR_ARGS: return "INVALID_ARGUMENT";
    case TODO_ERR_OPEN: return "OPEN_FAILED";
    case TODO_ERR_PROBE: return "PROBE_FAILED";
    case TODO_ERR_DECODE: return "DECODE_FAILED";
    case TODO_ERR_TIMEOUT: return "PROBE_TIMEOUT";
    case TODO_ERR_IO: return "IO_ERROR";
    case TODO_ERR_NO_STREAM: return "NO_MEDIA_STREAM";
    case TODO_ERR_UNSUPPORTED: return "UNSUPPORTED";
    case TODO_ERR_EOF: return "EOF";
  }
  return "UNKNOWN";
}

static int cmd_probe(const wchar_t *path, int timeout_ms) {
  TodoProbeInfo info{};
  const TodoStatus st = todo_probe(path, timeout_ms, &info);
  if (st != TODO_OK) return fail_json(status_code(st), status_code(st));
  std::printf(
    "{\"ok\":true,\"engine\":\"todo-cpp-ffmpeg\",\"duration\":%.9f,\"format\":",
    info.duration);
  json_escape(info.format);
  std::printf(",\"hasVideo\":%s,\"hasAudio\":%s",
    info.has_video ? "true" : "false",
    info.has_audio ? "true" : "false");
  if (info.has_video) {
    std::printf(",\"width\":%d,\"height\":%d,\"frameRate\":%.9f",
      info.width, info.height, info.frame_rate);
  }
  std::puts("}");
  return 0;
}

static int write_bmp_bgr(FILE *fp, int w, int h, const unsigned char *rgb) {
  const int row = (w * 3 + 3) & ~3;
  const int pixel_bytes = row * h;
  const int file_size = 54 + pixel_bytes;
  unsigned char hdr[54] = {0};
  hdr[0] = 'B'; hdr[1] = 'M';
  hdr[2] = file_size & 255; hdr[3] = (file_size >> 8) & 255; hdr[4] = (file_size >> 16) & 255; hdr[5] = (file_size >> 24) & 255;
  hdr[10] = 54;
  hdr[14] = 40;
  hdr[18] = w & 255; hdr[19] = (w >> 8) & 255; hdr[20] = (w >> 16) & 255; hdr[21] = (w >> 24) & 255;
  hdr[22] = h & 255; hdr[23] = (h >> 8) & 255; hdr[24] = (h >> 16) & 255; hdr[25] = (h >> 24) & 255;
  hdr[26] = 1; hdr[28] = 24;
  if (std::fwrite(hdr, 1, 54, fp) != 54) return 0;
  std::vector<unsigned char> line(static_cast<size_t>(row), 0);
  for (int y = h - 1; y >= 0; --y) {
    const unsigned char *src = rgb + static_cast<size_t>(y) * w * 3;
    for (int x = 0; x < w; ++x) {
      line[static_cast<size_t>(x) * 3 + 0] = src[x * 3 + 2];
      line[static_cast<size_t>(x) * 3 + 1] = src[x * 3 + 1];
      line[static_cast<size_t>(x) * 3 + 2] = src[x * 3 + 0];
    }
    if (std::fwrite(line.data(), 1, static_cast<size_t>(row), fp) != static_cast<size_t>(row)) return 0;
  }
  return 1;
}

static int cmd_frame(const wchar_t *path, double time_sec, int timeout_ms, const wchar_t *out_path) {
  TodoProbeInfo info{};
  TodoStatus st = todo_probe(path, timeout_ms, &info);
  if (st != TODO_OK) return fail_json(status_code(st), "probe before frame failed");
  if (!info.has_video || info.width <= 0 || info.height <= 0) {
    return fail_json("NO_VIDEO", "no video stream");
  }
  const int need = info.width * info.height * 3;
  std::vector<unsigned char> rgb(static_cast<size_t>(need));
  int w = 0, h = 0;
  st = todo_decode_rgb24(path, time_sec, timeout_ms, rgb.data(), need, &w, &h);
  if (st != TODO_OK) return fail_json(status_code(st), "decode failed");

#ifdef _WIN32
  FILE *fp = _wfopen(out_path, L"wb");
#else
  FILE *fp = std::fopen(reinterpret_cast<const char *>(out_path), "wb");
#endif
  if (!fp) return fail_json("WRITE_FAILED", "cannot write output");
  const bool bmp = [&]() {
    const wchar_t *dot = wcsrchr(out_path, L'.');
    return dot && (_wcsicmp(dot, L".bmp") == 0);
  }();
  const bool ok = bmp
    ? write_bmp_bgr(fp, w, h, rgb.data()) != 0
    : (std::fprintf(fp, "P6\n%d %d\n255\n", w, h) > 0
      && std::fwrite(rgb.data(), 1, static_cast<size_t>(w * h * 3), fp) == static_cast<size_t>(w * h * 3));
  std::fclose(fp);
  if (!ok) return fail_json("WRITE_FAILED", "short write");
  std::printf("{\"ok\":true,\"engine\":\"todo-cpp-ffmpeg\",\"width\":%d,\"height\":%d,\"time\":%.9f}\n", w, h, time_sec);
  return 0;
}

static int cmd_play_smoke(const wchar_t *path, double seconds, int timeout_ms) {
  if (!(seconds > 0)) return fail_json("INVALID_ARGUMENT", "seconds must be > 0");

  TodoPlayer *player = nullptr;
  TodoStatus st = todo_player_open(path, timeout_ms, &player);
  if (st != TODO_OK) return fail_json(status_code(st), "player open failed");

  TodoPlayerInfo info{};
  st = todo_player_info(player, &info);
  if (st != TODO_OK || !info.has_video || info.width <= 0 || info.height <= 0) {
    todo_player_close(player);
    return fail_json(st == TODO_OK ? "NO_VIDEO" : status_code(st), "no video for play-smoke");
  }

  const int need = info.width * info.height * 3;
  std::vector<unsigned char> rgb(static_cast<size_t>(need));
  int frames = 0;
  const double limit = seconds;

  for (;;) {
    int w = 0, h = 0;
    double pts = 0;
    st = todo_player_read(player, rgb.data(), need, &w, &h, &pts);
    if (st == TODO_ERR_EOF) break;
    if (st != TODO_OK) {
      todo_player_close(player);
      return fail_json(status_code(st), "player read failed");
    }
    ++frames;
    if (pts + 1e-9 >= limit) break;
  }

  todo_player_close(player);
  std::printf(
    "{\"ok\":true,\"engine\":\"todo-cpp-ffmpeg\",\"frames\":%d,\"fps\":%.9f,\"duration\":%.9f}\n",
    frames, info.frame_rate, info.duration);
  return 0;
}

static void flush_out() {
  std::fflush(stdout);
}

static void reply_err(const char *code) {
  std::printf("ERR %s\n", code);
  flush_out();
}

static void reply_ok() {
  std::puts("OK");
  flush_out();
}

#ifdef _WIN32
static std::wstring utf8_to_wide(const std::string &utf8) {
  if (utf8.empty()) return std::wstring();
  const int n = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), nullptr, 0);
  if (n <= 0) return std::wstring();
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), out.data(), n);
  return out;
}
#endif

/** stdin line protocol: OPEN/SEEK/READ/CLOSE/QUIT — RGB24 frames on stdout. */
static int cmd_play_session(int timeout_ms) {
#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
#endif

  TodoPlayer *player = nullptr;
  std::vector<unsigned char> rgb;
  int open_timeout = timeout_ms;
  if (open_timeout < 100) open_timeout = 10000;
  if (open_timeout > 30000) open_timeout = 30000;

  std::string line;
  for (;;) {
    line.clear();
    for (;;) {
      const int ch = std::fgetc(stdin);
      if (ch == EOF) {
        if (player) {
          todo_player_close(player);
          player = nullptr;
        }
        return 0;
      }
      if (ch == '\n') break;
      if (ch != '\r') line.push_back(static_cast<char>(ch));
    }

    if (line.empty()) continue;

    if (line == "QUIT") {
      if (player) {
        todo_player_close(player);
        player = nullptr;
      }
      reply_ok();
      return 0;
    }

    if (line == "CLOSE") {
      if (player) {
        todo_player_close(player);
        player = nullptr;
      }
      rgb.clear();
      reply_ok();
      continue;
    }

    if (line.rfind("OPEN ", 0) == 0) {
      const std::string path_utf8 = line.substr(5);
      if (player) {
        todo_player_close(player);
        player = nullptr;
      }
      rgb.clear();
#ifdef _WIN32
      const std::wstring wpath = utf8_to_wide(path_utf8);
      if (wpath.empty()) {
        reply_err("INVALID_ARGUMENT");
        continue;
      }
      const TodoStatus st = todo_player_open(wpath.c_str(), open_timeout, &player);
#else
      (void)path_utf8;
      const TodoStatus st = TODO_ERR_UNSUPPORTED;
#endif
      if (st != TODO_OK || !player) {
        player = nullptr;
        reply_err(status_code(st != TODO_OK ? st : TODO_ERR_OPEN));
        continue;
      }
      TodoPlayerInfo info{};
      if (todo_player_info(player, &info) != TODO_OK || !info.has_video || info.width <= 0 || info.height <= 0) {
        todo_player_close(player);
        player = nullptr;
        reply_err("NO_VIDEO");
        continue;
      }
      rgb.assign(static_cast<size_t>(info.width) * static_cast<size_t>(info.height) * 3u, 0);
      reply_ok();
      continue;
    }

    if (line.rfind("SEEK ", 0) == 0) {
      if (!player) {
        reply_err("NOT_OPEN");
        continue;
      }
      const double sec = std::atof(line.c_str() + 5);
      if (!(sec >= 0) || !std::isfinite(sec)) {
        reply_err("INVALID_ARGUMENT");
        continue;
      }
      const TodoStatus st = todo_player_seek(player, sec);
      if (st != TODO_OK) {
        reply_err(status_code(st));
        continue;
      }
      reply_ok();
      continue;
    }

    if (line == "READ") {
      if (!player) {
        reply_err("NOT_OPEN");
        continue;
      }
      int w = 0, h = 0;
      double pts = 0;
      const TodoStatus st = todo_player_read(
        player, rgb.data(), static_cast<int>(rgb.size()), &w, &h, &pts);
      if (st == TODO_ERR_EOF) {
        std::puts("EOF");
        flush_out();
        continue;
      }
      if (st != TODO_OK) {
        reply_err(status_code(st));
        continue;
      }
      const int nbytes = w * h * 3;
      if (nbytes <= 0 || static_cast<size_t>(nbytes) > rgb.size()) {
        reply_err("DECODE_FAILED");
        continue;
      }
      std::printf("FRAME %d %d %.9f %d\n", w, h, pts, nbytes);
      flush_out();
      if (std::fwrite(rgb.data(), 1, static_cast<size_t>(nbytes), stdout) != static_cast<size_t>(nbytes)) {
        return 1;
      }
      flush_out();
      continue;
    }

    /* PCM decode + waveOut; returns sample/position clock (pumps audio). */
    if (line == "AUDIO_CLOCK") {
      if (!player) {
        reply_err("NOT_OPEN");
        continue;
      }
      double sec = 0;
      const TodoStatus st = todo_player_audio_clock(player, &sec);
      if (st != TODO_OK) {
        std::puts("AUDIO_CLOCK none");
        flush_out();
        continue;
      }
      std::printf("AUDIO_CLOCK %.9f\n", sec);
      flush_out();
      continue;
    }

    reply_err("UNKNOWN_CMD");
  }
}

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
  if (argc < 2) {
    return fail_json(
      "INVALID_ARGUMENT",
      "usage: todo-media-engine probe <file> [timeoutMs] | frame <file> <timeSec> <out.ppm> [timeoutMs] | export <editGraph.json> <out.mp4> | compose <editGraph.json> <timeSec> <out.bmp> | play-smoke <file> <seconds> [timeoutMs] | play-session [timeoutMs]");
  }
  const std::wstring cmd = argv[1];
  if (cmd == L"probe") {
    if (argc < 3) return fail_json("INVALID_ARGUMENT", "probe requires file");
    int timeout = 10000;
    if (argc >= 4) timeout = static_cast<int>(_wtoi(argv[3]));
    return cmd_probe(argv[2], timeout);
  }
  if (cmd == L"frame") {
    if (argc < 5) return fail_json("INVALID_ARGUMENT", "frame requires file time out.ppm");
    const double t = _wtof(argv[3]);
    int timeout = 10000;
    if (argc >= 6) timeout = static_cast<int>(_wtoi(argv[5]));
    return cmd_frame(argv[2], t, timeout, argv[4]);
  }
  if (cmd == L"export") {
    if (argc < 4) return fail_json("INVALID_ARGUMENT", "export requires editGraph.json out.mp4");
    return todo_cmd_export(argv[2], argv[3]);
  }
  if (cmd == L"compose") {
    if (argc < 5) return fail_json("INVALID_ARGUMENT", "compose requires editGraph.json timeSec out.bmp");
    return todo_cmd_compose(argv[2], _wtof(argv[3]), argv[4]);
  }
  if (cmd == L"play-smoke") {
    if (argc < 4) return fail_json("INVALID_ARGUMENT", "play-smoke requires file seconds");
    const double seconds = _wtof(argv[3]);
    int timeout = 15000;
    if (argc >= 5) timeout = static_cast<int>(_wtoi(argv[4]));
    return cmd_play_smoke(argv[2], seconds, timeout);
  }
  if (cmd == L"play-session") {
    int timeout = 10000;
    if (argc >= 3) timeout = static_cast<int>(_wtoi(argv[2]));
    return cmd_play_session(timeout);
  }
  return fail_json("INVALID_ARGUMENT", "unknown command");
}
#else
int main(int argc, char **argv) {
  (void)argc;
  (void)argv;
  return fail_json("UNSUPPORTED", "Windows build required");
}
#endif
