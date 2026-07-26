# Coax — Design Spec

**Date:** 2026-05-14
**Status:** Approved — ready for implementation planning

A cross-platform desktop HTTP client that imports, edits, and executes `.http` files (VS Code REST Client / JetBrains HTTP Client format), with workspace-level collections, layered environments, secret handling, and shareable export.

---

## 1. Goals

1. Open existing `.http` files, present each request in an attractive UI, let the user fill in `{{variables}}` and send the request.
2. Author new requests through forms (URL, method, headers, body, params, auth) and save into collections.
3. Group requests into collections and folders that survive across sessions.
4. Switch between environments (dev / staging / prod) without editing files.
5. Handle tokens and other secrets safely; allow exporting collections to share with others without leaking those secrets.
6. Cross-platform: macOS, Windows, Linux.

## 2. Non-Goals (v1)

- Pre-request / post-response JS scripting.
- Full execution history with diffing (only "last response" is stored).
- Auto re-import when a `.http` file changes on disk (planned for v2).
- Save-response-to-file (planned for v2).
- Cloud sync, team workspaces, or live collaboration.

## 3. Tech Stack

| Layer | Choice |
|---|---|
| Shell | Electron (latest stable), TypeScript, `contextIsolation: true`, `nodeIntegration: false` |
| UI framework | `@melodicdev/core` 1.6.x + `@melodicdev/components` 1.6.x (web components, signals, theme) |
| Code editor | Monaco, wrapped as a `<http-monaco-editor>` custom element |
| HTTP client | `undici` running inside a Node `worker_threads` worker |
| Storage | SQLite via `better-sqlite3`, one file per workspace under `app.getPath('userData')` |
| Encryption | Electron `safeStorage.encryptString` for secret variable values |
| Build | Vite (renderer) + esbuild (main) via `electron-vite`; Playwright + Vitest for tests |

Choices the user explicitly made: Electron over Tauri/Wails; Monaco over CodeMirror; vertical request/response split inside tabs; SQLite over JSON; main-process execution over renderer; encrypted-in-DB secrets over OS keychain so secrets travel with the workspace.

## 4. Architecture

```
┌──────────────────────────── Electron App ─────────────────────────────┐
│                                                                       │
│  ┌─────────────── Renderer (Chromium) ──────────────┐                 │
│  │  Melodic web components UI                       │   typed IPC     │
│  │   • <ml-app-shell> + <ml-sidebar>                │ ◄────────────►  │
│  │   • Request tabs, Monaco editor (wrapped),       │   (preload      │
│  │     response viewer, env switcher                │    contextBridge)│
│  │   • Workspace state via Melodic signals          │                 │
│  └──────────────────────────────────────────────────┘                 │
│                                                                       │
│  ┌─────────────────── Main (Node) ──────────────────┐                 │
│  │   • SQLite workspace (better-sqlite3)            │                 │
│  │   • .http parser & serializer                    │                 │
│  │   • Variable resolver (layered)                  │                 │
│  │   • safeStorage encryption for secrets           │                 │
│  │   • File dialogs, import/export                  │                 │
│  │   • Spawns one Worker per workspace              │                 │
│  │                                                  │                 │
│  │   ┌─────── HTTP Runner Worker (undici) ──────┐  │                 │
│  │   │ abortable, concurrent, streamed bodies   │  │                 │
│  │   └──────────────────────────────────────────┘  │                 │
│  └──────────────────────────────────────────────────┘                 │
└───────────────────────────────────────────────────────────────────────┘
```

**Why this shape:**
- Strict main/renderer split. Renderer runs Chromium with no Node — safer, plays well with Melodic's web-component model.
- HTTP execution in a worker: cancel mid-flight without blocking SQLite, run "Send all in folder" concurrently, bypass browser fetch limitations (CORS, mixed-content, self-signed certs).
- Parser lives in main so the future on-disk watcher can reuse it.
- Monaco wrapped as a custom element so the rest of the UI is uniformly Melodic.

## 5. UI / UX

### 5.1 Layout

```
┌─ <ml-app-shell> ──────────────────────────────────────────────────────────────┐
│ [Workspace ▾]   Env: [dev ▾]   ───── tab1 · tab2* · + ─────   [⚙] [🌓]        │
├─────────────────┬─────────────────────────────────────────────────────────────┤
│ <ml-sidebar>    │  ┌──── active request tab ──────────────────────────────┐  │
│                 │  │ [GET ▾] {{baseUrl}}/.../users/{{id}}     [ Send ▾ ]  │  │
│ ▾ OneRoster     │  ├───────────────────────────────────────────────────────┤  │
│   ▸ Auth        │  │ Params · Headers · Body · Auth · Vars · cURL          │  │
│   ▾ Users       │  │ <ml-data-grid editable>  or  <http-monaco-editor>     │  │
│     • Get all   │  │                                                       │  │
│     • Get by id │  ├────── 200 OK · 142 ms · 4.2 KB ──────────────────────┤  │
│     • New       │  │ Body · Headers · Raw · Save▾                          │  │
│   ▸ Schools     │  │ <http-monaco-editor readonly language=json>           │  │
│ ▾ Environments  │  │                                                       │  │
│   • global      │  │                                                       │  │
│   • dev (active)│  │                                                       │  │
│   • staging     │  └───────────────────────────────────────────────────────┘  │
├─────────────────┴─────────────────────────────────────────────────────────────┤
│ status bar: workspace path · last-saved · Send: ⌘↩  · New tab: ⌘T            │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Sidebar
Single tree (`<ml-sidebar>`) with two top-level groups:
- **Collections** — workspace → collection → folder → request. Each request row shows a colored method tag (`<ml-tag>`).
- **Environments** — global + per-collection envs. Active env is bold.

Right-click context menu on any node: rename, duplicate, delete, move, copy as cURL, export.

### 5.3 Tabs
Each open request opens in a tab. Conventions:
- `*` after the title = unsaved changes.
- Middle-click closes a tab.
- Tabs reorder by drag.
- Tab list persists across app restarts (`open_tabs` table).
- Special tab kinds: collection settings, environment editor, variables editor — opened via the same tab strip.

### 5.4 Top bar
- Workspace switcher (left) — switch between workspaces, create new, open from disk.
- Active environment dropdown — visible at all times so the user knows what `{{vars}}` will resolve against.
- Tab strip (center).
- Settings button + theme toggle (uses `applyTheme('light' | 'dark' | 'system')` from `@melodicdev/components/theme`).

### 5.5 Request tab — vertical split
- Method dropdown + URL input + split Send button.
- Sub-tabs: **Params**, **Headers**, **Body**, **Auth**, **Vars**, **cURL**.
  - Params/Headers: `<ml-data-grid>` with editable rows (key, value, description, ✕).
  - Body: `<http-monaco-editor>` with language picker (json/text/xml/graphql) + multipart form builder.
  - Auth: `<ml-select>` for kind (None / Bearer / Basic / API Key / Inherit) + form fields per kind.
  - Vars: list of in-scope variables with their resolved values + which layer they came from (debugging aid).
  - cURL: read-only `<http-monaco-editor>` showing the equivalent `curl` command (with secrets masked) + Copy button.
- Divider.
- Response panel: status pill, time, size, then sub-tabs **Body**, **Headers**, **Raw**. (A "Save response" button is planned for v2 and intentionally absent from v1.)

### 5.6 Send button
Split button. Main action sends the current request. Menu:
- "Send without env substitution" — debugging mode; sends with `{{var}}` literals intact.
- "Send all in folder" — concurrent run of every request in the parent folder.

("Send and download response" is a v2 follow-on once save-response-to-file lands.)

### 5.7 Theming
`@melodicdev/components` ships light + dark via `data-theme`. Default to `system`. Toggle in the top bar.

## 6. Data Model

### 6.1 SQLite schema

```
workspaces        (id, name, created_at, updated_at, settings_json)
collections       (id, workspace_id, name, parent_collection_id NULL, sort_order)
folders           (id, collection_id, parent_folder_id NULL, name, sort_order)
requests          (id, collection_id, folder_id NULL, name, method, url,
                   headers_json, body_text, body_kind, auth_json, sort_order)
environments      (id, scope_kind, scope_id NULL, name, is_active)
                   -- scope_kind: 'global' | 'collection'
variables         (id, env_id, key, value_plain NULL, value_secret_blob NULL,
                   is_secret BOOL, description)
last_responses    (request_id PK, status, headers_json, body_blob,
                   ms, size_bytes, executed_at, error_text NULL)
open_tabs         (id, request_id, sort_order, is_pinned, is_dirty,
                   draft_json NULL)
http_files        (id, collection_id, path, last_imported_at, hash)
```

Notes:
- `body_kind` ∈ `none | text | json | form | multipart | graphql`.
- `value_secret_blob` is the output of `safeStorage.encryptString(plaintext)`; `value_plain` is `NULL` when `is_secret = 1`.
- `draft_json` on `open_tabs` holds in-progress edits so unsaved work survives a crash.
- `http_files` records the source path + content hash for the future on-disk watcher (v2).

Workspace DB lives at `${app.getPath('userData')}/workspaces/<workspace-id>.sqlite`. A small `app.json` next to it lists known workspaces.

### 6.2 Variable resolution

Resolution happens in main right before send. Order (highest precedence first):

1. Request-local `@var = value` definitions (parsed from the request's draft).
2. Active environment for the request's collection.
3. Active **global** environment.
4. Collection defaults (a hidden env named "Defaults" auto-created per collection).
5. Built-ins: `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$guid}}`, `{{$randomInt min max}}`.
6. Response-chain refs: `{{name.response.body.$.path}}` — JSONPath against the named request's last cached response.

Unresolved `{{x}}` does not error. The literal text is sent as-is and the request bar shows a yellow ⚠ chip; clicking it opens the Vars editor with the missing key pre-filled.

Active env per scope is sticky — stored in `settings_json`.

## 7. .http Parser & Serializer

### 7.1 Parser (TypeScript, pure, in main)

```ts
parseHttpFile(text: string): ParsedFile
type ParsedFile = { variables: VarDef[]; requests: ParsedRequest[] }
type ParsedRequest = {
  name?: string                              // from `# @name foo`
  title: string                              // from `### Title` line
  method: HttpMethod
  url: string                                // raw, with {{vars}} intact
  headers: { key: string; value: string }[]
  body?: { kind: BodyKind; raw: string; parts?: MultipartPart[] }
  hints: { graphql?: boolean; file?: string; contentType?: string }
  range: { startLine: number; endLine: number }
}
```

Grammar (line-based, pragmatic — not a full PEG):

| Token | Pattern |
|---|---|
| Variable def | `^@(name)\s*=\s*(value)$` |
| Separator | `^###\s*(.*)$` — opens a new request, captures title |
| Name hint | `^#\s*@name\s+(\w+)$` |
| GraphQL hint | `^#\s*@graphql$` |
| File hint (body) | `^<\s+(path)$` — body comes from a file on disk |
| Request line | `^(GET\|POST\|PUT\|PATCH\|DELETE\|HEAD\|OPTIONS)\s+(\S+)\s*(HTTP/\S+)?$` |
| Header | `^([A-Za-z0-9\-_]+):\s*(.*)$` (only between request line and blank line) |
| Body | everything after the first blank line up to next `###` |
| Multipart | when `Content-Type: multipart/...` — split body on `--boundary` markers into parts |
| Comment | `^#` or `^//` (non-significant unless `@name`/`@graphql`) |

### 7.2 Serializer

Inverse of the parser. **Preserves order, comments, and blank lines** by using each request's `range` to re-emit only what changed. New requests/variables are appended in canonical form.

This means import → edit one request → export produces a minimal diff — important for the "share collections" goal so reviewers can sanity-check changes.

### 7.3 Import flow

1. User picks a `.http` file. Main parses it.
2. Each request becomes a `requests` row inside a new collection. Folder structure is derived from `### Section` divider patterns (e.g. the `############` blocks in the example files).
3. `@var` definitions become a per-collection environment named "From file" so the user can switch envs without losing the original values.
4. File path + content hash recorded in `http_files`.

### 7.4 Export flow

1. User picks a collection + target path.
2. Main serializes back to `.http`.
3. **Export hygiene** runs first:
   - Strip every `value_plain` for `is_secret = 1` variables; emit the value as a `PASTE_*_HERE` placeholder (matches the convention already in the example file).
   - Walk all request `Authorization` headers — if any contain a literal token (not a `{{var}}`), warn the user with a diff preview before saving.
   - Per-environment values for environments **not** selected for export are stripped. Default selection: just the "From file" env.

## 8. Execution Path

```
Renderer                           Main                              Worker
────────                           ────                              ──────
[Send] ──► ipc("request:send",
            { tabId, requestId,
              draftJson })
                              ──► resolve vars (layered)
                                   decrypt secrets via safeStorage
                                   build runnable RequestSpec
                                                              ──► postMessage(spec)
                                                                    undici.request(...)
                                                                    abortable; streamed body
                                                              ◄── { status, headers,
                                                                    bodyBytes, ms, error? }
                              ◄── persist last_response
                                   redact request log (mask
                                   secret values in echoed
                                   headers)
            ◄── ipc("request:done",
                    { tabId, response })
update tab UI, parsed body
```

One Worker per workspace, multiplexed across requests. Cancel = `worker.postMessage({ kind: 'cancel', requestId })`. Concurrent sends supported (needed for "Send all in folder").

Renderer never sees `value_secret_blob`. Plaintext for a secret only flows main → worker → wire. The renderer UI shows `••••••••` with a click-to-reveal that round-trips through main and re-masks on blur.

## 9. IPC Contract

Single typed channel, request/response envelope:

```ts
type IpcRequest =
  | { kind: 'workspace:list' }
  | { kind: 'workspace:create';   name: string }
  | { kind: 'workspace:open';     id: string }
  | { kind: 'collection:create';  name: string; parent?: string }
  | { kind: 'collection:rename';  id: string; name: string }
  | { kind: 'collection:delete';  id: string }
  | { kind: 'collection:export';  collectionId: string; targetPath: string }
  | { kind: 'request:create';     parent: { collectionId: string; folderId?: string }; draft: RequestDraft }
  | { kind: 'request:save';       requestId: string; patch: Partial<RequestDraft> }
  | { kind: 'request:send';       tabId: string; requestId: string; draftJson?: RequestDraft }
  | { kind: 'request:cancel';     tabId: string }
  | { kind: 'env:list';           scope: { kind: 'global' } | { kind: 'collection'; id: string } }
  | { kind: 'env:setActive';      scope; envId: string }
  | { kind: 'var:setSecret';      varId: string; plaintext: string }
  | { kind: 'var:revealSecret';   varId: string }   // for click-to-reveal
  | { kind: 'http:import';        path: string }
  | { kind: 'tabs:list' }
  | { kind: 'tabs:saveDraft';     tabId: string; draftJson: RequestDraft }

type IpcResponse<R> =
  | { ok: true;  data: R }
  | { ok: false; error: { code: string; message: string; hint?: string } }
```

## 10. Error Handling

| Where | How shown |
|---|---|
| Network (DNS / conn refused / timeout / TLS) | Response panel renders red `<ml-alert>` with category + raw error |
| Unresolved `{{var}}` | Yellow ⚠ chip in URL bar; clicking jumps to Vars editor with the missing key pre-filled |
| Parser error on import | Dialog shows line number + offending text; "Import anyway, skipping bad request" option |
| Export hygiene warning | Diff preview dialog before write; user must explicitly confirm or fix |
| IPC failure | `<ml-toast>`; op retried once, then surfaced |
| Worker crash | Worker auto-respawned; in-flight requests for that worker fail with `WORKER_RESTARTED` and tabs show retry button |

## 11. Module Boundaries

Designed so each piece is independently testable.

```
packages/
  parser/            pure ts, no I/O      parseHttpFile, serializeHttpFile, fixtures
  resolver/          pure ts, no I/O      resolveVars(spec, envs, builtins, lastResponses)
  storage/           main only            sqlite repos: WorkspaceRepo, CollectionRepo,
                                           RequestRepo, EnvRepo, VarRepo, TabRepo
  secrets/           main only            wraps safeStorage; encrypt/decrypt
  runner/            worker only          undici send; cancel; streaming
  ipc/               shared types         IpcRequest/IpcResponse + bridge wrappers
  app/               main process         wires everything, owns BrowserWindow
  ui/                renderer             Melodic components, signals, screens
```

Rule: parser/resolver/runner have no Electron imports. Renderer has no `node:*` imports. Main is the only place that touches both.

## 12. Testing Strategy

| Layer | Tool | What it covers |
|---|---|---|
| Parser & serializer | Vitest (pure functions) | Round-trip the two `examples/*.http` files byte-identically; multipart, GraphQL, named requests, `< file` body, comment preservation, unicode in headers; malformed request line, unterminated body |
| Variable resolver | Vitest | Layer precedence (request > env > global > builtins); response-chain JSONPath; unresolved-var produces warning not exception; built-ins |
| SQLite repos | Vitest against in-memory `better-sqlite3` | CRUD per entity; cascading deletes; migration apply-from-empty |
| Secret encryption | Vitest with stubbed `safeStorage` | Round-trip encrypt/decrypt; assert via spy that secret never leaves main in plaintext |
| HTTP runner worker | Vitest against a local `node:http` server | All methods; headers echoed; body streaming; abort-mid-flight cancels; 4xx/5xx/network-error mapped to typed errors; concurrent sends don't cross-contaminate |
| IPC bridge | Vitest with fake `ipcMain`/`ipcRenderer` | Each `IpcRequest` kind has a handler; unknown kind → typed error; renderer-side wrapper resolves/rejects correctly |
| Renderer components | Vitest + happy-dom | Per Melodic component file: render, fire `ml:*` events, assert state via signals |
| End-to-end smoke | `@playwright/test` driving Electron | Cold launch → import `examples/oneroster-v1p1.http` → open a request → set `@token` → send against a mock server → assert 200 → export collection → diff against expected `.http` |

**Coverage targets:** parser/resolver/repos at 100% line. UI at "every code path triggered at least once." E2E covers the journey above.

**Non-test guards:** TypeScript `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. ESLint `@typescript-eslint/strict-type-checked`. CI runs `vitest run`, `playwright test`, `tsc --noEmit`, `eslint`.

## 13. Build, Package, Distribute

- `electron-vite` for dev/build (handles main + preload + renderer with HMR).
- `electron-builder` for packaging: `.dmg` (macOS, signed if certs available), `.exe` NSIS installer (Windows), `.AppImage` + `.deb` (Linux).
- `better-sqlite3` is native — bundled via `electron-rebuild` for each target.
- Auto-update via `electron-updater` (deferred until there's a release channel; design supports it).

## 14. Out of Scope (for v1)

Repeated for clarity:
- Pre/post request scripting.
- Multi-run history with diff.
- File watcher for re-import.
- Save-response-to-file.
- Sync / sharing beyond manual export.
- OS keychain integration (kept secrets in workspace per user preference; can add later as opt-in).
