import { ChangeDetectionStrategy, Component, viewChild } from '@angular/core';
import { listenOnDocument } from '../../util/document-events';
import { ButtonComponent, DialogComponent, IconComponent } from '../ui';

/**
 * Tells the user how to install the Coax CLI on their machine. Opened from
 * Help → "Install CLI…" via a document-level `hu:open-install-cli` event
 * (dispatched from the menu IPC bridge).
 *
 * The CLI ships as a separate npm package that requires Node 18+ on the
 * user's machine. Bundling a standalone binary inside the desktop installer
 * is on the roadmap; this dialog explains the current install path until then.
 */
@Component({
	selector: 'hu-install-cli-dialog',
	templateUrl: './install-cli-dialog.component.html',
	styleUrls: ['./install-cli-dialog.component.scss'],
	imports: [ButtonComponent, DialogComponent, IconComponent],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstallCliDialogComponent {
	protected readonly installCmd = 'npm install --global @nhaschools/coax-cli';
	protected readonly sampleCmd = 'coax run path/to/tests.http';
	protected readonly docsUrl = 'https://github.com/NationalHeritageAcademies/coax/blob/main/docs/cli.md';

	private readonly dialog = viewChild.required(DialogComponent);

	constructor() {
		listenOnDocument('hu:open-install-cli', () => {
			this.open();
		});
	}

	open(): void {
		this.dialog().open();
	}

	close(): void {
		this.dialog().close();
	}

	protected async copy(text: string, btn: EventTarget | null): Promise<void> {
		if (!(btn instanceof HTMLButtonElement)) return;
		try {
			await navigator.clipboard.writeText(text);
			btn.classList.add('copied');
			const originalLabel = btn.textContent ?? 'Copy';
			btn.textContent = 'Copied';
			setTimeout(() => {
				btn.classList.remove('copied');
				btn.textContent = originalLabel;
			}, 1500);
		} catch {
			// Clipboard write can fail in unusual sandboxes; ignore silently
			// rather than surface a low-value error to the user.
		}
	}
}
