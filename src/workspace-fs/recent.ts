// =============================================================================
// Recent workspaces tracking
// =============================================================================
//
// Per-machine list of recently-opened workspace folders. Stored as a flat
// JSON file in user-data because (a) it's tiny, (b) it has to be available
// before any workspace is open (so it can't live in cache.sqlite, which is
// per-workspace), and (c) keeping it human-readable makes manual fixes
// possible if anything goes wrong.

import { existsSync, readFileSync } from 'node:fs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const RECENT_LIMIT = 20;

export interface RecentWorkspace {
  /** Absolute path to the workspace folder. */
  path: string;
  /** Human-readable name — usually the folder's basename. */
  name: string;
  /** ISO 8601 timestamp of the last successful open. */
  lastOpenedAt: string;
}

function recentFilePath(userDataRoot: string): string {
  return join(userDataRoot, 'Coax', 'recent-workspaces.json');
}

/**
 * Read the recent-workspaces list. Returns an empty array on missing
 * file or anything we can't parse — we'd rather start fresh than
 * crash on a corrupt prefs file.
 */
export function readRecentWorkspaces(userDataRoot: string): RecentWorkspace[] {
  const file = recentFilePath(userDataRoot);
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter((e): e is RecentWorkspace => {
      if (typeof e !== 'object' || e === null) return false;
      const o = e as Record<string, unknown>;
      return (
        typeof o.path === 'string' &&
        typeof o.name === 'string' &&
        typeof o.lastOpenedAt === 'string'
      );
    });
  } catch {
    return [];
  }
}

/**
 * Record that the user just opened a workspace. Moves it to the top of
 * the list, deduplicates, and trims to `RECENT_LIMIT` entries.
 */
export function recordRecentWorkspace(
  userDataRoot: string,
  entry: { path: string; name: string },
): void {
  const file = recentFilePath(userDataRoot);
  const existing = readRecentWorkspaces(userDataRoot);
  const filtered = existing.filter((e) => e.path !== entry.path);
  const updated: RecentWorkspace[] = [
    { path: entry.path, name: entry.name, lastOpenedAt: new Date().toISOString() },
    ...filtered,
  ].slice(0, RECENT_LIMIT);

  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(updated, null, 2), 'utf8');
}

/**
 * Most-recently-opened workspace, if any. Returns null on first launch
 * or after the recent list is cleared.
 */
export function mostRecentWorkspace(userDataRoot: string): RecentWorkspace | null {
  const list = readRecentWorkspaces(userDataRoot);
  return list[0] ?? null;
}
