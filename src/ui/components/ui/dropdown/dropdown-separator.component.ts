import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Hairline rule between groups of `hu-dropdown-item`s. */
@Component({
	selector: 'hu-dropdown-separator',
	template: '',
	styles: `
		:host {
			display: block;
			height: 1px;
			margin: 4px 0;
			background: var(--hu-border);
		}
	`,
	changeDetection: ChangeDetectionStrategy.OnPush
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Angular components are classes even when template-only
export class DropdownSeparatorComponent {}
