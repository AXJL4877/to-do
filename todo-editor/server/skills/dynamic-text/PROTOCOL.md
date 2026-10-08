# Dynamic text production runtime

Package ID: `builtin.dynamic-text`. Protocol: `todo-skill-pack/1`.
Pipeline: `production`. Runtime: `{ "type": "text", "engine": "jizura" }`.
Only this fixed host engine is accepted; the manifest cannot execute scripts.

The host splits the narration, synthesizes each segment using TTS_timeline,
and builds short text scenes from its phrase timestamps. Each board contains
one literal text element and `textTiming: { startMs, endMs }`. The render layer
stores `result.dynamicText` (TextStyle fields and versioned JIZURA parameters),
frame dimensions, fps, start/end time and effect ID. It generates no external
images and needs no Python renderer entry.

The client inserts each scene as an editable transparent text clip linked to
its voice clip. Subtitle production uses the existing subtitle runtime.
Ordinary sequence export bakes text in a hidden Canvas window, then FFmpeg
composites. Animated / full-composition clips stream RGBA into qtrle (not
per-frame PNG IPC); same-segment full scenes bake once and slice by inPoint.
Local editing, saved projects and incremental retries use the same production
document and hashes as blackboard.
