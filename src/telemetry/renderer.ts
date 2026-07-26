// =============================================================================
// Telemetry init (renderer process)
// =============================================================================
//
// Initializes Sentry in the renderer. Same gating rules as the main process:
// requires both a configured SENTRY_DSN and explicit user consent. The
// renderer Sentry SDK auto-routes events through the main process, which is
// where our scrubber runs and where the SDK transports to Sentry's servers.
// We still run a renderer-local `beforeSend` so console/breadcrumb data
// gets scrubbed before it ever leaves the renderer.

import * as Sentry from '@sentry/electron/renderer';
import { scrubErrorEvent } from './scrubber.js';

export interface RendererTelemetryContext {
  consent: boolean;
  appVersion: string;
}

let initialized = false;

/**
 * Reads the build-time DSN.
 * In the renderer this comes from `import.meta.env.VITE_SENTRY_DSN` so the
 * value can be injected by Vite at build time. Local dev typically has none.
 */
export function getRendererSentryDsn(): string | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const raw = env.VITE_SENTRY_DSN;
  if (!raw || raw.trim() === '') return null;
  return raw.trim();
}

export function initRendererTelemetry(ctx: RendererTelemetryContext): boolean {
  if (initialized) return false;
  if (!ctx.consent) return false;
  const dsn = getRendererSentryDsn();
  if (!dsn) return false;

  Sentry.init({
    dsn,
    release: `coax@${ctx.appVersion}`,
    tracesSampleRate: 0,
    beforeSend: scrubErrorEvent,
    beforeBreadcrumb: (breadcrumb) => {
      if (breadcrumb.category === 'console') return null;
      return breadcrumb;
    },
  });

  initialized = true;
  return true;
}

export function isRendererTelemetryActive(): boolean {
  return initialized;
}
