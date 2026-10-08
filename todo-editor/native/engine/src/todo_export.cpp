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
#include <cstdlib>
#include <atomic>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <type_traits>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
}

#include "todo_engine.h"
#include "editgraph.h"
#include "timemap.h"
#include "keyframes.h"
#include "layers.h"

namespace {

/**
 * 导出用的顺序读帧：解码器一直开着，时间往前走就接着解，只有倒退或跳远才 seek。
 * 取帧规则和 todo_decode_rgb24 一致：第一帧 pts >= t - 1ms。
 */
class FrameSource {
 public:
  ~FrameSource() { close(); }

  bool open(const std::string &path_utf8) {
    if (avformat_open_input(&fmt_, path_utf8.c_str(), nullptr, nullptr) < 0) return false;
    if (avformat_find_stream_info(fmt_, nullptr) < 0) return false;
    vi_ = av_find_best_stream(fmt_, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (vi_ < 0) return false;
    AVStream *st = fmt_->streams[vi_];
    const AVCodec *codec = avcodec_find_decoder(st->codecpar->codec_id);
    if (!codec) return false;
    dec_ = avcodec_alloc_context3(codec);
    if (!dec_ || avcodec_parameters_to_context(dec_, st->codecpar) < 0) return false;
    dec_->thread_count = 0;
    if (avcodec_open2(dec_, codec, nullptr) < 0) return false;
    w_ = st->codecpar->width;
    h_ = st->codecpar->height;
    tb_ = av_q2d(st->time_base);
    const double rate = av_q2d(av_guess_frame_rate(fmt_, st, nullptr));
    frame_dur_ = rate > 0 && std::isfinite(rate) ? 1.0 / rate : 1.0 / 30;
    pkt_ = av_packet_alloc();
    frame_ = av_frame_alloc();
    return w_ > 0 && h_ > 0 && pkt_ && frame_;
  }

  /** 返回 RGB24；素材带透明通道时 *alpha 指向同尺寸的 8 位透明度，否则为 nullptr */
  const uint8_t *at(double t, int *out_w, int *out_h, const uint8_t **alpha = nullptr) {
    const double eps = 1e-3;
    const bool current_ok = have_ && cur_pts_ + eps >= t && prev_pts_ + eps < t;
    if (!current_ok) {
      const bool forward = have_ && !eof_ && cur_pts_ + eps < t && t - cur_pts_ < 3.0;
      if (!forward && !seek(t)) return nullptr;
      if (!advance_to(t)) return nullptr;
    }
    *out_w = w_;
    *out_h = h_;
    if (alpha) *alpha = has_alpha_ ? alpha_.data() : nullptr;
    return rgb_.data();
  }

 private:
  AVFormatContext *fmt_ = nullptr;
  AVCodecContext *dec_ = nullptr;
  SwsContext *sws_ = nullptr;
  AVPacket *pkt_ = nullptr;
  AVFrame *frame_ = nullptr;
  int vi_ = -1;
  int w_ = 0, h_ = 0;
  double tb_ = 0;
  double frame_dur_ = 1.0 / 30;
  AVPixelFormat sws_src_ = AV_PIX_FMT_NONE;
  std::vector<uint8_t> rgb_, alpha_, rgba_;
  bool has_alpha_ = false;
  double cur_pts_ = 0;
  double prev_pts_ = -1e18;
  bool have_ = false;
  bool eof_ = false;
  bool draining_ = false;

  bool seek(double t) {
    const int64_t ts = static_cast<int64_t>(t / tb_);
    if (av_seek_frame(fmt_, vi_, ts, AVSEEK_FLAG_BACKWARD) < 0) return false;
    avcodec_flush_buffers(dec_);
    have_ = eof_ = draining_ = false;
    prev_pts_ = -1e18;
    return true;
  }

  bool next(double *pts) {
    for (;;) {
      const int r = avcodec_receive_frame(dec_, frame_);
      if (r >= 0) {
        const int64_t p = frame_->best_effort_timestamp != AV_NOPTS_VALUE ? frame_->best_effort_timestamp : frame_->pts;
        *pts = p != AV_NOPTS_VALUE ? p * tb_ : (have_ ? cur_pts_ + frame_dur_ : 0.0);
        return true;
      }
      if (r != AVERROR(EAGAIN) || draining_) return false;
      if (av_read_frame(fmt_, pkt_) < 0) {
        draining_ = true;
        avcodec_send_packet(dec_, nullptr);
        continue;
      }
      if (pkt_->stream_index == vi_) avcodec_send_packet(dec_, pkt_);
      av_packet_unref(pkt_);
    }
  }

  bool advance_to(double t) {
    double last = have_ ? cur_pts_ : prev_pts_;
    for (;;) {
      double pts = 0;
      if (!next(&pts)) {
        eof_ = true;
        return false;
      }
      if (pts + 1e-3 >= t) {
        prev_pts_ = last;
        cur_pts_ = pts;
        have_ = convert();
        return have_;
      }
      last = pts;
    }
  }

  bool convert() {
    const AVPixelFormat src = static_cast<AVPixelFormat>(frame_->format);
    if (!sws_ || src != sws_src_) {
      if (sws_) sws_freeContext(sws_);
      const AVPixFmtDescriptor *desc = av_pix_fmt_desc_get(src);
      has_alpha_ = desc && (desc->flags & AV_PIX_FMT_FLAG_ALPHA);
      sws_ = sws_getContext(w_, h_, src, w_, h_, has_alpha_ ? AV_PIX_FMT_RGBA : AV_PIX_FMT_RGB24, SWS_BILINEAR, nullptr, nullptr, nullptr);
      sws_src_ = src;
      if (!sws_) return false;
    }
    const size_t n = static_cast<size_t>(w_) * h_;
    rgb_.resize(n * 3);
    if (!has_alpha_) {
      uint8_t *dst[4] = { rgb_.data(), nullptr, nullptr, nullptr };
      int dst_ls[4] = { w_ * 3, 0, 0, 0 };
      sws_scale(sws_, frame_->data, frame_->linesize, 0, h_, dst, dst_ls);
      return true;
    }
    rgba_.resize(n * 4);
    alpha_.resize(n);
    uint8_t *dst[4] = { rgba_.data(), nullptr, nullptr, nullptr };
    int dst_ls[4] = { w_ * 4, 0, 0, 0 };
    sws_scale(sws_, frame_->data, frame_->linesize, 0, h_, dst, dst_ls);
    for (size_t i = 0; i < n; ++i) {
      rgb_[i * 3] = rgba_[i * 4];
      rgb_[i * 3 + 1] = rgba_[i * 4 + 1];
      rgb_[i * 3 + 2] = rgba_[i * 4 + 2];
      alpha_[i] = rgba_[i * 4 + 3];
    }
    return true;
  }

  void close() {
    if (sws_) sws_freeContext(sws_);
    av_frame_free(&frame_);
    av_packet_free(&pkt_);
    avcodec_free_context(&dec_);
    if (fmt_) avformat_close_input(&fmt_);
  }
};

struct StillImage {
  std::vector<uint8_t> rgb, alpha;
  int w = 0, h = 0;
  bool ok = false;
  int64_t used = 0;
};

/** 常驻工作线程：导出每帧要并行好几次，不能每次现建线程 */
class WorkerPool {
 public:
  void run(size_t n, const std::function<void(size_t)> &fn) {
    if (tl_worker_ || n <= 1) {
      for (size_t i = 0; i < n; ++i) fn(i);
      return;
    }
    ensure();
    job_ = &fn;
    count_ = n;
    next_ = 0;
    const int k = static_cast<int>((std::min)(threads_.size(), n - 1));
    active_ = k;
    if (k > 0) {
      ResetEvent(done_);
      ReleaseSemaphore(go_, k, nullptr);
    }
    drain();
    if (k > 0) WaitForSingleObject(done_, INFINITE);
  }

 private:
  static thread_local bool tl_worker_;
  std::vector<HANDLE> threads_;
  HANDLE go_ = nullptr, done_ = nullptr;
  const std::function<void(size_t)> *job_ = nullptr;
  size_t count_ = 0;
  std::atomic<size_t> next_{0};
  std::atomic<int> active_{0};

  void drain() {
    for (size_t i; (i = next_.fetch_add(1)) < count_;) (*job_)(i);
  }

  void ensure() {
    if (go_) return;
    SYSTEM_INFO si{};
    GetSystemInfo(&si);
    const int n = static_cast<int>((std::min)(32ul, (std::max)(1ul, si.dwNumberOfProcessors))) - 1;
    go_ = CreateSemaphoreW(nullptr, 0, 64, nullptr);
    done_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    for (int i = 0; i < n; ++i) {
      HANDLE t = CreateThread(nullptr, 0, [](LPVOID p) -> DWORD {
        auto *self = static_cast<WorkerPool *>(p);
        tl_worker_ = true;
        for (;;) {
          WaitForSingleObject(self->go_, INFINITE);
          self->drain();
          if (--self->active_ == 0) SetEvent(self->done_);
        }
      }, this, 0, nullptr);
      if (t) threads_.push_back(t);
    }
  }
};
thread_local bool WorkerPool::tl_worker_ = false;
WorkerPool g_pool;

/** fn(0..n-1) 分到各核跑完再返回；在工作线程里再调用就原地串行 */
template <class F>
void parallel_for(size_t n, F &&fn) {
  g_pool.run(n, std::function<void(size_t)>(std::ref(fn)));
}

/** 把 [0,h) 行切块并行，fn(y0, y1) */
template <class F>
void for_row_chunks(int h, F &&fn) {
  const int chunks = (std::min)(h, 32);
  parallel_for(static_cast<size_t>(chunks), [&](size_t i) {
    fn(static_cast<int>(h * i / chunks), static_cast<int>(h * (i + 1) / chunks));
  });
}

/** 一次导出内复用：每个片段一个顺序读帧器，静帧图只解一次；不再出现的及时释放 */
struct ComposeCache {
  std::map<std::string, std::unique_ptr<FrameSource>> videos;
  std::map<std::string, int64_t> video_used;
  std::map<std::string, StillImage> stills;
  int64_t tick = 0;

  /** 后台线程提前打开并定位到首帧的读帧器 */
  struct Pending {
    HANDLE thread = nullptr;
    std::unique_ptr<FrameSource> src;
    std::string path;
    double media_t = 0, start = 0;
    bool ok = false;
  };
  std::map<std::string, std::unique_ptr<Pending>> pending;

  struct PendingStill {
    HANDLE thread = nullptr;
    std::string path;
    StillImage img;
    double start = 0;
  };
  std::map<std::string, std::unique_ptr<PendingStill>> pending_stills;

  ~ComposeCache() {
    for (auto &kv : pending) join(*kv.second);
    for (auto &kv : pending_stills) join(*kv.second);
  }

  static std::string key_of(const Clip &c) {
    return c.id.empty() ? c.media_path + "@" + std::to_string(c.start) : c.id;
  }

  template <class P>
  static void join(P &p) {
    if (!p.thread) return;
    WaitForSingleObject(p.thread, INFINITE);
    CloseHandle(p.thread);
    p.thread = nullptr;
  }

  /** 片段自己的读帧器（打不开为 nullptr）；只在主线程调，取帧可以各层并行 */
  FrameSource *source(const Clip &c) {
    const std::string key = key_of(c);
    auto it = videos.find(key);
    if (it == videos.end()) {
      std::unique_ptr<FrameSource> src;
      auto pit = pending.find(key);
      if (pit != pending.end()) {
        join(*pit->second);
        if (pit->second->ok) src = std::move(pit->second->src);
        pending.erase(pit);
      } else {
        src = std::make_unique<FrameSource>();
        if (!src->open(c.media_path)) src.reset();
      }
      it = videos.emplace(key, std::move(src)).first;
    }
    video_used[key] = tick;
    return it->second.get();
  }

  /** 接下来 horizon 秒内要出场的视频片段，先在后台打开并解到首帧，出场那帧不用停下来等 */
  void prefetch(const EditGraph &g, double t, double horizon) {
    for (auto it = pending.begin(); it != pending.end();) {
      if (it->second->start + 1.0 < t) {
        join(*it->second);
        it = pending.erase(it);
      } else {
        ++it;
      }
    }
    for (auto it = pending_stills.begin(); it != pending_stills.end();) {
      if (it->second->start + 1.0 < t) {
        join(*it->second);
        it = pending_stills.erase(it);
      } else {
        ++it;
      }
    }
    for (const Clip &c : g.clips) {
      if (!c.enabled || c.start <= t || c.start > t + horizon) continue;
      if (c.kind == "text" || !c.text_content.empty() || c.kind == "solid") continue;
      if (c.media_path.empty()) continue;
      if (is_still_image(c.kind, c.media_path)) {
        if (stills.count(c.media_path) || pending_stills.count(c.media_path)) continue;
        auto p = std::make_unique<PendingStill>();
        p->path = c.media_path;
        p->start = c.start;
        p->thread = CreateThread(nullptr, 0, [](LPVOID arg) -> DWORD {
          auto *pd = static_cast<PendingStill *>(arg);
          decode_still(pd->path, pd->img);
          return 0;
        }, p.get(), 0, nullptr);
        if (p->thread) pending_stills.emplace(c.media_path, std::move(p));
        continue;
      }
      const std::string key = key_of(c);
      if (videos.count(key) || pending.count(key)) continue;
      auto p = std::make_unique<Pending>();
      p->src = std::make_unique<FrameSource>();
      p->path = c.media_path;
      p->start = c.start;
      p->media_t = clip_media_time(c, c.start + 1e-4);
      p->thread = CreateThread(nullptr, 0, [](LPVOID arg) -> DWORD {
        auto *pd = static_cast<Pending *>(arg);
        int w = 0, h = 0;
        pd->ok = pd->src->open(pd->path);
        if (pd->ok) pd->src->at(pd->media_t, &w, &h);
        return 0;
      }, p.get(), 0, nullptr);
      if (!p->thread) continue;
      pending.emplace(key, std::move(p));
    }
  }

  static void decode_still(const std::string &path, StillImage &s) {
    FrameSource src;
    const uint8_t *a = nullptr;
    const uint8_t *rgb = src.open(path) ? src.at(0.0, &s.w, &s.h, &a) : nullptr;
    if (rgb && s.w > 0 && s.h > 0) {
      const size_t n = static_cast<size_t>(s.w) * s.h;
      s.rgb.assign(rgb, rgb + n * 3);
      if (a) s.alpha.assign(a, a + n);
      s.ok = true;
      return;
    }
    const std::wstring pw = utf8_to_wide(path);
    TodoProbeInfo info{};
    if (todo_probe(pw.c_str(), 8000, &info) == TODO_OK && info.has_video && info.width > 0) {
      s.rgb.resize(static_cast<size_t>(info.width) * info.height * 3);
      s.ok = todo_decode_rgb24(pw.c_str(), 0.0, 12000, s.rgb.data(), static_cast<int>(s.rgb.size()), &s.w, &s.h) == TODO_OK;
    }
  }

  const uint8_t *still(const std::string &path, int *w, int *h, const uint8_t **alpha) {
    auto sit = stills.find(path);
    if (sit == stills.end()) {
      StillImage img;
      auto pit = pending_stills.find(path);
      if (pit != pending_stills.end()) {
        join(*pit->second);
        img = std::move(pit->second->img);
        pending_stills.erase(pit);
      } else {
        decode_still(path, img);
      }
      sit = stills.emplace(path, std::move(img)).first;
    }
    StillImage &s = sit->second;
    s.used = tick;
    if (!s.ok) return nullptr;
    *w = s.w;
    *h = s.h;
    *alpha = s.alpha.empty() ? nullptr : s.alpha.data();
    return s.rgb.data();
  }

  /** 每帧合成完调用：这一帧没用到的视频关掉，几秒没用的静帧图扔掉 */
  void end_frame(int64_t still_keep) {
    for (auto it = video_used.begin(); it != video_used.end();) {
      if (it->second < tick) {
        videos.erase(it->first);
        it = video_used.erase(it);
      } else {
        ++it;
      }
    }
    for (auto it = stills.begin(); it != stills.end();) {
      if (it->second.used + still_keep < tick) it = stills.erase(it);
      else ++it;
    }
    ++tick;
  }
};

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

/** 成片视频编码：优先显卡硬件编码，都不可用时用 libx264 */
struct VideoEncoder {
  std::wstring ffmpeg;
  std::vector<std::wstring> args;
  std::string name;
};

static VideoEncoder pick_video_encoder(const std::wstring &primary) {
  VideoEncoder x264{primary, {L"-c:v", L"libx264", L"-pix_fmt", L"yuv420p", L"-preset", L"fast", L"-crf", L"18"}, "libx264"};
  wchar_t env[64];
  const DWORD n = GetEnvironmentVariableW(L"TODO_EXPORT_ENCODER", env, 64);
  const std::wstring force = n > 0 && n < 64 ? std::wstring(env, n) : L"";
  if (force == L"x264" || force == L"libx264" || force == L"cpu") return x264;

  std::vector<std::wstring> ffmpegs{primary};
  wchar_t mod[MAX_PATH];
  const DWORD m = GetModuleFileNameW(nullptr, mod, MAX_PATH);
  if (m > 0 && m < MAX_PATH) {
    std::wstring dir(mod, mod + m);
    const auto slash = dir.find_last_of(L"\\/");
    if (slash != std::wstring::npos) {
      const std::wstring hw = dir.substr(0, slash + 1) + L"ffmpeg-hw.exe";
      if (file_exists_w(hw.c_str())) ffmpegs.push_back(hw);
    }
  }

  const std::vector<VideoEncoder> hw = {
    {L"", {L"-c:v", L"h264_nvenc", L"-pix_fmt", L"yuv420p", L"-preset", L"p4", L"-tune", L"hq", L"-rc", L"vbr",
           L"-cq", L"19", L"-b:v", L"0", L"-spatial-aq", L"1", L"-profile:v", L"high"}, "h264_nvenc"},
    {L"", {L"-c:v", L"h264_amf", L"-pix_fmt", L"yuv420p", L"-quality", L"quality", L"-rc", L"cqp",
           L"-qp_i", L"18", L"-qp_p", L"20", L"-qp_b", L"22"}, "h264_amf"},
    {L"", {L"-c:v", L"h264_qsv", L"-pix_fmt", L"nv12", L"-preset", L"medium", L"-global_quality", L"20"}, "h264_qsv"},
  };
  for (const auto &enc : hw) {
    if (!force.empty() && force != utf8_to_wide(enc.name)) continue;
    for (const auto &ff : ffmpegs) {
      std::vector<std::wstring> probe{L"-hide_banner", L"-v", L"error", L"-f", L"lavfi", L"-i", L"color=black:s=640x360:r=30:d=0.2"};
      probe.insert(probe.end(), enc.args.begin(), enc.args.end());
      probe.insert(probe.end(), {L"-f", L"null", L"-"});
      if (run_ffmpeg(ff, probe) == 0) return {ff, enc.args, enc.name};
    }
  }
  return x264;
}

/** ffmpeg 从 stdin 收原始帧：合成好一帧写一帧，不落盘 */
struct FfmpegPipe {
  HANDLE proc = nullptr;
  HANDLE in = nullptr;

  bool start(const std::wstring &ffmpeg, const std::vector<std::wstring> &args) {
    std::wstring cmd = quote_arg(ffmpeg);
    for (const auto &a : args) {
      cmd.push_back(L' ');
      cmd += quote_arg(a);
    }
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    HANDLE rd = nullptr;
    if (!CreatePipe(&rd, &in, &sa, 8 << 20)) return false;
    SetHandleInformation(in, HANDLE_FLAG_INHERIT, 0);
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = rd;
    si.hStdOutput = nul;
    si.hStdError = nul;
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> buf(cmd.begin(), cmd.end());
    buf.push_back(L'\0');
    const BOOL ok = CreateProcessW(nullptr, buf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
    CloseHandle(rd);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    if (!ok) {
      CloseHandle(in);
      in = nullptr;
      return false;
    }
    CloseHandle(pi.hThread);
    proc = pi.hProcess;
    return true;
  }

  bool write(const uint8_t *data, size_t n) {
    while (n > 0) {
      DWORD wrote = 0;
      const DWORD chunk = static_cast<DWORD>((std::min)(n, static_cast<size_t>(1) << 24));
      if (!WriteFile(in, data, chunk, &wrote, nullptr) || wrote == 0) return false;
      data += wrote;
      n -= wrote;
    }
    return true;
  }

  int finish() {
    if (in) CloseHandle(in);
    in = nullptr;
    if (!proc) return -1;
    WaitForSingleObject(proc, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(proc, &code);
    CloseHandle(proc);
    proc = nullptr;
    return static_cast<int>(code);
  }
};

/** 后台线程往 ffmpeg 写帧：写上一帧的同时合成下一帧 */
class PipeWriter {
 public:
  explicit PipeWriter(FfmpegPipe *pipe) : pipe_(pipe) {
    ready_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    idle_ = CreateEventW(nullptr, FALSE, TRUE, nullptr);
    thread_ = CreateThread(nullptr, 0, [](LPVOID p) -> DWORD {
      auto *self = static_cast<PipeWriter *>(p);
      for (;;) {
        WaitForSingleObject(self->ready_, INFINITE);
        if (self->quit_) return 0;
        if (!self->pipe_->write(self->buf_.data(), self->buf_.size())) self->ok_ = false;
        SetEvent(self->idle_);
      }
    }, this, 0, nullptr);
  }

  ~PipeWriter() { finish(); }

  /** 交出这一帧（和内部缓冲交换，调用方拿回一块可复用的内存）；上一帧写失败返回 false */
  bool push(std::vector<uint8_t> *frame) {
    if (!thread_) return pipe_->write(frame->data(), frame->size());
    WaitForSingleObject(idle_, INFINITE);
    if (!ok_) return false;
    buf_.swap(*frame);
    SetEvent(ready_);
    return true;
  }

  bool finish() {
    if (thread_) {
      WaitForSingleObject(idle_, INFINITE);
      quit_ = true;
      SetEvent(ready_);
      WaitForSingleObject(thread_, INFINITE);
      CloseHandle(thread_);
      thread_ = nullptr;
    }
    if (ready_) { CloseHandle(ready_); ready_ = nullptr; }
    if (idle_) { CloseHandle(idle_); idle_ = nullptr; }
    return ok_;
  }

 private:
  FfmpegPipe *pipe_;
  std::vector<uint8_t> buf_;
  HANDLE thread_ = nullptr, ready_ = nullptr, idle_ = nullptr;
  volatile bool quit_ = false;
  volatile bool ok_ = true;
};

std::string fmt_num(double v) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.6g", v);
  return buf;
}

}  // namespace

static int compose_graph_rgb(const EditGraph &g, double time_sec, std::vector<uint8_t> *canvas, int *out_w, int *out_h, int *out_layers, ComposeCache *cache = nullptr);

static int64_t prof_now() {
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  return c.QuadPart;
}
/** TODO_EXPORT_PROFILE=1 时导出结束在 stderr 打各阶段耗时 */
struct ExportProfile {
  std::atomic<int64_t> decode{0}, layer{0}, parallel{0}, gpu{0}, pipe{0}, open{0}, compose{0}, endf{0};
  std::atomic<int64_t> layers{0};
  std::atomic<int64_t> stage[10]{};
  void report(int frames) const {
    if (!std::getenv("TODO_EXPORT_PROFILE")) return;
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    auto s = [&](int64_t v) { return static_cast<double>(v) / f.QuadPart; };
    std::fprintf(stderr, "profile frames=%d layers/frame=%.1f open=%.2fs decode(sum)=%.2fs layer(sum)=%.2fs parallel(wall)=%.2fs gpu=%.2fs compose=%.2fs end_frame=%.2fs pipe=%.2fs\n",
      frames, static_cast<double>(layers) / (std::max)(1, frames), s(open), s(decode), s(layer), s(parallel), s(gpu), s(compose), s(endf), s(pipe));
    static const char *names[10] = {"collect", "alloc", "text", "solid", "letterbox", "look", "chroma", "crop", "mask", "transform+transition"};
    for (int i = 0; i < 10; ++i) std::fprintf(stderr, "  %s=%.2fs\n", names[i], s(stage[i]));
  }
};
static ExportProfile g_prof;
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

  // 文字 / 纯色无素材文件，由合成直接画
  auto synthetic = [](const Clip &c) {
    return c.kind == "solid" || c.kind == "text" || !c.text_content.empty();
  };
  std::vector<Clip> clips;
  bool has_synthetic = false;
  for (const auto &c : g.clips) {
    if (!c.enabled) continue;
    if (synthetic(c)) {
      has_synthetic = true;
      clips.push_back(c);
      continue;
    }
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
    if (synthetic(c)) continue;
    std::string k = c.kind;
    if (k == "sticker") k = "image";
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
    if (c.mute) continue;
    if (synthetic(c)) continue;
    if (is_still_image(c.kind, c.media_path) || c.kind == "image") continue;
    audio_clips.push_back(c);
  }

  double timeline_end = 0;
  for (const auto &c : clips) timeline_end = (std::max)(timeline_end, c.start + c.duration);
  if (!(timeline_end > 0)) timeline_end = range_only ? work_out : 1.0;
  const double out_dur = (std::max)(0.1, timeline_end);

  /* Video: compose each frame (same rules as preview) then ffmpeg encode. */
  if (!audio_only) {
    if (video_clips.empty() && audio_clips.empty() && !has_synthetic) {
      return fail_json("没有可导出的媒体片段（需本机 path）");
    }
    const double t0 = range_only ? work_in : 0.0;
    const double t1 = range_only ? work_out : out_dur;
    const int nframes = (std::max)(1, static_cast<int>(std::ceil((t1 - t0) * fps)));

    std::vector<InputMeta> inputs;
    std::vector<std::string> filters;
    std::vector<std::string> audio_labs;
    for (size_t i = 0; i < audio_clips.size(); ++i) {
      const Clip &c = audio_clips[i];
      /* input 0 = stdin 原始帧；音频从 1 起 */
      const int idx = static_cast<int>(i + 1);
      inputs.push_back({c.media_path, false, 0});
      const double start = (std::max)(0.0, c.start);
      const double dur = (std::max)(0.04, c.duration);
      const double in_point = (std::max)(0.0, c.in_point);
      const int delay_ms = static_cast<int>(std::lround(start * 1000.0));
      const std::string lab = "a" + std::to_string(i);
      std::string vol;
      if (std::fabs(c.gain_db) > 1e-6) vol = ",volume=" + fmt_num(c.gain_db) + "dB";
      filters.push_back(
        "[" + std::to_string(idx) + ":a]atrim=start=" + fmt_num(in_point) + ":duration=" + fmt_num(dur) +
        ",asetpts=PTS-STARTPTS" + vol + ",adelay=" + std::to_string(delay_ms) + "|" + std::to_string(delay_ms) +
        ":all=1[" + lab + "]");
      audio_labs.push_back("[" + lab + "]");
    }
    if (audio_labs.size() == 1) filters.push_back(audio_labs[0] + "anull[aout]");
    else if (audio_labs.size() > 1) {
      std::string mix;
      for (const auto &l : audio_labs) mix += l;
      /* normalize=0: adelay silence still counts as inputs; default normalize=1 divides by N */
      mix += "amix=inputs=" + std::to_string(audio_labs.size()) +
             ":duration=longest:dropout_transition=0:normalize=0[aout]";
      filters.push_back(mix);
    }

    std::vector<std::wstring> args;
    args.push_back(L"-y");
    args.push_back(L"-hide_banner");
    args.push_back(L"-loglevel");
    args.push_back(L"error");
    args.push_back(L"-f");
    args.push_back(L"rawvideo");
    args.push_back(L"-pix_fmt");
    args.push_back(L"rgb24");
    args.push_back(L"-s");
    args.push_back(std::to_wstring(w) + L"x" + std::to_wstring(h));
    args.push_back(L"-framerate");
    args.push_back(utf8_to_wide(fmt_num(fps)));
    args.push_back(L"-i");
    args.push_back(L"-");
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
    const std::wstring primary_ffmpeg = find_ffmpeg();
    if (primary_ffmpeg.empty()) return fail_json("找不到 ffmpeg（PATH / WinGet Links / native/bin / FFMPEG）");
    const VideoEncoder encoder = pick_video_encoder(primary_ffmpeg);
    std::fprintf(stderr, "encoder %s\n", encoder.name.c_str());
    args.push_back(L"-map");
    args.push_back(L"0:v");
    args.insert(args.end(), encoder.args.begin(), encoder.args.end());
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
    FfmpegPipe pipe;
    if (!pipe.start(encoder.ffmpeg, args)) return fail_json("无法启动 ffmpeg");

    /* 进度走 stderr：每帧一行「progress 已合成 总帧数」 */
    ComposeCache cache;
    const int64_t still_keep = static_cast<int64_t>(fps * 5);
    std::vector<uint8_t> canvas;
    bool piped = true;
    PipeWriter writer(&pipe);
    for (int fi = 0; fi < nframes && piped; ++fi) {
      const double t = t0 + (fi + 0.0) / fps;
      int cw = 0, ch = 0, layers = 0;
      if (fi % 5 == 0) cache.prefetch(g, t, 1.0);
      const int64_t c0 = prof_now();
      compose_graph_rgb(g, t, &canvas, &cw, &ch, &layers, &cache);
      const int64_t e0 = prof_now();
      cache.end_frame(still_keep);
      g_prof.compose += e0 - c0;
      g_prof.endf += prof_now() - e0;
      g_prof.layers += layers;
      const int64_t p0 = prof_now();
      piped = cw == w && ch == h && writer.push(&canvas);
      g_prof.pipe += prof_now() - p0;
      std::fprintf(stderr, "progress %d %d\n", fi + 1, nframes);
      std::fflush(stderr);
    }
    piped = writer.finish() && piped;
    g_prof.report(nframes);
    const int code = pipe.finish();

    if (!piped || code != 0 || !file_exists_w(out_path)) {
      if (encoder.name != "libx264") {
        std::fprintf(stderr, "encoder %s failed (code %d), retry with libx264\n", encoder.name.c_str(), code);
        SetEnvironmentVariableW(L"TODO_EXPORT_ENCODER", L"x264");
        return todo_cmd_export(graph_path, out_path);
      }
      char msg[128];
      std::snprintf(msg, sizeof(msg), piped ? "ffmpeg 退出码 %d" : "ffmpeg 提前退出（退出码 %d）", code);
      return fail_json(msg);
    }
    std::printf("{\"ok\":true,\"backend\":\"todo-cpp-compose-ffmpeg\",\"encoder\":\"%s\",\"path\":", encoder.name.c_str());
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
    std::string vol;
    if (std::fabs(c.gain_db) > 1e-6) vol = ",volume=" + fmt_num(c.gain_db) + "dB";
    filters.push_back(
      "[" + std::to_string(idx) + ":a]atrim=start=" + fmt_num(in_point) + ":duration=" + fmt_num(dur) +
      ",asetpts=PTS-STARTPTS" + vol + ",adelay=" + std::to_string(delay_ms) + "|" + std::to_string(delay_ms) +
      ":all=1[" + lab + "]");
    audio_labs.push_back("[" + lab + "]");
  }

  if (audio_labs.size() == 1) {
    filters.push_back(audio_labs[0] + "anull[aout]");
  } else if (audio_labs.size() > 1) {
    std::string mix;
    for (const auto &l : audio_labs) mix += l;
    mix += "amix=inputs=" + std::to_string(audio_labs.size()) +
           ":duration=longest:dropout_transition=0:normalize=0[aout]";
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
    args.push_back(L"fast");
    args.push_back(L"-crf");
    args.push_back(L"18");
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
  const uint8_t *src, int sw, int sh,
  const uint8_t *src_alpha = nullptr, uint8_t *dst_alpha = nullptr) {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  const double s = (std::min)(static_cast<double>(dw) / sw, static_cast<double>(dh) / sh);
  const int nw = (std::max)(1, static_cast<int>(std::lround(sw * s)));
  const int nh = (std::max)(1, static_cast<int>(std::lround(sh * s)));
  const int ox = (dw - nw) / 2;
  const int oy = (dh - nh) / 2;
  const bool same_w = nw == sw;
  std::vector<int> sxs;
  if (!same_w) {
    sxs.resize(static_cast<size_t>(nw));
    for (int x = 0; x < nw; ++x)
      sxs[x] = 3 * (std::min)(sw - 1, static_cast<int>(std::lround((x + 0.5) * sw / nw - 0.5)));
  }
  for (int y = 0; y < nh; ++y) {
    const int sy = (std::min)(sh - 1, static_cast<int>(std::lround((y + 0.5) * sh / nh - 0.5)));
    uint8_t *drow = dst + static_cast<size_t>(oy + y) * dw * 3 + static_cast<size_t>(ox) * 3;
    const uint8_t *srow = src + static_cast<size_t>(sy) * sw * 3;
    if (src_alpha && dst_alpha) {
      uint8_t *darow = dst_alpha + static_cast<size_t>(oy + y) * dw + ox;
      const uint8_t *sarow = src_alpha + static_cast<size_t>(sy) * sw;
      if (same_w) std::memcpy(darow, sarow, static_cast<size_t>(nw));
      else for (int x = 0; x < nw; ++x) darow[x] = sarow[sxs[x] / 3];
    }
    if (same_w) {
      std::memcpy(drow, srow, static_cast<size_t>(nw) * 3);
      continue;
    }
    for (int x = 0; x < nw; ++x) {
      const uint8_t *s3 = srow + sxs[x];
      drow[0] = s3[0];
      drow[1] = s3[1];
      drow[2] = s3[2];
      drow += 3;
    }
  }
}

static void apply_color_grade(uint8_t *rgb, int n_pixels,
  double exposure, double contrast, double saturation, double temperature, double tint) {
  const double e = 1e-6;
  if (std::fabs(exposure) < e && std::fabs(contrast) < e && std::fabs(saturation) < e
      && std::fabs(temperature) < e && std::fabs(tint) < e) return;
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

static void apply_mask(uint8_t *rgb, uint8_t *alpha, int w, int h, const Clip &c) {
  if (c.mask_type.empty()) return;
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const double a = mask_alpha_uv(c, (x + 0.5) / w, (y + 0.5) / h);
      if (a >= 0.999) continue;
      if (alpha) {
        uint8_t &av = alpha[static_cast<size_t>(y) * w + x];
        av = static_cast<uint8_t>(av * a + 0.5);
        continue;
      }
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

/** 转场类型里要逐像素改画面的（其余只调透明度 / 位置） */
static bool is_pixel_transition(const std::string &type) {
  return type == "fadeBlack" || type == "fadeWhite" || type == "wipe";
}

/** time_sec 时这个片段有没有正在进行的逐像素转场 */
static bool pixel_transition_active(const Clip &c, double time_sec) {
  const double local = (std::max)(0.0, time_sec - c.start);
  const double dur = (std::max)(0.04, c.duration);
  return (c.trans_in_dur > 1e-4 && local < c.trans_in_dur && is_pixel_transition(c.trans_in_type))
    || (c.trans_out_dur > 1e-4 && local > dur - c.trans_out_dur && is_pixel_transition(c.trans_out_type));
}

/** 素材层这一帧要不要在 CPU 上逐像素处理（调色、模糊、抠像、裁切、遮罩、闪黑白/擦除） */
static bool media_needs_cpu(const Clip &c, double time_sec) {
  const double e = 1e-6;
  const double contrast = c.contrast + c.fx_sharpen * 0.35 + c.fx_filter * 0.12;
  const double saturation = c.saturation + c.fx_filter * 0.22;
  if (std::fabs(c.exposure) > e || std::fabs(contrast) > e || std::fabs(saturation) > e
      || std::fabs(c.temperature) > e || std::fabs(c.tint) > e) return true;
  if (c.fx_blur > 0.02 || c.chroma_on || !c.mask_type.empty()) return true;
  if ((std::max)(0.0, c.crop_l) + (std::max)(0.0, c.crop_r) + (std::max)(0.0, c.crop_t) + (std::max)(0.0, c.crop_b) >= 1e-6) return true;
  return pixel_transition_active(c, time_sec);
}

/** 片内转场：入/出段调透明度、闪黑白、擦除、推移（与时间线 transitionIn/Out 同字段）。layer 为空时只算透明度和位置 */
static void apply_transition(
  uint8_t *layer, int w, int h, const Clip &c, double time_sec,
  double *x, double *op) {
  const double local = (std::max)(0.0, time_sec - c.start);
  const double dur = (std::max)(0.04, c.duration);
  auto run = [&](const std::string &type, double u, bool is_out) {
    u = (std::max)(0.0, (std::min)(1.0, u));
    const std::string t = type.empty() ? "dissolve" : type;
    if (!layer && is_pixel_transition(t)) return;
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
  /** 空 = 旧规则：纯黑透明、其余不透明；否则逐像素透明度（纯黑仍算透明，裁切/遮罩靠置黑生效） */
  std::vector<uint8_t> alpha;
  float x = 0, y = 0, sx = 1, sy = 1, rot = 0, op = 1;
  int blend = 0; // 0 normal 1 multiply 2 screen 3 add
  /**
   * 不需要逐像素处理的层直接给原始素材（rgb 为空）：GPU 按 fit 矩形把素材放进画布再变换，
   * 省掉整幅画布的分配、缩放和上传。tex_key 相同的素材共用纹理，persistent 的只传一次。
   */
  const uint8_t *src = nullptr, *src_alpha = nullptr;
  int sw = 0, sh = 0;
  int fit_x = 0, fit_y = 0, fit_w = 0, fit_h = 0;
  std::string tex_key;
  bool persistent = false;
};

/** 与 letterbox_onto 同一套取整：素材等比放进 dw×dh 后占的矩形 */
static void letterbox_rect(int dw, int dh, int sw, int sh, int *ox, int *oy, int *nw, int *nh) {
  const double s = (std::min)(static_cast<double>(dw) / sw, static_cast<double>(dh) / sh);
  *nw = (std::max)(1, static_cast<int>(std::lround(sw * s)));
  *nh = (std::max)(1, static_cast<int>(std::lround(sh * s)));
  *ox = (dw - *nw) / 2;
  *oy = (dh - *nh) / 2;
}

/** RGB(+透明度) → 预乘 RGBA 写进映射好的纹理；纯黑一律透明 */
static void write_premultiplied_rgba(uint8_t *dst, size_t pitch, const uint8_t *rgb, const uint8_t *alpha, int w, int h) {
  for_row_chunks(h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      auto *row = reinterpret_cast<uint32_t *>(dst + static_cast<size_t>(y) * pitch);
      const uint8_t *src = rgb + static_cast<size_t>(y) * w * 3;
      if (!alpha) {
        for (int x = 0; x < w; ++x, src += 3) {
          const uint32_t a = (src[0] | src[1] | src[2]) ? 0xFF000000u : 0u;
          row[x] = a | (static_cast<uint32_t>(src[2]) << 16) | (static_cast<uint32_t>(src[1]) << 8) | src[0];
        }
        continue;
      }
      const uint8_t *arow = alpha + static_cast<size_t>(y) * w;
      for (int x = 0; x < w; ++x, src += 3) {
        const uint32_t a = (src[0] | src[1] | src[2]) ? arow[x] : 0u;
        auto pm = [a](uint32_t v) { return (v * a + 127) / 255; };
        row[x] = (a << 24) | (pm(src[2]) << 16) | (pm(src[1]) << 8) | pm(src[0]);
      }
    }
  });
}

static int blend_code(const std::string &b) {
  if (b == "multiply") return 1;
  if (b == "screen") return 2;
  if (b == "add") return 3;
  return 0;
}

/** D3D11 合成的常驻状态：设备、着色器、渲染目标按画幅建一次，整次导出复用（逐帧重建设备和编译着色器极慢） */
struct GpuCompositor {
  struct CBData {
    float center[2];
    float invScale[2];
    float cosR, sinR, opacity;
    int blendMode;
    float invSize[2];
    float fitOrigin[2];
    float fitInv[2];
    float pad[2];
  };

  /** 原始尺寸素材的纹理；persistent 的（静帧）内容只写一次 */
  struct SourceTex {
    ID3D11Texture2D *tex = nullptr;
    ID3D11ShaderResourceView *srv = nullptr;
    int w = 0, h = 0;
    bool filled = false;
    int64_t used = 0;
  };
  std::map<std::string, SourceTex> sources;
  int64_t frame_no = 0;

  bool failed = false;
  int w = 0, h = 0;
  ID3D11Device *device = nullptr;
  ID3D11DeviceContext *ctx = nullptr;
  ID3D11VertexShader *vs = nullptr;
  ID3D11PixelShader *ps = nullptr;
  ID3D11InputLayout *layout = nullptr;
  ID3D11Buffer *vb = nullptr, *cb = nullptr;
  ID3D11SamplerState *samp = nullptr;
  ID3D11Texture2D *rtA = nullptr, *rtB = nullptr, *layerTex = nullptr, *staging = nullptr;
  ID3D11RenderTargetView *rtvA = nullptr, *rtvB = nullptr;
  ID3D11ShaderResourceView *srvA = nullptr, *srvB = nullptr, *layerSrv = nullptr;

  template <class T> static void rel(T *&p) { if (p) { p->Release(); p = nullptr; } }

  void release_source(SourceTex &t) { rel(t.srv); rel(t.tex); }

  void release_targets() {
    for (auto &kv : sources) release_source(kv.second);
    sources.clear();
    rel(layerSrv); rel(layerTex); rel(staging);
    rel(srvA); rel(srvB); rel(rtvA); rel(rtvB); rel(rtA); rel(rtB);
    w = h = 0;
  }

  void release_all() {
    release_targets();
    rel(samp); rel(cb); rel(vb); rel(layout); rel(ps); rel(vs); rel(ctx); rel(device);
  }

  ~GpuCompositor() { release_all(); }

  bool init_device() {
    const D3D_FEATURE_LEVEL levels[] = { D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0 };
    D3D_FEATURE_LEVEL level;
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, levels, 2, D3D11_SDK_VERSION, &device, &level, &ctx))
        || !device || !ctx) return false;
    const char *vs_src =
      "struct VSIn{float2 p:POSITION;float2 u:TEXCOORD0;};"
      "struct VSOut{float4 p:SV_POSITION;float2 u:TEXCOORD0;};"
      "VSOut main(VSIn i){VSOut o;o.p=float4(i.p,0,1);o.u=i.u;return o;}";
    const char *ps_src =
      "cbuffer CB:register(b0){float2 center;float2 invScale;float cosR;float sinR;float opacity;int blendMode;float2 invSize;float2 fitOrigin;float2 fitInv;float2 pad;};"
      "Texture2D srcTex:register(t0);Texture2D dstTex:register(t1);SamplerState samp:register(s0);"
      "float4 main(float4 p:SV_POSITION,float2 u:TEXCOORD0):SV_TARGET{"
      "float2 pix=float2(p.x,p.y);"
      "float2 d=pix-center;"
      "float2 loc=float2(cosR*d.x+sinR*d.y,-sinR*d.x+cosR*d.y);"
      "loc=loc*invScale+float2(0.5/invSize.x,0.5/invSize.y);"
      "float2 uv=(loc-fitOrigin)*fitInv;"
      "float3 dest=dstTex.Sample(samp,u).rgb;"
      "if(uv.x<0||uv.y<0||uv.x>1||uv.y>1) return float4(dest,1);"
      "float4 s4=srcTex.Sample(samp,uv);"
      "if(s4.a<1e-4) return float4(dest,1);"
      "float3 s=saturate(s4.rgb/s4.a);"
      "float3 o=s;"
      "if(blendMode==1) o=dest*s;"
      "else if(blendMode==2) o=1-(1-dest)*(1-s);"
      "else if(blendMode==3) o=saturate(dest+s);"
      "o=lerp(dest,o,saturate(opacity)*s4.a);"
      "return float4(o,1);}";
    ID3DBlob *vsb = nullptr, *psb = nullptr, *err = nullptr;
    if (FAILED(D3DCompile(vs_src, std::strlen(vs_src), nullptr, nullptr, nullptr, "main", "vs_4_0", 0, 0, &vsb, &err))) {
      rel(err);
      return false;
    }
    if (FAILED(D3DCompile(ps_src, std::strlen(ps_src), nullptr, nullptr, nullptr, "main", "ps_4_0", 0, 0, &psb, &err))) {
      rel(err);
      rel(vsb);
      return false;
    }
    device->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr, &vs);
    device->CreatePixelShader(psb->GetBufferPointer(), psb->GetBufferSize(), nullptr, &ps);
    D3D11_INPUT_ELEMENT_DESC ied[] = {
      { "POSITION", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0 },
      { "TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 8, D3D11_INPUT_PER_VERTEX_DATA, 0 },
    };
    device->CreateInputLayout(ied, 2, vsb->GetBufferPointer(), vsb->GetBufferSize(), &layout);
    rel(vsb);
    rel(psb);
    if (!vs || !ps || !layout) return false;

    // 顺时针：D3D11 默认剔除逆时针三角形，逆时针的全屏四边形一个像素都画不出
    const float quad[] = {
      -1, -1, 0, 1,
      -1,  1, 0, 0,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0,
       1, -1, 1, 1,
    };
    D3D11_BUFFER_DESC vbd{};
    vbd.ByteWidth = sizeof(quad);
    vbd.Usage = D3D11_USAGE_IMMUTABLE;
    vbd.BindFlags = D3D11_BIND_VERTEX_BUFFER;
    D3D11_SUBRESOURCE_DATA vinit{ quad, 0, 0 };
    device->CreateBuffer(&vbd, &vinit, &vb);

    D3D11_BUFFER_DESC cbd{};
    cbd.ByteWidth = (sizeof(CBData) + 15) & ~15;
    cbd.Usage = D3D11_USAGE_DYNAMIC;
    cbd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    cbd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    device->CreateBuffer(&cbd, nullptr, &cb);

    D3D11_SAMPLER_DESC sd{};
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    device->CreateSamplerState(&sd, &samp);
    return vb && cb && samp;
  }

  bool init_targets(int nw, int nh) {
    auto make_rt = [&](ID3D11Texture2D **tex, ID3D11RenderTargetView **rtv, ID3D11ShaderResourceView **srv) -> bool {
      D3D11_TEXTURE2D_DESC td{};
      td.Width = nw; td.Height = nh; td.MipLevels = 1; td.ArraySize = 1;
      td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
      td.SampleDesc.Count = 1;
      td.Usage = D3D11_USAGE_DEFAULT;
      td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
      return SUCCEEDED(device->CreateTexture2D(&td, nullptr, tex)) && *tex
        && SUCCEEDED(device->CreateRenderTargetView(*tex, nullptr, rtv))
        && SUCCEEDED(device->CreateShaderResourceView(*tex, nullptr, srv));
    };
    if (!make_rt(&rtA, &rtvA, &srvA) || !make_rt(&rtB, &rtvB, &srvB)) return false;

    D3D11_TEXTURE2D_DESC ltd{};
    ltd.Width = nw; ltd.Height = nh; ltd.MipLevels = 1; ltd.ArraySize = 1;
    ltd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    ltd.SampleDesc.Count = 1;
    ltd.Usage = D3D11_USAGE_DYNAMIC;
    ltd.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    ltd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    if (FAILED(device->CreateTexture2D(&ltd, nullptr, &layerTex)) || !layerTex) return false;
    if (FAILED(device->CreateShaderResourceView(layerTex, nullptr, &layerSrv))) return false;

    D3D11_TEXTURE2D_DESC stad{};
    stad.Width = nw; stad.Height = nh; stad.MipLevels = 1; stad.ArraySize = 1;
    stad.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    stad.SampleDesc.Count = 1;
    stad.Usage = D3D11_USAGE_STAGING;
    stad.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    if (FAILED(device->CreateTexture2D(&stad, nullptr, &staging)) || !staging) return false;
    w = nw;
    h = nh;
    return true;
  }

  bool ensure(int nw, int nh) {
    if (failed) return false;
    if (!device && !init_device()) {
      release_all();
      failed = true;
      return false;
    }
    if (w == nw && h == nh) return true;
    release_targets();
    if (!init_targets(nw, nh)) {
      release_all();
      failed = true;
      return false;
    }
    return true;
  }

  SourceTex *source_tex(const std::string &key, int tw, int th) {
    SourceTex &t = sources[key];
    if (t.tex && (t.w != tw || t.h != th)) {
      release_source(t);
      t = SourceTex{};
    }
    if (!t.tex) {
      D3D11_TEXTURE2D_DESC td{};
      td.Width = tw; td.Height = th; td.MipLevels = 1; td.ArraySize = 1;
      td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
      td.SampleDesc.Count = 1;
      td.Usage = D3D11_USAGE_DYNAMIC;
      td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
      td.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
      if (FAILED(device->CreateTexture2D(&td, nullptr, &t.tex)) || !t.tex
          || FAILED(device->CreateShaderResourceView(t.tex, nullptr, &t.srv))) {
        release_source(t);
        sources.erase(key);
        return nullptr;
      }
      t.w = tw;
      t.h = th;
    }
    return &t;
  }

  /** 视频纹理这帧没用就放掉；静帧留 5 秒（≈150 帧）以免来回切时重传 */
  void evict_sources() {
    for (auto it = sources.begin(); it != sources.end();) {
      const bool still = it->first.rfind("still:", 0) == 0;
      if (it->second.used + (still ? 150 : 1) < frame_no) {
        release_source(it->second);
        it = sources.erase(it);
      } else {
        ++it;
      }
    }
  }

  bool composite(const std::vector<PreparedLayer> &layers, std::vector<uint8_t> *out) {
    const float clear[4] = { 0, 0, 0, 1 };
    ctx->ClearRenderTargetView(rtvA, clear);
    ctx->ClearRenderTargetView(rtvB, clear);
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

    ++frame_no;
    bool useA = true;
    for (const auto &L : layers) {
      // 预乘透明度上传，采样插值时透明像素不会把黑色混进边缘
      ID3D11ShaderResourceView *layerView = nullptr;
      float fit_origin[2] = { 0, 0 }, fit_inv[2] = { 1.0f / w, 1.0f / h };
      if (L.src) {
        SourceTex *st = source_tex(L.tex_key, L.sw, L.sh);
        if (!st) continue;
        if (!(L.persistent && st->filled)) {
          D3D11_MAPPED_SUBRESOURCE mapped{};
          if (FAILED(ctx->Map(st->tex, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) continue;
          write_premultiplied_rgba(static_cast<uint8_t *>(mapped.pData), mapped.RowPitch, L.src, L.src_alpha, L.sw, L.sh);
          ctx->Unmap(st->tex, 0);
          st->filled = true;
        }
        st->used = frame_no;
        layerView = st->srv;
        fit_origin[0] = static_cast<float>(L.fit_x);
        fit_origin[1] = static_cast<float>(L.fit_y);
        fit_inv[0] = 1.0f / static_cast<float>(L.fit_w);
        fit_inv[1] = 1.0f / static_cast<float>(L.fit_h);
      } else {
        D3D11_MAPPED_SUBRESOURCE mapped{};
        if (FAILED(ctx->Map(layerTex, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) continue;
        write_premultiplied_rgba(static_cast<uint8_t *>(mapped.pData), mapped.RowPitch, L.rgb.data(), L.alpha.empty() ? nullptr : L.alpha.data(), w, h);
        ctx->Unmap(layerTex, 0);
        layerView = layerSrv;
      }

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
      c->fitOrigin[0] = fit_origin[0];
      c->fitOrigin[1] = fit_origin[1];
      c->fitInv[0] = fit_inv[0];
      c->fitInv[1] = fit_inv[1];
      c->pad[0] = c->pad[1] = 0;
      ctx->Unmap(cb, 0);

      ID3D11ShaderResourceView *srvs[2] = { layerView, dstSrv };
      ctx->PSSetShaderResources(0, 2, srvs);
      ctx->Draw(6, 0);
      ID3D11ShaderResourceView *nulls[2] = { nullptr, nullptr };
      ctx->PSSetShaderResources(0, 2, nulls);
      ID3D11RenderTargetView *noRtv = nullptr;
      ctx->OMSetRenderTargets(1, &noRtv, nullptr);
      useA = !useA;
    }

    evict_sources();
    ctx->CopyResource(staging, useA ? rtA : rtB);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(ctx->Map(staging, 0, D3D11_MAP_READ, 0, &mapped))) return false;
    out->resize(static_cast<size_t>(w) * h * 3);
    const auto *src = static_cast<const uint8_t *>(mapped.pData);
    const UINT pitch = mapped.RowPitch;
    for_row_chunks(h, [&](int y0, int y1) {
      for (int y = y0; y < y1; ++y) {
        const auto *row = reinterpret_cast<const uint32_t *>(src + static_cast<size_t>(y) * pitch);
        uint8_t *dst = out->data() + static_cast<size_t>(y) * w * 3;
        for (int x = 0; x < w; ++x, dst += 3) {
          const uint32_t p = row[x];
          dst[0] = static_cast<uint8_t>(p);
          dst[1] = static_cast<uint8_t>(p >> 8);
          dst[2] = static_cast<uint8_t>(p >> 16);
        }
      }
    });
    ctx->Unmap(staging, 0);
    return true;
  }
};

static GpuCompositor g_gpu;

static bool gpu_composite_cached(int w, int h, const std::vector<PreparedLayer> &layers, std::vector<uint8_t> *out) {
  if (layers.empty()) {
    out->assign(static_cast<size_t>(w) * h * 3, 0);
    return true;
  }
  return g_gpu.ensure(w, h) && g_gpu.composite(layers, out);
}

static bool g_compose_used_gpu = false;

static double dust_hash(const std::string &seed, int i) {
  uint32_t h = 2166136261u ^ static_cast<uint32_t>(i);
  for (unsigned char ch : seed) {
    h ^= ch;
    h *= 16777619u;
  }
  h ^= h >> 15;
  h *= 2246822507u;
  h ^= h >> 13;
  h *= 3266489909u;
  h ^= h >> 16;
  return h / 4294967295.0;
}

static void blend_dust_disc(uint8_t *rgb, int w, int h, double cx, double cy, double radius, double alpha) {
  if (alpha <= 0.004 || radius < 0.4) return;
  const int r = static_cast<int>(std::ceil(radius));
  const int x0 = (std::max)(0, static_cast<int>(std::floor(cx)) - r);
  const int y0 = (std::max)(0, static_cast<int>(std::floor(cy)) - r);
  const int x1 = (std::min)(w - 1, static_cast<int>(std::floor(cx)) + r);
  const int y1 = (std::min)(h - 1, static_cast<int>(std::floor(cy)) + r);
  for (int y = y0; y <= y1; ++y) {
    for (int x = x0; x <= x1; ++x) {
      const double d = std::hypot(x + 0.5 - cx, y + 0.5 - cy) / radius;
      if (d >= 1.0) continue;
      const double a = alpha * std::pow(1.0 - d, 1.5);
      uint8_t *p = rgb + (static_cast<size_t>(y) * static_cast<size_t>(w) + x) * 3;
      p[0] = static_cast<uint8_t>(236.0 * a + p[0] * (1.0 - a));
      p[1] = static_cast<uint8_t>(228.0 * a + p[1] * (1.0 - a));
      p[2] = static_cast<uint8_t>(210.0 * a + p[2] * (1.0 - a));
    }
  }
}

/** 盖章入场的粉笔灰，叠在已经合成好的画面上。时间对齐片段内的 effect.start/end。 */
static void paint_stamp_dust(uint8_t *rgb, int w, int h, const EditGraph &g, double time_sec) {
  for (const Clip &c : g.clips) {
    if (c.fx_dust <= 0 || !c.enabled) continue;
    const double local = time_sec - c.start;
    if (local < 0 || local >= c.duration || local < c.fx_dust_start || local > c.fx_dust_end) continue;
    const double span = c.fx_dust_end - c.fx_dust_start;
    if (span < 1e-3) continue;
    const double u = (local - c.fx_dust_start) / span;
    if (u < 0.36 || u >= 0.995) continue;
    const double q = (std::min)(1.0, (u - 0.36) / 0.64);
    double x = 0, y = 0, sx = 1, sy = 1, rot = 0, op = 1;
    clip_transform_at(c, c.start + c.fx_dust_end, &x, &y, &sx, &sy, &rot, &op);
    const double cx = w * 0.5 + x * w * 0.5;
    const double cy = h * 0.5 + y * h * 0.5;
    const double mw = c.media_w > 1.0 ? c.media_w : w;
    const double mh = c.media_h > 1.0 ? c.media_h : h;
    const double fit = (std::min)(w / (std::max)(mw, 1.0), h / (std::max)(mh, 1.0));
    const double crop_w = (std::min)(1.0, (std::max)(0.05, 1.0 - c.crop_l - c.crop_r));
    const double crop_h = (std::min)(1.0, (std::max)(0.05, 1.0 - c.crop_t - c.crop_b));
    const double dw = mw * fit * std::fabs(sx) * crop_w;
    const double dh = mh * fit * std::fabs(sy) * crop_h;
    const double spread = (std::max)(4.0, (std::min)(dw, dh)) * 0.42;
    const int n = static_cast<int>(std::lround(16.0 + 30.0 * c.fx_dust));
    const std::string seed = c.id.empty() ? c.media_path : c.id;
    for (int i = 0; i < n; ++i) {
      const double h1 = dust_hash(seed, i);
      const double h2 = dust_hash(seed, i + 101);
      const double h3 = dust_hash(seed, i + 202);
      const double h4 = dust_hash(seed, i + 303);
      const double life = 0.42 + h1 * 0.58;
      if (q >= life) continue;
      const double age = q / life;
      const double ang = h2 * 6.283185307179586;
      const double speed = spread * (0.35 + h3 * 1.15);
      const double rise = spread * (0.85 + h4 * 1.35);
      const bool puff = h4 > 0.84;
      const double px = cx + std::cos(ang) * speed * age;
      const double py = cy - rise * age + spread * 0.5 * age * age + std::sin(ang) * speed * 0.22 * age;
      const double radius = (std::max)(0.7, spread * (puff ? 0.2 : 0.035 + h1 * 0.04) * (1.0 + age * 0.7));
      const double alpha = c.fx_dust * std::pow(1.0 - age, 1.25) * (puff ? 0.28 : 0.4 + h3 * 0.55);
      blend_dust_disc(rgb, w, h, px, py, radius, alpha);
    }
  }
}

static int compose_graph_rgb(const EditGraph &g, double time_sec, std::vector<uint8_t> *canvas, int *out_w, int *out_h, int *out_layers, ComposeCache *cache) {
  g_compose_used_gpu = false;
  const int w = (std::max)(16, static_cast<int>(std::lround(g.width)) & ~1);
  const int h = (std::max)(16, static_cast<int>(std::lround(g.height)) & ~1);
#define PROF_STAGE(i, ...) do { const int64_t pt0_ = prof_now(); __VA_ARGS__; g_prof.stage[i] += prof_now() - pt0_; } while (0)
  std::vector<LayerRef> visible;
  PROF_STAGE(0, visible = collect_visible_layers(g, time_sec));

  // 取素材要动缓存表，串行做；解码和逐像素处理各层互不相干，并行做
  struct Source { FrameSource *video = nullptr; const uint8_t *still = nullptr, *still_alpha = nullptr; int sw = 0, sh = 0; };
  std::vector<Source> sources(visible.size());
  if (cache) {
    const int64_t o0 = prof_now();
    struct AddOpen { int64_t t; ~AddOpen() { g_prof.open += prof_now() - t; } } add_open{o0};
    for (size_t i = 0; i < visible.size(); ++i) {
      const Clip &c = *visible[i].clip;
      if (c.kind == "text" || !c.text_content.empty() || c.kind == "solid") continue;
      if (is_still_image(c.kind, c.media_path)) PROF_STAGE(3, sources[i].still = cache->still(c.media_path, &sources[i].sw, &sources[i].sh, &sources[i].still_alpha));
      else sources[i].video = cache->source(c);
    }
  }

  std::vector<PreparedLayer> slots(visible.size());
  std::vector<char> filled(visible.size(), 0);
  const bool gpu_ready = cache && g_gpu.ensure(w, h);
  const int64_t par0 = prof_now();
  parallel_for(visible.size(), [&](size_t li) {
    const int64_t lt0 = prof_now();
    const Clip &c = *visible[li].clip;
    PreparedLayer &pl = slots[li];
    auto finish = [&](double x, double y, double sx, double sy, double rot, double op) {
      pl.x = static_cast<float>(x);
      pl.y = static_cast<float>(y);
      pl.sx = static_cast<float>(sx);
      pl.sy = static_cast<float>(sy);
      pl.rot = static_cast<float>(rot);
      pl.op = static_cast<float>((std::max)(0.0, (std::min)(1.0, op)));
      pl.blend = blend_code(c.blend);
      filled[li] = 1;
      g_prof.layer += prof_now() - lt0;
    };
    const bool is_text = (c.kind == "text") || !c.text_content.empty();

    // 快速路径：素材原样交给 GPU，不在 CPU 上铺整幅画布
    if (gpu_ready && !is_text && c.kind != "solid" && !media_needs_cpu(c, time_sec)) {
      const Source &s = sources[li];
      const uint8_t *src = nullptr, *src_alpha = nullptr;
      int rw = 0, rh = 0;
      if (s.still) {
        src = s.still; src_alpha = s.still_alpha; rw = s.sw; rh = s.sh;
        pl.tex_key = "still:" + c.media_path;
        pl.persistent = true;
      } else if (s.video) {
        const int64_t d0 = prof_now();
        src = s.video->at(clip_media_time(c, time_sec), &rw, &rh, &src_alpha);
        g_prof.decode += prof_now() - d0;
        pl.tex_key = "video:" + (c.id.empty() ? c.media_path + "@" + std::to_string(c.start) : c.id);
      }
      if (!src || rw <= 0 || rh <= 0) return;
      pl.src = src;
      pl.src_alpha = src_alpha;
      pl.sw = rw;
      pl.sh = rh;
      letterbox_rect(w, h, rw, rh, &pl.fit_x, &pl.fit_y, &pl.fit_w, &pl.fit_h);
      double x, y, sx, sy, rot, op;
      clip_transform_at(c, time_sec, &x, &y, &sx, &sy, &rot, &op);
      apply_transition(nullptr, w, h, c, time_sec, &x, &op);
      finish(x, y, sx, sy, rot, op);
      return;
    }

    std::vector<uint8_t> layer, layer_alpha;
    PROF_STAGE(1, layer.assign(static_cast<size_t>(w) * h * 3, 0));
    if (is_text) {
      PROF_STAGE(2, paint_text_layer(layer.data(), w, h, c));
    } else if (c.kind == "solid") {
      int r = 0, gr = 0, b = 0;
      hex_rgb(c.solid_color, &r, &gr, &b);
      // 合成把纯黑 (0,0,0) 当透明，纯黑底抬到 1 才会盖住下层
      if (r == 0 && gr == 0 && b == 0) r = gr = b = 1;
      for (size_t p = 0; p < layer.size(); p += 3) {
        layer[p] = static_cast<uint8_t>(r);
        layer[p + 1] = static_cast<uint8_t>(gr);
        layer[p + 2] = static_cast<uint8_t>(b);
      }
      apply_clip_look(layer.data(), w * h, w, h, c);
    } else {
      const bool still = is_still_image(c.kind, c.media_path);
      const double media_t = still ? 0.0 : clip_media_time(c, time_sec);
      int rw = 0, rh = 0;
      const uint8_t *src = nullptr, *src_alpha = nullptr;
      std::vector<uint8_t> rgb;
      if (cache) {
        const Source &s = sources[li];
        if (s.still) { src = s.still; src_alpha = s.still_alpha; rw = s.sw; rh = s.sh; }
        else if (s.video) {
          const int64_t d0 = prof_now();
          src = s.video->at(media_t, &rw, &rh, &src_alpha);
          g_prof.decode += prof_now() - d0;
        }
      } else {
        const std::wstring path_w = utf8_to_wide(c.media_path);
        TodoProbeInfo info{};
        if (todo_probe(path_w.c_str(), 8000, &info) != TODO_OK || !info.has_video || info.width <= 0) return;
        const int need = info.width * info.height * 3;
        rgb.resize(static_cast<size_t>(need));
        if (todo_decode_rgb24(path_w.c_str(), media_t, 12000, rgb.data(), need, &rw, &rh) == TODO_OK) src = rgb.data();
      }
      if (!src) return;
      if (src_alpha) layer_alpha.assign(static_cast<size_t>(w) * h, 0);
      PROF_STAGE(4, letterbox_onto(layer.data(), w, h, src, rw, rh, src_alpha, src_alpha ? layer_alpha.data() : nullptr));
      PROF_STAGE(5, apply_clip_look(layer.data(), w * h, w, h, c));
      PROF_STAGE(6, apply_chroma(layer.data(), w * h, c));
    }
    PROF_STAGE(7, apply_crop(layer.data(), w, h, c));
    PROF_STAGE(8, apply_mask(layer.data(), layer_alpha.empty() ? nullptr : layer_alpha.data(), w, h, c));

    double x, y, sx, sy, rot, op;
    PROF_STAGE(9, clip_transform_at(c, time_sec, &x, &y, &sx, &sy, &rot, &op); apply_transition(layer.data(), w, h, c, time_sec, &x, &op));

    pl.rgb = std::move(layer);
    pl.alpha = std::move(layer_alpha);
    finish(x, y, sx, sy, rot, op);
  });
  g_prof.parallel += prof_now() - par0;
  std::vector<PreparedLayer> prepared;
  prepared.reserve(slots.size());
  for (size_t i = 0; i < slots.size(); ++i) if (filled[i]) prepared.push_back(std::move(slots[i]));

  const int64_t gpu0 = prof_now();
  const bool on_gpu = gpu_composite_cached(w, h, prepared, canvas);
  g_prof.gpu += prof_now() - gpu0;
  if (on_gpu) {
    g_compose_used_gpu = true;
  } else {
    canvas->assign(static_cast<size_t>(w) * h * 3, 0);
    for (auto &pl : prepared) {
      if (pl.src && pl.rgb.empty()) {
        pl.rgb.assign(static_cast<size_t>(w) * h * 3, 0);
        letterbox_onto(pl.rgb.data(), w, h, pl.src, pl.sw, pl.sh);
      }
      blit_layer_transformed(
        canvas->data(), w, h, pl.rgb.data(),
        pl.x, pl.y, pl.sx, pl.sy, pl.rot, pl.op,
        pl.blend == 1 ? "multiply" : pl.blend == 2 ? "screen" : pl.blend == 3 ? "add" : "normal");
    }
  }

  if (canvas && !canvas->empty()) paint_stamp_dust(canvas->data(), w, h, g, time_sec);

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
  ComposeCache cache;
  compose_graph_rgb(g, time_sec, &canvas, &w, &h, &layers, &cache);
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

