/* Timeline → media time (extracted from todo_export.cpp). */
#include "timemap.h"

#ifdef _WIN32

#include <algorithm>

double clip_media_time(const Clip &c, double timeline_t) {
  const double local = (std::max)(0.0, timeline_t - c.start);
  const double spd = (std::max)(0.05, c.speed <= 0 ? 1.0 : c.speed);
  if (c.reverse) {
    const double span = c.out_point > c.in_point
      ? (c.out_point - c.in_point)
      : (std::max)(0.04, c.duration) * spd;
    return (std::max)(0.0, c.in_point + span - local * spd);
  }
  return (std::max)(0.0, c.in_point + local * spd);
}

#endif
