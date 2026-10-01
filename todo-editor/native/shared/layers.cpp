/* Visible layer collect + z-order (extracted from compose_graph_rgb). */
#include "layers.h"

#ifdef _WIN32

#include <algorithm>
#include <cstddef>
#include <string>
#include <unordered_map>
#include <vector>

std::vector<LayerRef> collect_visible_layers(const EditGraph &g, double time_sec) {
  auto track_of = [&](const std::string &id) -> const Track * {
    for (const auto &t : g.tracks) if (t.id == id) return &t;
    return nullptr;
  };
  // 导出逐帧调用：同一素材只查一次磁盘
  static std::unordered_map<std::string, bool> path_ok;
  auto usable = [&](const std::string &p) {
    auto it = path_ok.find(p);
    if (it == path_ok.end()) it = path_ok.emplace(p, usable_path(p)).first;
    return it->second;
  };
  std::vector<size_t> drawables;
  for (size_t i = 0; i < g.clips.size(); ++i) {
    const auto &c = g.clips[i];
    if (!c.enabled) continue;
    const double start = (std::max)(0.0, c.start);
    if (time_sec < start || time_sec >= start + (std::max)(0.04, c.duration)) continue;
    const Track *t = track_of(c.track_id);
    if (!t || !(t->kind == "video" || t->kind == "subtitle" || t->kind == "effect" || t->kind == "adjustment")) continue;
    const bool is_text = (c.kind == "text") || !c.text_content.empty();
    if (is_text || c.kind == "solid") {
      drawables.push_back(i);
      continue;
    }
    if (!usable(c.media_path)) continue;
    std::string k = c.kind;
    if (k == "sticker") k = "image";
    if (k.empty()) k = is_still_image(c.kind, c.media_path) ? "image" : "video";
    if (k == "video" || k == "image") drawables.push_back(i);
  }
  // 和监视器 clipStackRank 一致：字幕/文字 > 特效轨 > 视频轨，同层级轨道越靠上越后画
  auto tier = [&](const Clip &c, const Track *t) {
    if (c.text_layer || c.kind == "text" || !c.text_content.empty() || (t && t->kind == "subtitle")) return 2;
    if (t && (t->kind == "effect" || t->kind == "adjustment")) return 1;
    return 0;
  };
  std::stable_sort(drawables.begin(), drawables.end(), [&](size_t ai, size_t bi) {
    const Clip &a = g.clips[ai];
    const Clip &b = g.clips[bi];
    const Track *ta = track_of(a.track_id);
    const Track *tb = track_of(b.track_id);
    const int ra = tier(a, ta), rb = tier(b, tb);
    if (ra != rb) return ra < rb;
    const int ia = ta ? ta->index : 0;
    const int ib = tb ? tb->index : 0;
    if (ia != ib) return ia > ib;
    return a.start < b.start;
  });

  std::vector<LayerRef> out;
  out.reserve(drawables.size());
  for (size_t idx : drawables) out.push_back(LayerRef{&g.clips[idx]});
  return out;
}

#endif
