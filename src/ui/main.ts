import './bootstrap-styles.js';
import '@melodicdev/components/app-shell';
import '@melodicdev/components/button';
import '@melodicdev/components/icon';
import '@melodicdev/components/sidebar';
import '@melodicdev/components/tabs';
import '@melodicdev/components/select';
import '@melodicdev/components/input';
import '@melodicdev/components/divider';
import '@melodicdev/components/tag';
import '@melodicdev/components/dialog';
import '@melodicdev/components/dropdown';
import '@melodicdev/components/toggle';
import { applyTheme } from '@melodicdev/components/theme';
import { theme } from './store/state.js';
import { bootstrapRenderer } from './store/lifecycle.js';
import { initRendererTelemetry } from '@telemetry/renderer';
import { rpc } from '@ipc/renderer';
import type { TelemetrySettings, TelemetryAvailability } from '@ipc/types';
import './components/method-badge.js';
import './components/theme-toggle.js';
import './components/sidebar-tree.js';
import './components/tab-strip.js';
import './components/status-bar.js';
import './components/app-frame.js';
import './components/env-switcher.js';
import './components/env-manager.js';
import './components/help-dialog.js';
import './components/install-cli-dialog.js';
import './components/settings-dialog.js';
import './components/monaco-editor.js';
import './components/request-tab.js';
import './components/telemetry-consent.js';

// Initialize theme to whatever the user last set (defaults to 'system')
applyTheme(theme());

// Kick off data loading. Errors logged but not surfaced — the UI shows empty state
// (no workspaces / no collections) which is sensible until handler errors are surfaced via toast.
bootstrapRenderer()
  .then(() => bootstrapTelemetry())
  .catch((err: unknown) => {
    console.error('bootstrap failed:', err);
  });

// Refresh-on-focus: when the main process tells us the window regained
// focus, ask it to re-scan the workspace folder + re-adopt any changed
// .http files, then re-load the cache into the renderer state. Lets
// external edits (VS Code, vim, `git pull`, etc.) propagate into Coax.
window.httpui.onMainEvent('hu:focus-refresh', async () => {
  try {
    await rpc({ kind: 'workspace:refresh' });
    const { activeWorkspace } = await import('./store/state.js');
    const ws = activeWorkspace();
    if (ws !== null) {
      const { loadWorkspaceData } = await import('./store/lifecycle.js');
      await loadWorkspaceData(ws.id);
    }
  } catch (err) {
    console.warn('focus-refresh failed:', err);
  }
});

// Application menu → renderer event wiring. Each menu item sends a
// one-way event we translate into the corresponding in-app flow.
window.httpui.onMainEvent('hu:menu-open-workspace', () => {
  void import('./store/lifecycle.js').then(({ pickAndOpenWorkspace }) =>
    pickAndOpenWorkspace().catch((e: unknown) => { console.error('pickAndOpenWorkspace failed:', e); }),
  );
});
window.httpui.onMainEvent('hu:menu-close-workspace', () => {
  void import('./store/lifecycle.js').then(({ closeCurrentWorkspace }) =>
    closeCurrentWorkspace().catch((e: unknown) => { console.error('closeCurrentWorkspace failed:', e); }),
  );
});
window.httpui.onMainEvent('hu:menu-import-http', () => {
  document.dispatchEvent(new CustomEvent('hu:menu-import-http'));
});
window.httpui.onMainEvent('hu:menu-import-swagger-url', () => {
  document.dispatchEvent(new CustomEvent('hu:menu-import-swagger-url'));
});
window.httpui.onMainEvent('hu:menu-import-swagger-file', () => {
  document.dispatchEvent(new CustomEvent('hu:menu-import-swagger-file'));
});
window.httpui.onMainEvent('hu:menu-export-collection', () => {
  document.dispatchEvent(new CustomEvent('hu:menu-export-collection'));
});
window.httpui.onMainEvent('hu:menu-help', () => {
  document.dispatchEvent(new CustomEvent('hu:open-help'));
});
window.httpui.onMainEvent('hu:menu-install-cli', () => {
  document.dispatchEvent(new CustomEvent('hu:open-install-cli'));
});
window.httpui.onMainEvent('hu:menu-preferences', () => {
  document.dispatchEvent(new CustomEvent('hu:open-settings'));
});

// Auto-update: main process tells us the new build is downloaded and
// staged. Two affordances:
//
//   1. A sticky toast with a "Restart" action — clicking it calls
//      app:quitAndInstall which swaps the binary and relaunches.
//   2. A persistent updateReady signal that the app header renders
//      as a small "Update ready" pill, so users who missed (or
//      dismissed) the toast still see the update is pending.
window.httpui.onMainEvent('hu:update-downloaded', () => {
  void (async () => {
    const { showToast } = await import('./components/toast.js');
    const { updateReady } = await import('./store/state.js');
    updateReady.set({ version: '' });
    showToast('A new Coax version is ready — click to restart.', 'info', {
      durationMs: 0,
      actionLabel: 'Restart now',
      onClick: () => {
        void rpc({ kind: 'app:quitAndInstall' });
      },
    });
  })();
});

/**
 * Telemetry bootstrap. Reads the stored consent + availability flags, then:
 *  - Initializes Sentry in the renderer if (DSN configured) AND (consent granted)
 *  - Mounts the first-run consent dialog only if (DSN configured) AND
 *    (user has never been asked). No DSN → never bother the user.
 *
 * Runs after the workspace bootstrap so the SQLite settings table is open.
 */
async function bootstrapTelemetry(): Promise<void> {
  let settings: TelemetrySettings;
  let availability: TelemetryAvailability;
  try {
    [settings, availability] = await Promise.all([
      rpc<TelemetrySettings>({ kind: 'telemetry:get' }),
      rpc<TelemetryAvailability>({ kind: 'telemetry:isAvailable' }),
    ]);
  } catch (err) {
    // If the handlers haven't initialized (e.g. boot ordering quirk in dev),
    // we silently skip — we'd rather miss a few crashes than ask the user
    // permission via a broken dialog.
    console.warn('telemetry: unable to read settings, skipping init', err);
    return;
  }

  if (!availability.configured) {
    // No DSN in this build. Nothing to do — silently no-op.
    return;
  }

  initRendererTelemetry({
    consent: settings.consent === true,
    appVersion: '0.1.0', // mirrors package.json; consider exposing via IPC if we drift.
  });

  if (settings.consent === null) {
    // User has never been asked. Mount the dialog at the body level so its
    // backdrop covers everything.
    const dialog = document.createElement('hu-telemetry-consent');
    document.body.appendChild(dialog);
  }
}
