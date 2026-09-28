/* S0.1: overlay spike — child or owned popup over Electron HWND.
 * Usage:
 *   spike-child-window.exe child <hwndInt64> <x> <y> <w> <h>
 *   spike-child-window.exe popup <ownerHwndInt64> <screenX> <screenY> <w> <h>
 * Stdin commands: pos x y w h | quit
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <shellscalingapi.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "shcore.lib")

static HWND g_hwnd = nullptr;
static bool g_popup = false;
static COLORREF g_color = RGB(255, 0, 180);

static void set_dpi_aware() {
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

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  switch (msg) {
  case WM_NCHITTEST:
    return HTTRANSPARENT;
  case WM_PAINT: {
    PAINTSTRUCT ps;
    HDC hdc = BeginPaint(hwnd, &ps);
    RECT rc;
    GetClientRect(hwnd, &rc);
    HBRUSH br = CreateSolidBrush(g_color);
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

static bool create_overlay(const char *mode, HWND parentOrOwner, int x, int y, int w, int h) {
  WNDCLASSW wc{};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"TodoSpikeOverlay";
  wc.hbrBackground = nullptr;
  RegisterClassW(&wc);

  g_popup = (_stricmp(mode, "popup") == 0);
  DWORD ex = WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
  DWORD style = 0;
  HWND parent = nullptr;
  if (g_popup) {
    style = WS_POPUP | WS_VISIBLE;
    parent = parentOrOwner; /* owner */
    ex |= WS_EX_LAYERED;
  } else {
    style = WS_CHILD | WS_VISIBLE;
    parent = parentOrOwner;
  }

  g_hwnd = CreateWindowExW(
    ex, wc.lpszClassName, L"spike-overlay",
    style, x, y, w, h,
    parent, nullptr, wc.hInstance, nullptr);
  if (!g_hwnd) {
    std::fprintf(stderr, "CreateWindowEx failed err=%lu\n", GetLastError());
    return false;
  }
  if (g_popup) {
    SetLayeredWindowAttributes(g_hwnd, 0, 200, LWA_ALPHA);
  }
  ShowWindow(g_hwnd, SW_SHOWNOACTIVATE);
  UpdateWindow(g_hwnd);
  if (g_popup && parentOrOwner) {
    SetWindowPos(g_hwnd, parentOrOwner, x, y, w, h,
      SWP_NOACTIVATE | SWP_SHOWWINDOW);
    /* keep above owner content: HWND_TOP */
    SetWindowPos(g_hwnd, HWND_TOP, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } else {
    SetWindowPos(g_hwnd, HWND_TOP, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
  std::printf("ok mode=%s hwnd=%llu parent=%llu rect=%d,%d %dx%d\n",
    mode,
    (unsigned long long)(uintptr_t)g_hwnd,
    (unsigned long long)(uintptr_t)parentOrOwner,
    x, y, w, h);
  std::fflush(stdout);
  return true;
}

static void apply_pos(int x, int y, int w, int h) {
  if (!g_hwnd) return;
  SetWindowPos(g_hwnd, HWND_TOP, x, y, w, h,
    SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

int main(int argc, char **argv) {
  set_dpi_aware();
  if (argc < 7) {
    std::fprintf(stderr,
      "usage: spike-child-window.exe <child|popup> <hwndInt64> <x> <y> <w> <h>\n");
    return 2;
  }
  const char *mode = argv[1];
  const long long hwndLL = strtoll(argv[2], nullptr, 10);
  const int x = atoi(argv[3]);
  const int y = atoi(argv[4]);
  const int w = atoi(argv[5]);
  const int h = atoi(argv[6]);
  HWND parent = reinterpret_cast<HWND>(static_cast<uintptr_t>(hwndLL));
  if (!IsWindow(parent)) {
    std::fprintf(stderr, "parent hwnd invalid: %lld\n", hwndLL);
    return 3;
  }
  if (!create_overlay(mode, parent, x, y, w, h)) return 4;

  /* stdin pump on a thread-less peek in message loop */
  HANDLE stdinH = GetStdHandle(STD_INPUT_HANDLE);
  std::string line;
  MSG msg;
  for (;;) {
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) return 0;
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    DWORD avail = 0;
    if (PeekNamedPipe(stdinH, nullptr, 0, nullptr, &avail, nullptr) && avail > 0) {
      char buf[256];
      DWORD rd = 0;
      if (ReadFile(stdinH, buf, sizeof(buf) - 1, &rd, nullptr) && rd > 0) {
        buf[rd] = 0;
        line.append(buf, rd);
        size_t nl;
        while ((nl = line.find('\n')) != std::string::npos) {
          std::string cmd = line.substr(0, nl);
          line.erase(0, nl + 1);
          if (!cmd.empty() && cmd.back() == '\r') cmd.pop_back();
          if (cmd == "quit") {
            DestroyWindow(g_hwnd);
            continue;
          }
          int px, py, pw, ph;
          if (sscanf(cmd.c_str(), "pos %d %d %d %d", &px, &py, &pw, &ph) == 4) {
            apply_pos(px, py, pw, ph);
            std::printf("pos %d %d %d %d\n", px, py, pw, ph);
            std::fflush(stdout);
          }
        }
      }
    } else {
      /* also accept console line input when not a pipe */
      MsgWaitForMultipleObjects(0, nullptr, FALSE, 16, QS_ALLINPUT);
    }
  }
}
