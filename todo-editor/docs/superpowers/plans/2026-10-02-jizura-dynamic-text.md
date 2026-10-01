# JIZURA Dynamic Text Implementation Plan

> For agentic workers: use superpowers:executing-plans for inline execution. The user explicitly requested direct implementation and acceptance of the finished feature.

**Goal:** Editable short dynamic text in the existing fancy-text library, with transparent timeline preview and export.
**Architecture:** Vendor the pinned JIZURA drawing core behind an isolated factory. A typed adapter compiles one literal-text cut and draws it to a reusable offscreen surface. Preview and hidden-window export share drawTextClip.
**Tech Stack:** TypeScript, React, Canvas2D, Electron, existing FFmpeg alpha export.
**Spec:** ../specs/2026-10-02-jizura-dynamic-text-design.md

## Global Constraints

- Preserve uncommitted timeline fixes. Work in the current checkout for immediate user acceptance.
- Retain upstream MIT attribution; no network fonts or user script execution.
- Store versioned JSON parameters and seed, never Canvas or functions.
- Six presets, transparent composition, literal punctuation, Chinese fonts, deterministic seeks.
- Duration 0.5–12 seconds, default 3; motion 0–1, default 0.7.

## Review Focus

- Empty/multiline/long text must keep literal content and use a readable fallback.
- Unknown saved configuration must fall back without breaking project load/export.
- Multiple clips with different fonts must not share stale glyph or layout measurements.
- A long or trimmed clip must not unexpectedly go blank during its middle.
- Host transforms/alpha/background pixels must survive dynamic rendering.

## Task 1: Engine and renderer

- [x] Add tests/dynamic-text.browser.tsx and scripts/test-dynamic-text.mjs. Confirm missing dynamic presets fails before production edits.
- [x] Vendor src/lib/jizura/{engine.js,engine.d.ts,LICENSE,README.md}; provide createJizura() without a window.J global.
- [x] Add typed dynamic data to src/types.ts and src/lib/dynamicText.ts. Expose normalizeDynamicText(), dynamicTextWarning(), drawDynamicText(ctx,text,w,h,time,duration,fontSize).
- [x] Add six presets to fancyText.ts and route monitorDraw.ts before ordinary animation handling.
- [x] Verify actual Canvas visibility, alpha, deterministic replay, fallback, font isolation, host transforms and variable duration.

## Task 2: Editable UI and export

- [x] Extend failing browser tests for category, presets, playback, randomization, clip insertion and edits/undo/save JSON.
- [x] Extend FancyTextPanel.tsx with dynamic controls and project-aspect preview calling drawTextClip.
- [x] In chalkRender.ts load used fonts at the actual weights and invalidate renderer font caches after loading.
- [x] Verify hidden renderer pixel equality and animated alpha export using existing export helpers.

## Task 3: Acceptance and regression

- [x] Run dynamic browser tests, existing fancy/chalk checks, tsc and Vite build. Diagnose any failures rather than claiming partial success.
- [x] Repair the existing nullable progress-theme type only if it still blocks the required build; test null skill input.
- [x] Review complete diff for source licensing, clip persistence, transforms and preview/export consistency.
- [x] Capture a dynamic preset gallery and make the updated application available for acceptance using the existing dev setup.
- [x] Commit only the dynamic feature and its checks, preserving the timeline changes as separate work.

## Execution Ledger

- Ruling: direct implementation requested by the user supersedes repeated spec/plan approval prompts. Execute inline in the current checkout so existing app startup sees the feature.
- Ruling: use JIZURA layout/mainDraw/makeEnv contracts directly; do not instantiate its full-frame Renderer or call frame(). This avoids non-deterministic paper/grain and preserves transparent host composition.
- Review fix: map configured duration onto a complete three-second source motion. Scale spatial entrance/hold transforms, stack impulses and wave/flow amplitudes while preserving reveal timing. Zero strength is a still composition. Added low/high, zero, minimum-duration and typing reveal tests fail before their corrections.
- Export fix: the six sequential title integration test exposed opaque black tpad frames in the FFmpeg fallback before later clips start. Use transparent delay frames so upcoming titles cannot cover current ones.

- Verification (2026-10-02): 14 dynamic browser checks, 5 fancy checks, 6 chalk checks, TypeScript/Vite production build and existing export regression passed. All six presets matched preview pixels in the built hidden renderer and lossless alpha MOV; all six titles were visible in the final nine-second MP4.
- Review: independent follow-up confirmed reveal timing, spatial motion strength and minimum-duration completion fixes. Development preview returns HTTP 200 at http://127.0.0.1:5173; opened in the Codex browser panel for acceptance.
