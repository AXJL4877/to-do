# JIZURA expression engine

Vendored from JIZURA 0.10.1, fc16bfe43ea4a6c25a21f1caf04d17326de14f00, MIT hakoniwa.

`engine.js` contains all expression registries, planner, unification rules, themes, complete renderer and expression packs (860 parts, 27 styles). `catalog.ts` exposes the generated shared catalogue. Chinese registry names come from upstream app/chinese_hans.js; style names from its i18n_zh_hans.py dictionary captured in shared/jizura-style-zh.json.

Local patches: private factory namespace, seeded grain/paper textures, kinetic stack motion strength. Reproduce with scripts/vendor-jizura.mjs followed by scripts/catalog-jizura.mjs. No global window.J, remote font loading, audio/export/UI modules or mp4-muxer are included. MIT notice ships in public/licenses/JIZURA.txt.

Version 1 uses the original six transparent templates. Version 2 uses fullComposition.ts and Renderer.frame, injecting literal text and exact narration timing. Host fonts, transforms, alpha, timeline, voice/subtitles and video export remain the editor's responsibility.
