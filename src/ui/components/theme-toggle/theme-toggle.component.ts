import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ThemeService } from '../../store/theme.service';
import { ButtonComponent, IconComponent } from '../ui';

/**
 * A light/dark toggle. Each click flips to the OPPOSITE of the currently
 * *resolved* theme, so a single click always produces a visible change —
 * see ThemeService.toggle() for why there is no light → dark → system cycle.
 * The icon reflects the resolved (light|dark) theme.
 */
@Component({
	selector: 'hu-theme-toggle',
	imports: [ButtonComponent, IconComponent],
	template: `
		<button hu-button variant="ghost" aria-label="Toggle theme" (click)="theme.toggle()">
			<hu-icon [name]="icon()" />
		</button>
	`,
	styles: `
		:host {
			display: inline-flex;
		}
	`,
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class ThemeToggleComponent {
	protected readonly theme = inject(ThemeService);
	protected readonly icon = computed(() => (this.theme.resolved() === 'dark' ? 'moon' : 'sun'));
}
