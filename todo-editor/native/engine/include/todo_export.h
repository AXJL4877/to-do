/* EditGraph v1 → ffmpeg filter_complex export (CLI). */
#pragma once

#ifdef _WIN32
/** Parse editGraph.json, spawn ffmpeg, print one JSON line to stdout. Returns 0 on ok. */
int todo_cmd_export(const wchar_t *graph_path, const wchar_t *out_path);

/** Compose EditGraph at time_sec (same track/overlay order + letterbox as export).
 * Writes BMP and uploads to D3D11. */
int todo_cmd_compose(const wchar_t *graph_path, double time_sec, const wchar_t *out_bmp);
#endif
