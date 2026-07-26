// =============================================================================
// Telemetry consent storage (sidecar JSON)
// =============================================================================
//
// Persists the user's crash-reporting preference outside the workspace SQLite.
// Why a separate file:
//
//   The Electron Sentry SDK MUST be initialized BEFORE `app.whenReady()`
//   fires — Crashpad and the unhandled-exception listeners install during
//   the boot window. That means we have to read consent before the workspace
//   DB is open (Secrets / safeStorage require ready), so a SQLite-backed
//   read won't fit the boot timeline.
//
//   A flat JSON sidecar in `<userData>/telemetry.json` solves this cleanly:
//   `app.getPath('userData')` works pre-ready (it just returns the default
//   path computed from the app name), and `readFileSync` is synchronous.
//
// File format (stable, future-additive):
//
//   {
//     "consent": true | false | null,   // null = never asked
//     "decidedAt": "2026-05-20T14:32:00.000Z" | null
//   }
//
// Permissions: written with `mode: 0o600` so only the current user can read.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface TelemetrySettings {
  /** Tri-state: null = never asked, true = consented, false = declined. */
  consent: boolean | null;
  /** ISO8601 timestamp of the last user-driven change, or null. */
  decidedAt: string | null;
}

const DEFAULT: TelemetrySettings = { consent: null, decidedAt: null };

function sidecarPath(userDataDir: string): string {
  return join(userDataDir, 'telemetry.json');
}

/**
 * Read the sidecar. Returns the default (`consent: null`) on missing file,
 * unreadable file, or unparseable JSON — we'd rather re-prompt than risk
 * sending data we shouldn't.
 */
export function readTelemetrySettings(userDataDir: string): TelemetrySettings {
  const file = sidecarPath(userDataDir);
  if (!existsSync(file)) return { ...DEFAULT };
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TelemetrySettings>;
    return {
      consent: parsed.consent === true || parsed.consent === false ? parsed.consent : null,
      decidedAt: typeof parsed.decidedAt === 'string' ? parsed.decidedAt : null,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function writeTelemetrySettings(
  userDataDir: string,
  settings: TelemetrySettings,
): void {
  const file = sidecarPath(userDataDir);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
}
