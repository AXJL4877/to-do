# Extension package installation implementation plan

**Goal:** Ship a reusable extension authoring format and automatic drag/drop installation.

**Architecture:** Wrap existing manifests in a ZIP envelope, reuse existing validators and registries, and handle package drops before media drops. Installation never starts a generation job.

**Tech Stack:** Node filesystem/crypto, fflate 0.8.3, existing HTTP middleware, React/TypeScript.

**Spec:** ../specs/2026-10-09-extension-package-design.md

- [x] Write and run failing package installation tests.
- [x] Add server/extensionPacks.mjs for validation, packing and atomic installation; scripts/pack-extension.mjs for authors.
- [x] Add a bounded binary upload endpoint in server/aiHttp.mjs and test it.
- [x] Add src/lib/extensionImport.ts for file routing and global drop capture; reuse it from App and refresh pack lists.
- [x] Add browser regressions for drop capture, mixed media, errors and duplicate installation.
- [x] Deliver docs/extension-authoring.md and a working example .todoext, then run compatibility checks and build.

Execution: inline in the current workspace, retaining existing user changes.

Validation: extension:test (server packaging/install/HTTP plus 10 browser checks), skills:check, styles:check, anims:check, dynamic:production, production:test (10 checks), ui:test (19 checks), pack:paths, and build passed. AI services were mocked for the custom-ID generation test; no paid generation was requested. The 15,993-byte distributed example was installed successfully in isolated test data.

Independent review requested through requesting-code-review: fixed opaque Origin/simple request installation by requiring binary Content-Type, and reset obsolete draft parameters/plans on manifest version changes while preserving the prompt. Re-review reported no remaining material findings.
