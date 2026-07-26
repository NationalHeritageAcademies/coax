# Swagger / OpenAPI Import — Design Spec

**Date:** 2026-05-18
**Status:** Approved — ready for implementation planning

Import an OpenAPI 3.x or Swagger 2.0 document and produce a Coax collection: one folder per tag, one request per operation, with URLs templated to `{{baseUrl}}{path}`, path/query params and headers scaffolded, and auth wired from the document's security schemes when present.

---

## 1. Goals

1. Generate a working collection from a swagger document with zero hand-editing for the common case.
2. Support both OpenAPI 3.x and Swagger 2.0 — both are common in the wild.
3. Two source paths: open a local `.json` / `.yaml` file, or fetch a `.json` / `.yaml` from a URL.
4. Resolve a sensible `baseUrl` automatically when imported from a URL; fall back to letting the user edit it after import.
5. Group operations by their first tag; scaffold headers, path params, query params, body, and auth from the document.

## 2. Non-Goals (v1)

- Generating bodies from `requestBody.content[*].schema` when no `example` is provided. The schema → JSON example synthesizer is its own piece of work; v1 stays empty when there's no explicit example.
- Re-syncing an existing collection against an updated swagger document (no diff/merge).
- Validation of the imported document against the OpenAPI schema. We parse what we recognize, ignore the rest.
- Generating typed clients or response models.

## 3. Source & Trigger

A new sidebar action "Import from Swagger…" (and a corresponding menu item) opens a small dialog with two tabs:

- **Open file…** — file picker filtered to `.json` / `.yaml` / `.yml`.
- **Fetch from URL…** — text input. The fetched body is parsed as JSON, falling back to YAML if JSON parse fails. A 10 MB cap protects against unbounded responses.

For URL imports we keep the source URL on the import handler so the base-URL resolver in §6 can use it.

## 4. Format Detection

The parser detects format from the document root:

- `openapi` field present (e.g. `"3.0.1"`, `"3.1.0"`) → OpenAPI 3.x path.
- `swagger` field present (e.g. `"2.0"`) → Swagger 2.0 path.
- Neither → reject with a clear error.

Both formats route through a single normalization step that produces a uniform `NormalizedSpec` — the rest of the import code reads only the normalized form, so the 3.x and 2.0 branches are isolated to the parser.

## 5. Normalized Spec

```ts
interface NormalizedSpec {
  title: string;             // info.title, falling back to filename / URL hostname
  baseUrlCandidates: string[]; // possible base URLs; first one wins (see §6)
  operations: NormalizedOperation[];
  securitySchemes: Record<string, NormalizedSecurityScheme>;
  globalSecurity: SecurityRequirement[];  // applied when an op doesn't override
}

interface NormalizedOperation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  path: string;              // raw, with `{x}` placeholders
  tag: string | null;        // first tag, or null
  operationId: string | null;
  summary: string | null;
  parameters: NormalizedParam[];
  bodyExample: { contentType: string; raw: string } | null;
  security: SecurityRequirement[] | null;  // null = inherit globalSecurity
}

interface NormalizedParam {
  in: 'path' | 'query' | 'header' | 'cookie';
  name: string;
  required: boolean;
}
```

`securitySchemes` and `SecurityRequirement` use the OpenAPI 3.x shape; the Swagger 2.0 parser translates 2.0's `securityDefinitions` into the same shape (mapping `apiKey`, `basic`, `oauth2` directly; `basic` becomes `http` with `scheme: 'basic'`).

## 6. Base URL Resolution

For OpenAPI 3.x: `servers[0].url`. For Swagger 2.0: `${(schemes[0] ?? 'https')}://${host}${basePath ?? ''}`.

Resolution rules (in order):

1. If the candidate is **absolute** (has a scheme) → use it verbatim.
2. If the candidate is **relative** AND the import source was a **URL** → resolve against the source URL's origin. (E.g. `servers[0].url = '/dyn-feature-68474/'` imported from `https://oneroster.sis.nhatest.com/dyn-feature-68474/swagger/v1/swagger.json` → `https://oneroster.sis.nhatest.com/dyn-feature-68474`.)
3. If the candidate is **relative** AND the import source was a **file** → use it verbatim. The user edits it in the resulting env after import.
4. If `servers` is missing entirely (3.x default) → use `/` per spec.

Trailing slash is normalized off so the templated URL `{{baseUrl}}{path}` doesn't end up with double slashes.

## 7. Mapping to Coax Entities

After parsing into `NormalizedSpec`, the importer creates one collection, N folders (one per unique tag), and one request per operation.

**Collection**
- Name = `info.title`, falling back to the filename (file import) or the URL hostname (URL import).
- Parent = optional `parentCollectionId` (same as `http:import`).

**Folders**
- One per unique non-null tag, attached to `collection.rootFolderId`.
- Operations with no tag land at the collection root (no folder).

**Requests** — one per operation. Per-field rules:

| Field | Rule |
|---|---|
| `name` | `summary` if present, else `operationId` if present, else `${METHOD} ${path}` |
| `chainName` | sluggified `operationId` if present, else unset |
| `method` | from the operation |
| `url` | `{{baseUrl}}` + path with `{x}` → `{{x}}`, + `?p1={{p1}}&p2={{p2}}` for **required** query params (in alphabetical order for stability) |
| `headers` | one entry per `parameters[in=header]` with `value = {{paramName}}`; plus `Content-Type` from the operation's body content-type when a body is set |
| `body` | when `requestBody.content` has at least one media type with `example` → use that example as `raw`, `kind` inferred from content-type. **Without an example** → `kind: 'none'` (no body). GET/HEAD always `kind: 'none'`. |
| `auth` | derived from the operation's `security` (or `globalSecurity` if the op doesn't override) — see §8 |

**Variables — the "From swagger" env**
- Created at `collection.rootFolderId`, activated immediately (mirrors how `http:import` handles the "From file" env).
- Always seeded with `baseUrl` per §6.
- Path params: if the same param name appears on 2+ operations, it's added as a variable with an empty value (so the user can set it once and have it apply broadly). Path params unique to a single operation are not added — the `{{paramName}}` reference works without an entry and the user fills it via the Vars tab if desired.

**Optional query params** are NOT added to the URL. They're documented in a body-text comment? No — we don't write to the request body for that. Instead, optional params land in the operation summary that becomes part of `name`/description, and the user adds them via the Params tab when needed. Required ones go in the URL so the request is sendable immediately.

## 8. Auth Scaffolding

The first applicable security scheme wins (operations rarely list more than one viable choice; we pick first and let the user adjust). Map to Coax's auth kinds:

| Scheme | Coax auth |
|---|---|
| `http` + `scheme: bearer` | `{ kind: 'bearer', data: { token: '{{bearerToken}}' } }` |
| `http` + `scheme: basic` | `{ kind: 'basic', data: { username: '{{username}}', password: '{{password}}' } }` |
| `apiKey` (in: header) | header `<name> = {{<name>}}` (no `auth` set; encoded as a regular header) |
| `apiKey` (in: query) | query param `<name>={{<name>}}` appended to URL |
| `apiKey` (in: cookie) | header `Cookie = <name>={{<name>}}` |
| `oauth2` | leave `auth` unset; the user wires it up in the Auth tab |
| no security on operation/global | no `auth` |

The variable names (`bearerToken`, `username`, `password`, scheme name) are also seeded as empty entries in the "From swagger" env so they show up in Manage Envs ready for values.

## 9. IPC Surface

Three new handlers in `src/app/handlers.ts`:

| Channel | Payload | Returns |
|---|---|---|
| `swagger:import` | `{ source: { kind: 'file'; path } \| { kind: 'url'; url }, parentCollectionId? }` | `{ collectionId, stats: { operations, tags, paramVars } }` |
| `dialog:openSwagger` | — | `{ path: string \| null }` (file picker) |
| `swagger:fetch` | `{ url }` | `{ text: string }` (10 MB cap; mainly for the renderer-side preview, optional in v1) |

Implementation lives in a new file `src/importer/swagger.ts` (parser + normalizer + mapper). The `swagger:import` handler is a thin wrapper around it; the actual logic is exported so it's unit-testable without IPC.

A separate file (not folded into `src/parser/`) because the `.http` parser is a tight self-contained component and mixing the much-larger swagger schema-walking code in would obscure the lexer. `parser/` parses Coax's native file format; `importer/` brings in foreign formats.

## 10. UI

A new sidebar action triggers the import dialog. Two reasonable placements:

- The existing "+ Collection" kebab menu next to the COLLECTIONS header gains a third item: "Import from Swagger…" (alongside "New collection" and "Import .http…").
- A top-level "Import" submenu off the same kebab — preferred if the kebab grows beyond ~4 entries.

The import dialog is a new component `hu-swagger-import-dialog` mounted at body level (same pattern as `hu-env-manager`). It has:
- A segmented control toggling between **File** and **URL**.
- For File: an `ml-button` that calls `dialog:openSwagger` and then `swagger:import`.
- For URL: an `ml-input` and a "Import" button that calls `swagger:import` directly.
- During the import, a small inline status (operation count, current step).
- On success, a toast and the sidebar focuses the new collection.
- On failure (parse error, fetch failure, format unrecognized), a clear inline error with the underlying message.

## 11. Edge Cases

| Case | Behavior |
|---|---|
| Document is YAML, not JSON | Parse with a YAML library (`yaml` package). Add as a runtime dep — small footprint. |
| Operation has multiple tags | Use the first. |
| Operation has no `operationId`, no `summary` | Name = `${METHOD} ${path}`. No `chainName`. |
| Multiple `servers[]` entries | Use the first. The others are dropped in v1 — the user can paste an alternative into the env. |
| Path param appears in URL but not in `parameters` | Still rendered as `{{paramName}}` in the URL — the templated `{{}}` keeps the placeholder visible. |
| `$ref` external file references | Not followed in v1 — only inline `$ref` to `#/components/...` is resolved. External refs produce a warning in the import result. |
| Same `tag` capitalized differently across operations | Treated as distinct tags (preserves source casing). |
| Document `> 10 MB` | Import aborts with an error. |
| URL returns HTML (not JSON/YAML) | Parse fails; surface the parse error. |

## 12. Testing

**Unit / integration (Vitest):**
- `tests/importer/swagger-openapi3.test.ts` — small inline OpenAPI 3.x doc → normalized spec → expected requests, folders, env.
- `tests/importer/swagger-2.test.ts` — same with a Swagger 2.0 doc, including `host`/`basePath`/`schemes`.
- `tests/importer/swagger-baseurl.test.ts` — covers every base-URL resolution rule in §6 (absolute, relative+url, relative+file, missing servers).
- `tests/importer/swagger-auth.test.ts` — each row of the auth mapping table in §8 produces the right `auth` (or header) on the request.
- `tests/handlers/swagger-import.test.ts` — round-trips an end-to-end import through the IPC handler against the existing repos.
- A fixture file `tests/fixtures/oneroster-skeleton.json` based on the OneRoster sample so we exercise the "skeletal spec" case.

**UI (Playwright):**
- Open the import dialog, paste a URL, import. Confirm the new collection appears with the expected number of folders and a request count.
- Import the same file twice — should create two collections (no dedupe in v1).

**Manual smoke:**
- Import the OneRoster swagger by URL: 72 paths, ~144 operations. Confirm `baseUrl` resolves to `https://oneroster.sis.nhatest.com/dyn-feature-68474`. Send one operation end-to-end after setting `Limit`/`Offset` etc.
