import { Injectable, computed, signal } from '@angular/core';

/**
 * Set by the auto-update flow when a new version has been downloaded and staged.
 * The app header renders a persistent "Restart to update" pill off this, so users
 * who missed or dismissed the toast still see that an update is pending.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
	private readonly _pending = signal<{ version: string } | null>(null);

	readonly pending = this._pending.asReadonly();
	readonly isReady = computed(() => this._pending() !== null);

	markDownloaded(version = ''): void {
		this._pending.set({ version });
	}
}
