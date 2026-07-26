import { parse as parseYaml } from 'yaml';
import type { Db } from '../storage/db.js';
import { Repos } from '../storage/repos.js';
import type {
  ImportSource,
  NormalizedSpec,
  NormalizedOperation,
  NormalizedParam,
  NormalizedSecurityScheme,
  SecurityRequirement,
  HttpMethod,
} from './swagger-types.js';

export type {
  ImportSource,
  NormalizedSpec,
  NormalizedOperation,
  NormalizedParam,
  NormalizedSecurityScheme,
  SecurityRequirement,
  HttpMethod,
};

/**
 * Parse a swagger/OpenAPI document text (JSON or YAML) into a NormalizedSpec.
 * Throws SWAGGER_PARSE if the text isn't valid JSON+YAML or the root is missing
 * both `openapi` and `swagger` discriminators.
 */
export function parseSpec(source: ImportSource): NormalizedSpec {
  const raw = parseDocument(source.text);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('SWAGGER_PARSE: document root must be an object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.openapi === 'string') return normalizeOpenApi3(r, source);
  if (typeof r.swagger === 'string') return normalizeSwagger2(r, source);
  throw new Error('SWAGGER_PARSE: missing `openapi` or `swagger` discriminator field');
}

function parseDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to YAML */
  }
  try {
    return parseYaml(text);
  } catch (e) {
    throw new Error(`SWAGGER_PARSE: ${(e as Error).message}`);
  }
}

// =====================================================================
// OpenAPI 3.x
// =====================================================================

export function normalizeOpenApi3(
  doc: Record<string, unknown>,
  source: ImportSource,
): NormalizedSpec {
  const info = (doc.info as Record<string, unknown> | undefined) ?? {};
  const title =
    (typeof info.title === 'string' && info.title) || fallbackTitle(source);

  const servers =
    (doc.servers as { url?: string }[] | undefined) ?? [];
  const baseUrlCandidates = servers
    .map((s) => (typeof s.url === 'string' ? s.url : null))
    .filter((u): u is string => u !== null && u.length > 0);

  const securitySchemes = readSecuritySchemes3(doc);
  const globalSecurity = readSecurityRequirement(doc.security);

  const operations: NormalizedOperation[] = [];
  const paths = (doc.paths as Record<string, unknown> | undefined) ?? {};
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    if (!pathItemRaw || typeof pathItemRaw !== 'object') continue;
    const pathItem = pathItemRaw as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      const opRaw = pathItem[method.toLowerCase()];
      if (!opRaw || typeof opRaw !== 'object') continue;
      operations.push(
        operationFromOpenApi3(method, path, opRaw as Record<string, unknown>),
      );
    }
  }

  return { title, baseUrlCandidates, operations, securitySchemes, globalSecurity };
}

function operationFromOpenApi3(
  method: HttpMethod,
  path: string,
  op: Record<string, unknown>,
): NormalizedOperation {
  const tags = (op.tags as string[] | undefined) ?? [];
  const tag = tags.length > 0 ? tags[0]! : null;
  const operationId = typeof op.operationId === 'string' ? op.operationId : null;
  const summary = typeof op.summary === 'string' ? op.summary : null;

  const parameters: NormalizedParam[] = [];
  for (const pRaw of (op.parameters as Record<string, unknown>[] | undefined) ?? []) {
    const inField = pRaw.in;
    const name = pRaw.name;
    if (typeof inField !== 'string' || typeof name !== 'string') continue;
    if (!isParamLocation(inField)) continue;
    parameters.push({
      in: inField,
      name,
      required: Boolean(pRaw.required),
    });
  }

  let bodyExample: NormalizedOperation['bodyExample'] = null;
  const requestBody = op.requestBody as
    | { content?: Record<string, { example?: unknown }> }
    | undefined;
  if (requestBody?.content) {
    for (const [contentType, mt] of Object.entries(requestBody.content)) {
      if (mt && 'example' in mt && mt.example !== undefined) {
        bodyExample = {
          contentType,
          raw: contentType.includes('json')
            ? JSON.stringify(mt.example, null, 2)
            : // eslint-disable-next-line @typescript-eslint/no-base-to-string -- non-JSON examples keep String()'s existing output, including '[object Object]'.
              String(mt.example),
        };
        break;
      }
    }
  }

  const security = 'security' in op ? readSecurityRequirement(op.security) : null;
  return { method, path, tag, operationId, summary, parameters, bodyExample, security };
}

function readSecuritySchemes3(
  doc: Record<string, unknown>,
): Record<string, NormalizedSecurityScheme> {
  const components = doc.components as
    | { securitySchemes?: Record<string, Record<string, unknown>> }
    | undefined;
  const schemes = components?.securitySchemes ?? {};
  const out: Record<string, NormalizedSecurityScheme> = {};
  for (const [name, s] of Object.entries(schemes)) {
    out[name] = mapSecurityScheme3(s);
  }
  return out;
}

function mapSecurityScheme3(s: Record<string, unknown>): NormalizedSecurityScheme {
  if (s.type === 'http' && s.scheme === 'bearer') return { kind: 'httpBearer' };
  if (s.type === 'http' && s.scheme === 'basic') return { kind: 'httpBasic' };
  if (
    s.type === 'apiKey' &&
    typeof s.in === 'string' &&
    typeof s.name === 'string' &&
    isApiKeyLocation(s.in)
  ) {
    return { kind: 'apiKey', in: s.in, name: s.name };
  }
  if (s.type === 'oauth2') return { kind: 'oauth2' };
  return { kind: 'unknown', raw: s };
}

// =====================================================================
// Swagger 2.0
// =====================================================================

export function normalizeSwagger2(
  doc: Record<string, unknown>,
  source: ImportSource,
): NormalizedSpec {
  const info = (doc.info as Record<string, unknown> | undefined) ?? {};
  const title = (typeof info.title === 'string' && info.title) || fallbackTitle(source);

  const scheme =
    (Array.isArray(doc.schemes) && (doc.schemes as string[])[0]) || 'https';
  const host = typeof doc.host === 'string' ? doc.host : '';
  const basePath = typeof doc.basePath === 'string' ? doc.basePath : '';
  const baseUrlCandidates = host ? [`${scheme}://${host}${basePath}`] : [];

  const operations: NormalizedOperation[] = [];
  const paths = (doc.paths as Record<string, unknown> | undefined) ?? {};
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    if (!pathItemRaw || typeof pathItemRaw !== 'object') continue;
    const pathItem = pathItemRaw as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      const opRaw = pathItem[method.toLowerCase()];
      if (!opRaw || typeof opRaw !== 'object') continue;
      operations.push(
        operationFromSwagger2(method, path, opRaw as Record<string, unknown>),
      );
    }
  }

  const defs =
    (doc.securityDefinitions as Record<string, Record<string, unknown>> | undefined) ?? {};
  const securitySchemes: Record<string, NormalizedSecurityScheme> = {};
  for (const [name, s] of Object.entries(defs)) {
    if (s.type === 'basic') securitySchemes[name] = { kind: 'httpBasic' };
    else if (
      s.type === 'apiKey' &&
      typeof s.in === 'string' &&
      typeof s.name === 'string' &&
      isApiKeyLocation(s.in)
    ) {
      securitySchemes[name] = { kind: 'apiKey', in: s.in, name: s.name };
    } else if (s.type === 'oauth2') securitySchemes[name] = { kind: 'oauth2' };
    else securitySchemes[name] = { kind: 'unknown', raw: s };
  }

  return {
    title,
    baseUrlCandidates,
    operations,
    securitySchemes,
    globalSecurity: readSecurityRequirement(doc.security),
  };
}

function operationFromSwagger2(
  method: HttpMethod,
  path: string,
  op: Record<string, unknown>,
): NormalizedOperation {
  const tags = (op.tags as string[] | undefined) ?? [];
  const tag = tags.length > 0 ? tags[0]! : null;
  const operationId = typeof op.operationId === 'string' ? op.operationId : null;
  const summary = typeof op.summary === 'string' ? op.summary : null;

  const parameters: NormalizedParam[] = [];
  let bodyExample: NormalizedOperation['bodyExample'] = null;
  for (const pRaw of (op.parameters as Record<string, unknown>[] | undefined) ?? []) {
    const inField = pRaw.in;
    const name = pRaw.name;
    if (typeof inField !== 'string' || typeof name !== 'string') continue;
    if (inField === 'body') {
      const example = pRaw['x-example'] ?? pRaw.example;
      if (example !== undefined) {
        bodyExample = {
          contentType: 'application/json',
          raw: JSON.stringify(example, null, 2),
        };
      }
      continue;
    }
    if (!isParamLocation(inField) || inField === 'cookie') continue;
    parameters.push({
      in: inField,
      name,
      required: Boolean(pRaw.required),
    });
  }

  const security = 'security' in op ? readSecurityRequirement(op.security) : null;
  return { method, path, tag, operationId, summary, parameters, bodyExample, security };
}

// =====================================================================
// Base URL resolution
// =====================================================================

/**
 * Resolve a single absolute baseUrl from the candidate list. Strips trailing
 * slashes so templated URLs don't double-slash at the join.
 */
export function resolveBaseUrl(args: {
  candidates: string[];
  source: ImportSource;
}): string {
  const c = args.candidates[0];
  if (!c) return '/';
  const trimmed = c.replace(/\/+$/, '') || '/';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (args.source.kind === 'url') {
    try {
      const origin = new URL(args.source.origin).origin;
      const joined = `${origin}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
      return joined.replace(/\/+$/, '') || origin;
    } catch {
      /* fall through */
    }
  }
  return trimmed;
}

// =====================================================================
// Auth mapping (per operation)
// =====================================================================

export interface AuthApplyResult {
  /** Set when the scheme maps cleanly to Coax's auth field. */
  auth?: { kind: 'bearer' | 'basic'; data: Record<string, string> };
  /** Headers including any apiKey/Cookie additions from the auth scheme. */
  headers: { key: string; value: string }[];
  /** Query params including any apiKey-in-query additions. */
  queryParams: { key: string; value: string }[];
  /**
   * Variable names to seed into the "From swagger" env (with empty values).
   * Lets the user fill them out once in Manage Envs rather than per-request.
   */
  envSeedKeys: string[];
}

/**
 * Resolve the per-operation security and translate the first applicable scheme
 * into Coax's auth/headers/queryParams shape. Operation-level `security`
 * overrides spec-level `globalSecurity`; an empty list means "no auth".
 */
export function applyAuthForOperation(
  spec: NormalizedSpec,
  op: NormalizedOperation,
  start: {
    headers: { key: string; value: string }[];
    queryParams: { key: string; value: string }[];
  },
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
      result.auth = {
        kind: 'basic',
        data: { username: '{{username}}', password: '{{password}}' },
      };
      result.envSeedKeys.push('username', 'password');
      return result;
    case 'apiKey':
      if (scheme.in === 'header') {
        result.headers.push({ key: scheme.name, value: `{{${scheme.name}}}` });
      } else if (scheme.in === 'query') {
        result.queryParams.push({ key: scheme.name, value: `{{${scheme.name}}}` });
      } else {
        result.headers.push({
          key: 'Cookie',
          value: `${scheme.name}={{${scheme.name}}}`,
        });
      }
      result.envSeedKeys.push(scheme.name);
      return result;
    case 'oauth2':
    case 'unknown':
      // Leave the user to wire it up in the Auth tab.
      return result;
  }
}

// =====================================================================
// Mapper: NormalizedSpec -> Coax collection/folders/requests/env
// =====================================================================

export interface ImportSpecResult {
  collectionId: string;
  stats: {
    operations: number;
    tags: number;
    paramVars: number;
  };
}

/**
 * Top-level orchestrator: parse the source, resolve baseUrl, create one
 * collection + N folders (one per tag) + one request per operation +
 * the "From swagger" env at the collection root pre-populated with
 * baseUrl + shared path params + any auth-required keys.
 */
export function importSpec(
  db: Db,
  args: { workspaceId: string; source: ImportSource; parentCollectionId?: string },
): ImportSpecResult {
  const spec = parseSpec(args.source);
  const baseUrl = resolveBaseUrl({
    candidates: spec.baseUrlCandidates,
    source: args.source,
  });

  // Place the imported spec at the workspace root by default; if the
  // caller anchored on an existing collection, drop into that collection's
  // directory. (Directories model: collections live IN a directory.) Lazy-
  // create the root directory if missing (mirrors Collections.create).
  const root =
    Repos.Directories.getRoot(db, args.workspaceId) ??
    Repos.Directories.create(db, { workspaceId: args.workspaceId, name: '' });
  let directoryId = root.id;
  if (args.parentCollectionId !== undefined) {
    const anchor = Repos.Collections.get(db, args.parentCollectionId);
    if (anchor) directoryId = anchor.directoryId;
  }
  const collection = Repos.Collections.create(db, {
    workspaceId: args.workspaceId,
    name: spec.title,
    directoryId,
  });

  // One folder per unique tag, preserving first-seen order.
  const tagOrder: string[] = [];
  const seenTags = new Set<string>();
  for (const op of spec.operations) {
    if (op.tag && !seenTags.has(op.tag)) {
      seenTags.add(op.tag);
      tagOrder.push(op.tag);
    }
  }
  const folderByTag = new Map<string, string>();
  for (const tag of tagOrder) {
    const f = Repos.Folders.create(db, { collectionId: collection.id, name: tag });
    folderByTag.set(tag, f.id);
  }

  // Track path-param-usage across operations so shared params get seeded as
  // top-level env vars (the user sets them once, every request inherits).
  const pathParamUseCount = new Map<string, number>();
  // Keys to seed into the "From swagger" env. baseUrl is always present;
  // auth schemes contribute their templated names; path params used in 2+
  // operations contribute theirs.
  const envSeedKeys = new Set<string>();

  for (const op of spec.operations) {
    const startHeaders: { key: string; value: string }[] = [];
    const startQueryParams: { key: string; value: string }[] = [];
    for (const p of op.parameters) {
      if (p.in === 'header') {
        startHeaders.push({ key: p.name, value: `{{${p.name}}}` });
      } else if (p.in === 'query' && p.required) {
        startQueryParams.push({ key: p.name, value: `{{${p.name}}}` });
      } else if (p.in === 'path') {
        pathParamUseCount.set(p.name, (pathParamUseCount.get(p.name) ?? 0) + 1);
      }
    }
    const authResult = applyAuthForOperation(spec, op, {
      headers: startHeaders,
      queryParams: startQueryParams,
    });
    for (const k of authResult.envSeedKeys) envSeedKeys.add(k);

    const pathTemplated = op.path.replace(/\{([^}]+)\}/g, '{{$1}}');
    const queryStr =
      authResult.queryParams.length > 0
        ? '?' +
          [...authResult.queryParams]
            .sort((a, b) => a.key.localeCompare(b.key))
            .map((q) => `${q.key}=${q.value}`)
            .join('&')
        : '';

    const requestName = op.summary || op.operationId || `${op.method} ${op.path}`;

    const headers = [...authResult.headers];
    // Set Content-Type when we're attaching a body and the auth path didn't
    // already supply one.
    const hasBody =
      op.method !== 'GET' && op.method !== 'HEAD' && op.bodyExample !== null;
    if (
      hasBody &&
      !headers.some((h) => h.key.toLowerCase() === 'content-type')
    ) {
      headers.push({ key: 'Content-Type', value: op.bodyExample!.contentType });
    }

    const create: Parameters<typeof Repos.Requests.create>[1] = {
      collectionId: collection.id,
      name: requestName,
      method: op.method,
      url: `{{baseUrl}}${pathTemplated}${queryStr}`,
      headers,
    };
    const folderId = op.tag ? folderByTag.get(op.tag) : undefined;
    if (folderId) create.folderId = folderId;
    if (op.operationId) create.chainName = slug(op.operationId);
    if (hasBody) {
      create.body = {
        kind: bodyKindForContentType(op.bodyExample!.contentType),
        raw: op.bodyExample!.raw,
      };
    }
    if (authResult.auth) create.auth = authResult.auth;
    Repos.Requests.create(db, create);
  }

  // Create the "From swagger" env at the collection root with the seeded keys.
  const env = Repos.Envs.create(db, {
    folderId: collection.rootFolderId,
    name: 'From swagger',
  });
  Repos.Vars.create(db, { envId: env.id, key: 'baseUrl', valuePlain: baseUrl });

  let paramVarCount = 0;
  for (const [name, count] of pathParamUseCount) {
    if (count >= 2) {
      Repos.Vars.create(db, { envId: env.id, key: name, valuePlain: '' });
      paramVarCount++;
    }
  }
  for (const k of envSeedKeys) {
    if (k === 'baseUrl') continue;
    const exists = Repos.Vars.listByEnv(db, env.id).some((v) => v.key === k);
    if (!exists) Repos.Vars.create(db, { envId: env.id, key: k, valuePlain: '' });
  }
  Repos.Envs.setActive(db, env.id);

  return {
    collectionId: collection.id,
    stats: {
      operations: spec.operations.length,
      tags: tagOrder.length,
      paramVars: paramVarCount,
    },
  };
}

function slug(s: string): string {
  // Strip non-alphanumerics; lowercase the leading character. We keep the rest
  // case-sensitive so `getUser` stays distinct from `getuser`.
  const stripped = s.replace(/[^a-zA-Z0-9]+/g, '');
  if (stripped.length === 0) return '';
  return stripped[0]!.toLowerCase() + stripped.slice(1);
}

function bodyKindForContentType(ct: string): string {
  const lower = ct.toLowerCase();
  if (lower.includes('json')) return 'json';
  if (lower.includes('xml')) return 'text';
  if (lower.includes('form')) return 'form';
  return 'text';
}

// =====================================================================
// Helpers
// =====================================================================

const HTTP_METHODS: HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

function isParamLocation(v: string): v is NormalizedParam['in'] {
  return v === 'path' || v === 'query' || v === 'header' || v === 'cookie';
}

function isApiKeyLocation(v: string): v is 'header' | 'query' | 'cookie' {
  return v === 'header' || v === 'query' || v === 'cookie';
}

function readSecurityRequirement(raw: unknown): SecurityRequirement[] {
  if (!Array.isArray(raw)) return [];
  const out: SecurityRequirement[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const keys = Object.keys(entry);
    if (keys[0]) out.push({ schemeName: keys[0] });
  }
  return out;
}

function fallbackTitle(source: ImportSource): string {
  if (source.kind === 'file') {
    return (
      source.origin.split(/[/\\]/).pop()?.replace(/\.(ya?ml|json)$/i, '') ??
      'Imported'
    );
  }
  try {
    return new URL(source.origin).hostname;
  } catch {
    return 'Imported';
  }
}
