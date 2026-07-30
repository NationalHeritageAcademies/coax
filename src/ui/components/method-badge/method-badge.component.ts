import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

const METHOD_COLOR: Record<string, string> = {
	GET: 'var(--hu-method-get)',
	POST: 'var(--hu-method-post)',
	PUT: 'var(--hu-method-put)',
	PATCH: 'var(--hu-method-patch)',
	DELETE: 'var(--hu-method-delete)',
	HEAD: 'var(--hu-method-head)',
	OPTIONS: 'var(--hu-method-options)'
};

/**
 * Small, color-coded HTTP method pill rendered inline. The color comes from
 * the CSS method tokens defined in tokens.css. color-mix() derives the
 * background from the same token (light mode shows a ~15% tint), keeping a
 * single source of truth for method colors.
 */
@Component({
	selector: 'hu-method-badge',
	template: `<span class="badge" [style.--badge-color]="color()">{{ label() }}</span>`,
	styleUrls: ['./method-badge.component.scss'],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class MethodBadgeComponent {
	readonly method = input<string>('GET');

	readonly label = computed(() => this.method().toUpperCase());
	readonly color = computed(() => METHOD_COLOR[this.label()] ?? METHOD_COLOR.GET);
}
