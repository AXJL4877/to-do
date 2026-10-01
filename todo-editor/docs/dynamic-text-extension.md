# Dynamic text extension

Entry: 拓展 → 动态文字. The six JIZURA templates are registered in
`src/lib/dynamicTextPack.ts`, outside `FANCY_PRESETS` and the font library.
`SkillsPanel` lists the local pack beside the existing server-backed packs.
It remains available while other packs load or their service is unavailable.

`DynamicTextPanel` owns the extension page. `TextPresetEditor` shares the text,
font, preview and clip editing controls with the ordinary font library, but
selects a separate registry and only edits clips belonging to its mode.
The existing blackboard generation workflow stays in its own workbench.

The pack runs locally and inserts editable transparent text clips. Saved
version-1 JIZURA clip parameters retain their original schema, so existing
projects remain compatible. The inspector routes their editing link to the
extension page. Preview and export continue using the same renderer.

Validation: `npm run dynamic:test`, `npm run dynamic:export`,
`npm run chalk:test`, `npm run fancy:check`, and `npm run build`.
