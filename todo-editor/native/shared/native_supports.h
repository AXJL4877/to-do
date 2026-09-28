/* Which visible clips native preview cannot fully render (B2). */
#pragma once

#include "editgraph.h"

#include <string>
#include <vector>

#ifdef _WIN32

/** True if clip needs features beyond B2 solid/simple path. */
bool native_clip_unsupported(const Clip &c);

/**
 * Collect unsupported visible clip ids at timeline time (or all enabled if t < 0).
 * Id: Clip.id if set, else "c{index}".
 */
std::vector<std::string> native_unsupported_clip_ids(const EditGraph &g, double timeline_t = -1.0);

#endif
