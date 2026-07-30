import { ChangeDetectionStrategy, Component, viewChild } from '@angular/core';
import { listenOnDocument } from '../../util/document-events';
import { ButtonComponent, DialogComponent, IconComponent } from '../ui';

/**
 * A short reference for the syntax users hit most often: variables, chaining
 * requests through their last response, per-request overrides, secrets, and
 * built-in tokens. Mounted at body level by app-frame and opened via a
 * document-level `hu:open-help` event (dispatched from the brand area in
 * the header and the Help menu).
 *
 * The content lives in the template rather than markdown so code samples
 * stay styled with the rest of the app's tokens without pulling in a
 * markdown renderer for one screen.
 */
@Component({
	selector: 'hu-help-dialog',
	templateUrl: './help-dialog.component.html',
	styleUrls: ['./help-dialog.component.scss'],
	imports: [ButtonComponent, DialogComponent, IconComponent],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class HelpDialogComponent {
	private readonly dialog = viewChild.required(DialogComponent);

	constructor() {
		listenOnDocument('hu:open-help', () => {
			this.open();
		});
	}

	open(): void {
		this.dialog().open();
	}

	close(): void {
		this.dialog().close();
	}
}
