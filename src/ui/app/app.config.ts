import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';

/**
 * Renderer-wide providers.
 *
 * Zoneless: every piece of renderer state is already a signal (see
 * `src/ui/store`), so there is nothing for zone.js to usefully patch. Dropping
 * it also keeps Monaco's own async work from being wrapped in a zone, which is
 * a known source of spurious change-detection churn in editor-heavy UIs.
 */
export const appConfig: ApplicationConfig = {
	providers: [provideBrowserGlobalErrorListeners(), provideZonelessChangeDetection()]
};
