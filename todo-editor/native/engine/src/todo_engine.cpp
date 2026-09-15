/* C++ media core: probe + exact RGB24 + sequential player via libav*. */
#include "todo_engine.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <new>
#include <string>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mmsystem.h>
#endif

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/imgutils.h>
#include <libavutil/mem.h>
#include <libavutil/opt.h>
#include <libavutil/time.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

namespace {

struct Input {
  FILE *file = nullptr;
  int64_t deadline = 0;
};

int interrupted(void *opaque) {
  return av_gettime_relative() >= static_cast<Input *>(opaque)->deadline;
}

int read_packet(void *opaque, uint8_t *buf, int size) {
  auto *in = static_cast<Input *>(opaque);
  if (interrupted(in)) return AVERROR_EXIT;
  const size_t n = fread(buf, 1, static_cast<size_t>(size), in->file);
  if (n) return static_cast<int>(n);
  return ferror(in->file) ? AVERROR(EIO) : AVERROR_EOF;
}

int64_t seek_file(void *opaque, int64_t offset, int whence) {
  auto *in = static_cast<Input *>(opaque);
  if (interrupted(in)) return AVERROR_EXIT;
#ifdef _WIN32
  auto seek64 = _fseeki64;
  auto tell64 = _ftelli64;
#else
  auto seek64 = fseeko;
  auto tell64 = ftello;
#endif
  if (whence == AVSEEK_SIZE) {
    const int64_t current = tell64(in->file);
    if (current < 0 || seek64(in->file, 0, SEEK_END)) return AVERROR(EIO);
    const int64_t size = tell64(in->file);
    if (seek64(in->file, current, SEEK_SET)) return AVERROR(EIO);
    return size;
  }
  if (seek64(in->file, offset, whence & ~AVSEEK_FORCE)) return AVERROR(EIO);
  return tell64(in->file);
}

TodoStatus map_error(int ret, bool timed_out) {
  if (timed_out || ret == AVERROR_EXIT) return TODO_ERR_TIMEOUT;
  if (ret == AVERROR(ENOENT) || ret == AVERROR(EIO)) return TODO_ERR_IO;
  if (ret == AVERROR_INVALIDDATA) return TODO_ERR_PROBE;
  return TODO_ERR_PROBE;
}

struct Opened {
  Input in{};
  AVFormatContext *format = nullptr;
  AVIOContext *io = nullptr;
  unsigned char *io_buffer = nullptr;

  ~Opened() {
    if (format) avformat_close_input(&format);
    if (io) {
      av_freep(&io->buffer);
      avio_context_free(&io);
    } else if (io_buffer) {
      av_free(io_buffer);
    }
    if (in.file) fclose(in.file);
  }
};

TodoStatus open_input(const wchar_t *path, int timeout_ms, Opened *o) {
  if (!path || !o) return TODO_ERR_ARGS;
  if (timeout_ms < 100 || timeout_ms > 30000) return TODO_ERR_ARGS;
  o->in.deadline = av_gettime_relative() + static_cast<int64_t>(timeout_ms) * 1000;
#ifdef _WIN32
  o->in.file = _wfopen(path, L"rb");
#else
  char narrow[4096];
  std::wcstombs(narrow, path, sizeof(narrow) - 1);
  o->in.file = fopen(narrow, "rb");
#endif
  if (!o->in.file) return TODO_ERR_OPEN;

  av_log_set_level(AV_LOG_ERROR);
  o->io_buffer = static_cast<unsigned char *>(av_malloc(32768));
  o->io = o->io_buffer
    ? avio_alloc_context(o->io_buffer, 32768, 0, &o->in, read_packet, nullptr, seek_file)
    : nullptr;
  o->format = avformat_alloc_context();
  if (!o->io || !o->format) return TODO_ERR_IO;
  o->io_buffer = nullptr; // owned by io
  o->format->pb = o->io;
  o->format->flags |= AVFMT_FLAG_CUSTOM_IO;
  o->format->interrupt_callback = AVIOInterruptCB{interrupted, &o->in};

  AVDictionary *opts = nullptr;
  av_dict_set(&opts, "protocol_whitelist", "", 0);
  av_dict_set(&opts, "probesize", "8388608", 0);
  av_dict_set(&opts, "analyzeduration", "5000000", 0);
  int ret = avformat_open_input(&o->format, nullptr, nullptr, &opts);
  av_dict_free(&opts);
  if (ret >= 0) ret = avformat_find_stream_info(o->format, nullptr);
  if (ret < 0 || interrupted(&o->in)) return map_error(ret, interrupted(&o->in));
  return TODO_OK;
}

int find_stream(AVFormatContext *format, AVMediaType type) {
  for (unsigned i = 0; i < format->nb_streams; ++i) {
    AVStream *s = format->streams[i];
    if (s->codecpar->codec_type != type) continue;
    if (type == AVMEDIA_TYPE_VIDEO && (s->disposition & AV_DISPOSITION_ATTACHED_PIC)) continue;
    return static_cast<int>(i);
  }
  return -1;
}

} // namespace

TodoStatus todo_probe(const wchar_t *path, int timeout_ms, TodoProbeInfo *out) {
  if (!out) return TODO_ERR_ARGS;
  std::memset(out, 0, sizeof(*out));
  Opened o;
  const TodoStatus st = open_input(path, timeout_ms, &o);
  if (st != TODO_OK) return st;

  double duration = o.format->duration != AV_NOPTS_VALUE
    ? static_cast<double>(o.format->duration) / AV_TIME_BASE
    : 0.0;
  const int video = find_stream(o.format, AVMEDIA_TYPE_VIDEO);
  const int audio = find_stream(o.format, AVMEDIA_TYPE_AUDIO);
  for (unsigned i = 0; i < o.format->nb_streams; ++i) {
    AVStream *s = o.format->streams[i];
    if (s->duration == AV_NOPTS_VALUE) continue;
    const double d = s->duration * av_q2d(s->time_base);
    if (std::isfinite(d) && d > duration) duration = d;
  }
  if (video < 0 && audio < 0) return TODO_ERR_NO_STREAM;
  if (!std::isfinite(duration) || duration < 0) duration = 0;

  out->duration = duration;
  out->has_video = video >= 0;
  out->has_audio = audio >= 0;
  std::snprintf(out->format, sizeof(out->format), "%s", o.format->iformat->name ? o.format->iformat->name : "");
  if (video >= 0) {
    AVStream *s = o.format->streams[video];
    out->width = s->codecpar->width;
    out->height = s->codecpar->height;
    const AVRational fps = av_guess_frame_rate(o.format, s, nullptr);
    const double rate = av_q2d(fps);
    out->frame_rate = std::isfinite(rate) ? rate : 0.0;
  }
  return TODO_OK;
}

TodoStatus todo_decode_rgb24(
  const wchar_t *path,
  double time_sec,
  int timeout_ms,
  unsigned char *rgb,
  int rgb_capacity,
  int *out_w,
  int *out_h) {
  if (!rgb || !out_w || !out_h || time_sec < 0) return TODO_ERR_ARGS;
  *out_w = 0;
  *out_h = 0;

  Opened o;
  TodoStatus st = open_input(path, timeout_ms, &o);
  if (st != TODO_OK) return st;

  const int video = find_stream(o.format, AVMEDIA_TYPE_VIDEO);
  if (video < 0) return TODO_ERR_NO_STREAM;
  AVStream *stream = o.format->streams[video];
  const AVCodec *codec = avcodec_find_decoder(stream->codecpar->codec_id);
  if (!codec) return TODO_ERR_UNSUPPORTED;

  AVCodecContext *dec = avcodec_alloc_context3(codec);
  if (!dec) return TODO_ERR_IO;
  if (avcodec_parameters_to_context(dec, stream->codecpar) < 0 || avcodec_open2(dec, codec, nullptr) < 0) {
    avcodec_free_context(&dec);
    return TODO_ERR_DECODE;
  }

  const int w = stream->codecpar->width;
  const int h = stream->codecpar->height;
  if (w <= 0 || h <= 0 || rgb_capacity < w * h * 3) {
    avcodec_free_context(&dec);
    return TODO_ERR_ARGS;
  }

  const int64_t ts = static_cast<int64_t>(time_sec / av_q2d(stream->time_base));
  if (av_seek_frame(o.format, video, ts, AVSEEK_FLAG_BACKWARD) < 0) {
    avcodec_free_context(&dec);
    return TODO_ERR_DECODE;
  }
  avcodec_flush_buffers(dec);

  AVPacket *pkt = av_packet_alloc();
  AVFrame *frame = av_frame_alloc();
  AVFrame *rgb_frame = av_frame_alloc();
  SwsContext *sws = nullptr;
  TodoStatus result = TODO_ERR_DECODE;

  if (!pkt || !frame || !rgb_frame) {
    result = TODO_ERR_IO;
    goto done;
  }

  sws = sws_getContext(w, h, dec->pix_fmt, w, h, AV_PIX_FMT_RGB24, SWS_BILINEAR, nullptr, nullptr, nullptr);
  if (!sws) {
    result = TODO_ERR_UNSUPPORTED;
    goto done;
  }
  if (av_image_fill_arrays(rgb_frame->data, rgb_frame->linesize, rgb, AV_PIX_FMT_RGB24, w, h, 1) < 0) {
    result = TODO_ERR_IO;
    goto done;
  }

  while (!interrupted(&o.in) && av_read_frame(o.format, pkt) >= 0) {
    if (pkt->stream_index != video) {
      av_packet_unref(pkt);
      continue;
    }
    if (avcodec_send_packet(dec, pkt) < 0) {
      av_packet_unref(pkt);
      continue;
    }
    av_packet_unref(pkt);
    while (avcodec_receive_frame(dec, frame) >= 0) {
      const double pts = frame->best_effort_timestamp != AV_NOPTS_VALUE
        ? frame->best_effort_timestamp * av_q2d(stream->time_base)
        : time_sec;
      if (pts + 1e-3 < time_sec) continue;
      sws_scale(sws, frame->data, frame->linesize, 0, h, rgb_frame->data, rgb_frame->linesize);
      *out_w = w;
      *out_h = h;
      result = TODO_OK;
      goto done;
    }
  }
  if (interrupted(&o.in)) result = TODO_ERR_TIMEOUT;

done:
  if (sws) sws_freeContext(sws);
  av_frame_free(&rgb_frame);
  av_frame_free(&frame);
  av_packet_free(&pkt);
  avcodec_free_context(&dec);
  return result;
}

struct TodoPlayer {
  Input in{};
  AVFormatContext *format = nullptr;
  AVIOContext *io = nullptr;
  unsigned char *io_buffer = nullptr;
  AVCodecContext *dec = nullptr;
  AVCodecContext *audio_dec = nullptr;
  SwsContext *sws = nullptr;
  SwrContext *swr = nullptr;
  AVPacket *pkt = nullptr;
  AVFrame *frame = nullptr;
  AVFrame *audio_frame = nullptr;
  int video_index = -1;
  int audio_index = -1;
  int width = 0;
  int height = 0;
  double frame_rate = 0;
  double duration = 0;
  int timeout_ms = 10000;
  bool draining = false;
  bool eof = false;
  AVPixelFormat sws_src = AV_PIX_FMT_NONE;
  double audio_clock_sec = 0;
  bool audio_clock_valid = false;
  double audio_seek_base = 0;
  int out_rate = 48000;
  int out_channels = 2;
#ifdef _WIN32
  HWAVEOUT wave = nullptr;
  static const int kWaveBufs = 4;
  WAVEHDR wave_hdr[4]{};
  std::vector<char> wave_data[4];
  int wave_next = 0;
#endif
};

static void player_bump_deadline(TodoPlayer *p) {
  p->in.deadline = av_gettime_relative() + static_cast<int64_t>(p->timeout_ms) * 1000;
}

#ifdef _WIN32
static void player_wave_close(TodoPlayer *p) {
  if (!p->wave) return;
  waveOutReset(p->wave);
  for (int i = 0; i < TodoPlayer::kWaveBufs; ++i) {
    if (p->wave_hdr[i].dwFlags & WHDR_PREPARED) {
      waveOutUnprepareHeader(p->wave, &p->wave_hdr[i], sizeof(WAVEHDR));
    }
    p->wave_hdr[i] = {};
    p->wave_data[i].clear();
  }
  waveOutClose(p->wave);
  p->wave = nullptr;
  p->wave_next = 0;
}

static bool player_wave_open(TodoPlayer *p) {
  player_wave_close(p);
  WAVEFORMATEX fmt{};
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = static_cast<WORD>(p->out_channels);
  fmt.nSamplesPerSec = static_cast<DWORD>(p->out_rate);
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = static_cast<WORD>(fmt.nChannels * fmt.wBitsPerSample / 8);
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
  if (waveOutOpen(&p->wave, WAVE_MAPPER, &fmt, 0, 0, CALLBACK_NULL) != MMSYSERR_NOERROR) {
    p->wave = nullptr;
    return false;
  }
  const size_t bytes = static_cast<size_t>(p->out_rate / 20) * fmt.nBlockAlign; /* ~50ms */
  for (int i = 0; i < TodoPlayer::kWaveBufs; ++i) {
    p->wave_data[i].assign(bytes, 0);
    p->wave_hdr[i].lpData = p->wave_data[i].data();
    p->wave_hdr[i].dwBufferLength = static_cast<DWORD>(bytes);
    if (waveOutPrepareHeader(p->wave, &p->wave_hdr[i], sizeof(WAVEHDR)) != MMSYSERR_NOERROR) {
      player_wave_close(p);
      return false;
    }
  }
  return true;
}

static void player_wave_write(TodoPlayer *p, const uint8_t *pcm, int bytes) {
  if (!p->wave || bytes <= 0) return;
  int left = bytes;
  const uint8_t *src = pcm;
  while (left > 0) {
    WAVEHDR *hdr = &p->wave_hdr[p->wave_next];
    /* Wait briefly for a free buffer instead of dropping audio. */
    for (int spin = 0; spin < 200 && (hdr->dwFlags & WHDR_INQUEUE); ++spin) {
      Sleep(1);
    }
    if (hdr->dwFlags & WHDR_INQUEUE) return;
    const int n = (std::min)(left, static_cast<int>(hdr->dwBufferLength));
    std::memcpy(hdr->lpData, src, static_cast<size_t>(n));
    if (n < static_cast<int>(hdr->dwBufferLength)) {
      std::memset(hdr->lpData + n, 0, static_cast<size_t>(hdr->dwBufferLength - n));
    }
    hdr->dwBufferLength = static_cast<DWORD>(n);
    waveOutWrite(p->wave, hdr, sizeof(WAVEHDR));
    hdr->dwBufferLength = static_cast<DWORD>(p->wave_data[p->wave_next].size());
    p->wave_next = (p->wave_next + 1) % TodoPlayer::kWaveBufs;
    src += n;
    left -= n;
  }
}

static double player_wave_clock(const TodoPlayer *p) {
  if (!p->wave) return p->audio_clock_sec;
  MMTIME mt{};
  mt.wType = TIME_SAMPLES;
  if (waveOutGetPosition(p->wave, &mt, sizeof(mt)) != MMSYSERR_NOERROR) return p->audio_clock_sec;
  if (mt.wType != TIME_SAMPLES) return p->audio_clock_sec;
  return p->audio_seek_base + static_cast<double>(mt.u.sample) / static_cast<double>(p->out_rate);
}
#else
static void player_wave_close(TodoPlayer *) {}
static bool player_wave_open(TodoPlayer *) { return false; }
static void player_wave_write(TodoPlayer *, const uint8_t *, int) {}
static double player_wave_clock(const TodoPlayer *p) { return p->audio_clock_sec; }
#endif

static void player_audio_flush(TodoPlayer *p) {
#ifdef _WIN32
  if (p->wave) waveOutReset(p->wave);
#endif
  if (p->audio_dec) avcodec_flush_buffers(p->audio_dec);
}

static bool player_setup_audio(TodoPlayer *p) {
  if (p->audio_index < 0) return false;
  AVStream *as = p->format->streams[p->audio_index];
  const AVCodec *acodec = avcodec_find_decoder(as->codecpar->codec_id);
  if (!acodec) return false;
  p->audio_dec = avcodec_alloc_context3(acodec);
  if (!p->audio_dec || avcodec_parameters_to_context(p->audio_dec, as->codecpar) < 0
      || avcodec_open2(p->audio_dec, acodec, nullptr) < 0) {
    avcodec_free_context(&p->audio_dec);
    return false;
  }
  p->audio_frame = av_frame_alloc();
  if (!p->audio_frame) {
    avcodec_free_context(&p->audio_dec);
    return false;
  }
  AVChannelLayout out_ch{};
  av_channel_layout_default(&out_ch, p->out_channels);
  if (swr_alloc_set_opts2(
        &p->swr, &out_ch, AV_SAMPLE_FMT_S16, p->out_rate,
        &p->audio_dec->ch_layout, p->audio_dec->sample_fmt, p->audio_dec->sample_rate,
        0, nullptr) < 0 || swr_init(p->swr) < 0) {
    swr_free(&p->swr);
    av_frame_free(&p->audio_frame);
    avcodec_free_context(&p->audio_dec);
    av_channel_layout_uninit(&out_ch);
    return false;
  }
  av_channel_layout_uninit(&out_ch);
  if (!player_wave_open(p)) {
    /* Decode still works for clock via sample count even without waveOut. */
  }
  return true;
}

static void player_feed_audio_frame(TodoPlayer *p, AVFrame *fr) {
  if (!p->swr || !fr) return;
  const int max_out = swr_get_out_samples(p->swr, fr->nb_samples) + 32;
  if (max_out <= 0) return;
  std::vector<uint8_t> buf(static_cast<size_t>(max_out) * p->out_channels * 2);
  uint8_t *out_planes[1] = { buf.data() };
  const int got = swr_convert(p->swr, out_planes, max_out,
                              const_cast<const uint8_t **>(fr->extended_data), fr->nb_samples);
  if (got <= 0) return;
  const int bytes = got * p->out_channels * 2;
  player_wave_write(p, buf.data(), bytes);

  AVStream *as = p->format->streams[p->audio_index];
  double pts = p->audio_clock_sec;
  if (fr->best_effort_timestamp != AV_NOPTS_VALUE) {
    pts = fr->best_effort_timestamp * av_q2d(as->time_base);
  } else if (fr->pts != AV_NOPTS_VALUE) {
    pts = fr->pts * av_q2d(as->time_base);
  }
  p->audio_clock_sec = pts + static_cast<double>(got) / static_cast<double>(p->out_rate);
  p->audio_clock_valid = true;
}

static void player_handle_audio_packet(TodoPlayer *p, AVPacket *pkt) {
  if (!p->audio_dec) {
    AVStream *as = p->format->streams[p->audio_index];
    const int64_t ats = pkt->pts != AV_NOPTS_VALUE ? pkt->pts : pkt->dts;
    if (ats != AV_NOPTS_VALUE) {
      p->audio_clock_sec = ats * av_q2d(as->time_base);
      p->audio_clock_valid = true;
    }
    return;
  }
  if (avcodec_send_packet(p->audio_dec, pkt) < 0) return;
  for (;;) {
    const int r = avcodec_receive_frame(p->audio_dec, p->audio_frame);
    if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) break;
    if (r < 0) break;
    player_feed_audio_frame(p, p->audio_frame);
  }
}

/* Demux/decode/play some audio without returning a video frame. */
static void player_pump_audio(TodoPlayer *p, int max_packets) {
  if (!p || p->audio_index < 0 || max_packets <= 0) return;
  player_bump_deadline(p);
  for (int n = 0; n < max_packets; ++n) {
    if (interrupted(&p->in)) break;
    /* Prefer draining decoder first. */
    if (p->audio_dec) {
      const int r = avcodec_receive_frame(p->audio_dec, p->audio_frame);
      if (r >= 0) {
        player_feed_audio_frame(p, p->audio_frame);
        continue;
      }
    }
    AVPacket *pkt = av_packet_alloc();
    if (!pkt) break;
    const int rr = av_read_frame(p->format, pkt);
    if (rr < 0) {
      av_packet_free(&pkt);
      break;
    }
    if (pkt->stream_index == p->audio_index) {
      player_handle_audio_packet(p, pkt);
    } else if (pkt->stream_index == p->video_index) {
      /* Keep video packets for later READ — re-queue by sending to video decoder buffer.
       * ponytail: drop interleaving perfection; push into video decoder. */
      if (p->dec) avcodec_send_packet(p->dec, pkt);
    }
    av_packet_unref(pkt);
    av_packet_free(&pkt);
  }
}

static void player_free(TodoPlayer *p) {
  if (!p) return;
  player_wave_close(p);
  if (p->swr) swr_free(&p->swr);
  if (p->sws) sws_freeContext(p->sws);
  av_frame_free(&p->audio_frame);
  av_frame_free(&p->frame);
  av_packet_free(&p->pkt);
  avcodec_free_context(&p->audio_dec);
  avcodec_free_context(&p->dec);
  if (p->format) avformat_close_input(&p->format);
  if (p->io) {
    av_freep(&p->io->buffer);
    avio_context_free(&p->io);
  } else if (p->io_buffer) {
    av_free(p->io_buffer);
  }
  if (p->in.file) fclose(p->in.file);
  delete p;
}

TodoStatus todo_player_open(const wchar_t *path, int timeout_ms, TodoPlayer **out) {
  if (!out) return TODO_ERR_ARGS;
  *out = nullptr;
  if (!path || timeout_ms < 100 || timeout_ms > 30000) return TODO_ERR_ARGS;

  auto *p = new (std::nothrow) TodoPlayer();
  if (!p) return TODO_ERR_IO;
  p->timeout_ms = timeout_ms;

  Opened o;
  TodoStatus st = open_input(path, timeout_ms, &o);
  if (st != TODO_OK) {
    delete p;
    return st;
  }

  // Take ownership of Opened resources into player.
  p->in = o.in;
  p->format = o.format;
  p->io = o.io;
  p->io_buffer = o.io_buffer;
  o.in.file = nullptr;
  o.format = nullptr;
  o.io = nullptr;
  o.io_buffer = nullptr;
  if (p->format && p->format->interrupt_callback.opaque == &o.in) {
    p->format->interrupt_callback.opaque = &p->in;
  }
  if (p->io) p->io->opaque = &p->in;

  double duration = p->format->duration != AV_NOPTS_VALUE
    ? static_cast<double>(p->format->duration) / AV_TIME_BASE
    : 0.0;
  for (unsigned i = 0; i < p->format->nb_streams; ++i) {
    AVStream *s = p->format->streams[i];
    if (s->duration == AV_NOPTS_VALUE) continue;
    const double d = s->duration * av_q2d(s->time_base);
    if (std::isfinite(d) && d > duration) duration = d;
  }
  if (!std::isfinite(duration) || duration < 0) duration = 0;
  p->duration = duration;

  p->video_index = find_stream(p->format, AVMEDIA_TYPE_VIDEO);
  p->audio_index = find_stream(p->format, AVMEDIA_TYPE_AUDIO);
  if (p->video_index < 0) {
    player_free(p);
    return TODO_ERR_NO_STREAM;
  }

  AVStream *stream = p->format->streams[p->video_index];
  p->width = stream->codecpar->width;
  p->height = stream->codecpar->height;
  const AVRational fps = av_guess_frame_rate(p->format, stream, nullptr);
  const double rate = av_q2d(fps);
  p->frame_rate = std::isfinite(rate) ? rate : 0.0;

  const AVCodec *codec = avcodec_find_decoder(stream->codecpar->codec_id);
  if (!codec) {
    player_free(p);
    return TODO_ERR_UNSUPPORTED;
  }
  p->dec = avcodec_alloc_context3(codec);
  if (!p->dec || avcodec_parameters_to_context(p->dec, stream->codecpar) < 0
      || avcodec_open2(p->dec, codec, nullptr) < 0) {
    player_free(p);
    return TODO_ERR_DECODE;
  }
  if (p->width <= 0 || p->height <= 0) {
    player_free(p);
    return TODO_ERR_UNSUPPORTED;
  }

  p->pkt = av_packet_alloc();
  p->frame = av_frame_alloc();
  if (!p->pkt || !p->frame) {
    player_free(p);
    return TODO_ERR_IO;
  }

  player_setup_audio(p); /* optional; video-only still ok */

  player_bump_deadline(p);
  *out = p;
  return TODO_OK;
}

void todo_player_close(TodoPlayer *p) {
  player_free(p);
}

TodoStatus todo_player_info(const TodoPlayer *p, TodoPlayerInfo *out) {
  if (!p || !out) return TODO_ERR_ARGS;
  std::memset(out, 0, sizeof(*out));
  out->duration = p->duration;
  out->width = p->width;
  out->height = p->height;
  out->frame_rate = p->frame_rate;
  out->has_video = p->video_index >= 0;
  out->has_audio = p->audio_index >= 0;
  return TODO_OK;
}

static TodoStatus player_ensure_sws(TodoPlayer *p, AVPixelFormat src) {
  if (src == AV_PIX_FMT_NONE) return TODO_ERR_UNSUPPORTED;
  if (p->sws && p->sws_src == src) return TODO_OK;
  if (p->sws) {
    sws_freeContext(p->sws);
    p->sws = nullptr;
  }
  p->sws = sws_getContext(
    p->width, p->height, src,
    p->width, p->height, AV_PIX_FMT_RGB24,
    SWS_BILINEAR, nullptr, nullptr, nullptr);
  if (!p->sws) return TODO_ERR_UNSUPPORTED;
  p->sws_src = src;
  return TODO_OK;
}

static TodoStatus player_emit_frame(
  TodoPlayer *p,
  unsigned char *rgb,
  int rgb_capacity,
  int *out_w,
  int *out_h,
  double *out_pts) {
  if (rgb_capacity < p->width * p->height * 3) return TODO_ERR_ARGS;
  const AVPixelFormat src = static_cast<AVPixelFormat>(p->frame->format);
  TodoStatus st = player_ensure_sws(p, src);
  if (st != TODO_OK) return st;

  AVFrame rgb_frame{};
  if (av_image_fill_arrays(rgb_frame.data, rgb_frame.linesize, rgb, AV_PIX_FMT_RGB24, p->width, p->height, 1) < 0) {
    return TODO_ERR_IO;
  }
  sws_scale(p->sws, p->frame->data, p->frame->linesize, 0, p->height, rgb_frame.data, rgb_frame.linesize);

  AVStream *stream = p->format->streams[p->video_index];
  double pts = 0.0;
  if (p->frame->best_effort_timestamp != AV_NOPTS_VALUE) {
    pts = p->frame->best_effort_timestamp * av_q2d(stream->time_base);
  } else if (p->frame->pts != AV_NOPTS_VALUE) {
    pts = p->frame->pts * av_q2d(stream->time_base);
  }
  *out_w = p->width;
  *out_h = p->height;
  if (out_pts) *out_pts = pts;
  return TODO_OK;
}

TodoStatus todo_player_read(
  TodoPlayer *p,
  unsigned char *rgb,
  int rgb_capacity,
  int *out_w,
  int *out_h,
  double *out_pts) {
  if (!p || !rgb || !out_w || !out_h) return TODO_ERR_ARGS;
  *out_w = 0;
  *out_h = 0;
  if (out_pts) *out_pts = 0;
  if (p->eof) return TODO_ERR_EOF;

  player_bump_deadline(p);

  for (;;) {
    if (interrupted(&p->in)) return TODO_ERR_TIMEOUT;

    // Prefer frames already pending in the decoder.
    const int recv = avcodec_receive_frame(p->dec, p->frame);
    if (recv >= 0) {
      return player_emit_frame(p, rgb, rgb_capacity, out_w, out_h, out_pts);
    }
    if (recv != AVERROR(EAGAIN)) {
      if (recv == AVERROR_EOF || p->draining) {
        p->eof = true;
        return TODO_ERR_EOF;
      }
      return TODO_ERR_DECODE;
    }

    if (p->draining) {
      p->eof = true;
      return TODO_ERR_EOF;
    }

    const int rr = av_read_frame(p->format, p->pkt);
    if (rr < 0) {
      if (rr == AVERROR_EOF || interrupted(&p->in)) {
        if (interrupted(&p->in)) return TODO_ERR_TIMEOUT;
        // Drain decoder once at demux EOF.
        p->draining = true;
        avcodec_send_packet(p->dec, nullptr);
        continue;
      }
      return TODO_ERR_DECODE;
    }

    if (p->pkt->stream_index != p->video_index) {
      if (p->pkt->stream_index == p->audio_index && p->audio_index >= 0) {
        player_handle_audio_packet(p, p->pkt);
      }
      av_packet_unref(p->pkt);
      continue;
    }
    const int send = avcodec_send_packet(p->dec, p->pkt);
    av_packet_unref(p->pkt);
    if (send < 0 && send != AVERROR(EAGAIN)) return TODO_ERR_DECODE;
  }
}

TodoStatus todo_player_seek(TodoPlayer *p, double time_sec) {
  if (!p || time_sec < 0) return TODO_ERR_ARGS;
  player_bump_deadline(p);
  AVStream *stream = p->format->streams[p->video_index];
  const int64_t ts = static_cast<int64_t>(time_sec / av_q2d(stream->time_base));
  if (av_seek_frame(p->format, p->video_index, ts, AVSEEK_FLAG_BACKWARD) < 0) {
    return TODO_ERR_DECODE;
  }
  avcodec_flush_buffers(p->dec);
  player_audio_flush(p);
  p->draining = false;
  p->eof = false;
  p->audio_seek_base = time_sec;
  p->audio_clock_sec = time_sec;
  p->audio_clock_valid = p->audio_index >= 0;
  return TODO_OK;
}

TodoStatus todo_player_audio_clock(TodoPlayer *p, double *out_sec) {
  if (!p || !out_sec) return TODO_ERR_ARGS;
  *out_sec = 0;
  if (p->audio_index < 0) return TODO_ERR_NO_STREAM;
  player_pump_audio(p, 32);
#ifdef _WIN32
  if (p->wave) {
    p->audio_clock_sec = player_wave_clock(p);
    p->audio_clock_valid = true;
  }
#endif
  if (!p->audio_clock_valid) return TODO_ERR_NO_STREAM;
  *out_sec = p->audio_clock_sec;
  return TODO_OK;
}
