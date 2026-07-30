// =============================================================================
// App-level settings storage (sidecar JSON)
// =============================================================================
//
// Persists user-facing app preferences that aren't tied to a specific workspace.
// A flat JSON file under userData,
// written with `mode: 0o600` so only the current user can read it.
//
// Why a sidecar (not SQLite): the active workspace's DB isn't always open
// (empty-state, multiple workspaces, fresh install). App settings need to be
// available pre-workspace, and persist across workspace switches.
//
// File format (stable, future-additive):
//
//   {
//     "allowInsecureTLS": false
//   }
//
// Add fields here as new app-level preferences land. Missing fields fall back
// to DEFAULT — never write a partial object, always merge against DEFAULT.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AppSettings {
  /**
   * When true, the runner skips TLS cert validation for every request.
   * Default false. Intended for self-signed dev certs (mkcert, ASP.NET
   * dev-certs, etc.). Documented as a global toggle in Settings.
   */
  allowInsecureTLS: boolean;
  /**
   * Flipped true the first time the welcome dialog is dismissed.
   * Gates the first-run welcome flow so it only appears once.
   */
  hasSeenWelcome: boolean;
  /**
   * When true, the app checks R2 for new builds on launch and offers
   * a one-click restart to install. Default true. Users who prefer
   * pinned versions can disable.
   */
  autoUpdate: boolean;
}

const DEFAULT: AppSettings = {
  allowInsecureTLS: false,
  hasSeenWelcome: false,
  autoUpdate: true,
};

function sidecarPath(userDataDir: string): string {
  return join(userDataDir, 'settings.json');
}

/**
 * Read the sidecar. Returns DEFAULT on missing file, unreadable file, or
 * unparseable JSON. Unknown fields are ignored (forward-compatible reads).
 */
export function readAppSettings(userDataDir: string): AppSettings {
  const file = sidecarPath(userDataDir);
  if (!existsSync(file)) return { ...DEFAULT };
  try {
    const text = readFileSync(file, 'utf8');
    const parsed = JSON.parse(text) as Partial<AppSettings>;
    return mergeWithDefault(parsed);
  } catch {
    return { ...DEFAULT };
  }
}

/**
 * Atomic-ish write: ensures the userData dir exists, writes with restrictive
 * permissions. Returns the merged settings (the same shape readAppSettings
 * would return next time).
 */
export function writeAppSettings(
  userDataDir: string,
  partial: Partial<AppSettings>,
): AppSettings {
  const current = readAppSettings(userDataDir);
  const next: AppSettings = { ...current, ...partial };
  const file = sidecarPath(userDataDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function mergeWithDefault(raw: Partial<AppSettings>): AppSettings {
  return {
    allowInsecureTLS:
      typeof raw.allowInsecureTLS === 'boolean' ? raw.allowInsecureTLS : DEFAULT.allowInsecureTLS,
    hasSeenWelcome:
      typeof raw.hasSeenWelcome === 'boolean' ? raw.hasSeenWelcome : DEFAULT.hasSeenWelcome,
    autoUpdate:
      typeof raw.autoUpdate === 'boolean' ? raw.autoUpdate : DEFAULT.autoUpdate,
  };
}
