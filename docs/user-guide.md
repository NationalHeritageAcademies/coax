# Coax — User Guide

Everything you need to know to use the app day-to-day. If you're brand new, start with [Quick start](#quick-start). If you're looking for one specific topic, scan the table of contents.

## Table of contents

- [Quick start](#quick-start)
- [Interface tour](#interface-tour)
- [Workspaces](#workspaces)
- [Collections, folders, requests](#collections-folders-requests)
- [Importing a `.http` file](#importing-a-http-file)
- [Editing a request](#editing-a-request)
  - [Method and URL](#method-and-url)
  - [Query parameters](#query-parameters)
  - [Headers](#headers)
  - [Body](#body)
  - [Auth](#auth)
- [Variables and environments](#variables-and-environments)
- [Response chaining](#response-chaining)
- [Sending requests](#sending-requests)
- [Reading the response](#reading-the-response)
- [Tabs](#tabs)
- [Theme & layout](#theme--layout)
- [Exporting a collection](#exporting-a-collection)
- [Workspace files & where data lives](#workspace-files--where-data-lives)
- [Troubleshooting](#troubleshooting)

---

## Quick start

1. **Install and launch.**
   ```bash
   npm install
   npm run dev
   ```

2. **Import a `.http` file.** Click the **⬇ Import** button in the header. Pick any `.http` file (the `examples/` folder has a couple of OneRoster spec files to try). Each `### Title` block becomes a request in the sidebar.

3. **Open a request.** Click any request in the sidebar. It opens in a new tab.

4. **Set variable values.** If your file has `@baseUrl = ...` lines, those become a "From file" environment that's auto-activated. To edit values, switch to the **Vars** sub-tab on the request, or open the **⚙ env manager** modal from the header.

5. **Send.** Hit the green **Send** button (or press `Enter` while in the URL bar). The response renders in the lower pane.

---

## Interface tour

```
┌──────────────────────────────────────────────────────────────────┐
│  ●─● Coax   Env: [dev ▾] +  ──── tab tab tab + ───  ⚙ ⬇ ⬆ ☾    │  ← Header
├─────────────┬────────────────────────────────────────────────────┤
│             │  Chain name:  getToken                              │
│  COLLECTIONS│  [POST ▾] {{baseUrl}}/users           [ Send → ]   │  ← Request bar
│             │                                                     │
│  ▾ Project1 │  Params  Headers  Body  Auth  Vars  cURL            │  ← Sub-tabs
│    ▸ Auth   │  ┌───────────────────────────────────────────────┐ │
│    ▾ Users  │  │   request body / params / headers editor      │ │
│      • Get  │  │                                               │ │
│      • New  │  └───────────────────────────────────────────────┘ │
│             │  ─── (drag handle to resize) ────────────────────── │
│             │  ─── 200 OK · 142 ms · 4.2 KB ─────────────────── │
│             │  Body  Headers  Raw                                 │
│             │  ┌───────────────────────────────────────────────┐ │
│             │  │   response body                               │ │
│             │  └───────────────────────────────────────────────┘ │
├─────────────┴────────────────────────────────────────────────────┤
│  ● Default · ~/Library/Application Support/Coax/.../*.sqlite   │  ← Status bar
└──────────────────────────────────────────────────────────────────┘
   ▲                                                            ▲
   │                                                            │
 Drag the vertical bar to resize the sidebar       Drag the horizontal bar
                                                   between request & response
```

### Header buttons (left to right)

| Button | What it does |
|---|---|
| Logo + name | Just branding |
| **Env** dropdown | Switch the active environment (Collection envs grouped first, then Global) |
| **+** next to env | Create a new env in the current scope |
| **Re-extract from .http** | Appears when the active collection has a recorded `.http` source but no envs — repopulates variables from the file |
| **Tab strip** | One tab per open request; click to switch, ✕ to close, drag the divider to scroll |
| **⚙ Manage envs** | Opens the central env manager modal |
| **⬇ Import** | Open OS file picker for a `.http` file |
| **⬆ Export** | Save the active collection as a `.http` file (secrets stripped to placeholders) |
| **☾ Theme** | Cycle light → dark → system |

### Sidebar

Single hierarchical tree:
- **Collections** (folder icons) → **folders** → **requests** (with colored method badge)
- Click a chevron to expand/collapse
- Click a request to open it as a tab
- Method colors: GET = blue, POST = green, PUT = orange, PATCH = purple, DELETE = red, HEAD = cyan, OPTIONS = indigo

### Status bar

Bottom of the window. Shows a green dot + the active workspace's name + path. Useful when you have multiple workspaces and want to confirm where data is being saved.

---

## Workspaces

A workspace is one SQLite file containing collections, folders, requests, environments, variables, tabs, and last-responses. The default workspace is created automatically the first time you open the app.

For now, multi-workspace is functional via IPC but not surfaced in the UI — you'll have one Default workspace until that ships. The active workspace is shown in the status bar.

---

## Collections, folders, requests

- **Collection** = the top-level grouping in the sidebar (typically maps to one `.http` file or one logical API)
- **Folder** = a sub-grouping inside a collection (created automatically from `############`-style comment dividers in imported files)
- **Request** = the actual HTTP request — method + URL + headers + body + optional auth + chain name

Right-click is not implemented yet. Collection/folder/request management is mostly via importing for now.

---

## Importing a `.http` file

Click **⬇ Import** in the header. Pick a file ending in `.http`. The app:

1. Parses the file's `@var = value` lines into a new environment named **From file** scoped to the new collection.
2. Auto-activates that environment so `{{var}}` references resolve immediately.
3. Creates one request per `### Title` block, preserving headers/body verbatim.
4. Detects `############`-fenced section headers as folder names — requests inside each section land in that folder.
5. Stores the source path so you can later **Re-extract from .http** to repopulate variables if you accidentally delete them.
6. Records a SHA-256 hash of the source so future re-import can detect drift.

Importing the same file twice creates a second collection (no merge logic yet). Delete the first one if you want a clean re-import.

---

## Editing a request

Click any request in the sidebar to open it in a tab. The request tab has these areas:

### Method and URL

- Top of the tab. Method dropdown (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS) + URL input + Send button.
- The URL supports `{{var}}` references — they're resolved against the active environment at send time.
- Edits autosave 500 ms after you stop typing — no need for a Save button.

Above the method/URL row is an optional **Chain name** field — set it (e.g. `getToken`) to make this request's response referenceable from other requests via `{{getToken.response.body.$.field}}`. See [Response chaining](#response-chaining).

### Query parameters

The **Params** sub-tab. Reads/writes the `?key=value&...` portion of the URL. Each row is a key + value pair; click `+ Add param` to add one, ✕ to remove. Edits update the URL in real time.

### Headers

The **Headers** sub-tab. Same key/value editor pattern as Params. Common headers like `Content-Type` are typed in directly (no autocomplete yet).

### Body

The **Body** sub-tab. Pick a body kind (none / text / json / form / multipart / graphql) from the dropdown, then edit in the Monaco editor. JSON bodies get syntax highlighting and validation. The editor honors the active theme.

### Auth

The **Auth** sub-tab. Pick a kind (None / Bearer / Basic / API Key) and fill in the fields. Currently auth is captured into the request data but not auto-injected into headers — explicitly add an `Authorization: Bearer {{token}}` header in the Headers tab for now. (Auto-injection is a planned post-v1 polish.)

---

## Variables and environments

See [variables-and-environments.md](variables-and-environments.md) for the full reference. Short version:

- A **variable** is a `name → value` mapping. Reference it anywhere with `{{name}}`.
- An **environment** is a named bag of variables. Each env is scoped to either **global** (visible to every collection) or a specific **collection**.
- Only one env per scope is **active** at a time. The active env's values are what `{{name}}` resolves to.
- Variables can be marked **secret** — encrypted at rest, masked in the UI.

Resolution order (highest precedence first):
1. Request-local vars (defined inside the request body via `@name = value`)
2. Active collection environment
3. Active global environment
4. Built-ins: `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$guid}}`, `{{$randomInt min max}}`

To create or edit envs, click the **⚙** button in the header to open the env manager. To switch envs, use the **Env** dropdown in the header.

---

## Response chaining

See [response-chaining.md](response-chaining.md) for the full guide. Short version:

1. Set the source request's **Chain name** (e.g. `getToken`).
2. Send it. The response is saved.
3. In another request, reference the response with `{{getToken.response.body.$.access_token}}`.

JSONPath syntax is supported (`$.field`, `$.array[0]`, `$..nested`). For headers from the response, use `{{getToken.response.headers.x-request-id}}` (header names lowercased).

The Vars sub-tab on a request shows resolved values for every reference, so you can verify a chain is working before you send.

---

## Sending requests

Click the **Send** button. While in flight:
- Send button shows a spinner and disables
- Cancel mid-flight by clicking Send again (sends a cancel signal to the runner worker)

After the response arrives:
- Status pill colored by class: green (2xx), blue (3xx), orange (4xx), red (5xx) or red (network error)
- Time and size shown next to the pill
- The response is stored as the request's "last response" — used by [chaining](#response-chaining)

Errors (DNS failure, connection refused, TLS errors, timeout, malformed URL) render with a red category pill (NETWORK / TLS / TIMEOUT / ABORTED / INVALID / UNKNOWN) and the underlying error message.

---

## Reading the response

Three sub-tabs in the response pane:

- **Body** — pretty-printed JSON / XML / HTML / plaintext in the Monaco editor (read-only)
- **Headers** — sorted list of response headers
- **Raw** — full HTTP transcript: outgoing request line + headers + body, then response line + headers + body. Curl-style `>` for sent, `<` for received.

If the body is empty, the panel says `(empty body)` instead of being blank.

---

## Tabs

- Each open request is one tab in the strip at the top.
- Click a tab to focus it. Active tab has a green underline and lighter background.
- Click ✕ to close a tab. The tab list persists across app restarts.
- Method badge on each tab matches the request's method.
- Tab labels truncate if too long; hover for the full name.

---

## Theme & layout

- **Theme**: cycle light → dark → system with the **☾** button in the header. Persists across restarts.
- **Sidebar width**: drag the vertical bar between sidebar and main pane. Bounds 180–600px. Persisted.
- **Request/response split**: drag the horizontal bar between the request editor and the response viewer. Persisted.

---

## Exporting a collection

Click the **⬆ Export** button. A Save dialog opens; pick where to save the `.http` file.

The export rules:

- Variable definitions are written as `@name = value` at the top of the file
- **Secret variables** are written as placeholders (`PASTE_NAME_HERE`) instead of the decrypted value — safe to share
- If any request has an `Authorization` header containing a literal token (not a `{{var}}` reference), a warning toast appears so you can decide whether to scrub it before sharing
- The result is a clean `.http` file that VS Code REST Client / JetBrains HTTP Client can open

---

## Workspace files & where data lives

The app stores everything in your OS user-data directory:

- macOS: `~/Library/Application Support/Coax/`
- Windows: `%APPDATA%/Coax/`
- Linux: `~/.config/Coax/`

Inside that:

```
Coax/
  workspaces/
    index.json                        — list of known workspaces (id, name, path)
    {workspace-id}.sqlite             — the workspace database
    {workspace-id}.sqlite-wal         — WAL journal (auto-managed by SQLite)
    {workspace-id}.sqlite-shm         — shared memory (auto-managed by SQLite)
```

To start fresh, quit the app, delete the relevant `*.sqlite` file (and its `-wal`/`-shm` siblings), and remove its entry from `index.json`. The next launch creates a new Default workspace.

---

## Troubleshooting

### "Invalid URL" when I send a request
Your URL contains an unresolved `{{var}}` reference. Check the **Vars** sub-tab on the request — any reference showing italic "unresolved" is the culprit. Likely fixes:
- Active env doesn't have that variable: switch envs from the header dropdown, or add the variable in the env manager
- Variable name typo: check spelling
- Imported a `.http` file but the env wasn't created: click the **Re-extract from .http** button next to the env dropdown

### My imported collection has no env (no variables visible)
A historical bug occasionally produced collections with the requests imported but the env not created. Click **Re-extract from .http** in the header (visible only when the collection has zero envs but has a recorded source file) to rebuild the env from the original file.

### Send button does nothing
Check the response panel for a red error pill. If it says `INVALID`, see the "Invalid URL" entry above. If it says `NETWORK` (e.g. `ECONNREFUSED`), the target isn't reachable from your machine.

### `npm run dev` errors with `ERR_DLOPEN_FAILED` or `NODE_MODULE_VERSION` mismatch
The `better-sqlite3` native module was built against Node but Electron uses a different ABI. Run:
```bash
npx electron-builder install-app-deps
```
This is auto-wired into `npm run dev` via `predev`, but if you've recently run `npm test` (which rebuilds for Node ABI), the auto-rebuild for Electron should kick in on the next `dev`.

### Tabs vanish or duplicate
Quit the app and relaunch. The tabs table is rebuilt from the `open_tabs` SQLite table on startup.

### My secret value is showing as plain text
Marking a variable as secret happens in the env manager (or via the lock icon in the Vars sub-tab). Once marked, the value is encrypted on save and shown as `[secret]` until you click Reveal. If you see plain text, the variable wasn't actually marked secret yet.

### Response body is huge and unreadable
For now there's no fold/collapse beyond Monaco's built-in JSON folding (click the gutter triangles). For very large responses, the **Raw** tab is plain text and may be easier to search with `Cmd-F`.

---

## See also

- [`docs/variables-and-environments.md`](variables-and-environments.md) — the full env reference
- [`docs/response-chaining.md`](response-chaining.md) — chaining requests with `{{name.response.body.$.x}}`
- [`docs/http-file-format.md`](http-file-format.md) — `.http` file syntax reference
- [`README.md`](../README.md) — install, build, project layout
