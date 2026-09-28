/* Keyframe sample + clip transform (extracted from todo_export.cpp). */
#include "keyframes.h"
#ifdef _WIN32
#include <algorithm>
double sample_kf(const std::vector<Clip::Kf> &kfs, double local_t, double fallback) {
  if (kfs.empty()) return fallback;
  if (local_t <= kfs.front().t) return kfs.front().value;
  if (local_t >= kfs.back().t) return kfs.back().value;
  for (size_t i = 1; i < kfs.size(); ++i) {
    if (local_t <= kfs[i].t) {
      const auto &a = kfs[i - 1];
      const auto &b = kfs[i];
      const double u = (b.t - a.t) > 1e-9 ? (local_t - a.t) / (b.t - a.t) : 0;
      return a.value + (b.value - a.value) * u;
    }
  }
  return fallback;
}
void clip_transform_at(const Clip &c, double timeline_t, double *x, double *y, double *sx, double *sy, double *rot, double *op) {
  const double local = (std::max)(0.0, timeline_t - c.start);
  *x = sample_kf(c.kf_x, local, c.x);
  *y = sample_kf(c.kf_y, local, c.y);
  *sx = sample_kf(c.kf_scale, local, c.scale_x);
  *sy = c.kf_scale_y.empty() ? sample_kf(c.kf_scale, local, c.scale_y) : sample_kf(c.kf_scale_y, local, c.scale_y);
  *rot = sample_kf(c.kf_rot, local, c.rotation);
  *op = sample_kf(c.kf_opacity, local, c.opacity);
}
#endif