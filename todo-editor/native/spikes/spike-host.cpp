/* Minimal parent HWND to host spike-child-window for offline a/d checks. */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <cstdio>
#include <string>

static LRESULT CALLBACK Proc(HWND hwnd, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
  if (m == WM_PAINT) {
    PAINTSTRUCT ps; HDC dc = BeginPaint(hwnd, &ps);
    RECT rc; GetClientRect(hwnd, &rc);
    FillRect(dc, &rc, (HBRUSH)(COLOR_WINDOW + 1));
    TextOutW(dc, 16, 16, L"HOST — click/drag here if spike is HTTRANSPARENT", 48);
    EndPaint(hwnd, &ps);
    return 0;
  }
  return DefWindowProcW(hwnd, m, w, l);
}

int main() {
  SetProcessDPIAware();
  WNDCLASSW wc{};
  wc.lpfnWndProc = Proc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"TodoSpikeHost";
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  RegisterClassW(&wc);
  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"spike-host",
    WS_OVERLAPPEDWINDOW | WS_VISIBLE, 100, 100, 800, 600,
    nullptr, nullptr, wc.hInstance, nullptr);
  std::printf("%llu\n", (unsigned long long)(uintptr_t)hwnd);
  std::fflush(stdout);
  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return 0;
}
