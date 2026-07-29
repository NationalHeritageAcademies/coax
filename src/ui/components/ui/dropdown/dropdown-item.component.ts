import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { DropdownComponent } from './dropdown.component';

/** A single row in a `hu-dropdown`. Reports its `value` to the parent on click. */
@Component({
	selector: 'hu-dropdown-item',
	templateUrl: './dropdown-item.component.html',
	styleUrls: ['./dropdown-item.component.scss'],
	changeDetection: ChangeDetectionStrategy.OnPush,
	imports: [IconComponent]
})
export class DropdownItemComponent {
	private readonly parent = inject(DropdownComponent, { optional: true });

	readonly value = input<string>('');
	readonly icon = input<string>('');
	readonly disabled = input<boolean>(false);
	readonly danger = input<boolean>(false);

	onClick(): void {
		if (this.disabled()) return;
		this.parent?.selectItem(this.value());
	}
}
