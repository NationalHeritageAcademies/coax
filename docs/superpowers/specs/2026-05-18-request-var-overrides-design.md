# Per-Request Variable Overrides — Design Spec

**Date:** 2026-05-18
**Status:** Approved — ready for implementation planning

A new layer in the variable resolution chain that lets a single request override the value of an existing env var without modifying any environment. Visible from the request's Vars tab as click-to-edit on inherited values. Persisted with the request, round-trips through `.http` export/import as `# @override` directives.

---

## 1. Goals

1. View every variable that resolves for a request — inherited from any folder env in the chain — on the request's Vars tab.
2. Allow per-request overrides of inherited var values. Overrides are stored with the request, not with any env.
3. Make the only way to add a brand-new variable key, or edit a value used by other requests, be the **Manage Envs** screen. The request page is read-only with respect to env data.
4. Overrides round-trip cleanly: exported `.http` files preserve overrides; importing a file with `# @override` directives restores them.
5. Treat secret overrides the same way env secrets are treated today: their values never appear in plaintext on disk in the exported file.

## 2. Non-Goals

- Introducing brand-new variable names from the request page. Overrides only apply to keys that already exist somewhere in the request's env chain.
- A "request-only" variable concept (vars that live only on the request and don't override anything). Once an override's matching env var is removed, the row becomes an *orphan* — surfaced for cleanup, not promoted to a first-class concept.
- Bulk override editing across multiple requests.
- Override history / diffing.

## 3. Data Model

A new SQLite table:

```sql
CREATE TABLE request_var_overrides (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_plain TEXT,             -- NULL when is_secret = 1
  value_secret_blob BLOB,       -- encrypted ciphertext when is_secret = 1
  is_secret INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(request_id, key)
);

CREATE INDEX idx_request_var_overrides_request_id
  ON request_var_overrides(request_id);
```

**Secret overrides** mirror env secrets exactly (see `Repos.Vars` in `src/storage/repos.ts`): when `is_secret = 1`, `value_plain` is `NULL` and `value_secret_blob` holds the `safeStorage.encryptString(...)` ciphertext. Materialization at resolve time goes through `Secrets.decrypt(blob)`.

**Why a separate table** (not a JSON column on `requests`):
- Mirrors how `variables` works today, so the secrets wiring is the same shape (`value_plain` / `value_secret_blob` / `is_secret`).
- Per-key DML stays cheap; no read-modify-write of a JSON blob on every change.

## 4. Resolver

`ResolverScopes` already has a `request` field reserved for "inline / per-request overrides" — it's just been unused. This design wires it up.

In `buildScopesForRequest` (`src/app/handlers.ts:135`), after the existing `chainFlat` walk, add a step that loads overrides via `Repos.RequestVarOverrides.listForRequest(db, secretsImpl, requestId)` and writes them into `scopes.request`. Secret overrides materialize through the secrets vault at this point — same `materialize…` pattern used by `materializeEnv`.

Precedence (highest → lowest): `request` → `chainFlat` (deepest env wins inside it) → `collectionDefaults`. That precedence is already encoded in the resolver itself; no resolver changes needed beyond populating `scopes.request`.

**Orphan overrides:** an override whose `key` is no longer present in any env in the request's chain still resolves — the resolver doesn't care whether a parent exists. The Vars panel separates orphans into their own section so the user can delete or restore them.

## 5. Storage Layer

A new module `Repos.RequestVarOverrides` in `src/storage/repos.ts`, modeled on `Repos.Vars`:

```ts
export const RequestVarOverrides = {
  listByRequest(db, requestId): RequestVarOverride[],
  listForRequest(db, secrets, requestId): { key, value, isSecret }[],  // materialized
  upsert(db, input: {
    requestId, key, valuePlain?, valueSecretBlob?
  }): RequestVarOverride,
  delete(db, { requestId, key }): void,
}
```

`listByRequest` returns rows for UI display (secrets stay opaque — `value_secret_blob` is not exposed). `listForRequest` is the resolver-side accessor that decrypts each secret row via `secrets.decrypt(value_secret_blob)`. Both indexed by `request_id`.

`upsert` takes either `valuePlain` or `valueSecretBlob` (the ciphertext, already encrypted by the IPC handler) — the repo doesn't own the encryption step, matching `Repos.Vars`. `delete` is a pure-SQL delete; no separate vault entry to clean up because the ciphertext lives in the row itself.

## 6. IPC

Three new IPC handlers in `src/app/handlers.ts`:

| Channel | Payload | Returns |
|---|---|---|
| `request:overrides:list` | `{ requestId }` | `{ overrides: { key, valuePlain?, isSecret }[] }` |
| `request:overrides:set` | `{ requestId, key, valuePlain? \| valueSecret? }` | the upserted row |
| `request:overrides:delete` | `{ requestId, key }` | `{ key }` |

`request:overrides:set` accepts either `valuePlain` (string) or `valueSecret` (string to be encrypted), never both. The handler validates that `key` exists somewhere in the request's resolved env chain *at create time* — if not, the call is rejected so the UI can prompt the user to use Manage Envs to create the key first. (Already-orphaned overrides can still be deleted; only *creation* requires a matching parent key.)

No new resolver IPC — `var:resolve` already returns the merged set, and once `scopes.request` is populated it shows up in the `varDebug` rows that drive the existing UI.

## 7. UI — Request Vars Panel

The current panel has three sub-pieces (`src/ui/components/request-tab.ts:1284–1461`):
1. `renderInheritedVars` — read-only table of ancestor env vars.
2. `renderEnvVarsTable` — editable table of the deepest folder's active env (with `+ Add variable`).
3. Help text + `varDebug` reference table.

This becomes a **single unified table** of inherited variables:

- Every row is one variable from the resolved env chain (deepest-wins dedupe across the chain), plus any orphan overrides at the bottom in their own subsection.
- Columns: **Key** · **Value** · **From** · *(secret-marker / overridden-badge cell)*.
- Read-only by default. The whole `renderEnvVarsTable` block — including `+ Add variable` — is removed.

**Click-to-override (plain values):**
- Clicking the **Value** cell of a non-secret row replaces the cell with an `ml-input` pre-filled with the current value (env or existing override).
- Blur or Enter saves via `request:overrides:set`. Empty input on save deletes the override via `request:overrides:delete`.
- An overridden row gets an "overridden" badge in the trailing cell and a subtle accent on the value cell. The **From** column shows the override source (`This request`) when overridden, the env folder/name otherwise.

**Click-to-override (secret values):**
- Secret rows still display `[secret]`.
- Clicking opens a small inline picker with two choices:
  - **Override with plaintext** → reveals a plain `ml-input`; save calls `request:overrides:set` with `valuePlain`.
  - **Override with new secret** → reveals an `ml-input` that, on save, calls `request:overrides:set` with `valueSecret`. The cell then shows `[secret · overridden]`.
- An overridden secret row shows an "x" on the badge to clear the override.

**Orphan section** at the bottom (only rendered when ≥ 1 orphan):
- Header: `Overrides without a matching env var`.
- Rows: key · value (`[secret]` for secret rows) · delete-x.
- No edit affordance — orphans are either deleted, or implicitly "rescued" when the user re-creates the matching env key in Manage Envs.

**Empty state** (no envs in the chain at all): unchanged from today — message pointing to Manage Envs.

**Help text** above the table stays as today (chain references).

## 8. Export / Import Format

Overrides serialize as comment-based directives placed immediately after each request's `###` title line.

**Plaintext override:**
```
### My Request
# @override apiBase https://staging.example.com
GET {{apiBase}}/users
```

**Secret override:**
```
### My Request
# @override:secret apiKey
GET {{apiBase}}/users
Authorization: Bearer {{apiKey}}
```

No value is written for secret overrides — the user re-supplies the value after import (same model as `PASTE_<KEY>_HERE` for env secrets).

**Parser changes** (`src/parser/lexer.ts`, `parse.ts`):
- New lexer match: `/^#\s*@override(:secret)?\s+(\S+)(?:\s+(.*))?\s*$/` → line kind `override`.
- `blockToRequest` collects override lines into `r.overrides: { key, value?: string, isSecret: boolean }[]`.

**Serializer changes** (`src/parser/serialize.ts`):
- For each request, emit override lines between the `### title` and the method line.

**Import handler** (`http:import`):
- After creating the request row, insert one `request_var_overrides` row per parsed override. Secret overrides land with `is_secret = 1` and `value_plain = NULL`; the UI surfaces `[secret · needs value]` until the user sets one.

**Export** (`exportTree`):
- For each request, query `Repos.RequestVarOverrides.listByRequest` and pass the rows to the serializer.
- Plain values write through; secrets emit the `:secret` marker without a value.

**Other-tool compatibility:** `# @override …` is a comment to VS Code REST Client / JetBrains. They ignore it. Re-importing into Coax restores everything.

## 9. Migration

A new migration `src/storage/migrations/004_request_var_overrides.sql` adds the table and index from §3. No backfill — existing requests simply have zero override rows.

## 10. Testing

**Unit / integration (Vitest):**
- `tests/resolver/request-overrides.test.ts` — override wins over deepest env; secret override materializes via vault; orphan override resolves regardless of parent.
- `tests/parser/override-directive.test.ts` — parse + serialize round-trip for both `# @override` and `# @override:secret` forms.
- `tests/storage/request-var-overrides.test.ts` — repo upsert / delete / listByRequest / listForRequest semantics, including the secret vault wiring.
- `tests/handlers/import-overrides.test.ts` — importing a file with override directives produces the expected rows.
- `tests/handlers/export-overrides.test.ts` — exporting a request with overrides emits the expected directives; secrets emit the marker without value.
- `tests/handlers/request-overrides-ipc.test.ts` — `request:overrides:set` rejects keys not present in the chain (unless already-orphaned).

**UI (Playwright):**
- Click-to-override on a plaintext row: edit, blur, value updates; clear value, blur, override removed.
- Secret override picker: both branches set the value correctly; `[secret · overridden]` badge appears.
- Orphan section appears after the matching env var is deleted in Manage Envs; orphan delete removes the row.
- "+ Add variable" no longer exists on the request page.

**Manual smoke:**
- Import `examples/oneroster-v1p1.http`. Override `baseUrl` on one request. Send → request uses override. Export collection. Re-import → override survived as `# @override baseUrl …`.
- Same flow but with a secret-marked env var → exported file has `# @override:secret <key>` (no value); re-imported override row prompts for value.
