/* S0.2 DXGI adapter pick + S0.3 ID3D11Multithread self-decl QI */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <dxgi1_2.h>
#include <cstdio>
#include <cstdint>
#include <vector>
#include <string>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

/* S0.3: layout-compatible with ID3D11Multithread; IID from Windows SDK */
struct ITodoD3D11Multithread : public IUnknown {
  virtual void STDMETHODCALLTYPE Enter() = 0;
  virtual void STDMETHODCALLTYPE Leave() = 0;
  virtual BOOL STDMETHODCALLTYPE SetMultithreadProtected(BOOL bMTProtect) = 0;
  virtual BOOL STDMETHODCALLTYPE GetMultithreadProtected() = 0;
};

static const GUID kIID_ITodoD3D11Multithread =
  {0x9B7E4E00, 0x342C, 0x4106, {0xA1, 0x9F, 0x4F, 0x27, 0x04, 0xF6, 0x89, 0xF0}};

static std::string narrow(const WCHAR *w) {
  if (!w) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

struct AdapterInfo {
  int index = 0;
  std::string name;
  LUID luid{};
  SIZE_T vram = 0;
  UINT flags = 0;
  IDXGIAdapter1 *adapter = nullptr;
};

int main(int argc, char **argv) {
  uint64_t overrideLuid = 0;
  if (argc >= 2) {
    overrideLuid = strtoull(argv[1], nullptr, 0);
  }

  IDXGIFactory1 *factory = nullptr;
  HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void **)&factory);
  if (FAILED(hr) || !factory) {
    std::printf("CreateDXGIFactory1 failed hr=0x%08lX\n", (unsigned long)hr);
    return 1;
  }

  std::vector<AdapterInfo> list;
  for (UINT i = 0;; ++i) {
    IDXGIAdapter1 *ad = nullptr;
    if (factory->EnumAdapters1(i, &ad) == DXGI_ERROR_NOT_FOUND) break;
    DXGI_ADAPTER_DESC1 desc{};
    ad->GetDesc1(&desc);
    AdapterInfo info;
    info.index = (int)i;
    info.name = narrow(desc.Description);
    info.luid = desc.AdapterLuid;
    info.vram = desc.DedicatedVideoMemory;
    info.flags = desc.Flags;
    info.adapter = ad;
    list.push_back(info);
    std::printf(
      "adapter[%d] name=\"%s\" LUID=%08X:%08X vramMB=%.1f flags=0x%X%s\n",
      info.index,
      info.name.c_str(),
      (unsigned)info.luid.HighPart, (unsigned)info.luid.LowPart,
      info.vram / (1024.0 * 1024.0),
      (unsigned)info.flags,
      (info.flags & DXGI_ADAPTER_FLAG_SOFTWARE) ? " SOFTWARE" : "");
  }

  AdapterInfo *chosen = nullptr;
  if (overrideLuid) {
    for (auto &a : list) {
      uint64_t v = (uint64_t(uint32_t(a.luid.HighPart)) << 32) | uint32_t(a.luid.LowPart);
      if (v == overrideLuid) { chosen = &a; break; }
    }
    std::printf("override LUID=0x%llX -> %s\n",
      (unsigned long long)overrideLuid, chosen ? "HIT" : "MISS");
  }
  if (!chosen) {
    SIZE_T best = 0;
    for (auto &a : list) {
      if (a.flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
      if (a.vram == 0) continue; /* drop Oray-like virtual */
      if (!chosen || a.vram > best) {
        chosen = &a;
        best = a.vram;
      }
    }
  }
  if (!chosen) {
    std::printf("FAIL: no adapter selected\n");
    for (auto &a : list) if (a.adapter) a.adapter->Release();
    factory->Release();
    return 2;
  }
  std::printf(
    "SELECTED adapter[%d] \"%s\" LUID=%08X:%08X vramMB=%.1f\n",
    chosen->index, chosen->name.c_str(),
    (unsigned)chosen->luid.HighPart, (unsigned)chosen->luid.LowPart,
    chosen->vram / (1024.0 * 1024.0));

  ID3D11Device *device = nullptr;
  ID3D11DeviceContext *ctx = nullptr;
  D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
  const D3D_FEATURE_LEVEL levels[] = {
    D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0
  };
  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
  hr = D3D11CreateDevice(
    chosen->adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags,
    levels, (UINT)(sizeof(levels) / sizeof(levels[0])),
    D3D11_SDK_VERSION, &device, &fl, &ctx);
  if (FAILED(hr)) {
    std::printf("D3D11CreateDevice(VIDEO|BGRA) failed hr=0x%08lX, retry without VIDEO_SUPPORT\n",
      (unsigned long)hr);
    flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    hr = D3D11CreateDevice(
      chosen->adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags,
      levels, (UINT)(sizeof(levels) / sizeof(levels[0])),
      D3D11_SDK_VERSION, &device, &fl, &ctx);
  }
  std::printf("D3D11CreateDevice hr=0x%08lX featureLevel=0x%X flags=0x%X\n",
    (unsigned long)hr, (unsigned)fl, (unsigned)flags);
  if (FAILED(hr) || !device) {
    for (auto &a : list) if (a.adapter) a.adapter->Release();
    factory->Release();
    return 3;
  }

  /* S0.3 */
  ITodoD3D11Multithread *mt = nullptr;
  hr = device->QueryInterface(kIID_ITodoD3D11Multithread, (void **)&mt);
  std::printf("QI ITodoD3D11Multithread hr=0x%08lX ptr=%p\n",
    (unsigned long)hr, (void *)mt);
  if (SUCCEEDED(hr) && mt) {
    BOOL before = mt->GetMultithreadProtected();
    std::printf("GetMultithreadProtected(default)=%d\n", (int)before);
    BOOL ok = mt->SetMultithreadProtected(TRUE);
    BOOL after = mt->GetMultithreadProtected();
    std::printf("SetMultithreadProtected(TRUE) returned=%d after=%d\n", (int)ok, (int)after);
    mt->Release();
  } else {
    std::printf("QI FAILED — not guessing other IIDs\n");
  }

  /* also try VideoDevice */
  ID3D11VideoDevice *vd = nullptr;
  hr = device->QueryInterface(__uuidof(ID3D11VideoDevice), (void **)&vd);
  std::printf("QI ID3D11VideoDevice hr=0x%08lX ptr=%p\n", (unsigned long)hr, (void *)vd);
  if (vd) vd->Release();

  if (ctx) ctx->Release();
  device->Release();
  for (auto &a : list) if (a.adapter) a.adapter->Release();
  factory->Release();
  return 0;
}
