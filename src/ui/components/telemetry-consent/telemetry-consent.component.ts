import { AfterViewInit, ChangeDetectionStrategy, Component, output, signal, viewChild } from '@angular/core';
import { rpc } from '@ipc/renderer';
import { showToast } from '../toast';
import { ButtonComponent, DialogComponent, IconComponent } from '../ui';

/**
 * First-run modal asking the user whether to opt in to anonymous crash
 * reporting. Rendered (behind an @if) only when bootstrap decided it is
 * needed: SENTRY_DSN configured in the build AND the user has never been
 * asked (settings.consent === null). See RendererLifecycleService.
 *
 * Either choice persists immediately via the `telemetry:set` IPC; toggling
 * later goes through the regular settings UI. The decision takes effect for
 * crash capture on next launch — see the comment in telemetry/init.ts for
 * why we don't re-init mid-session.
 *
 * Emits `finished` when the flow is over (choice saved, or consent turned
 * out to be already decided) so the host can drop it from the DOM.
 */
@Component({
	selector: 'hu-telemetry-consent',
	templateUrl: './telemetry-consent.component.html',
	styleUrls: ['./telemetry-consent.component.scss'],
	imports: [ButtonComponent, DialogComponent, IconComponent],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class TelemetryConsentComponent implements AfterViewInit {
	readonly finished = output();

	protected readonly saving = signal(false);

	private readonly dialog = viewChild.required(DialogComponent);

	ngAfterViewInit(): void {
		void this.checkAndMaybeOpen();
	}

	/**
	 * Defensively re-check consent state on mount: bootstrap decided to render
	 * us based on a `consent: null` snapshot, but another process / window
	 * could have decided in the meantime. If it has, silently bow out.
	 */
	private async checkAndMaybeOpen(): Promise<void> {
		try {
			const settings = await rpc<{ consent: boolean | null }>({ kind: 'telemetry:get' });
			if (settings.consent !== null) {
				this.finished.emit();
				return;
			}
		} catch {
			// Can't read settings — fall through and open the dialog anyway,
			// since asking the user is safer than silently disabling.
		}
		this.dialog().open();
	}

	protected async handleAccept(): Promise<void> {
		await this.save(true, 'Crash reporting on');
	}

	protected async handleDecline(): Promise<void> {
		await this.save(false, 'Crash reporting off');
	}

	/**
	 * Dismissing via Escape or the backdrop is treated as an explicit "No
	 * thanks" — we never want to leave the user in an undecided state where
	 * we'd ask again on next launch. Guard against re-entrance during save.
	 */
	protected async handleDismiss(): Promise<void> {
		if (this.saving()) return;
		// Only persist if the user hasn't already answered. Without this guard
		// the close event from `handleAccept`/`handleDecline` would re-fire the
		// save with the wrong value.
		try {
			const settings = await rpc<{ consent: boolean | null }>({ kind: 'telemetry:get' });
			if (settings.consent !== null) return;
		} catch {
			/* fall through */
		}
		await this.save(false, 'Crash reporting off');
	}

	protected handleOpenPrivacy(e: Event): void {
		e.preventDefault();
		showToast('Privacy details: see docs/privacy.md', 'info', 5000);
	}

	private async save(consent: boolean, message: string): Promise<void> {
		if (this.saving()) return;
		this.saving.set(true);
		try {
			await rpc({ kind: 'telemetry:set', consent });
			showToast(message, 'success', 3000);
			this.dialog().close();
			// Defer teardown so the dialog close animation can complete.
			setTimeout(() => {
				this.finished.emit();
			}, 220);
		} catch (err) {
			console.error('telemetry:set failed:', err);
			showToast(`Couldn't save preference: ${(err as Error).message}`, 'error');
		} finally {
			this.saving.set(false);
		}
	}
}
