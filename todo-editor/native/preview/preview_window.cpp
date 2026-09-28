#include "preview_window.h"

#include <cstdio>

static const wchar_t *kClass = L"TodoPreviewOverlay";
static COLORREF kFill = RGB(40, 180, 120); /* solid GDI fill for B2 */

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  switch (msg) {
  case WM_NCHITTEST:
    return HTTRANSPARENT;
  case WM_MOUSEACTIVATE:
    return MA_NOACTIVATE;
  case WM_PAINT: {
    PAINTSTRUCT ps;
    HDC hdc = BeginPaint(hwnd, &ps);
    RECT rc;
    GetClientRect(hwnd, &rc);
    HBRUSH br = CreateSolidBrush(kFill);
    FillRect(hdc, &rc, br);
    DeleteObject(br);
    EndPaint(hwnd, &ps);
    return 0;
  }
  case WM_ERASEBKGND:
    return 1;
  case WM_DESTROY:
    PostQuitMessage(0);
    return 0;
  default:
    return DefWindowProcW(hwnd, msg, wParam, lParam);
  }
}

/* Rect payload via heap copy freed by window thread */
struct RectMsg { int x, y, w, h; };

bool PreviewWindow::create_window() {
  WNDCLASSW wc{};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = kClass;
  wc.hbrBackground = nullptr;
  RegisterClassW(&wc);

  const DWORD ex = WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
  const DWORD style = WS_POPUP; /* start hidden */
  HWND h = CreateWindowExW(
    ex, kClass, L"todo-preview",
    style, 0, 0, 64, 64,
    owner_, nullptr, wc.hInstance, nullptr);
  if (!h) {
    std::fprintf(stderr, "CreateWindowEx failed err=%lu\n", GetLastError());
    return false;
  }
  hwnd.store(h, std::memory_order_release);
  ShowWindow(h, SW_HIDE);
  return true;
}

DWORD WINAPI PreviewWindow::thread_main(LPVOID selfv) {
  auto *self = static_cast<PreviewWindow *>(selfv);
  if (!self->create_window()) {
    self->failed.store(true, std::memory_order_release);
    return 1;
  }
  self->ready.store(true, std::memory_order_release);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    if (msg.message == PWM_SET_RECT) {
      auto *r = reinterpret_cast<RectMsg *>(msg.lParam);
      if (r) {
        HWND h = self->hwnd.load(std::memory_order_acquire);
        if (h) {
          SetWindowPos(h, HWND_TOP, r->x, r->y, r->w, r->h,
            SWP_NOACTIVATE | (IsWindowVisible(h) ? SWP_SHOWWINDOW : SWP_NOREDRAW));
          InvalidateRect(h, nullptr, TRUE);
        }
        delete r;
      }
      continue;
    }
    if (msg.message == PWM_SET_VISIBLE) {
      HWND h = self->hwnd.load(std::memory_order_acquire);
      if (h) {
        ShowWindow(h, msg.wParam ? SW_SHOWNOACTIVATE : SW_HIDE);
        if (msg.wParam) {
          SetWindowPos(h, HWND_TOP, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
      }
      continue;
    }
    if (msg.message == PWM_SHUTDOWN) {
      HWND h = self->hwnd.load(std::memory_order_acquire);
      if (h) DestroyWindow(h);
      continue;
    }
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  self->hwnd.store(nullptr, std::memory_order_release);
  return 0;
}

bool PreviewWindow::start(HWND owner) {
  owner_ = owner;
  thread_ = CreateThread(nullptr, 0, thread_main, this, 0, &tid_);
  if (!thread_) return false;
  for (int i = 0; i < 200; ++i) {
    if (ready.load(std::memory_order_acquire) || failed.load(std::memory_order_acquire)) break;
    Sleep(5);
  }
  return ready.load(std::memory_order_acquire);
}

void PreviewWindow::stop() {
  if (tid_) PostThreadMessageW(tid_, PWM_SHUTDOWN, 0, 0);
  if (thread_) {
    WaitForSingleObject(thread_, 3000);
    CloseHandle(thread_);
    thread_ = nullptr;
  }
  tid_ = 0;
}

void PreviewWindow::post_rect(int x, int y, int w, int h) {
  if (!tid_) return;
  auto *r = new RectMsg{x, y, w, h};
  if (!PostThreadMessageW(tid_, PWM_SET_RECT, 0, reinterpret_cast<LPARAM>(r))) {
    delete r;
  }
}

void PreviewWindow::post_visible(bool show) {
  if (!tid_) return;
  PostThreadMessageW(tid_, PWM_SET_VISIBLE, show ? 1 : 0, 0);
}

bool PreviewWindow::is_window_visible() const {
  HWND h = hwnd.load(std::memory_order_acquire);
  return h && IsWindowVisible(h);
}
