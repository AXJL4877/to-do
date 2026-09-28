import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output/quantize')
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'check.cpp'), `
#include "quantize.h"
#include <cstdio>
int main() {
  struct Case { double t, fps; long long frame; };
  const Case cases[] = {{0.02,30,0},{0.05,30,1},{1.0/30,30,1},{0.999,30,29},{0,30,0}};
  for (auto c : cases) {
    auto actual = frame_index_from_t(c.t,c.fps);
    if (actual != c.frame) {
      std::printf("FAIL t=%.9f fps=%.3f expected=%lld actual=%lld\\n",c.t,c.fps,c.frame,actual);
      return 1;
    }
  }
  std::puts("preview quantize: 5 cases passed");
}
`)
const compiler = process.env.CXX || resolve(root, '.native-tools/w64devkit/bin/g++.exe')
const exe = resolve(out, 'check.exe')
const compiled = spawnSync(compiler, ['-std=c++17', '-O2', '-I' + resolve(root, 'native/shared'), resolve(out, 'check.cpp'), '-o', exe], { stdio: 'inherit', windowsHide: true })
if (compiled.status !== 0) process.exit(compiled.status ?? 1)
const result = spawnSync(exe, [], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
