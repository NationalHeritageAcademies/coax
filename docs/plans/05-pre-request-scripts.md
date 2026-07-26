# Plan: Pre-request scripts

## Why
The #1 feature Postman users say they miss when they switch. Without it, request signing, dynamic auth, and request preparation force people to leave Coax.

## Goal
Allow a small, sandboxed JavaScript block to run before a request, with a deliberately constrained API surface.

## Syntax in `.http`
```http
### Sign and send
# @pre-request
#   const body = JSON.stringify(coax.request.body);
#   const sig = coax.crypto.hmac('sha256', coax.env.get('SECRET'), body);
#   coax.vars.set('signature', sig);
POST {{baseUrl}}/data
Content-Type: application/json
X-Signature: {{signature}}

{ "amount": 42 }
```

Block alternative for readability:
```http
# @pre-request {
#   const body = JSON.stringify(coax.request.body);
#   const sig = coax.crypto.hmac('sha256', coax.env.get('SECRET'), body);
#   coax.vars.set('signature', sig);
# }
```

## Sandbox

**Use a Node `worker_threads` worker, not `vm2`** (deprecated and CVE-prone) and not `isolated-vm` (heavyweight native dep). The worker boundary is good enough: a malicious script can crash itself but can't reach the main process. We already have this pattern in `src/runner/worker.ts`.

Each request execution spins up a script worker, runs the pre-request script with a 5-second wall clock, kills it on overrun.

## API surface (deliberately small)

```ts
coax.vars.set(name: string, value: string | number | boolean): void
coax.vars.get(name: string): string | undefined
coax.env.get(name: string): string | undefined
coax.request: Readonly<{ method, url, headers, body }>  // mutable copy gets discarded; use vars.set instead
coax.crypto:
  hmac(algo: 'sha1' | 'sha256' | 'sha512', key: string, data: string): string  // hex
  sha256(data: string): string
  base64.encode(data: string): string
  base64.decode(data: string): string
  uuid(): string
coax.fetch(url, opts): Promise<{status, body, headers}>  // sandboxed, no access to local fs
console.log(...args): void  // captured into the "Script output" tab
```

No `require`, no `import`, no fs, no process, no child_process. Document this clearly — people will try.

## Postman compat shim

Best-effort `pm.*` mapping for imported Postman scripts:
- `pm.environment.set('x', y)` → `coax.vars.set('x', y)`
- `pm.environment.get('x')` → `coax.env.get('x')`
- `pm.sendRequest(...)` → `coax.fetch(...)` (subset)

Mark imported scripts with a `// imported from Postman, may need adjustment` comment. Document the gaps.

## Work breakdown
1. Extend parser to capture `# @pre-request` blocks (multi-line, hash-prefixed JS).
2. Build script worker harness (`src/scripts/worker.ts`) — receives `{script, requestContext}`, returns `{varsToWrite, log, error}`.
3. Implement the `coax.*` API surface in the worker bootstrap.
4. Wire into request execution: resolve vars → run pre-request script → re-resolve with updated vars → send request.
5. UI:
   - New "Script" tab in the request panel (Monaco JS editor with our API surface as type definitions for autocomplete).
   - "Script output" tab in the response panel showing `console.log` output.
   - Errors in script execution show as a red banner in the response panel with stack trace.
6. Tests: fixtures for HMAC signing, dynamic auth (OAuth client credentials flow), date-stamped requests.
7. Postman compat shim + import path wiring (plan 06).
8. Docs: `docs/scripts.md` with cookbook (HMAC signing, JWT generation, OAuth flows).

## Risks / open questions
- **API surface scope creep.** People will ask for fs, network, env (process.env). Don't give in to fs and process.env; consider `coax.fetch` and `coax.env` only.
- **Synchronous vs async API.** `coax.fetch` is async; `coax.crypto.*` is sync. Be consistent: documented sync = always sync, documented async = always returns a Promise.
- **Script editor performance.** Monaco is heavy; if startup time degrades, lazy-load the JS language service only when a script panel opens.

## Definition of done
- HMAC-signing fixture round-trips through pre-request script and produces a valid request.
- Script that throws shows a clear error with line number in the response panel.
- Killing a 10-second sleep loop succeeds within ~5s timeout.
- Imported Postman pre-request scripts using `pm.environment.*` work without manual rewrites.
- Cookbook doc has at least 3 worked examples.
