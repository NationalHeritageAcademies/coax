import { ChangeDetectionStrategy, Component, ElementRef, input, output, signal, viewChild } from '@angular/core';

/**
 * Modal shell built on the native `<dialog>` element.
 *
 * Using the real element (rather than a fixed-position div) puts the dialog in
 * the browser's top layer, so it is reliably above everything else without a
 * z-index arms race, and Esc + focus trapping come for free. `promptInline`
 * relies on the same mechanism, which is what lets a prompt open on top of an
 * already-open dialog.
 *
 * Content is projected into two slots:
 *   [slot=dialog-header] — the header row
 *   (default)            — the body
 */
@Component({
	selector: 'hu-dialog',
	templateUrl: './dialog.component.html',
	styleUrls: ['./dialog.component.scss'],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class DialogComponent {
	/** Caps the dialog width; the surface stays fluid below this. */
	readonly maxWidth = input<string>('560px');

	/** Emitted whenever the dialog closes, including via Esc or backdrop click. */
	readonly closed = output();

	private readonly dialogRef = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
	private readonly _isOpen = signal(false);
	readonly isOpen = this._isOpen.asReadonly();

	open(): void {
		const el = this.dialogRef().nativeElement;
		if (el.open) return;
		el.showModal();
		this._isOpen.set(true);
	}

	close(): void {
		const el = this.dialogRef().nativeElement;
		if (!el.open) return;
		el.close();
	}

	/**
	 * Clicking the backdrop dismisses. The backdrop is not a separate node, so we
	 * detect it by testing whether the click landed on the <dialog> itself rather
	 * than on the surface rendered inside it.
	 */
	onBackdropClick(event: MouseEvent): void {
		if (event.target === this.dialogRef().nativeElement) this.close();
	}

	/** Fires for Esc and for close(); the single place we flip state and notify. */
	onNativeClose(): void {
		this._isOpen.set(false);
		this.closed.emit();
	}
}
