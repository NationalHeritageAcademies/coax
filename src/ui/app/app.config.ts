import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { RendererLifecycleService } from '../store/renderer-lifecycle.service';

/**
 * Renderer-wide providers.
 *
 * Zoneless: every piece of renderer state is already a signal (see
 * `src/ui/store`), so there is nothing for zone.js to usefully patch. Dropping
 * it also keeps Monaco's own async work from being wrapped in a zone, which is
 * a known source of spurious change-detection churn in editor-heavy UIs.
 *
 * The initializer starts the renderer lifecycle (menu IPC bridge, workspace
 * bootstrap) without awaiting the data load — first paint should
 * not block on IPC.
 */
export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideZonelessChangeDetection(),
		provideAppInitializer(() => {
			inject(RendererLifecycleService).start();
		})
	]
};
