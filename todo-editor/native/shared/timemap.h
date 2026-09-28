/* Timeline → media time（与 JS mediaTimeCore 对齐）。 */
#pragma once

#include "editgraph.h"

#ifdef _WIN32

/** floor(t*fps + 1e-6)/fps；fps 至少为 1。 */
double quantize_timeline_t(double t, double fps);

/**
 * 时间线时刻 → 源媒体时间（不量化）。
 * 若 has_freeze：直接返回 freeze（优先于 reverse/speed）。
 * 否则与历史 clip_media_time 同式；reverse 用 C++ span 语义。
 */
double media_time(const Clip &c, double timeline_t);

/** 兼容旧调用名 → media_time */
inline double clip_media_time(const Clip &c, double timeline_t) {
  return media_time(c, timeline_t);
}

/** stdin JSON → {ok,values}；见 scripts/crosscheck-timemap.mjs */
int todo_cmd_timemap_eval_stdin();

#endif
