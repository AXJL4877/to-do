#include "native_supports.h"

#ifdef _WIN32

#include <cmath>
#include <sstream>

bool native_clip_unsupported(const Clip &c) {
  if (!c.enabled) return false;
  if (c.chroma_on) return true;
  if (!c.mask_type.empty()) return true;
  if (c.kind == "text" || !c.text_content.empty()) return true;
  if (c.kind == "solid") return true;
  if (std::fabs(c.exposure) > 1e-9 || std::fabs(c.contrast) > 1e-9 ||
      std::fabs(c.saturation) > 1e-9 || std::fabs(c.temperature) > 1e-9 ||
      std::fabs(c.tint) > 1e-9) {
    return true;
  }
  if (c.fx_blur > 1e-9 || c.fx_sharpen > 1e-9 || c.fx_filter > 1e-9) return true;
  return false;
}

static bool track_is_video(const EditGraph &g, const std::string &id) {
  for (const auto &t : g.tracks) {
    if (t.id == id) return t.kind == "video" || t.kind.empty();
  }
  return true;
}

std::vector<std::string> native_unsupported_clip_ids(const EditGraph &g, double timeline_t) {
  std::vector<std::string> out;
  for (size_t i = 0; i < g.clips.size(); ++i) {
    const Clip &c = g.clips[i];
    if (!c.enabled) continue;
    if (!track_is_video(g, c.track_id)) continue;
    if (timeline_t >= 0) {
      if (timeline_t < c.start || timeline_t >= c.start + c.duration) continue;
    }
    if (!native_clip_unsupported(c)) continue;
    if (!c.id.empty()) out.push_back(c.id);
    else {
      std::ostringstream oss;
      oss << 'c' << i;
      out.push_back(oss.str());
    }
  }
  return out;
}

#endif
