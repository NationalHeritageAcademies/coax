import { Injectable, inject, signal } from '@angular/core';
import { rpc } from '@ipc/renderer';
import type { TelemetryAvailability, TelemetrySettings } from '@ipc/types';
import { initRendererTelemetry } from '@telemetry/renderer';
import { showToast } from '../components/toast';
import { AppUpdateService } from './app-update.service';
import { WorkspaceFacade } from './workspace.facade';
import { WorkspaceStateService } from './workspace-state.service';

/**
 * Renderer-side boot glue — the Angular home for what Melodic's ui/main.ts
 * did after mounting: kick off the workspace bootstrap, bridge main-process
 * menu events into in-app flows, refresh on window focus, surface staged
 * auto-updates, and run the telemetry consent bootstrap.
 *
 * start() is invoked once from the app initializer (see app.config.ts); the
 * data load itself is deliberately not awaited so first paint isn't blocked
 * on IPC.
 */
@Injectable({ providedIn: 'root' })
export class RendererLifecycleService {
	private readonly facade = inject(WorkspaceFacade);
	private readonly workspace = inject(WorkspaceStateService);
	private readonly appUpdate = inject(AppUpdateService);

	/**
	 * True when the first-run telemetry consent dialog should be in the DOM.
	 * Set during bootstrap when a Sentry DSN is configured AND the user has
	 * never answered; cleared when the dialog reports it is finished.
	 */
	private readonly _showTelemetryConsent = signal(false);
	readonly showTelemetryConsent = this._showTelemetryConsent.asReadonly();

	private started = false;

	start(): void {
		if (this.started) return;
		this.started = true;

		// Kick off data loading. Errors logged but not surfaced — the UI shows
		// empty state (no workspaces / no collections) which is sensible until
		// handler errors are surfaced via toast.
		this.facade
			.bootstrap()
			.then(() => this.bootstrapTelemetry())
			.catch((err: unknown) => {
				console.error('bootstrap failed:', err);
			});

		// Refresh-on-focus: when the main process tells us the window regained
		// focus, ask it to re-scan the workspace folder + re-adopt any changed
		// .http files, then re-load the cache into the renderer state. Lets
		// external edits (VS Code, vim, `git pull`, etc.) propagate into Coax.
		window.httpui.onMainEvent('hu:focus-refresh', () => {
			void (async () => {
				try {
					await rpc({ kind: 'workspace:refresh' });
					const ws = this.workspace.activeWorkspace();
					if (ws !== null) await this.facade.loadWorkspaceData(ws.id);
				} catch (err) {
					console.warn('focus-refresh failed:', err);
				}
			})();
		});

		// Application menu → renderer event wiring. Each menu item sends a
		// one-way event we translate into the corresponding in-app flow. The
		// import/export/dialog ones re-dispatch as document-level CustomEvents
		// that app-frame and the dialogs listen for.
		window.httpui.onMainEvent('hu:menu-open-workspace', () => {
			this.facade.pickAndOpenWorkspace().catch((e: unknown) => {
				console.error('pickAndOpenWorkspace failed:', e);
			});
		});
		window.httpui.onMainEvent('hu:menu-close-workspace', () => {
			this.facade.closeCurrentWorkspace().catch((e: unknown) => {
				console.error('closeCurrentWorkspace failed:', e);
			});
		});
		for (const passthrough of ['hu:menu-import-http', 'hu:menu-import-swagger-url', 'hu:menu-import-swagger-file', 'hu:menu-export-collection'] as const) {
			window.httpui.onMainEvent(passthrough, () => {
				document.dispatchEvent(new CustomEvent(passthrough));
			});
		}
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
		//   2. The AppUpdateService signal that the app header renders as a
		//      persistent "Restart to update" pill, so users who missed (or
		//      dismissed) the toast still see the update is pending.
		window.httpui.onMainEvent('hu:update-downloaded', () => {
			this.appUpdate.markDownloaded();
			showToast('A new Coax version is ready — click to restart.', 'info', {
				durationMs: 0,
				actionLabel: 'Restart now',
				onClick: () => {
					void rpc({ kind: 'app:quitAndInstall' });
				}
			});
		});
	}

	dismissTelemetryConsent(): void {
		this._showTelemetryConsent.set(false);
	}

	/**
	 * Telemetry bootstrap. Reads the stored consent + availability flags, then:
	 *  - Initializes Sentry in the renderer if (DSN configured) AND (consent granted)
	 *  - Flags the first-run consent dialog for mounting only if (DSN
	 *    configured) AND (user has never been asked). No DSN → never bother
	 *    the user.
	 *
	 * Runs after the workspace bootstrap so the SQLite settings table is open.
	 */
	private async bootstrapTelemetry(): Promise<void> {
		let settings: TelemetrySettings;
		let availability: TelemetryAvailability;
		try {
			[settings, availability] = await Promise.all([
				rpc<TelemetrySettings>({ kind: 'telemetry:get' }),
				rpc<TelemetryAvailability>({ kind: 'telemetry:isAvailable' })
			]);
		} catch (err) {
			// If the handlers haven't initialized (e.g. boot ordering quirk in
			// dev), we silently skip — we'd rather miss a few crashes than ask
			// the user permission via a broken dialog.
			console.warn('telemetry: unable to read settings, skipping init', err);
			return;
		}

		if (!availability.configured) {
			// No DSN in this build. Nothing to do — silently no-op.
			return;
		}

		initRendererTelemetry({
			consent: settings.consent === true,
			appVersion: '0.1.0' // mirrors package.json; consider exposing via IPC if we drift.
		});

		if (settings.consent === null) {
			this._showTelemetryConsent.set(true);
		}
	}
}
