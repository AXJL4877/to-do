# Full JIZURA composition integration

User intent: the complete expression engine inside the existing narrated
production extension, with automatic composition and full manual controls.
Direct implementation is already authorized by the user.

- Preserve version-1 clips and the unrelated uncommitted timeline fixes.
- Vendor every expression pack, planner, set/theme rules and Chinese labels.
- Keep the factory isolated; seed renderer grain/paper for reproducible export.
- Publish a generated catalogue of all registries and styles from that factory.
- Add version-2 composition configuration with literal timed scenes, shared
  segment seed, per-clip offset, full-frame/transparent background, style,
  mood, effect strengths and explicit part overrides.
- Use the upstream planner and complete Renderer.frame for v2; inject literal
  text and exact narration times so lyric syntax never alters spoken text.
- Carry all scenes into each production clip so transitions can reference
  the previous scene across clip boundaries; preserve host transforms/alpha.
- Extend the official skill manifest and single-clip editor with catalogue
  controls. Add native preview/export checks across every expression group,
  complete catalogue registration, backward seeks, fonts, alpha and JSON.
- Verify actual full narrated MP4, TypeScript/Vite build and blackboard
  production regression. Review before committing only this feature.
