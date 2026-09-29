/* Visible layer collect + z-order (extracted from compose_graph_rgb). */
#include "layers.h"

#ifdef _WIN32

#include <algorithm>
#include <cstddef>
#include <string>
#include <vector>

std::vector<LayerRef> collect_visible_layers(const EditGraph &g, double time_sec) {
  auto track_of = [&](const std::string &id) -> const Track * {
    for (const auto &t : g.tracks) if (t.id == id) return &t;
    return nullptr;
  };
  std::vector<size_t> drawables;
  for (size_t i = 0; i < g.clips.size(); ++i) {
    const auto &c = g.clips[i];
    if (!c.enabled) continue;
    const Track *t = track_of(c.track_id);
    if (!t || t->kind != "video") continue;
    const bool is_text = (c.kind == "text") || !c.text_content.empty();
    if (is_text || c.kind == "solid") {
      drawables.push_back(i);
      continue;
    }
    if (!usable_path(c.media_path)) continue;
    std::string k = c.kind;
    if (k.empty()) k = is_still_image(c.kind, c.media_path) ? "image" : "video";
    if (k == "video" || k == "image") drawables.push_back(i);
  }
  std::sort(drawables.begin(), drawables.end(), [&](size_t ai, size_t bi) {
    const Clip &a = g.clips[ai];
    const Clip &b = g.clips[bi];
    const Track *ta = track_of(a.track_id);
    const Track *tb = track_of(b.track_id);
    const int ia = ta ? ta->index : 0;
    const int ib = tb ? tb->index : 0;
    if (ia != ib) return ia > ib;
    return a.start < b.start;
  });

  std::vector<LayerRef> out;
  for (size_t idx : drawables) {
    const Clip &c = g.clips[idx];
    const double start = (std::max)(0.0, c.start);
    const double dur = (std::max)(0.04, c.duration);
    if (time_sec < start || time_sec >= start + dur) continue;
    out.push_back(LayerRef{&c});
  }
  return out;
}

#endif
