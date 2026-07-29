import { ChangeDetectionStrategy, Component, ElementRef, HostListener, inject, input, output, signal } from '@angular/core';

export type DropdownPlacement = 'bottom-start' | 'bottom-end';

/**
 * Click-to-open menu. The trigger is projected into [slot=trigger]; the menu
 * body is whatever `hu-dropdown-item` / `hu-dropdown-separator` children follow.
 *
 * Items report upward by injecting this component rather than through a
 * @ContentChildren query, so selection works no matter how deeply an item is
 * nested inside the projected content (e.g. wrapped in an @if or @for).
 */
@Component({
	selector: 'hu-dropdown',
	templateUrl: './dropdown.component.html',
	styleUrls: ['./dropdown.component.scss'],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class DropdownComponent {
	private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

	readonly placement = input<DropdownPlacement>('bottom-start');

	/** Emits the `value` of the chosen item. */
	readonly itemSelect = output<string>();

	private readonly _isOpen = signal(false);
	readonly isOpen = this._isOpen.asReadonly();

	toggle(): void {
		this._isOpen.update((v) => !v);
	}

	close(): void {
		this._isOpen.set(false);
	}

	/** Called by `hu-dropdown-item` children on click. */
	selectItem(value: string): void {
		this.itemSelect.emit(value);
		this.close();
	}

	/**
	 * Dismiss when the click lands outside this dropdown. Bound on the document so
	 * it also catches clicks on other dropdowns' triggers, which is what keeps two
	 * menus from being open at once.
	 */
	@HostListener('document:pointerdown', ['$event'])
	onDocumentPointerDown(event: PointerEvent): void {
		if (!this._isOpen()) return;
		const target = event.target as Node | null;
		if (target !== null && !this.host.nativeElement.contains(target)) this.close();
	}

	@HostListener('document:keydown.escape')
	onEscape(): void {
		this.close();
	}
}
