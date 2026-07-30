import { ChangeDetectionStrategy, Component } from '@angular/core';
import { AppFrameComponent } from '../components/app-frame/app-frame.component';

/**
 * Root of the renderer. Deliberately thin — it exists so `index.html` has a
 * single stable mount point (`<hu-root>`) and so the real shell
 * (`<hu-app-frame>`) can be swapped or wrapped without touching bootstrap.
 */
@Component({
	selector: 'hu-root',
	template: '<hu-app-frame />',
	imports: [AppFrameComponent],
	changeDetection: ChangeDetectionStrategy.OnPush
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Angular components are classes even when template-only
export class AppComponent {}
