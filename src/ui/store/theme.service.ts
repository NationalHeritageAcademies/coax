import { Injectable, computed, effect, signal } from '@angular/core';
import type { ThemeMode } from './model';

const STORAGE_KEY = 'hu-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStoredTheme(): ThemeMode {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
	} catch {
		/* localStorage unavailable */
	}
	return 'system';
}

/**
 * Owns the light/dark theme. Replaces Melodic's `applyTheme` / `getResolvedTheme`.
 *
 * tokens.css keys off `[data-theme='light'|'dark']` on <html>, so 'system' has to
 * be resolved to a concrete value before it is written — leaving the literal
 * string 'system' on the attribute would match neither selector and silently fall
 * back to the light palette on a dark OS.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
	private readonly _mode = signal<ThemeMode>(readStoredTheme());
	private readonly _systemPrefersDark = signal(false);

	/** What the user picked — may be 'system'. */
	readonly mode = this._mode.asReadonly();

	/** What is actually on screen — never 'system'. */
	readonly resolved = computed<'light' | 'dark'>(() => {
		const mode = this._mode();
		if (mode !== 'system') return mode;
		return this._systemPrefersDark() ? 'dark' : 'light';
	});

	constructor() {
		const media = window.matchMedia(DARK_QUERY);
		this._systemPrefersDark.set(media.matches);
		media.addEventListener('change', (e) => this._systemPrefersDark.set(e.matches));

		effect(() => {
			document.documentElement.setAttribute('data-theme', this.resolved());
		});

		effect(() => {
			const mode = this._mode();
			try {
				localStorage.setItem(STORAGE_KEY, mode);
			} catch {
				/* localStorage unavailable */
			}
		});
	}

	set(mode: ThemeMode): void {
		this._mode.set(mode);
	}

	/**
	 * Flips to the opposite of what is currently *showing*, rather than stepping
	 * through a fixed light → dark → system cycle.
	 *
	 * The cycle version had a dead click: starting from 'system' on a light OS,
	 * the first click moved system → light, which looks identical, so it took two
	 * clicks to reach dark. Toggling off the resolved value guarantees every click
	 * changes something visible. 'system' stays the initial default; it just isn't
	 * a stop in the toggle.
	 */
	toggle(): void {
		this._mode.set(this.resolved() === 'dark' ? 'light' : 'dark');
	}
}
