/* Timeline → media time (extracted from todo_export.cpp). */
#pragma once

#include "editgraph.h"

#ifdef _WIN32
double clip_media_time(const Clip &c, double timeline_t);
#endif
