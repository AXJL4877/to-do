/* D3D11 RGB upload smoke / optional window present. */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>

#include <cstdint>
#include <cstdio>
#include <vector>

#include "todo_engine.h"

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

static bool gpu_upload_smoke(int w, int h, const uint8_t *rgb) {
  ID3D11Device *device = nullptr;
  ID3D11DeviceContext *ctx = nullptr;
  D3D_FEATURE_LEVEL level;
  const D3D_FEATURE_LEVEL levels[] = { D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0 };
  HRESULT hr = D3D11CreateDevice(
    nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
    levels, 2, D3D11_SDK_VERSION, &device, &level, &ctx);
  if (FAILED(hr) || !device || !ctx) return false;

  D3D11_TEXTURE2D_DESC td{};
  td.Width = static_cast<UINT>(w);
  td.Height = static_cast<UINT>(h);
  td.MipLevels = 1;
  td.ArraySize = 1;
  td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  td.SampleDesc.Count = 1;
  td.Usage = D3D11_USAGE_DYNAMIC;
  td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  td.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;

  ID3D11Texture2D *tex = nullptr;
  hr = device->CreateTexture2D(&td, nullptr, &tex);
  if (FAILED(hr) || !tex) {
    ctx->Release();
    device->Release();
    return false;
  }

  D3D11_MAPPED_SUBRESOURCE mapped{};
  hr = ctx->Map(tex, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped);
  if (FAILED(hr)) {
    tex->Release();
    ctx->Release();
    device->Release();
    return false;
  }
  auto *dst = static_cast<uint8_t *>(mapped.pData);
  for (int y = 0; y < h; ++y) {
    uint8_t *row = dst + y * mapped.RowPitch;
    const uint8_t *src = rgb + static_cast<size_t>(y) * w * 3;
    for (int x = 0; x < w; ++x) {
      row[x * 4 + 0] = src[x * 3 + 0];
      row[x * 4 + 1] = src[x * 3 + 1];
      row[x * 4 + 2] = src[x * 3 + 2];
      row[x * 4 + 3] = 255;
    }
  }
  ctx->Unmap(tex, 0);
  tex->Release();
  ctx->Release();
  device->Release();
  return true;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 2) {
    std::fputs("usage: todo-gpu-view <media> [timeSec] [--smoke]\n", stderr);
    return 1;
  }
  const wchar_t *path = argv[1];
  double t = 0.0;
  for (int i = 2; i < argc; ++i) {
    if (wcscmp(argv[i], L"--smoke") == 0) continue;
    t = _wtof(argv[i]);
  }

  TodoProbeInfo info{};
  if (todo_probe(path, 10000, &info) != TODO_OK || !info.has_video) {
    std::puts("{\"ok\":false,\"error\":\"probe\"}");
    return 2;
  }
  std::vector<uint8_t> rgb(static_cast<size_t>(info.width) * info.height * 3);
  int w = 0, h = 0;
  if (todo_decode_rgb24(path, t, 15000, rgb.data(), static_cast<int>(rgb.size()), &w, &h) != TODO_OK) {
    std::puts("{\"ok\":false,\"error\":\"decode\"}");
    return 3;
  }
  if (!gpu_upload_smoke(w, h, rgb.data())) {
    std::puts("{\"ok\":false,\"error\":\"d3d11\"}");
    return 4;
  }
  std::printf("{\"ok\":true,\"backend\":\"d3d11\",\"width\":%d,\"height\":%d,\"time\":%.6f,\"smoke\":true}\n",
    w, h, t);
  return 0;
}
