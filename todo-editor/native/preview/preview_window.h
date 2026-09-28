#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <atomic>
#include <cstdint>

enum : UINT {
  PWM_SET_RECT = WM_APP + 1,
  PWM_SET_VISIBLE = WM_APP + 2,
  PWM_SHUTDOWN = WM_APP + 3,
};

struct PreviewWindow {
  std::atomic<HWND> hwnd{nullptr};
  std::atomic<bool> ready{false};
  std::atomic<bool> failed{false};

  bool start(HWND owner);
  void stop();
  void post_rect(int x, int y, int w, int h);
  void post_visible(bool show);
  bool is_window_visible() const;

private:
  HANDLE thread_ = nullptr;
  DWORD tid_ = 0;
  HWND owner_ = nullptr;
  static DWORD WINAPI thread_main(LPVOID self);
  bool create_window();
};
