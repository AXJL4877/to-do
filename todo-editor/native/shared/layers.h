/* Visible layer collect + z-order (extracted from compose_graph_rgb). */
#pragma once

#include "editgraph.h"

#include <vector>

#ifdef _WIN32

struct LayerRef {
  const Clip *clip;
};

/**
 * 收集 time_sec 时刻可见层（视频 / 字幕 / 特效 / 调整轨），输出按「先画到后画」顺序。
 *
 * 排序规则（对应监视器 clipStackRank）：
 *   1. 层级：视频轨 < 特效/调整轨 < 字幕轨与文字片段；
 *   2. 同层级 track.index 较大者先画；
 *   3. 同轨 start 较小者先画。
 */
std::vector<LayerRef> collect_visible_layers(const EditGraph &g, double time_sec);

#endif
