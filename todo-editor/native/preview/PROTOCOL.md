# Preview protocol v1

Transport: UTF-8 JSON objects, one line per command/event. stdout is protocol only; diagnostics use stderr. Maximum command line: 16 MiB. `id` is optional; successful commands with an id emit `ack`. Commands enqueue work; decoder/render completion must not block input. B2 initialization still creates the window/device probe synchronously; this limitation must be removed as the renderer is introduced.

## Commands

| cmd | fields | meaning |
|---|---|---|
| init | hwnd (integer owner HWND), fps, budgetMB, adapterLuid (hex string or null) | Initialize once; explicit DXGI adapter selection, never default null adapter |
| rect | x,y,w,h (physical pixels; positive width/height) | Move popup; Electron performs DIP conversion |
| visible | on (boolean) | Requested visibility |
| suspend | reason (optional) | Hide popup while retaining frame |
| resume | | Restore requested visibility |
| timeline | json (string containing EditGraph) | Replace immutable graph snapshot |
| seek | frame (integer) | Increment serial and publish target immediately |
| play | | Start QPC clock |
| pause | | Freeze QPC clock at current timeline frame |
| stats | | Report counters |
| quit | | Acknowledge and shut down |

## Events

- `ready`: adapter, luid, featureLevel, mtProtected.
- `ack`: id. Acknowledgment does not mean decoded or displayed.
- `playhead`: frame, playing, serial. Timeline clock position, not a claim that this frame is on screen.
- `stats`: data (cmdCount, seekCount, seekTotalUs, serial, uptimeMs, windowVisible, suspended in B2). Render/decode measurements require T3/T4 implementation; never synthesize them from command timings.
- `unsupported`: clipIds, reason. Integration must hide native output and retain the legacy fallback for unsupported content. Existing bridge only logs this event: unresolved T2 integration gap.
- `error`: code, msg, optional id. Existing codes include bad_json, bad_args, init_twice, bad_hwnd, no_adapter, window_fail, bad_rect, not_inited, bad_timeline, unknown_cmd, line_too_long.

## Timing and ownership

Timeline t = frame/fps; quantization is floor(t*fps+1e-6)/fps. Seek media selection must choose the last decoded PTS <= mediaT+1e-4; intermediate keyframe-to-target frames must never be displayed. Every seek and graph replacement must invalidate pending old work by serial. B2 currently increments on seek only: timeline invalidation remains open.

Window is an owner WS_POPUP with WS_EX_TRANSPARENT|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW and HTTRANSPARENT. stdin EOF exits; host uses a Job Object with KILL_ON_JOB_CLOSE and parent-PID monitoring. No video rendering is implemented by the current GDI fill; `ready` is not video capability detection.

## Unresolved B2 checks before T3

Strict root JSON parsing/finite argument validation; serial invalidation on timeline edits; graph change detection independent of JSON length; unsupported fallback including playback boundary updates; async initialization and lifecycle cleanup. The existing smoke test passing does not establish these properties.
