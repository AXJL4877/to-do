#include "preview_clock.h"
#include "quantize.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

void PreviewClock::ensure_cs() {
  if (!cs_ready_) {
    InitializeCriticalSection(&cs_);
    cs_ready_ = true;
    QueryPerformanceFrequency(&qpc_freq_);
  }
}

double PreviewClock::qpc_sec() const {
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  return static_cast<double>(now.QuadPart) / static_cast<double>(qpc_freq_.QuadPart);
}

void PreviewClock::set_fps(double f) {
  ensure_cs();
  if (!(f > 1e-6)) f = 30.0;
  fps.store(f, std::memory_order_release);
}

void PreviewClock::seek(int64_t f) {
  ensure_cs();
  EnterCriticalSection(&cs_);
  base_frame_ = f;
  frame.store(f, std::memory_order_release);
  serial.fetch_add(1, std::memory_order_acq_rel);
  if (playing.load(std::memory_order_relaxed)) {
    play_origin_sec_ = qpc_sec();
  }
  LeaveCriticalSection(&cs_);
}

void PreviewClock::play() {
  ensure_cs();
  EnterCriticalSection(&cs_);
  base_frame_ = frame.load(std::memory_order_relaxed);
  play_origin_sec_ = qpc_sec();
  playing.store(true, std::memory_order_release);
  LeaveCriticalSection(&cs_);
}

void PreviewClock::pause() {
  ensure_cs();
  EnterCriticalSection(&cs_);
  if (playing.load(std::memory_order_relaxed)) {
    const double elapsed = qpc_sec() - play_origin_sec_;
    const double f = fps.load(std::memory_order_relaxed);
    base_frame_ = frame_from_elapsed(base_frame_, elapsed, f);
    frame.store(base_frame_, std::memory_order_release);
    playing.store(false, std::memory_order_release);
  }
  LeaveCriticalSection(&cs_);
}

int64_t PreviewClock::current_frame() {
  ensure_cs();
  EnterCriticalSection(&cs_);
  int64_t out = base_frame_;
  if (playing.load(std::memory_order_relaxed)) {
    const double elapsed = qpc_sec() - play_origin_sec_;
    const double f = fps.load(std::memory_order_relaxed);
    out = frame_from_elapsed(base_frame_, elapsed, f);
    frame.store(out, std::memory_order_relaxed);
  }
  LeaveCriticalSection(&cs_);
  return out;
}
