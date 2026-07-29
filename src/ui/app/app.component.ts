import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Root of the renderer. Deliberately thin — it exists so `index.html` has a
 * single stable mount point (`<hu-root>`) and so the real shell
 * (`<hu-app-frame>`) can be swapped or wrapped without touching bootstrap.
 */
@Component({
	selector: 'hu-root',
	templateUrl: './app.component.html',
	styleUrls: ['./app.component.scss'],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent {}
