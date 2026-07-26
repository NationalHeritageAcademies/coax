// =============================================================================
// Workspace path helpers
// =============================================================================
//
// Pure functions that map between three kinds of paths:
//
//   1. The workspace folder the user picked (e.g. ~/code/scholargateway-api/)
//   2. Collection .http files inside that folder (e.g. scholargateway.http)
//   3. Env JSON siblings of those .http files (e.g. scholargateway.dev.env.json)
//
// Plus one helper for deriving the per-machine cache location under
// <userData>/Coax/workspaces/<hash>/. Workspace identity = absolute path.
// Moving the workspace folder invalidates the cache; Coax just rebuilds it.

import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path';

/**
 * User-visible filename for a collection. Slugged from the collection's
 * display name so renames produce portable filenames. The slug is
 * lowercase-ascii with hyphens — survives every filesystem we care about
 * (APFS, NTFS, ext4) without escaping concerns.
 */
export function collectionFileName(displayName: string): string {
  return `${slug(displayName)}.http`;
}

/**
 * Build the env JSON path for a given `.http` path and env name.
 * `scholargateway.http` + `dev` → `scholargateway.dev.env.json` (in the same
 * directory). Env names get slugged the same way collection names do.
 */
export function envFilePath(httpFilePath: string, envName: string): string {
  const dir = dirname(httpFilePath);
  const base = basename(httpFilePath, '.http');
  return join(dir, `${base}.${slug(envName)}.env.json`);
}

/**
 * Reverse parse: given an `.env.json` path that lives next to a known `.http`
 * file, return `{ envName }` for the env it represents. Returns null if the
 * file doesn't match the expected `<collection>.<env>.env.json` shape.
 */
export function parseEnvFileName(
  envFilePathArg: string,
  httpFilePath: string,
): { envName: string } | null {
  const envBase = basename(envFilePathArg);
  const httpBase = basename(httpFilePath, '.http');
  const prefix = `${httpBase}.`;
  const suffix = '.env.json';
  if (!envBase.startsWith(prefix) || !envBase.endsWith(suffix)) return null;
  const middle = envBase.slice(prefix.length, envBase.length - suffix.length);
  if (middle === '') return null;
  return { envName: middle };
}

/**
 * Per-machine cache directory for a given workspace path. Identity is the
 * absolute path's SHA-256, truncated for brevity. Same path always hashes to
 * the same dir on the same machine; moving the workspace orphans the cache
 * and Coax just rebuilds it from the files on next open.
 */
export function workspaceCacheDir(userDataRoot: string, workspacePath: string): string {
  const abs = resolvePath(workspacePath);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 16);
  return join(userDataRoot, 'workspaces', hash);
}

/**
 * Path to the cache SQLite file inside a workspace's cache dir.
 */
export function workspaceCacheDbPath(userDataRoot: string, workspacePath: string): string {
  return join(workspaceCacheDir(userDataRoot, workspacePath), 'cache.sqlite');
}

/**
 * Slug a display name into something safe for any common filesystem.
 *
 * Rules:
 *   - lowercase
 *   - ASCII letters, digits, hyphens; everything else collapses to '-'
 *   - no leading/trailing hyphens
 *   - never empty (falls back to 'untitled')
 *
 * This is intentionally a one-way function — we don't try to reverse it on
 * read, we look up the slug in a known list. The unslugged display name lives
 * inside the file (in the parser's metadata) for UI rendering.
 */
export function slug(displayName: string): string {
  const out = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out === '' ? 'untitled' : out;
}

/**
 * `true` if the given file path is a Coax env JSON file (regardless of
 * which collection it belongs to). Caller still has to match it against a
 * known collection via `parseEnvFileName`.
 */
export function looksLikeEnvFile(path: string): boolean {
  return extname(path) === '.json' && path.endsWith('.env.json');
}
