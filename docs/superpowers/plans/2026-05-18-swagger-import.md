# Swagger / OpenAPI Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import an OpenAPI 3.x or Swagger 2.0 document (file or URL) and generate a working Coax collection — one folder per tag, one request per operation, with URL templating, params, body, and auth scaffolded from the spec.

**Architecture:** A new `src/importer/swagger.ts` module parses the spec (JSON or YAML) into a `NormalizedSpec`, then a separate mapper converts that into `Repos.{Collections, Folders, Requests, Envs, Vars}` writes. The .http parser is untouched. A small new dialog component (`hu-swagger-import-dialog`) gives the user a file picker or URL input.

**Tech Stack:** TypeScript, `yaml` package (new dep), undici (built-in fetch via Node 18+), existing `Repos.*` storage, `@melodicdev/core` web components.

**Spec:** `docs/superpowers/specs/2026-05-18-swagger-import-design.md`

---

## File Structure

**Create:**
- `src/importer/swagger.ts` — public surface: `parseSpec`, `normalizeOpenApi3`, `normalizeSwagger2`, `resolveBaseUrl`, `mapToCollection`.
- `src/importer/swagger-types.ts` — `NormalizedSpec`, `NormalizedOperation`, `NormalizedParam`, `NormalizedSecurityScheme`.
- `tests/importer/swagger-openapi3.test.ts`
- `tests/importer/swagger-2.test.ts`
- `tests/importer/swagger-baseurl.test.ts`
- `tests/importer/swagger-auth.test.ts`
- `tests/importer/swagger-mapper.test.ts`
- `tests/handlers/swagger-import.test.ts`
- `tests/fixtures/oneroster-skeleton.json` — trimmed OneRoster sample.
- `src/ui/components/swagger-import-dialog.ts` — `<hu-swagger-import-dialog>`.
- `tests-e2e/swagger-import.spec.ts`

**Modify:**
- `package.json` — add `yaml` dependency.
- `src/app/handlers.ts` — add `dialog:openSwagger`, `swagger:fetch`, `swagger:import` handlers.
- `src/ipc/types.ts` — channel payload types.
- `src/ui/components/app-frame.ts` — mount the swagger import dialog (mirrors env-manager mounting at line 230).
- `src/ui/components/sidebar-tree.ts` — add the "Import from Swagger…" item to the COLLECTIONS-header `+` menu (or wherever new collections are created today; grep for `'+ Collection'` / `collection:create` in the sidebar).

---

## Task 1: Dependency + module skeleton

**Files:**
- Modify: `package.json`
- Create: `src/importer/swagger-types.ts`, `src/importer/swagger.ts`

- [ ] **Step 1: Install `yaml`**

```bash
npm install yaml@^2
```

- [ ] **Step 2: Create the types module**

`src/importer/swagger-types.ts`:

```ts
export type HttpMethod =
  | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface NormalizedParam {
  in: 'path' | 'query' | 'header' | 'cookie';
  name: string;
  required: boolean;
}

export type NormalizedSecurityScheme =
  | { kind: 'httpBearer' }
  | { kind: 'httpBasic' }
  | { kind: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string }
  | { kind: 'oauth2' }
  | { kind: 'unknown'; raw: unknown };

export interface SecurityRequirement {
  schemeName: string;
}

export interface NormalizedOperation {
  method: HttpMethod;
  path: string;
  tag: string | null;
  operationId: string | null;
  summary: string | null;
  parameters: NormalizedParam[];
  bodyExample: { contentType: string; raw: string } | null;
  security: SecurityRequirement[] | null;
}

export interface NormalizedSpec {
  title: string;
  baseUrlCandidates: string[];
  operations: NormalizedOperation[];
  securitySchemes: Record<string, NormalizedSecurityScheme>;
  globalSecurity: SecurityRequirement[];
}

export interface ImportSource {
  kind: 'file' | 'url';
  /** Filename or URL — used for base-URL resolution and fallback titles. */
  origin: string;
  text: string;
}
```

- [ ] **Step 3: Create the swagger.ts skeleton**

`src/importer/swagger.ts`:

```ts
import { parse as parseYaml } from 'yaml';
import type { NormalizedSpec, ImportSource } from './swagger-types.js';

export function parseSpec(source: ImportSource): NormalizedSpec {
  const raw = parseDocument(source.text);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('SWAGGER_PARSE: document root must be an object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['openapi'] === 'string') return normalizeOpenApi3(r, source);
  if (typeof r['swagger'] === 'string') return normalizeSwagger2(r, source);
  throw new Error('SWAGGER_PARSE: missing `openapi` or `swagger` root field');
}

function parseDocument(text: string): unknown {
  try { return JSON.parse(text); } catch { /* fall through */ }
  try { return parseYaml(text); } catch (e) {
    throw new Error(`SWAGGER_PARSE: ${(e as Error).message}`);
  }
}

export function normalizeOpenApi3(_doc: Record<string, unknown>, _source: ImportSource): NormalizedSpec {
  throw new Error('not implemented');
}

export function normalizeSwagger2(_doc: Record<string, unknown>, _source: ImportSource): NormalizedSpec {
  throw new Error('not implemented');
}
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/importer/swagger-types.ts src/importer/swagger.ts
git commit -m "feat(swagger): module skeleton + yaml dep"
```

---

## Task 2: OpenAPI 3.x normalization

**Files:**
- Modify: `src/importer/swagger.ts`
- Test: `tests/importer/swagger-openapi3.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/importer/swagger-openapi3.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSpec } from '../../src/importer/swagger.js';

const tiny = {
  openapi: '3.0.1',
  info: { title: 'Tiny', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/users': {
      get: {
        tags: ['Users'],
        operationId: 'listUsers',
        summary: 'List users',
        parameters: [
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer' } },
        ],
      },
      post: {
        tags: ['Users'],
        operationId: 'createUser',
        requestBody: {
          content: {
            'application/json': {
              example: { name: 'Ada' },
            },
          },
        },
      },
    },
    '/users/{id}': {
      get: {
        tags: ['Users'],
        operationId: 'getUser',
        parameters: [
          { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
        ],
      },
    },
  },
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
    },
  },
  security: [{ bearer: [] }],
};

describe('normalizeOpenApi3', () => {
  it('produces operations with method, path, tag, parameters', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.operations).toHaveLength(3);
    const list = spec.operations.find((o) => o.operationId === 'listUsers')!;
    expect(list.method).toBe('GET');
    expect(list.path).toBe('/users');
    expect(list.tag).toBe('Users');
    expect(list.parameters).toEqual([{ in: 'query', name: 'limit', required: false }]);
    expect(list.bodyExample).toBeNull();
  });

  it('captures requestBody example as the body', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    const create = spec.operations.find((o) => o.operationId === 'createUser')!;
    expect(create.bodyExample).toEqual({
      contentType: 'application/json',
      raw: JSON.stringify({ name: 'Ada' }, null, 2),
    });
  });

  it('normalizes security schemes and globalSecurity', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.securitySchemes['bearer']).toEqual({ kind: 'httpBearer' });
    expect(spec.globalSecurity).toEqual([{ schemeName: 'bearer' }]);
  });

  it('emits servers[0].url as a baseUrl candidate', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.baseUrlCandidates).toEqual(['https://api.example.com/v1']);
  });
});
```

- [ ] **Step 2: Run — should fail (not implemented)**

```bash
npx vitest run tests/importer/swagger-openapi3.test.ts
```

- [ ] **Step 3: Implement `normalizeOpenApi3`**

In `src/importer/swagger.ts`:

```ts
export function normalizeOpenApi3(
  doc: Record<string, unknown>,
  source: ImportSource,
): NormalizedSpec {
  const info = (doc['info'] as Record<string, unknown> | undefined) ?? {};
  const title =
    (typeof info['title'] === 'string' && info['title']) ||
    fallbackTitle(source);

  const servers = (doc['servers'] as Array<{ url?: string }> | undefined) ?? [];
  const baseUrlCandidates = servers
    .map((s) => (typeof s.url === 'string' ? s.url : null))
    .filter((u): u is string => u !== null && u.length > 0);

  const securitySchemes = readSecuritySchemes3(doc);
  const globalSecurity = readSecurityRequirement(doc['security']);

  const operations: NormalizedOperation[] = [];
  const paths = (doc['paths'] as Record<string, unknown> | undefined) ?? {};
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    if (!pathItemRaw || typeof pathItemRaw !== 'object') continue;
    const pathItem = pathItemRaw as Record<string, unknown>;
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const) {
      const opRaw = pathItem[method];
      if (!opRaw || typeof opRaw !== 'object') continue;
      const op = opRaw as Record<string, unknown>;
      operations.push(operationFromOpenApi3(method.toUpperCase() as HttpMethod, path, op));
    }
  }

  return { title, baseUrlCandidates, operations, securitySchemes, globalSecurity };
}

function operationFromOpenApi3(method: HttpMethod, path: string, op: Record<string, unknown>): NormalizedOperation {
  const tags = (op['tags'] as string[] | undefined) ?? [];
  const tag = tags.length > 0 ? tags[0]! : null;
  const operationId = typeof op['operationId'] === 'string' ? op['operationId'] : null;
  const summary = typeof op['summary'] === 'string' ? op['summary'] : null;

  const parameters: NormalizedParam[] = [];
  for (const pRaw of (op['parameters'] as Array<Record<string, unknown>> | undefined) ?? []) {
    const inField = pRaw['in'];
    const name = pRaw['name'];
    if (typeof inField !== 'string' || typeof name !== 'string') continue;
    if (!['path', 'query', 'header', 'cookie'].includes(inField)) continue;
    parameters.push({
      in: inField as NormalizedParam['in'],
      name,
      required: Boolean(pRaw['required']),
    });
  }

  let bodyExample: NormalizedOperation['bodyExample'] = null;
  const requestBody = op['requestBody'] as { content?: Record<string, { example?: unknown }> } | undefined;
  if (requestBody?.content) {
    for (const [contentType, mt] of Object.entries(requestBody.content)) {
      if (mt && 'example' in mt && mt.example !== undefined) {
        bodyExample = {
          contentType,
          raw: contentType.includes('json')
            ? JSON.stringify(mt.example, null, 2)
            : String(mt.example),
        };
        break;
      }
    }
  }

  const security = 'security' in op ? readSecurityRequirement(op['security']) : null;

  return { method, path, tag, operationId, summary, parameters, bodyExample, security };
}

function readSecuritySchemes3(doc: Record<string, unknown>): Record<string, NormalizedSecurityScheme> {
  const components = doc['components'] as { securitySchemes?: Record<string, Record<string, unknown>> } | undefined;
  const schemes = components?.securitySchemes ?? {};
  const out: Record<string, NormalizedSecurityScheme> = {};
  for (const [name, s] of Object.entries(schemes)) {
    out[name] = mapSecurityScheme3(s);
  }
  return out;
}

function mapSecurityScheme3(s: Record<string, unknown>): NormalizedSecurityScheme {
  if (s['type'] === 'http' && s['scheme'] === 'bearer') return { kind: 'httpBearer' };
  if (s['type'] === 'http' && s['scheme'] === 'basic')  return { kind: 'httpBasic' };
  if (s['type'] === 'apiKey' && typeof s['in'] === 'string' && typeof s['name'] === 'string'
      && ['header', 'query', 'cookie'].includes(s['in'] as string)) {
    return { kind: 'apiKey', in: s['in'] as 'header' | 'query' | 'cookie', name: s['name'] as string };
  }
  if (s['type'] === 'oauth2') return { kind: 'oauth2' };
  return { kind: 'unknown', raw: s };
}

function readSecurityRequirement(raw: unknown): SecurityRequirement[] {
  if (!Array.isArray(raw)) return [];
  const out: SecurityRequirement[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const keys = Object.keys(entry);
    if (keys[0]) out.push({ schemeName: keys[0] });
  }
  return out;
}

function fallbackTitle(source: ImportSource): string {
  if (source.kind === 'file') {
    return source.origin.split(/[/\\]/).pop()?.replace(/\.(ya?ml|json)$/i, '') ?? 'Imported';
  }
  try { return new URL(source.origin).hostname; }
  catch { return 'Imported'; }
}
```

- [ ] **Step 4: Run — should pass**

```bash
npx vitest run tests/importer/swagger-openapi3.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/importer/swagger.ts tests/importer/swagger-openapi3.test.ts
git commit -m "feat(swagger): OpenAPI 3.x normalization"
```

---

## Task 3: Swagger 2.0 normalization

**Files:**
- Modify: `src/importer/swagger.ts`
- Test: `tests/importer/swagger-2.test.ts`

- [ ] **Step 1: Write failing test**

`tests/importer/swagger-2.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSpec } from '../../src/importer/swagger.js';

const tiny = {
  swagger: '2.0',
  info: { title: 'V2', version: '1.0' },
  host: 'api.example.com',
  basePath: '/v1',
  schemes: ['https'],
  paths: {
    '/widgets': {
      get: {
        tags: ['Widgets'],
        operationId: 'listWidgets',
        parameters: [{ in: 'query', name: 'q', required: false, type: 'string' }],
      },
    },
  },
  securityDefinitions: {
    apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
  },
  security: [{ apiKey: [] }],
};

describe('normalizeSwagger2', () => {
  it('derives the base url from schemes/host/basePath', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.baseUrlCandidates).toEqual(['https://api.example.com/v1']);
  });

  it('emits operations with correct tag/path/method', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.operations).toHaveLength(1);
    expect(spec.operations[0]!.method).toBe('GET');
    expect(spec.operations[0]!.path).toBe('/widgets');
    expect(spec.operations[0]!.tag).toBe('Widgets');
  });

  it('translates securityDefinitions into the 3.x shape', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.securitySchemes['apiKey']).toEqual({ kind: 'apiKey', in: 'header', name: 'X-Api-Key' });
  });
});
```

- [ ] **Step 2: Run — should fail (not implemented)**

```bash
npx vitest run tests/importer/swagger-2.test.ts
```

- [ ] **Step 3: Implement**

In `src/importer/swagger.ts`:

```ts
export function normalizeSwagger2(
  doc: Record<string, unknown>,
  source: ImportSource,
): NormalizedSpec {
  const info = (doc['info'] as Record<string, unknown> | undefined) ?? {};
  const title = (typeof info['title'] === 'string' && info['title']) || fallbackTitle(source);

  const scheme =
    (Array.isArray(doc['schemes']) && (doc['schemes'] as string[])[0]) || 'https';
  const host = typeof doc['host'] === 'string' ? doc['host'] : '';
  const basePath = typeof doc['basePath'] === 'string' ? doc['basePath'] : '';
  const baseUrlCandidates = host ? [`${scheme}://${host}${basePath}`] : [];

  const operations: NormalizedOperation[] = [];
  const paths = (doc['paths'] as Record<string, unknown> | undefined) ?? {};
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    if (!pathItemRaw || typeof pathItemRaw !== 'object') continue;
    const pathItem = pathItemRaw as Record<string, unknown>;
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const) {
      const opRaw = pathItem[method];
      if (!opRaw || typeof opRaw !== 'object') continue;
      const op = opRaw as Record<string, unknown>;
      operations.push(operationFromSwagger2(method.toUpperCase() as HttpMethod, path, op));
    }
  }

  const defs = (doc['securityDefinitions'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const securitySchemes: Record<string, NormalizedSecurityScheme> = {};
  for (const [name, s] of Object.entries(defs)) {
    if (s['type'] === 'basic') securitySchemes[name] = { kind: 'httpBasic' };
    else if (s['type'] === 'apiKey' && typeof s['in'] === 'string' && typeof s['name'] === 'string') {
      securitySchemes[name] = { kind: 'apiKey', in: s['in'] as 'header' | 'query' | 'cookie', name: s['name'] as string };
    } else if (s['type'] === 'oauth2') securitySchemes[name] = { kind: 'oauth2' };
    else securitySchemes[name] = { kind: 'unknown', raw: s };
  }

  return {
    title,
    baseUrlCandidates,
    operations,
    securitySchemes,
    globalSecurity: readSecurityRequirement(doc['security']),
  };
}

function operationFromSwagger2(method: HttpMethod, path: string, op: Record<string, unknown>): NormalizedOperation {
  const tags = (op['tags'] as string[] | undefined) ?? [];
  const tag = tags.length > 0 ? tags[0]! : null;
  const operationId = typeof op['operationId'] === 'string' ? op['operationId'] : null;
  const summary = typeof op['summary'] === 'string' ? op['summary'] : null;

  const parameters: NormalizedParam[] = [];
  let bodyExample: NormalizedOperation['bodyExample'] = null;
  for (const pRaw of (op['parameters'] as Array<Record<string, unknown>> | undefined) ?? []) {
    const inField = pRaw['in'];
    const name = pRaw['name'];
    if (typeof inField !== 'string' || typeof name !== 'string') continue;
    if (inField === 'body') {
      const example = pRaw['x-example'] ?? pRaw['example'];
      if (example !== undefined) {
        bodyExample = { contentType: 'application/json', raw: JSON.stringify(example, null, 2) };
      }
      continue;
    }
    if (!['path', 'query', 'header'].includes(inField)) continue;
    parameters.push({
      in: inField as NormalizedParam['in'],
      name,
      required: Boolean(pRaw['required']),
    });
  }

  const security = 'security' in op ? readSecurityRequirement(op['security']) : null;
  return { method, path, tag, operationId, summary, parameters, bodyExample, security };
}
```

- [ ] **Step 4: Run — should pass**

```bash
npx vitest run tests/importer/swagger-2.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/importer/swagger.ts tests/importer/swagger-2.test.ts
git commit -m "feat(swagger): Swagger 2.0 normalization"
```

---

## Task 4: Base URL resolution

**Files:**
- Modify: `src/importer/swagger.ts`
- Test: `tests/importer/swagger-baseurl.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { resolveBaseUrl } from '../../src/importer/swagger.js';

describe('resolveBaseUrl', () => {
  it('returns absolute candidate verbatim (strip trailing slash)', () => {
    expect(resolveBaseUrl({ candidates: ['https://api.example.com/v1/'], source: { kind: 'file', origin: 'x.json', text: '' } }))
      .toBe('https://api.example.com/v1');
  });
  it('joins relative candidate to URL source origin', () => {
    expect(resolveBaseUrl({
      candidates: ['/dyn-feature-68474/'],
      source: { kind: 'url', origin: 'https://oneroster.sis.nhatest.com/dyn-feature-68474/swagger/v1/swagger.json', text: '' },
    })).toBe('https://oneroster.sis.nhatest.com/dyn-feature-68474');
  });
  it('returns relative candidate verbatim for file sources', () => {
    expect(resolveBaseUrl({
      candidates: ['/dyn-feature-68474/'],
      source: { kind: 'file', origin: 'x.json', text: '' },
    })).toBe('/dyn-feature-68474');
  });
  it('falls back to "/" when no candidates', () => {
    expect(resolveBaseUrl({
      candidates: [], source: { kind: 'file', origin: 'x.json', text: '' },
    })).toBe('/');
  });
});
```

- [ ] **Step 2: Run — should fail**

- [ ] **Step 3: Implement**

```ts
export function resolveBaseUrl(args: { candidates: string[]; source: ImportSource }): string {
  const c = args.candidates[0];
  if (!c) return '/';
  const trimmed = c.replace(/\/+$/, '') || '/';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (args.source.kind === 'url') {
    try {
      const origin = new URL(args.source.origin).origin;
      return `${origin}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`.replace(/\/+$/, '') || origin;
    } catch { /* fall through */ }
  }
  return trimmed;
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/importer/swagger-baseurl.test.ts
git add src/importer/swagger.ts tests/importer/swagger-baseurl.test.ts
git commit -m "feat(swagger): base URL resolution"
```

---

## Task 5: Auth mapping (per request)

**Files:**
- Modify: `src/importer/swagger.ts` (add `applyAuthForOperation`)
- Test: `tests/importer/swagger-auth.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { applyAuthForOperation } from '../../src/importer/swagger.js';
import type { NormalizedSpec, NormalizedOperation } from '../../src/importer/swagger-types.js';

function spec(part: Partial<NormalizedSpec>): NormalizedSpec {
  return {
    title: 'x', baseUrlCandidates: [], operations: [], securitySchemes: {}, globalSecurity: [],
    ...part,
  };
}

const op = (over: Partial<NormalizedOperation> = {}): NormalizedOperation => ({
  method: 'GET', path: '/x', tag: null, operationId: null, summary: null,
  parameters: [], bodyExample: null, security: null, ...over,
});

describe('applyAuthForOperation', () => {
  it('httpBearer becomes a bearer auth', () => {
    const r = applyAuthForOperation(
      spec({ securitySchemes: { b: { kind: 'httpBearer' } }, globalSecurity: [{ schemeName: 'b' }] }),
      op(),
      { headers: [], queryParams: [] },
    );
    expect(r.auth).toEqual({ kind: 'bearer', data: { token: '{{bearerToken}}' } });
  });

  it('apiKey in header becomes a header', () => {
    const r = applyAuthForOperation(
      spec({
        securitySchemes: { k: { kind: 'apiKey', in: 'header', name: 'X-Api-Key' } },
        globalSecurity: [{ schemeName: 'k' }],
      }),
      op(),
      { headers: [], queryParams: [] },
    );
    expect(r.auth).toBeUndefined();
    expect(r.headers).toContainEqual({ key: 'X-Api-Key', value: '{{X-Api-Key}}' });
  });

  it('apiKey in query becomes a query param', () => { /* … */ });
  it('oauth2 leaves auth unset', () => { /* … */ });
  it('no security on op + no globalSecurity → no auth', () => { /* … */ });
  it('per-op security overrides globalSecurity', () => { /* … */ });
});
```

- [ ] **Step 2: Run — should fail**

- [ ] **Step 3: Implement**

```ts
export interface AuthApplyResult {
  auth?: { kind: 'bearer' | 'basic'; data: Record<string, string> };
  headers: { key: string; value: string }[];
  queryParams: { key: string; value: string }[];
  envSeedKeys: string[]; // env var names to seed in the "From swagger" env
}

export function applyAuthForOperation(
  spec: NormalizedSpec,
  op: NormalizedOperation,
  start: { headers: { key: string; value: string }[]; queryParams: { key: string; value: string }[] },
): AuthApplyResult {
  const reqs = op.security ?? spec.globalSecurity;
  const result: AuthApplyResult = {
    headers: [...start.headers],
    queryParams: [...start.queryParams],
    envSeedKeys: [],
  };
  if (reqs.length === 0) return result;
  const scheme = spec.securitySchemes[reqs[0]!.schemeName];
  if (!scheme) return result;
  switch (scheme.kind) {
    case 'httpBearer':
      result.auth = { kind: 'bearer', data: { token: '{{bearerToken}}' } };
      result.envSeedKeys.push('bearerToken');
      return result;
    case 'httpBasic':
      result.auth = { kind: 'basic', data: { username: '{{username}}', password: '{{password}}' } };
      result.envSeedKeys.push('username', 'password');
      return result;
    case 'apiKey':
      if (scheme.in === 'header') {
        result.headers.push({ key: scheme.name, value: `{{${scheme.name}}}` });
        result.envSeedKeys.push(scheme.name);
      } else if (scheme.in === 'query') {
        result.queryParams.push({ key: scheme.name, value: `{{${scheme.name}}}` });
        result.envSeedKeys.push(scheme.name);
      } else {
        result.headers.push({ key: 'Cookie', value: `${scheme.name}={{${scheme.name}}}` });
        result.envSeedKeys.push(scheme.name);
      }
      return result;
    case 'oauth2':
    case 'unknown':
      return result;
  }
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/importer/swagger-auth.test.ts
git add src/importer/swagger.ts tests/importer/swagger-auth.test.ts
git commit -m "feat(swagger): auth scheme → request auth/headers/params mapping"
```

---

## Task 6: Mapper — `NormalizedSpec` → DB rows

**Files:**
- Modify: `src/importer/swagger.ts` (add `importSpec` orchestrator)
- Test: `tests/importer/swagger-mapper.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Repos } from '../../src/storage/repos.js';
import { importSpec } from '../../src/importer/swagger.js';
import type { ImportSource } from '../../src/importer/swagger-types.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const dir = join(process.cwd(), 'src/storage/migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

const tiny = { /* same `tiny` fixture from Task 2 */ };

it('importSpec creates one collection, one folder per tag, one request per op', () => {
  const db = freshDb();
  const ws = Repos.Workspaces.create(db, { name: 'w' });
  const source: ImportSource = { kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) };
  const result = importSpec(db, { workspaceId: ws.id, source });
  expect(result.stats.operations).toBe(3);
  expect(result.stats.tags).toBe(1);
  const reqs = Repos.Requests.listByCollection(db, result.collectionId);
  const listUser = reqs.find((r) => r.name.includes('List users'))!;
  expect(listUser.url).toBe('{{baseUrl}}/users');
  const getUser = reqs.find((r) => /getUser|GET \/users\/\{/.test(r.name))!;
  expect(getUser.url).toBe('{{baseUrl}}/users/{{id}}');
});
```

- [ ] **Step 2: Run — should fail**

- [ ] **Step 3: Implement `importSpec`**

```ts
export function importSpec(
  db: Db,
  args: { workspaceId: string; source: ImportSource; parentCollectionId?: string },
): { collectionId: string; stats: { operations: number; tags: number; paramVars: number } } {
  const spec = parseSpec(args.source);
  const baseUrl = resolveBaseUrl({ candidates: spec.baseUrlCandidates, source: args.source });

  const collection = Repos.Collections.create(db, {
    workspaceId: args.workspaceId,
    name: spec.title,
    ...(args.parentCollectionId !== undefined ? { parentCollectionId: args.parentCollectionId } : {}),
  });

  // One folder per unique tag.
  const tags = [...new Set(spec.operations.map((o) => o.tag).filter((t): t is string => t !== null))];
  const folderByTag = new Map<string, string>();
  for (const tag of tags) {
    const f = Repos.Folders.create(db, { collectionId: collection.id, name: tag });
    folderByTag.set(tag, f.id);
  }

  // Track param-name usage to seed env vars for path params shared by 2+ ops.
  const pathParamUseCount = new Map<string, number>();
  const envSeedKeys = new Set<string>(['baseUrl']);

  for (const op of spec.operations) {
    const headers: { key: string; value: string }[] = [];
    const queryParams: { key: string; value: string }[] = [];
    for (const p of op.parameters) {
      if (p.in === 'header') headers.push({ key: p.name, value: `{{${p.name}}}` });
      else if (p.in === 'query' && p.required) queryParams.push({ key: p.name, value: `{{${p.name}}}` });
      else if (p.in === 'path') {
        pathParamUseCount.set(p.name, (pathParamUseCount.get(p.name) ?? 0) + 1);
      }
    }
    const authResult = applyAuthForOperation(spec, op, { headers, queryParams });
    for (const k of authResult.envSeedKeys) envSeedKeys.add(k);

    const pathTemplated = op.path.replace(/\{([^}]+)\}/g, '{{$1}}');
    const queryStr =
      authResult.queryParams.length > 0
        ? '?' + authResult.queryParams.sort((a, b) => a.key.localeCompare(b.key))
            .map((q) => `${q.key}=${q.value}`).join('&')
        : '';

    const requestName =
      op.summary || op.operationId || `${op.method} ${op.path}`;

    const create: Parameters<typeof Repos.Requests.create>[1] = {
      collectionId: collection.id,
      name: requestName,
      method: op.method,
      url: `{{baseUrl}}${pathTemplated}${queryStr}`,
      headers: authResult.headers,
    };
    const folderId = op.tag ? folderByTag.get(op.tag) : undefined;
    if (folderId) create.folderId = folderId;
    if (op.operationId) create.chainName = slug(op.operationId);
    if (op.method !== 'GET' && op.method !== 'HEAD' && op.bodyExample) {
      create.body = { kind: 'json', raw: op.bodyExample.raw };
      // Make sure Content-Type is set if not already.
      if (!authResult.headers.some((h) => h.key.toLowerCase() === 'content-type')) {
        create.headers = [...authResult.headers, { key: 'Content-Type', value: op.bodyExample.contentType }];
      }
    }
    if (authResult.auth) create.auth = authResult.auth;
    Repos.Requests.create(db, create);
  }

  // "From swagger" env at the collection root with baseUrl + shared path params + auth seeds.
  const env = Repos.Envs.create(db, { folderId: collection.rootFolderId, name: 'From swagger' });
  Repos.Vars.create(db, { envId: env.id, key: 'baseUrl', valuePlain: baseUrl });
  for (const [name, count] of pathParamUseCount) {
    if (count >= 2) {
      Repos.Vars.create(db, { envId: env.id, key: name, valuePlain: '' });
      envSeedKeys.add(name);
    }
  }
  for (const k of envSeedKeys) {
    if (k === 'baseUrl') continue;
    // Avoid duplicates (path param + auth key collision).
    const existing = Repos.Vars.listByEnv(db, env.id).some((v) => v.key === k);
    if (!existing) Repos.Vars.create(db, { envId: env.id, key: k, valuePlain: '' });
  }
  Repos.Envs.setActive(db, collection.rootFolderId, env.id);

  return {
    collectionId: collection.id,
    stats: {
      operations: spec.operations.length,
      tags: tags.length,
      paramVars: [...pathParamUseCount.values()].filter((n) => n >= 2).length,
    },
  };
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '').replace(/^./, (c) => c.toLowerCase());
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/importer/swagger-mapper.test.ts
git add src/importer/swagger.ts tests/importer/swagger-mapper.test.ts
git commit -m "feat(swagger): map NormalizedSpec to collection/folders/requests/env"
```

---

## Task 7: IPC handlers

**Files:**
- Modify: `src/app/handlers.ts`
- Modify: `src/ipc/types.ts`
- Test: `tests/handlers/swagger-import.test.ts`, `tests/fixtures/oneroster-skeleton.json`

- [ ] **Step 1: Add fixture**

`tests/fixtures/oneroster-skeleton.json` — copy a trimmed subset of the real OneRoster spec (5 operations across 2 tags is enough for the test).

- [ ] **Step 2: Write failing test**

`tests/handlers/swagger-import.test.ts`:

```ts
it('swagger:import (file) creates a collection with the expected counts', async () => {
  /* …seed workspace…  */
  const r = await h['swagger:import']({
    source: { kind: 'file', path: join(__dirname, '../fixtures/oneroster-skeleton.json') },
  });
  expect(r.stats.operations).toBeGreaterThan(0);
  expect(Repos.Collections.get(db, r.collectionId)?.name).toBeTruthy();
});

it('swagger:import (url) resolves baseUrl from origin', async () => {
  // Use a stubbed fetch — see Task 7 step 4 for the dependency-injection seam.
});
```

- [ ] **Step 3: Run — should fail**

- [ ] **Step 4: Add the IPC handlers**

In `src/app/handlers.ts`:

```ts
'dialog:openSwagger': async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import Swagger / OpenAPI',
    filters: [
      { name: 'Swagger / OpenAPI', extensions: ['json', 'yaml', 'yml'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return { path: null };
  return { path: result.filePaths[0]! };
},

'swagger:fetch': async ({ url }) => {
  const res = await fetch(url, { headers: { Accept: 'application/json, application/yaml, text/yaml' } });
  if (!res.ok) throw new Error(`SWAGGER_FETCH: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 10 * 1024 * 1024) throw new Error('SWAGGER_TOO_LARGE');
  return { text };
},

'swagger:import': async ({ source, parentCollectionId }) => {
  const entries = readIndex();
  if (entries.length === 0) throw new Error('NO_WORKSPACE');
  const workspaceId = entries[0]!.id;

  let importSource: ImportSource;
  if (source.kind === 'file') {
    const text = readFileSync(source.path, 'utf8');
    importSource = { kind: 'file', origin: source.path, text };
  } else {
    const res = await fetch(source.url, { headers: { Accept: 'application/json, application/yaml, text/yaml' } });
    if (!res.ok) throw new Error(`SWAGGER_FETCH: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 10 * 1024 * 1024) throw new Error('SWAGGER_TOO_LARGE');
    importSource = { kind: 'url', origin: source.url, text };
  }
  return importSpec(getDb(), {
    workspaceId,
    source: importSource,
    ...(parentCollectionId !== undefined ? { parentCollectionId } : {}),
  });
},
```

Add `ImportSource` import at the top of `handlers.ts`.

- [ ] **Step 5: Type the channels**

In `src/ipc/types.ts`, add the three new channel payload types.

- [ ] **Step 6: Run + commit**

```bash
npx vitest run tests/handlers/swagger-import.test.ts
git add src/app/handlers.ts src/ipc/types.ts tests/handlers/swagger-import.test.ts tests/fixtures/oneroster-skeleton.json
git commit -m "feat(swagger): IPC handlers (dialog, fetch, import)"
```

---

## Task 8: Sidebar entry point + dialog component

**Files:**
- Create: `src/ui/components/swagger-import-dialog.ts`
- Modify: `src/ui/components/app-frame.ts` (mount at body level)
- Modify: `src/ui/components/sidebar-tree.ts` (or wherever the COLLECTIONS-header `+` menu lives — see commit `68cf4ae`)
- Test: `tests-e2e/swagger-import.spec.ts`

- [ ] **Step 1: Create the dialog component**

`src/ui/components/swagger-import-dialog.ts` — mirror `env-manager.ts` for the dialog shell, `tabs:open` for the IPC call style. The component owns:
- Two signals: `mode = signal<'file' | 'url'>('url')` and `url = signal('')`.
- Document-event opener (`hu:open-swagger-import`).
- A render method with an `<ml-dialog>`, a segmented control between File and URL, and a "Import" button.
- An `import()` method:

```ts
import = async (): Promise<void> => {
  try {
    if (this.mode() === 'file') {
      const f = await rpc<{ path: string | null }>({ kind: 'dialog:openSwagger' });
      if (!f.path) return;
      const r = await rpc<{ collectionId: string; stats: { operations: number; tags: number } }>(
        { kind: 'swagger:import', source: { kind: 'file', path: f.path } },
      );
      showToast(`Imported ${r.stats.operations} operations across ${r.stats.tags} tags`, 'success');
    } else {
      const u = this.url().trim();
      if (!u) return;
      const r = await rpc<{ collectionId: string; stats: { operations: number; tags: number } }>(
        { kind: 'swagger:import', source: { kind: 'url', url: u } },
      );
      showToast(`Imported ${r.stats.operations} operations across ${r.stats.tags} tags`, 'success');
    }
    const ws = activeWorkspace();
    if (ws) await loadWorkspaceData(ws.id);
    this.close();
  } catch (err) {
    showToast((err as Error).message, 'error');
  }
};
```

- [ ] **Step 2: Mount the dialog in app-frame**

In `src/ui/components/app-frame.ts` `onCreate` (around line 230):

```ts
this._swaggerImport = document.createElement('hu-swagger-import-dialog');
document.body.appendChild(this._swaggerImport);
```

Add `private _swaggerImport: HTMLElement | null = null;` and the matching cleanup in `onDestroy`.

- [ ] **Step 3: Wire the sidebar entry**

Find where "New collection" is dispatched (grep `'+ Collection'` / `collection:create` / `+` button on COLLECTIONS header — see `68cf4ae`). Add a menu item "Import from Swagger…" that dispatches:

```ts
document.dispatchEvent(new CustomEvent('hu:open-swagger-import'));
```

The dialog component listens for that event and calls `this._dialog()?.open()`.

- [ ] **Step 4: Manual smoke**

```bash
npm run dev
```

In the running app: click the COLLECTIONS `+` menu → "Import from Swagger…" → paste `https://oneroster.sis.nhatest.com/dyn-feature-68474/swagger/v1/swagger.json` → click Import. Expect a new "OneRoster" (or whatever `info.title` is) collection with folders for each tag and ~144 requests.

- [ ] **Step 5: Playwright spec**

`tests-e2e/swagger-import.spec.ts` — exercise the URL path against a local fixture served via the existing test harness (check `tests-e2e/` for the fixture-server pattern). Verify the new collection appears in the tree with at least one folder and one request.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/swagger-import-dialog.ts src/ui/components/app-frame.ts src/ui/components/sidebar-tree.ts tests-e2e/swagger-import.spec.ts
git commit -m "feat(swagger): import dialog + sidebar entry"
```

---

## Final pass

- [ ] **Step 1: Type check + full test run**

```bash
npm run typecheck
npx vitest run
npx playwright test
```

- [ ] **Step 2: Manual smoke against the live OneRoster spec**

Import `https://oneroster.sis.nhatest.com/dyn-feature-68474/swagger/v1/swagger.json`. Confirm:
1. New collection appears with the expected number of folders (one per OneRoster tag).
2. `From swagger` env is active and `baseUrl` = `https://oneroster.sis.nhatest.com/dyn-feature-68474`.
3. Pick one request (e.g. `GET /ims/oneroster/rostering/v1p2/academicSessions`). Send → 200 or whatever the server returns; no `Invalid URL` toast.

- [ ] **Step 3: Commit any smoke-test fixes**

```bash
git add -A
git commit -m "polish(swagger): smoke-test fixes"
```

---

**Plan complete. Saved to `docs/superpowers/plans/2026-05-18-swagger-import.md`.**
