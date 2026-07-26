// =============================================================================
// Telemetry init (main process)
// =============================================================================
//
// Bootstraps Sentry in the Electron main process. The renderer init lives at
// `src/telemetry/renderer.ts` so it can be imported from the renderer bundle
// without dragging node-only deps along.
//
// Initialization is *always* gated on TWO signals:
//   1. A SENTRY_DSN is configured (build-time env var). No DSN → no init,
//      no network calls, nothing in the bundle path at runtime. Local dev
//      builds typically have no DSN and ship as silent.
//   2. The user has opted in (settings record `telemetry.crashReports = true`).
//      Default is `false` — we never collect without explicit consent.
//
// Initialization is one-shot per process. Toggling consent at runtime takes
// effect on next launch: we don't tear down the SDK mid-session because the
// SDK's internal state (queued events, native crash handler) doesn't cleanly
// support that, and the corner cases aren't worth the risk to a privacy
// promise.

import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';
import { homedir } from 'node:os';
import { configureScrubber, scrubErrorEvent } from './scrubber.js';

export interface TelemetryInitContext {
  /** Whether the user has consented to crash reporting. */
  consent: boolean;
  /** Absolute path to the workspace root (or app data dir) for path scrubbing. */
  workspaceRoot?: string;
  /** App version for release tagging. */
  appVersion: string;
  /** Environment label: 'dev' | 'prod' (overrides the auto-detected env). */
  environment?: string;
}

let initialized = false;

/**
 * Returns the DSN configured at build time, or null if telemetry is disabled
 * for this build entirely.
 */
export function getSentryDsn(): string | null {
  // We read `process.env` rather than a `define`'d build-time constant so a
  // single binary can be repurposed by an integrator who provides their own
  // DSN at launch (rare, but cheap to support).
  const raw = process.env.SENTRY_DSN;
  if (!raw || raw.trim() === '') return null;
  return raw.trim();
}

/**
 * Initializes Sentry in the main process. Safe to call multiple times — only
 * the first call has any effect.
 *
 * Returns `true` if Sentry was initialized, `false` if it was skipped (no
 * DSN, or consent not granted, or already initialized).
 */
export function initMainTelemetry(ctx: TelemetryInitContext): boolean {
  if (initialized) return false;
  if (!ctx.consent) return false;
  const dsn = getSentryDsn();
  if (!dsn) return false;

  const home = safeHomedir();
  configureScrubber({
    workspaceRoot: ctx.workspaceRoot ?? app.getPath('userData'),
    ...(home ? { homeDir: home } : {}),
  });

  Sentry.init({
    dsn,
    release: `coax@${ctx.appVersion}`,
    environment: ctx.environment ?? (app.isPackaged ? 'prod' : 'dev'),
    // Tracing/Profiling are off until we have a use case — defaults to 0%.
    tracesSampleRate: 0,
    // Drop default integrations that auto-capture http requests; those would
    // contain user URLs. The scrubber catches them in `beforeSend`, but
    // disabling at source is belt-and-suspenders.
    integrations: (defaults) =>
      defaults.filter((integration) => integration.name !== 'Http'),
    beforeSend: scrubErrorEvent,
    beforeBreadcrumb: (breadcrumb) => {
      // Drop console breadcrumbs entirely — they often contain user URLs
      // logged from third-party libraries. We have explicit error capture
      // for the cases we care about.
      if (breadcrumb.category === 'console') return null;
      return breadcrumb;
    },
  });

  initialized = true;
  return true;
}

export function isTelemetryActive(): boolean {
  return initialized;
}

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}
