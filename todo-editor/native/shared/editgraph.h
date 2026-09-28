/* EditGraph types + JSON parse (extracted from todo_export.cpp). */
#pragma once

#include <string>
#include <vector>

#ifdef _WIN32

struct Clip {
  std::string media_path;
  double start = 0;
  double duration = 0;
  double in_point = 0;
  double out_point = -1;
  std::string track_id;
  bool enabled = true;
  std::string kind;
  double speed = 1;
  bool reverse = false;
  double x = 0;
  double y = 0;
  double scale_x = 1;
  double scale_y = 1;
  double rotation = 0;
  double opacity = 1;
  double crop_l = 0;
  double crop_r = 0;
  double crop_t = 0;
  double crop_b = 0;
  double exposure = 0;
  double contrast = 0;
  double saturation = 0;
  double temperature = 0;
  double tint = 0;
  std::string blend = "normal";
  std::string text_content;
  std::string text_font = "Segoe UI";
  double text_size = 48;
  std::string text_color = "#F5F2EC";
  std::string text_align = "center";
  std::string text_bilingual;
  double text_stroke_w = 0;
  std::string text_stroke_color = "#000000";
  double fx_blur = 0;
  double fx_sharpen = 0;
  double fx_filter = 0;
  std::string mask_type;
  double mask_feather = 0;
  double mask_expand = 0;
  bool mask_invert = false;
  struct Pt { double x = 0; double y = 0; };
  std::vector<Pt> mask_points;
  bool chroma_on = false;
  int chroma_r = 0, chroma_g = 255, chroma_b = 0;
  double chroma_tol = 0.35;
  std::string trans_in_type;
  double trans_in_dur = 0;
  std::string trans_out_type;
  double trans_out_dur = 0;
  struct KfHandle { double x = 0; double y = 0; };
  struct Kf {
    double t = 0;
    double value = 0;
    std::string ease = "linear";
    bool has_oh = false;
    KfHandle oh{};
    bool has_ih = false;
    KfHandle ih{};
  };
  std::vector<Kf> kf_x, kf_y, kf_scale, kf_scale_y, kf_rot, kf_opacity;
};

struct Track {
  std::string id;
  std::string kind;
  bool muted = false;
  int index = 0;
};

struct EditGraph {
  std::vector<Clip> clips;
  std::vector<Track> tracks;
  int width = 1920;
  int height = 1080;
  double fps = 30;
  double work_in = 0;
  double work_out = 1;
  bool range_only = false;
  bool audio_only = false;
};

std::wstring utf8_to_wide(const std::string &utf8);
std::string wide_to_utf8(const std::wstring &w);
bool read_file_utf8(const wchar_t *path, std::string *out);
bool file_exists_w(const wchar_t *p);
bool usable_path(const std::string &p);
bool is_still_image(const std::string &kind, const std::string &media_path);
bool parse_edit_graph(const std::string &s, EditGraph *g);

#endif
