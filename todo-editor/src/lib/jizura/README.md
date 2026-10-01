# JIZURA drawing core

Source: https://github.com/852wa/JIZURA
Revision: fc16bfe43ea4a6c25a21f1caf04d17326de14f00 (VERSION 0.10.1).
Copyright (c) 2026 hakoniwa. MIT; see LICENSE.

Reproduce with `node scripts/vendor-jizura.mjs <upstream-checkout>`.
The selected upstream files are concatenated inside createJizura(); window.J is replaced with a private namespace.
Local stack impulse expressions multiply spatial movement by motion strength while preserving word reveal timing. The reproducible patch is listed in scripts/vendor-jizura.mjs. The adapter additionally scales entrance/hold transforms and wave/flow amplitudes.
The application uses layout.plan/render, mainDraw and Renderer.prototype.makeEnv. It does not instantiate the full-frame Renderer, whose grain/paper initialization uses Math.random, and does not call remote font loading, audio or export functions.
All active effects use the upstream seeded randomness. Local fonts are mapped by the adapter for both measurement and drawing.
No mp4-muxer or external font binaries are included.
The same license is shipped in public/licenses/JIZURA.txt and copied into dist for redistribution.
