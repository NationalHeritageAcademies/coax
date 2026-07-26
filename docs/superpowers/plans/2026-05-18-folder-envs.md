# Folder-scoped Environments Plan

**Goal:** Replace the current global+collection environment scopes with folder-scoped environments that cascade down the folder tree. Drop "global" envs entirely. Add drag-and-drop folder reparenting. Make export work from any node (collection or folder), bundling all descendants and inherited env vars into a single self-contained `.http` file.

**Reference:** `docs/superpowers/plans/2026-05-14-http-ui.md` (the original v1 plan, for context on the existing architecture)

---

## Design

### Data model

A collection has an implicit **root folder**. Every other folder has a `parentId` pointing at either the root folder or another folder. Envs always attach to a folder.

Schema:
- `folders` already has `parent_folder_id NULL` → reuse it.
- `environments.scope_kind` collapses to a single value: dropped. `environments.scope_id` becomes `folder_id` and is non-null. Migration creates a root folder per existing collection, moves collection-scoped envs to that root folder, and either drops or migrates existing global envs (see migration section).

Resolution order at send time, deepest wins:
```
collection root folder env → ... → request's parent folder env → request
```
Each folder along the chain may have its own *active env*; resolution merges the variables of all active envs along that chain.

### Resolver

`buildResolverContext(db, secrets, requestId)`:
1. Find the request's `folderId`.
2. Walk up via `folder.parent_folder_id` until we reach the root folder.
3. For each folder in the chain (root → ... → request's parent), pull its active env and the env's variables.
4. Merge variables with shallow-wins-then-deepest-overrides semantics, secret values decrypted on read.
5. Pass the merged map to `resolveVars`.

Chain (`{{name.response.body.$.x}}`) references work unchanged — they read from `last_responses` keyed by request `chain_name`, not from env vars.

### env-manager UI

The left aside becomes a **tree**, not flat sections. Each node is a folder; expand to see child folders; each node has its own env-list + "+ env" affordance. Selecting an env shows the vars panel on the right (unchanged).

The "active env per folder" is independent per folder, so the active-dot UI affordance stays. Folder rows show a chip if they have an active env (helps visualize the inherited chain).

### env-switcher

Becomes a **chain display** when a request tab is open: shows the folder chain top-down, with the active env at each level (or "—" if none). Click any level to swap its active env. Replaces the current single dropdown.

If no request tab is open, the switcher shows the collection-root chain only.

### Vars sub-tab

Two sections:
1. **Inherited** (read-only) — every var that resolves for this request via the chain, with a per-row badge showing the folder + env it came from. Sorted by chain depth so a reader can see the override path.
2. **Request-scoped** (editable) — variables stored at the request's parent folder's active env. Equivalent to what the Vars tab does today, but always operates on the closest folder env in the chain rather than just the collection-scoped one.

### Drag-and-drop reparenting

Sidebar tree gains drag handles on folders. Dropping a folder onto another folder updates its `parentId` (validating no cycles). Resolution picks up the new chain automatically at next send — no env copying happens.

A folder can be dropped onto:
- another folder (becomes child)
- the collection root (becomes top-level child of the collection)

Folders cannot be dragged out of their collection (collection identity is fixed).

### Export at any level

`collection:export` becomes `tree:export` with payload `{ nodeId, kind: 'collection' | 'folder', targetPath }`.

Algorithm:
1. Walk the subtree from `nodeId`: collect all requests, ordered as in the source.
2. Walk *up* from `nodeId` to the collection root, gathering all active envs.
3. Walk *down* from `nodeId` collecting any env vars from descendant folders' active envs.
4. Merge with deepest-wins; secrets stripped to `{{secretName}}` placeholders (same as today).
5. Emit a single `.http` file:
   - All resolved (non-secret) vars as `@key = value` at the top.
   - Each request as a `### name` block with method/url/headers/body, variable refs left as `{{key}}` so the importer's resolver re-binds them.
   - Chain references (`{{name.response.body.$.x}}`) left as-is — exports must be reproducible, not snapshotted.

The export-hygiene warnings (literal Authorization headers, literal secret leaks) carry over unchanged.

### Migration

Single new schema version. Down-migration not supported (this is a destructive refactor on dev/local DBs only).

1. Create a `root_folder_id` column on `collections`, FK to `folders.id`.
2. For each existing collection: create a row in `folders` with `parent_folder_id = NULL` and `collection_id = c.id`, name = `(root)`, set `c.root_folder_id = the new row id`.
3. For every existing folder with `parent_folder_id = NULL` (the old "top-level" folders), set `parent_folder_id = c.root_folder_id`.
4. For every environment with `scope_kind = 'collection'`, set `folder_id = c.root_folder_id`.
5. For every environment with `scope_kind = 'global'` — **prompt at startup** what to do: drop them, or move them into a chosen collection's root. v1 of this migration: just drop with a warning logged. (User authorized this earlier.)
6. Drop `environments.scope_kind` and `environments.scope_id`; add `folder_id NOT NULL` FK.

---

## Phase 0 — Schema migration

### Task 0.1: Write migration SQL

**Files:**
- Create: `src/storage/migrations/0002_folder_envs.sql`

- [ ] Add `root_folder_id INTEGER REFERENCES folders(id)` to `collections` (nullable for migration step).
- [ ] In the same migration: for each collection, insert a `folders` row with `parent_folder_id = NULL`, `name = '(root)'`, `collection_id = c.id`; set `c.root_folder_id`.
- [ ] Update existing folders with `parent_folder_id = NULL` to point at their collection's root.
- [ ] Add `folder_id INTEGER` column to `environments`; populate from `scope_id` when `scope_kind = 'collection'`, otherwise NULL.
- [ ] Delete environments rows where `scope_kind = 'global'` and `folder_id IS NULL` (log count).
- [ ] Drop `environments.scope_kind` and `environments.scope_id`; make `environments.folder_id NOT NULL`.
- [ ] After migration runs, make `collections.root_folder_id NOT NULL` (separate ALTER TABLE).

### Task 0.2: Update Repos.Envs

**Files:**
- Modify: `src/storage/repos.ts`
- Modify: `src/storage/types.ts`

- [ ] `Environment.scope` type changes to `{ kind: 'folder'; folderId: string }` only. Drop the `'global'` variant.
- [ ] `Envs.list(db, { folderId })` returns all envs for a folder.
- [ ] `Envs.create(db, { folderId, name })`.
- [ ] `Envs.setActive(db, folderId, envId)` — exactly one active per folder.
- [ ] `Envs.listForRequest(db, requestId)` returns the chain of envs (deepest first) for resolution.

### Task 0.3: Update buildResolverContext

**Files:**
- Modify: `src/resolver/context.ts` (or wherever it lives — likely under `src/app/`)

- [ ] Walk the folder chain from the request's parent folder up to the root.
- [ ] Pull the active env at each level.
- [ ] Merge variables with deepest-wins.
- [ ] Decrypt secrets via `Secrets` as today.

### Task 0.4: Update existing IPC handlers

**Files:**
- Modify: `src/app/handlers.ts`
- Modify: `src/ipc/types.ts`

- [ ] `env:list` payload: `{ folderId }` (was `{ scope }`).
- [ ] `env:create` payload: `{ folderId, name }`.
- [ ] `env:setActive` payload: `{ folderId, envId }`.
- [ ] New `env:listForRequest` payload: `{ requestId }`, returns ordered chain of `{ folderId, folderName, env: Environment | null }`.
- [ ] Remove `activeGlobalEnvId` from state and any handlers that surface it.

---

## Phase 1 — Resolver tests

### Task 1.1: Resolver chain tests

**Files:**
- Create: `tests/resolver/folder-chain.test.ts`

- [ ] Single-folder env resolves vars from that env.
- [ ] Nested: parent has `baseUrl`, child has `clientCode`; request inherits both.
- [ ] Override: parent has `baseUrl = a`, child has `baseUrl = b`; resolves to `b`.
- [ ] Secret in parent decrypted via active env walk.
- [ ] Empty envs along chain are skipped silently.

### Task 1.2: Repos tests

**Files:**
- Modify: `tests/storage/repos.test.ts`

- [ ] `Envs.listForRequest` returns the expected chain order.
- [ ] `setActive` is per-folder (no cross-folder interference).

---

## Phase 2 — env-manager UI

### Task 2.1: Folder tree in env-manager left aside

**Files:**
- Modify: `src/ui/components/env-manager.ts`

- [ ] Recursive folder tree component (or inline render). Each row: chevron, folder name, env count, active-env chip.
- [ ] Selecting a folder shows its envs in the right pane.
- [ ] Existing env-row UI moves into the right pane unchanged.

### Task 2.2: Active env affordance per folder

**Files:**
- Modify: `src/ui/components/env-manager.ts`

- [ ] Each env row gets a radio-style selector ("active" indicator).
- [ ] Clicking another env in the same folder swaps the active.
- [ ] Folder tree's active-env chip updates.

---

## Phase 3 — env-switcher (chain UI)

### Task 3.1: Replace dropdown with chain display

**Files:**
- Modify: `src/ui/components/env-switcher.ts`

- [ ] When a request tab is open: render one dropdown per folder in the chain (top-down), with the folder name as label and the available envs at that scope.
- [ ] When no tab is open: chain shows only the collection root.
- [ ] Each level's selection updates that folder's active env via `env:setActive`.
- [ ] The "+ env" affordance now scopes to the focused folder (currently scopes by `active tab's collection`).
- [ ] Remove the "re-extract from .http" button or move it to env-manager — it's collection-scoped recovery, doesn't fit a per-folder model. (Decision: move to env-manager's right pane as a header action when the selected folder is a collection root.)

---

## Phase 4 — Request Vars sub-tab

### Task 4.1: Inherited vs. request-scoped split

**Files:**
- Modify: `src/ui/components/request-tab.ts` (renderVarsPanel)

- [ ] Top section: "Inherited" — list every var from the resolver chain, with per-row badge: `<folder name> · <env name>`. Read-only.
- [ ] Bottom section: "Request" — editable list of vars at the request's parent folder's active env. Same edit/delete/secret semantics as today.
- [ ] References table at the bottom stays unchanged.

---

## Phase 5 — Drag-and-drop reparenting

### Task 5.1: Folder drag handles in sidebar

**Files:**
- Modify: `src/ui/components/sidebar-tree.ts`

- [ ] Folder rows get `draggable="true"`.
- [ ] `@dragstart` sets dataTransfer payload to `{ kind: 'folder', folderId }`.
- [ ] `@dragover` on folder rows accepts the payload (preventDefault) and highlights the drop target.
- [ ] `@drop` calls a new `folder:reparent` IPC handler with `{ folderId, newParentFolderId }`.

### Task 5.2: folder:reparent handler

**Files:**
- Modify: `src/app/handlers.ts`
- Modify: `src/storage/repos.ts`

- [ ] Validate: target folder must be in the same collection; cycle check (target cannot be a descendant of the dragged folder).
- [ ] Update `folders.parent_folder_id`.
- [ ] Return updated folder row. Renderer refreshes the workspace data.

### Task 5.3: Repo + resolver tests

**Files:**
- Modify: `tests/storage/repos.test.ts`
- Modify: `tests/resolver/folder-chain.test.ts`

- [ ] `reparent` updates `parent_folder_id`.
- [ ] Cycle attempt throws.
- [ ] After reparent, the dragged folder's requests resolve via the new chain.

---

## Phase 6 — Export at any level

### Task 6.1: tree:export handler

**Files:**
- Modify: `src/app/handlers.ts`
- Modify: `src/ipc/types.ts`
- Modify: `src/app/serialize.ts` (or wherever the .http emitter lives)

- [ ] New IPC kind `tree:export` with payload `{ nodeKind: 'collection' | 'folder', nodeId, targetPath }`.
- [ ] Walk subtree to collect requests in document order.
- [ ] Walk up the folder chain to gather inherited active env vars.
- [ ] Walk down through any descendant folders to merge in descendant vars (descendants override ancestors at export time, same as resolution).
- [ ] Secrets stripped to `{{secretName}}` placeholders.
- [ ] Emit `@key = value` block at top, requests as `### name` blocks below.
- [ ] Existing export-hygiene warnings carry through.
- [ ] Existing `collection:export` becomes a thin wrapper around `tree:export` for back-compat.

### Task 6.2: app-frame Export button gains a target picker

**Files:**
- Modify: `src/ui/components/app-frame.ts`

- [ ] If only one collection exists, behavior unchanged (export the collection root).
- [ ] Otherwise: open a dialog listing the workspace tree; user picks any node.

### Task 6.3: Sidebar context-menu export

**Files:**
- Modify: `src/ui/components/sidebar-tree.ts`

- [ ] Right-click on any folder or collection row offers "Export this folder…" → opens save dialog → calls `tree:export`.

### Task 6.4: Tests

**Files:**
- Modify: `tests/app/export-hygiene.test.ts`
- Create: `tests/app/tree-export.test.ts`

- [ ] Folder-level export contains only descendants.
- [ ] Embedded vars come from the chain at the export root.
- [ ] Secrets stripped.
- [ ] Existing collection-export tests still pass via the back-compat wrapper.

---

## Phase 7 — Cleanup

### Task 7.1: Remove global-env code paths

**Files:**
- Modify: `src/ui/store/state.ts` — drop `activeGlobalEnvId`
- Modify: `src/ui/store/lifecycle.ts` — drop the global-env load
- Search for `kind: 'global'` and remove dead branches

### Task 7.2: Update memory / docs

**Files:**
- Modify: project README (envs section)

- [ ] One-paragraph note on the new model: collection root + folder hierarchy, no global.

---

## Acceptance criteria

- [ ] All 124 existing unit tests pass.
- [ ] New folder-chain resolver tests pass.
- [ ] Playwright E2E (`tests-e2e/import-send-export.spec.ts`) still passes — may need to update its assertions around env names if the imported `.http` file's "From file" env now lives on a folder root.
- [ ] Manual smoke: import `oneroster-v1p1.http`, run a request, verify chain resolution works (token still substitutes from cached response).
- [ ] Manual: drag a folder under another, send a request, verify it picks up the parent's env vars.
- [ ] Manual: right-click a folder → Export → re-import the exported file as a new collection → vars round-trip.
