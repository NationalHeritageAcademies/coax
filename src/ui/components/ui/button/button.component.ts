import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * Styling for a native button: `<button hu-button variant="ghost" size="sm">`.
 *
 * Deliberately an attribute selector rather than a wrapper element so the host
 * stays a real <button> — `disabled`, `type`, `(click)`, focus order and screen
 *-reader semantics all keep working without re-plumbing. Variant and size are
 * reflected as data attributes so the stylesheet can key off them without
 * fighting whatever classes a caller puts on the element.
 */
@Component({
	selector: 'button[hu-button]',
	template: '<ng-content />',
	styleUrls: ['./button.component.scss'],
	changeDetection: ChangeDetectionStrategy.OnPush,
	host: {
		'[attr.data-variant]': 'variant()',
		'[attr.data-size]': 'size()'
	}
})
export class ButtonComponent {
	readonly variant = input<ButtonVariant>('ghost');
	readonly size = input<ButtonSize>('md');
}
