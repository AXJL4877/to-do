# Timeline interaction performance

## Goal and design

Keep the existing editing model, persistence, undo, snapping and hit targets. Reduce continuous zoom below the 16.7ms/frame budget on the existing 925-clip synthetic workload. The user explicitly authorized implementation and technology choices.

The measured hot path is DOM style/layout during zoom (roughly 15–17ms), plus commit work (roughly 9ms). CSS containment did not materially improve it. Use a two-phase geometry update: during continuous zoom, transform the track layer using the ratio between current zoom and a stable geometry zoom; after 120ms without changes, materialize exact geometry. Keep the ruler, playhead, scroll extent and pointer anchor in current coordinates. Flush geometry before pointer editing. Keep culling based on current visible time, so newly exposed clips appear during zoom-out.

This change retains DOM hit testing and adds a viewport-sized Canvas text layer. Clip boxes transform during a gesture while labels render directly at current pixel coordinates; glyph proportions never scale with the track. Names remain available as DOM aria-labels. The Canvas follows live drag offsets, horizontal/vertical scroll and track resizing, and stays beneath the sticky ruler. Full Canvas hit testing would require replacing trim handles and animation controls and is unnecessary for the measured workload.

The user rejected transient text stretching. An intermediate per-label inverse-transform experiment removed stretching but regressed to roughly 17ms, so it was replaced with the independent Canvas text renderer (roughly 6ms in the synthetic workload).

## Implementation and verification

- [x] Add regression tests proving clip boxes do not change dimensions on every zoom step, while visual positions, viewport coverage and playhead remain correct.
- [x] Implement stable geometry zoom, current-coordinate overlays and editing flush; test settling, rapid direction changes, sequence switching and cleanup.
- [x] Measure continuous zoom and final materialization separately, with real styles.
- [x] Independent review: reproduce/fix active-drag double scaling; keep Canvas labels below the sticky ruler.

## Prompt responsiveness

`SkillsPanel` now supplies stable draft/action callbacks and memoizes task cards. `SkillStudio` isolates its plan elements, validation and timing bar from prompt edits. With 100 plan elements, 30 synthetic input events fell from 177.4ms and 9,000 plan-field reads to about 16–19ms and zero plan-field reads. Tests cover latest Chinese prompt submission, drafts, validation, editing and removal.

Background preview caching now yields to focused text editors and recent keyboard/pointer/wheel interaction. Idle callbacks no longer force frame composition on timeout, and insufficient idle budget postpones work. A regression executes the real cache worker: no frame is composed while a textarea has focus; caching resumes after blur.

## Verification and limits

Commands: `npm run timeline:test`, `node scripts/test-skill-input-browser.mjs`, `npm run build`, `node scripts/perf-timeline.mjs 25 --layout-only --screenshot`.

The benchmark uses 925 synthetic clips and production styles. It measures main-thread commits/layout, not real-project end-to-end frame rate or decoding latency. First large zoom-out mounts many clips once; exact materialization after a gesture also has a one-time cost. Hidden Electron RAF is throttled, so wall-clock frame waits must not be quoted as interactive latency. Canvas glyph tests compare raster bounds (including live drag), allowing device-pixel antialiasing variation without permitting stretching.

Keep the current checkout: it contains the user's ongoing uncommitted work and is the running Electron development app. Do not commit or overwrite unrelated edits.
