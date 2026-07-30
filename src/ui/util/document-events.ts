import { DestroyRef, inject } from '@angular/core';

/**
 * Coax uses document-level CustomEvents (`hu:open-help`, `hu:menu-import-http`,
 * …) as the bridge between the main-process menu and in-app flows, and between
 * loosely-coupled components. The names are part of the app's contract — the
 * menu IPC bridge dispatches them and the e2e suite can synthesize them — so
 * the Angular port keeps the mechanism rather than replacing it with a bus
 * service.
 *
 * Call from an injection context (constructor / field initializer); the
 * listener is removed when the calling component or service is destroyed.
 */
export function listenOnDocument(type: string, handler: (event: Event) => void): void {
	document.addEventListener(type, handler);
	inject(DestroyRef).onDestroy(() => {
		document.removeEventListener(type, handler);
	});
}
