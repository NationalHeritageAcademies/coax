# Future plan: folder-first storage model

> **Status:** future, post-v1.0 architecture pivot. Captured 2026-05-23 after a design conversation that started as "GitHub sync" and quickly clarified that the right answer is a deeper architectural change: make the `.http` file the source of truth instead of SQLite.

## Why

Today, Coax's source of truth is `<userData>/workspaces/<id>.sqlite`. `.http` files are an import/export format — *aspirationally* the source of truth (per the marketing site's "your API workspace is just a `.http` file") but not actually.

That gap matters because it forces every cross-machine and team-sharing story to invent something extra: a sync layer, a server, a conflict-merge engine, format extensions for envs. All complexity that exists only because the file isn't really the thing.

Folder-first inverts the relationship:

- The workspace **is** a folder of `.http` files plus sibling JSON files for envs. That's all that lives in the user's workspace folder.
- Every UI edit writes back to those files immediately.
- SQLite stays as a fast derived cache, but lives in user-data (`~/Library/Application Support/Coax/workspaces/<hash>/cache.sqlite`), not in the workspace folder. Rebuildable from the files at any time.
- Cross-machine sync becomes "clone the repo on the other machine" — not a feature Coax has to ship.
- Per-API-project workflows ("the .http files live next to the API code they exercise") work for free.

Every feature in the codebase that already round-trips through `.http` (parser, serializer, `@id` directive shipped 2026-05-23, exporter, importer) is *already aligned* with this direction. The SQLite layer is the only thing in the way.

## What this replaces

This plan supersedes [`github-sync.md`](github-sync.md). When folder-first lands, sync becomes a non-feature: the user clones their repo on another machine and opens the same folder. No semantic-merge layer, no auto-push, no Coax-managed repo layout. Delete `github-sync.md` when this ships.

## File and directory layout

The workspace is a folder the user picks (or a sensible default like `~/Documents/Coax/<workspace-name>/`). Inside that folder:

```
<workspace-root>/
├── scholargateway.http              # collection — source of truth (committed)
├── scholargateway.dev.env.json      # env "dev" (committed)
├── scholargateway.staging.env.json  # (committed)
├── scholargateway.prod.env.json     # user gitignores this if it holds prod creds
├── tests/integration/
│   ├── login.http                   # another collection, adopted in-place
│   └── login.dev.env.json
└── (literally nothing else from Coax — workspace folder stays the user's)
```

**Coax adds zero files to the workspace folder.** All per-machine state lives outside the workspace, in user-data:

```
~/Library/Application Support/Coax/workspaces/<hash-of-workspace-path>/
├── cache.sqlite                # parsed-form cache + indices, keyed by request id
├── cache.sqlite-shm
├── cache.sqlite-wal
├── active-envs.json            # which env is active per folder
└── preferences.json            # per-workspace user preferences (if any)
```

The workspace is identified by the **absolute path of the folder you opened.** Open `~/code/scholargateway-api/` → Coax hashes that path → `<hash>` is the user-data subdirectory. Move the folder later? The cache becomes orphaned and Coax rebuilds it on next open — a few seconds of re-parse. Acceptable.

This is the same separation VS Code uses: workspace-shared things go in the workspace folder (under `.vscode/`); workspace-aware *per-machine* things go in `~/Library/Application Support/Code/User/workspaceStorage/<hash>/`. Two different concerns, two different homes.

### What's committed vs. gitignored

| Path | In git? | Why |
|---|---|---|
| `*.http` | ✅ | Source of truth for collections. |
| `*.env.json` (non-prod) | ✅ | Shared env definitions. Secrets stay out via `secretId` references. |
| `*.prod.env.json` | user's call | If the file holds production credentials, gitignore it. Coax suggests this on first adoption but doesn't auto-edit `.gitignore`. |
| Anything outside the workspace folder | n/a | Coax's per-machine state lives in `~/Library/Application Support/Coax/` — git doesn't see it. |

The user's `.gitignore` needs **no Coax-specific entries**. The workspace folder stays the user's own.

### Why there's no `.coax/` directory in the workspace

An earlier draft of this plan put `.coax/` in the workspace folder for cache + per-machine state. Walking through what was in it:

- `cache.sqlite` → derived data, per-machine. No reason to be in the workspace folder.
- `active-envs.json` → per-machine selection. Same.
- `preferences.json` (theoretical) → per-user preferences. Same.

None of it was workspace-shared. Every file was per-machine. Putting them inside the workspace just meant the user had to gitignore them — a `.coax/` line in their `.gitignore` they otherwise wouldn't need.

The clean answer is: per-machine state lives in user-data. The workspace folder stays the user's. Nothing to gitignore.

### When might `.coax/` come back?

Only if we introduce **team-shared workspace settings** that:
- The team genuinely wants synced via git
- Don't belong in the `.http` or `.env.json` files themselves
- We can actually name (right now we can't)

If/when that happens, we'd add `.coax/settings.json` and commit *that one file*. But there's no use case for it today, and "speculatively reserve a directory" is exactly the kind of decision that locks in design debt.

### Marking a folder as "a Coax workspace"

No explicit marker. **A folder is a Coax workspace if it contains `.http` files.** Same convention VS Code uses ("this is a Node project if `package.json` exists"). Open any folder; if Coax finds `.http` files in it, it adopts them.

## File naming conventions

| Kind | Pattern | Examples |
|---|---|---|
| Collection | `<name>.http` | `scholargateway.http`, `login.http` |
| Env (one file per env, per collection) | `<collection>.<env-name>.env.json` | `scholargateway.dev.env.json`, `login.staging.env.json` |

The env-file pattern (`<collection>.<env>.env.json`) makes per-env gitignore trivial: `*.prod.env.json` excludes prod across all collections; `scholargateway.local.env.json` excludes one specific local env.

## Env JSON schema

```json
{
  "$schema": "https://coax.melodic.dev/schema/env.json",
  "name": "dev",
  "scopes": [
    {
      "folder": "/",
      "vars": [
        { "key": "baseUrl", "valuePlain": "https://dev.example.com" },
        { "key": "token", "isSecret": true, "secretId": "scholargateway-dev-token" }
      ]
    },
    {
      "folder": "/assessment",
      "vars": [
        { "key": "assessmentApiKey", "isSecret": true, "secretId": "scholargateway-assessment-dev" }
      ]
    }
  ]
}
```

- **One file = one (collection × env-name) pair.** All folder-scopes for that pair live in `scopes[]`.
- **`$schema`** is optional but enables editor autocomplete; we'll host a JSON Schema at that URL eventually.
- **Folder paths in `scopes[].folder`** are relative to the collection root (matching how the `.http` file encodes its own folder tree via title-path directives).
- **Secrets are *never* in the JSON.** `{ isSecret: true, secretId: "..." }` references a value stored elsewhere (OS keychain locally, env var in CI).

### Secret resolution order at runtime

1. `process.env["COAX_SECRET_" + secretId]` — for CI / scripted use.
2. OS keychain (via `safeStorage`) — for normal local desktop use.
3. Prompt the user — if neither is set and Coax is interactive.

This makes the same env JSON work in three contexts (dev's laptop, teammate's laptop after clone, CI runner) without modification.

## Workspace adoption rules

When Coax opens a folder for the first time:

1. **Compute the workspace hash** from the absolute folder path. Ensure `~/Library/Application Support/Coax/workspaces/<hash>/` exists.
2. **Scan for `.http` files.** Default scope: workspace root non-recursively. A future per-workspace setting can broaden this to specific subfolders.
3. **For each `.http` file found:** offer to adopt it as a collection. Default = adopt. User can deselect.
4. **Adopted files stay where they are.** Never moved. The path is recorded in `<userData>/.../cache.sqlite` (along with the file's mtime + the parsed model) for fast reopen.
5. **For each adopted `<name>.http`:** look for sibling `<name>.<env>.env.json` files and adopt them as envs for that collection.
6. **Build the cache** by parsing the adopted files into `cache.sqlite`. This is the only DB write on first open; everything else is reads.
7. **Show the gitignore tip** on first adoption *only if* the workspace folder is inside a git repo and any `*.prod.env.json` exists: "You may want to add `*.prod.env.json` to your `.gitignore` to keep production credentials out of the repo." One-shot, dismissable, never auto-edits the user's `.gitignore`. Coax itself adds no files to the workspace, so there's nothing else to suggest.

When the user creates a new collection in the UI:

1. Coax writes `<new-name>.http` at the workspace root (or the user's chosen collections subfolder).
2. `cache.sqlite` learns about it.
3. Sidebar updates.

When the user renames or deletes a collection in the UI:

1. Rename/delete the `.http` file.
2. Find and rename/delete any sibling `<old-name>.<env>.env.json` files in the same directory.
3. Update `cache.sqlite`.

When the user moves a `.http` file outside Coax (e.g. `git mv`):

1. Next open / refresh detects the previous path no longer exists.
2. Coax scans for the file under its new location (matching by `@id`-stamped first request, falling back to filename).
3. If found: update the cache entry. If not: prompt the user to relink or remove.

Because the cache is gitignored, a fresh clone on a new machine starts from "scan + adopt" — there's no manifest to get out of sync with the files. The files *are* the manifest.

## Atomic writes

Every write to a `.http` or `.env.json` file uses fsync-rename:

```
1. Serialize new content to a string.
2. Write to <path>.coax-tmp-<pid>.
3. fsync the tmp file.
4. Rename <path>.coax-tmp-<pid> → <path>.
```

This guarantees a power-loss mid-write doesn't corrupt the file. The reader either sees the previous version or the new version, never a half-written one.

## Debouncing

UI edits that fire on every keystroke (typing in a URL field, a body editor) debounce ~300ms before triggering a file write. Structural edits (adding a header, changing the method, reordering) write immediately. Heuristic: writes happen on a settle point, not on every microscopic mutation.

## External edits

If the user opens the workspace folder and edits a `.http` file in their own editor (VS Code, vim) while Coax is running:

**v1: refresh-on-focus.** When the Coax window regains focus, re-stat every adopted file. If any `mtime` is newer than the cache, re-parse from disk and reconcile. Same approach VS Code uses for files modified outside its own buffer.

**Future: file-watcher (chokidar)** for live updates while Coax stays in the foreground. Strictly an upgrade; refresh-on-focus is sufficient for v1.

## Active-env state (per machine)

`~/Library/Application Support/Coax/workspaces/<hash>/active-envs.json` (per-machine, never in the workspace folder):

```json
{
  "/scholargateway": "dev",
  "/tests/integration/login": "staging"
}
```

Keys are workspace-relative folder paths (matching the adopted collection locations). Values are the selected env name for that folder. Per-machine: your laptop and CI have independent files.

If a folder has no entry, the UI picks the first env alphabetically as a default and asks the user before persisting the choice.

## Migration from SQLite-only (existing users)

On first launch after the folder-first build ships, for each workspace currently stored in `<userData>/workspaces/<id>.sqlite`:

1. Detect: old workspace SQLite exists, no folder-first workspace has been picked yet.
2. Prompt the user: "Coax now stores collections as files in a workspace folder. Where do you want this workspace's files to live?" with a default of `~/Documents/Coax/<workspace-name>/`.
3. Export every top-level collection as `<name>.http` (already supported via existing `collection:export`).
4. Export every env as a sibling `.env.json` (new code, but mechanical).
5. Move secrets from the old SQLite-backed secret store to OS keychain with stable `secretId`s referenced from the new env JSONs (most are already keychain-stored; verify).
6. Initialize the per-machine cache at `~/Library/Application Support/Coax/workspaces/<hash>/cache.sqlite` by parsing the just-written files. The workspace folder itself stays clean — no `.coax/` directory, no files added.
7. Leave the old `<userData>/workspaces/<id>.sqlite` in place but stop using it. After the user confirms the new workspace works on next launch, prompt to clean up the old DB.

This is one-shot and transparent. Existing users see a "Choose where to keep your workspace" dialog on first launch after the upgrade, then everything keeps working.

## Build pipeline / CI usage

CI is a first-class consumer of this model. The same `.http` file the dev edits in Coax is the spec CI runs.

### Concrete example

```yaml
# .github/workflows/api-tests.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: melodicdev/setup-coax@v1
      - name: Run API integration tests
        run: coax run tests/integration/login.http --env=staging
        env:
          COAX_SECRET_scholargateway-staging-token: ${{ secrets.STAGING_TOKEN }}
          COAX_SECRET_scholargateway-staging-refresh: ${{ secrets.STAGING_REFRESH }}
```

### What the CLI sees

- **`tests/integration/login.http`** — committed in the repo. Parsed directly.
- **`tests/integration/login.staging.env.json`** — committed in the repo (it's not the prod env). Loaded automatically because it's the sibling matching `--env=staging`.
- **Secret references** in the env JSON are resolved by looking at `COAX_SECRET_<secretId>` env vars set by the CI runner from its secrets store.
- **No cache, no keychain, no GUI state needed.** Cache is per-machine; the CLI just doesn't use one. Or it builds a temp cache and discards it.

### What if the env file isn't in the repo (e.g. prod)?

Two patterns, both supported:

**A. Reconstruct the env JSON at the start of the job:**

```yaml
- name: Materialize prod env
  run: |
    cat > scholargateway.prod.env.json <<EOF
    { "name": "prod", "scopes": [{ "folder": "/", "vars": [
      { "key": "baseUrl", "valuePlain": "${{ secrets.PROD_BASE_URL }}" },
      { "key": "token", "isSecret": true, "secretId": "scholargateway-prod-token" }
    ]}]}
    EOF
- name: Run prod smoke tests
  run: coax run smoke.http --env=prod
  env:
    COAX_SECRET_scholargateway-prod-token: ${{ secrets.PROD_TOKEN }}
```

**B. Override individual values via CLI flags:**

```yaml
- run: |
    coax run smoke.http --env=staging \
      --var baseUrl=${{ secrets.PROD_BASE_URL }} \
      --var token=${{ secrets.PROD_TOKEN }}
```

Pattern A is cleaner for non-trivial envs; pattern B is fine for one-off overrides.

### Why this design is honest about CI

- No Coax-specific YAML to write beyond the `coax run` invocation.
- No "did the cache get committed?" footguns — cache is gitignored and the CLI doesn't need it.
- No "is Coax installed correctly on the runner?" pain beyond installing one binary.
- Secrets never enter the repo. They flow runner-secrets → env-var → CLI, the way every other CI tool does it.

## SQLite cache contents

`~/Library/Application Support/Coax/workspaces/<hash>/cache.sqlite` holds derived data — the database doesn't have to be the source of truth for anything in here, but having it speeds up the GUI substantially:

- Parsed forms of every `.http` file, indexed by request id for fast lookup.
- Last-response per request (already in SQLite today).
- Tab state (already in SQLite today).
- Run history.
- Any computed indices over the file contents (e.g. "all requests referencing variable X").

On first open after a `git pull` that changed several `.http` files, the cache picks up the mtimes via the refresh-on-focus mechanism and updates the relevant rows.

## Work breakdown (when this is built)

Rough order, 2–3 focused days as discussed:

1. **Storage layer** — read/write `.http` and `.env.json`, atomic write helper, debounce, workspace adoption rules.
2. **Workspace bootstrap** — scan + parse + populate cache on open.
3. **IPC handler rewire** — every mutation handler also writes to the file (~15–20 handlers).
4. **First-launch UX** — folder picker with `~/Documents/Coax/<name>/` default.
5. **Migration path** — existing SQLite-only users → folder workspaces.
6. **Refresh-on-focus** — single document-level event listener.
7. **Marketing site copy update** — the "your workspace is just a `.http` file" claim becomes literally true.
8. **Make the 300+ tests pass** — most are agnostic, some need updates for the new write path.
9. **Build a DMG from the branch** for manual smoke testing on a real API repo.

The actual writing is the small part; the testing pass that catches all the corner cases is the bigger part.

## What doesn't change

- Parser (`src/parser/`) — already round-trips, including the new `@id` directive.
- Serializer — same.
- OS keychain — secrets continue to live there per-machine.
- Licensing, telemetry, marketing site infrastructure, EULA — orthogonal.
- The IPC dispatch shape and RPC handlers' *signatures* — only their *implementations* change.
- UI components — the sidebar tree, request tab, env manager all read the same in-memory signals; they don't know whether the data came from SQLite or files.

## When to build

After:
- v1.0 ships with the current SQLite model and gets real customers.
- Customer signal confirms cross-machine sync / team-sharing is the next-most-asked-for feature.
- We're willing to invest the 2–3 days of focused work + a few weeks of soaking on a branch before merging.

Before:
- Any further investment in the SQLite-only model that we'd have to throw away.
- Shipping the team-tier features (which would assume a particular sync mechanism — better to pivot first, then build team-tier on top).

## Open questions to resolve when building

- **Schema versioning** for `.env.json` — `$schema` URL is one approach; explicit `version` field is another. Probably both, additive only.
- **Conflict UI for orphaned env files** after a manual `git mv` — wire-frame the relink dialog.
- **Performance ceiling for the refresh-on-focus scan** — how big can a workspace get before re-statting every file becomes noticeable? Probably very large; verify with a stress test.
- **First-open vs. re-open scan cost.** First-open has to parse every file. Re-open uses `cache.sqlite` keyed on mtime to skip unchanged files. Worth measuring the first-open cost on a 100-collection workspace before declaring scan-each-time fast enough.
