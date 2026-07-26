# Plan: Importers — Postman / Insomnia / Bruno

## Why
The switching cost from Postman is enormous if you have a 200-request collection. Removing that cost moves Coax from "interesting" to "I could realistically migrate."

## Goal
One-shot conversion of foreign collection formats into `.http` files + Coax metadata. Reuse the unified Import menu added in commit `ab0392f`.

## Formats

### Postman v2.1 collections (.json)
- Collection → top-level folder
- Folders → `############` divider blocks with folder names
- Requests → `### Title` blocks
- Environment files → Coax env file
- Variables → `@var` lines and `{{var}}` references
- Pre-request scripts → `# @pre-request` blocks (plan 05) with `pm.*` shim
- Tests → `# @test` lines, best-effort (Postman tests are arbitrary JS — convert common patterns, comment out the rest with a TODO marker)
- Auth: bearer/basic/api-key/oauth2 inline; oauth2 client credentials → pre-request script

### Insomnia v4 export (.json / .yaml)
- Workspace → folder
- Request groups → folders
- Requests → `### Title` blocks
- Environments (base + sub) → Coax env layering
- Plugin tags (`{% timestamp %}` etc.) → Coax builtins where they map, comment with TODO otherwise

### Bruno (.bru directory)
- Easiest of the three; already file-based with similar structure.
- Folder → folder. Each `.bru` file → request. Variables in `bruno.json` → env.

## Architecture
```
src/importer/
  index.ts           dispatcher (already exists for .http + Swagger)
  postman.ts         NEW
  insomnia.ts        NEW
  bruno.ts           NEW
  shared/
    var-substitute.ts   {{x}} → {{x}} (mostly), handle Postman's {{$randomInt}} etc.
    auth-mapper.ts      auth schemas → Coax auth
    script-converter.ts pm.* and insomnia equivalent → coax.*
```

Each importer exports `(input) => CoaxWorkspace`.

## UX
- Import menu already exists. Add three options.
- Drag-and-drop a `postman_collection.json` onto the sidebar → auto-detect format, prompt to confirm.
- After import, show a summary: "Imported 47 requests, 3 environments. 5 scripts converted with warnings — see Notices." Notices panel lists items that need manual review.

## Work breakdown
1. Collect 5–10 real-world fixtures per format (real exports, not synthetic ones — Postman files in the wild have decades of accumulated weirdness).
2. Build Postman importer + tests against fixtures.
3. Build Insomnia importer + tests.
4. Build Bruno importer + tests.
5. Build the "import notices" UI for warnings.
6. Wire script converter to plan 05's `pm.*` shim.
7. Document per-format limitations in `docs/importing.md`.

## Risks / open questions
- **Postman scripts are Turing-complete JS.** We will *never* convert 100%. Be explicit: convert what we can, comment out and flag what we can't, encourage the user to rewrite the rest using our pre-request script API.
- **Insomnia plugin tags** depend on user-installed plugins; we can't run those. Convert known ones, flag unknown ones.
- **Variable name collisions** between Postman env + collection vars. Resolution rule: Postman env wins (matches Postman runtime), Coax env layering covers the rest.

## Definition of done
- A real-world Postman collection from a major API provider (e.g. Stripe, Twilio) imports cleanly enough that the first request runs without manual edits.
- Insomnia export from a real workspace imports cleanly.
- Bruno directory imports without warnings.
- `docs/importing.md` documents every known compat caveat per format.
