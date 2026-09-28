/* Visible layer collect + z-order (extracted from compose_graph_rgb). */
#pragma once

#include "editgraph.h"

#include <vector>

#ifdef _WIN32

struct LayerRef {
  const Clip *clip;
};

/**
 * 收集 time_sec 时刻可见层，输出按「先画到后画」顺序。
 *
 * 排序规则（逐字对应原 compose_graph_rgb 逻辑）：
 *   std::sort(drawables.begin(), drawables.end(), [&](const Clip &a, const Clip &b) {
 *     const Track *ta = track_of(a.track_id);
 *     const Track *tb = track_of(b.track_id);
 *     const int ia = ta ? ta->index : 0;
 *     const int ib = tb ? tb->index : 0;
 *     if (ia != ib) return ia > ib;
 *     return a.start < b.start;
 *   });
 * 即：track.index 较大者先画；同 index 时 start 较小者先画。
 */
std::vector<LayerRef> collect_visible_layers(const EditGraph &g, double time_sec);

#endif
