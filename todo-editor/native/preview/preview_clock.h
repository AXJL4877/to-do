#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <atomic>
#include <cstdint>

struct PreviewClock {
  std::atomic<double> fps{30.0};
  std::atomic<bool> playing{false};
  std::atomic<int64_t> frame{0};
  std::atomic<uint64_t> serial{0};

  void set_fps(double f);
  void seek(int64_t f);
  void play();
  void pause();
  int64_t current_frame();
  bool is_playing() const { return playing.load(std::memory_order_acquire); }
  uint64_t current_serial() const { return serial.load(std::memory_order_acquire); }

private:
  LARGE_INTEGER qpc_freq_{};
  int64_t base_frame_ = 0;
  double play_origin_sec_ = 0;
  CRITICAL_SECTION cs_{};
  bool cs_ready_ = false;
  void ensure_cs();
  double qpc_sec() const;
};
