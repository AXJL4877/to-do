# Dynamic text production extension

Entry: 拓展 → 动态文字 → 口播文案 → 一键成片.
The authoritative package is server/skills/dynamic-text/skill.json, using
the same todo-skill-pack/1 manifest, production documents, queue, retries,
voice synthesis, subtitle generation, incremental updates and timeline
placement as the blackboard extension.

The fixed text/jizura runtime uses the host Canvas renderer. It requires no
image generation: narration phrase timestamps are split into short literal
text scenes, then assigned effects, colors and seeded motion. Phrase chunks
use proportional timing within a phrase and retain punctuation. Documents
store editable text descriptors rather than image variants. Synchronization
inserts text clips linked to their voice; sequence export uses the same engine.

The frontend reads metadata from the same manifest. SkillsPanel opens the
production workflow, including voice, aspect ratio, effects and subtitles.
ProductionStudio edits narration and text scenes and reruns changed layers.
The inspector opens DynamicTextPanel only for editing individual timeline
clips. The font library contains no dynamic entry. Saved version-1 clips
remain compatible.

Validation: npm run dynamic:production, npm run production:test,
npm run dynamic:test, npm run dynamic:export, npm run skills:check,
and npm run build. The export integration checks audio/video streams and
visible text in every scene of an automatically placed production.
