import { ChangeDetectionStrategy, Component, inject, viewChild } from '@angular/core';
import { rpc } from '@ipc/renderer';
import type { AppSettings } from '@ipc/types';
import { WorkspaceFacade } from '../../store/workspace.facade';
import { listenOnDocument } from '../../util/document-events';
import { ButtonComponent, DialogComponent, IconComponent } from '../ui';

/**
 * First-run dialog shown on initial app launch. Two affordances:
 *
 *   1. Open a workspace folder — kicks the existing pickAndOpenWorkspace
 *      flow. The right move for users who already have a folder of
 *      .http files.
 *   2. Try with examples — calls welcome:createSampleWorkspace which
 *      prompts for a parent dir, writes a tiny "Coax Examples" folder
 *      with one .http file (three requests against httpbin.org) and an
 *      env file, then opens it as a workspace. The intent is a
 *      <10-second "oh I get it" moment for new users.
 *
 * Gated by app-settings.hasSeenWelcome — dismissing the dialog (either
 * button or the close X) flips the flag so the dialog never reappears.
 * Reset path: edit <userData>/settings.json and set hasSeenWelcome to
 * false (no in-app reset since it's not a meaningful repeat experience).
 *
 * Opened via the document-level `hu:open-welcome` event.
 */
@Component({
	selector: 'hu-welcome-dialog',
	templateUrl: './welcome-dialog.component.html',
	styleUrls: ['./welcome-dialog.component.scss'],
	imports: [ButtonComponent, DialogComponent, IconComponent],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class WelcomeDialogComponent {
	private readonly facade = inject(WorkspaceFacade);
	private readonly dialog = viewChild.required(DialogComponent);

	constructor() {
		listenOnDocument('hu:open-welcome', () => {
			this.open();
		});
	}

	open(): void {
		this.dialog().open();
	}

	async dismiss(): Promise<void> {
		this.dialog().close();
		try {
			await rpc<AppSettings>({ kind: 'app:settings:set', settings: { hasSeenWelcome: true } });
		} catch (err) {
			console.warn('failed to flag hasSeenWelcome:', err);
		}
	}

	protected async handleOpenFolder(): Promise<void> {
		await this.dismiss();
		try {
			await this.facade.pickAndOpenWorkspace();
		} catch (err) {
			console.error('pickAndOpenWorkspace failed:', err);
		}
	}

	protected async handleTryExamples(): Promise<void> {
		try {
			const result = await rpc<{ canceled: true } | { canceled: false; folderPath: string }>({ kind: 'welcome:createSampleWorkspace' });
			if (result.canceled) return; // leave dialog open so the user can pick again
			await this.dismiss();
			await this.facade.openWorkspaceAtPath(result.folderPath);
		} catch (err) {
			console.error('createSampleWorkspace failed:', err);
		}
	}
}
