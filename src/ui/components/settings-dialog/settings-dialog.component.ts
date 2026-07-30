import { ChangeDetectionStrategy, Component, signal, viewChild } from '@angular/core';
import { rpc } from '@ipc/renderer';
import type { AppSettings } from '@ipc/types';
import { listenOnDocument } from '../../util/document-events';
import { ButtonComponent, DialogComponent, IconComponent } from '../ui';

/**
 * App-level preferences. Two sections: "Network" (allowInsecureTLS, applied by
 * the main process to every outbound request via undici's
 * `connect: { rejectUnauthorized: false }`) and "Updates" (autoUpdate).
 *
 * Opened from the Preferences… menu item (macOS: Coax → Preferences,
 * Win/Linux: File → Preferences) which sends `hu:menu-preferences` over IPC.
 * The renderer dispatches that as a document-level `hu:open-settings` event
 * which this component listens for.
 *
 * Settings live in <userData>/settings.json (sidecar — see
 * src/app/app-settings.ts). The dialog reads on open and writes on each
 * toggle. Saves are fast and synchronous from the user's perspective.
 */
@Component({
	selector: 'hu-settings-dialog',
	templateUrl: './settings-dialog.component.html',
	styleUrls: ['./settings-dialog.component.scss'],
	imports: [ButtonComponent, DialogComponent, IconComponent],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsDialogComponent {
	protected readonly allowInsecureTLS = signal(false);
	protected readonly autoUpdate = signal(true);

	private readonly dialog = viewChild.required(DialogComponent);

	constructor() {
		listenOnDocument('hu:open-settings', () => {
			void this.openWithFreshSettings();
		});
	}

	private async openWithFreshSettings(): Promise<void> {
		// Refresh from disk every open in case another window or external
		// edit changed the file. Cheap (single small JSON read).
		try {
			const current = await rpc<AppSettings>({ kind: 'app:settings:get' });
			this.allowInsecureTLS.set(current.allowInsecureTLS);
			this.autoUpdate.set(current.autoUpdate);
		} catch (err) {
			console.warn('settings:get failed:', err);
		}
		this.dialog().open();
	}

	close(): void {
		this.dialog().close();
	}

	protected async setInsecureTLS(next: boolean): Promise<void> {
		const previous = this.allowInsecureTLS();
		this.allowInsecureTLS.set(next);
		try {
			await rpc<AppSettings>({ kind: 'app:settings:set', settings: { allowInsecureTLS: next } });
		} catch (err) {
			console.error('settings:set failed:', err);
			this.allowInsecureTLS.set(previous);
		}
	}

	protected async setAutoUpdate(next: boolean): Promise<void> {
		const previous = this.autoUpdate();
		this.autoUpdate.set(next);
		try {
			await rpc<AppSettings>({ kind: 'app:settings:set', settings: { autoUpdate: next } });
		} catch (err) {
			console.error('settings:set failed:', err);
			this.autoUpdate.set(previous);
		}
	}
}
