// Renderer test bootstrap (vitest `renderer` project).
//
// The app runs zoneless (`provideZonelessChangeDetection` in app.config.ts),
// so this deliberately does NOT import Analog's `setup-vitest`, which patches
// vitest with zone.js test zones. Specs pass `provideZonelessChangeDetection()`
// via the shared `renderOptions` helper below.

import '@angular/compiler'; // JIT template compiler for specs
import { provideZonelessChangeDetection } from '@angular/core';
import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

/** Providers every renderer spec needs — mirror of app.config.ts. */
export function rendererTestProviders(): unknown[] {
	return [provideZonelessChangeDetection()];
}

// jsdom has no matchMedia; ThemeService reads it at construction.
if (typeof window.matchMedia !== 'function') {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			addListener: () => undefined,
			removeListener: () => undefined,
			onchange: null,
			dispatchEvent: () => false
		})
	});
}
