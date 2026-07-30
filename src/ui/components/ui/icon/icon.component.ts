import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ICON_PATHS, ICON_VIEW_BOX, type IconName } from './icon-set';

const PIXEL_SIZE = {
	xs: 12,
	sm: 16,
	md: 20,
	lg: 24
} as const;

export type IconSize = keyof typeof PIXEL_SIZE;

/**
 * Renders one of the inlined Phosphor icons (see `icon-set.ts`).
 *
 * `name` is deliberately typed loosely rather than as `IconName`: the sidebar
 * builds context menus from data where the icon is optional, so an empty or
 * unknown name has to degrade to "render nothing" instead of failing to compile.
 */
@Component({
	selector: 'hu-icon',
	templateUrl: './icon.component.html',
	styleUrls: ['./icon.component.scss'],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class IconComponent {
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- IconName documents intent; string keeps data-driven callers compiling
	readonly name = input<IconName | string>('');
	readonly size = input<IconSize>('md');

	readonly viewBox = ICON_VIEW_BOX;
	readonly pixels = computed(() => PIXEL_SIZE[this.size()]);
	readonly path = computed<string | null>(() => {
		const key = this.name();
		return key in ICON_PATHS ? ICON_PATHS[key as IconName] : null;
	});
}
