/* TO DO media engine public C ABI for Electron / Node spawn wrappers. */
#ifndef TODO_ENGINE_H
#define TODO_ENGINE_H

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  TODO_OK = 0,
  TODO_ERR_ARGS = 1,
  TODO_ERR_OPEN = 2,
  TODO_ERR_PROBE = 3,
  TODO_ERR_DECODE = 4,
  TODO_ERR_TIMEOUT = 5,
  TODO_ERR_IO = 6,
  TODO_ERR_NO_STREAM = 7,
  TODO_ERR_UNSUPPORTED = 8,
  TODO_ERR_EOF = 9
} TodoStatus;

typedef struct {
  double duration;
  int width;
  int height;
  double frame_rate;
  int has_video;
  int has_audio;
  char format[64];
} TodoProbeInfo;

/* Opaque sequential video player (libav* decode; seek only on todo_player_seek). */
typedef struct TodoPlayer TodoPlayer;

typedef struct {
  double duration;
  int width;
  int height;
  double frame_rate;
  int has_video;
  int has_audio;
} TodoPlayerInfo;

/* Probe a local media file. timeout_ms: 100..30000. */
TodoStatus todo_probe(const wchar_t *path, int timeout_ms, TodoProbeInfo *out);

/* Decode one RGB24 frame nearest to time_sec into caller buffer (width*height*3).
 * On success writes actual width/height. timeout_ms covers open+seek+decode. */
TodoStatus todo_decode_rgb24(
  const wchar_t *path,
  double time_sec,
  int timeout_ms,
  unsigned char *rgb,
  int rgb_capacity,
  int *out_w,
  int *out_h);

/* Open media for sequential RGB24 reads. timeout_ms: 100..30000 (open budget; refreshed per read/seek). */
TodoStatus todo_player_open(const wchar_t *path, int timeout_ms, TodoPlayer **out);

void todo_player_close(TodoPlayer *p);

TodoStatus todo_player_info(const TodoPlayer *p, TodoPlayerInfo *out);

/* Next decoded video frame as RGB24. out_pts is presentation time in seconds.
 * Returns TODO_ERR_EOF when no more frames. Does not call av_seek_frame. */
TodoStatus todo_player_read(
  TodoPlayer *p,
  unsigned char *rgb,
  int rgb_capacity,
  int *out_w,
  int *out_h,
  double *out_pts);

/* Seek (keyframe-backward) then flush decoder; subsequent reads are sequential. */
TodoStatus todo_player_seek(TodoPlayer *p, double time_sec);

/* Last known audio media time (PCM / waveOut). Pumps decode+playback. Non-const.
 * TODO_ERR_NO_STREAM if no audio. */
TodoStatus todo_player_audio_clock(TodoPlayer *p, double *out_sec);

#ifdef __cplusplus
}
#endif
#endif
