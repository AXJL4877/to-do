/* Timeline time ↔ frame index (aligns with src/lib/programPlayer.ts). */
#pragma once

#include <cmath>

/** Timeline selection uses floor, as in timemap.cpp; do not redefine its API here. */
inline long long frame_index_from_t(double abs_t, double fps) {
  const double f = fps >= 1.0 ? fps : 1.0;
  return static_cast<long long>(std::floor(abs_t * f + 1e-6));
}

/** B2 clock: frame = baseFrame + floor(elapsed * fps + 1e-6) */
inline long long frame_from_elapsed(long long base_frame, double elapsed_sec, double fps) {
  const double f = fps > 1e-6 ? fps : 1.0;
  if (elapsed_sec < 0) elapsed_sec = 0;
  return base_frame + static_cast<long long>(std::floor(elapsed_sec * f + 1e-6));
}

inline double t_from_frame(long long frame, double fps) {
  const double f = fps > 1e-6 ? fps : 1.0;
  return static_cast<double>(frame) / f;
}
