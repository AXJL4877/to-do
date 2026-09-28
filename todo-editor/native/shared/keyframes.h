/* Keyframe sample + clip transform (extracted from todo_export.cpp). */
#pragma once
#include "editgraph.h"
#include <vector>
#ifdef _WIN32
double sample_kf(const std::vector<Clip::Kf> &kfs, double local_t, double fallback);
void clip_transform_at(const Clip &c, double timeline_t, double *x, double *y, double *sx, double *sy, double *rot, double *op);
#endif