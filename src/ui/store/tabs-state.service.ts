import { Injectable, computed, signal } from '@angular/core';
import type { OpenTab } from './model';

/** Open request tabs and which one is focused. */
@Injectable({ providedIn: 'root' })
export class TabsStateService {
	private readonly _tabs = signal<OpenTab[]>([]);
	private readonly _activeTabId = signal<string | null>(null);

	readonly tabs = this._tabs.asReadonly();
	readonly activeTabId = this._activeTabId.asReadonly();

	readonly activeTab = computed(() => {
		const id = this._activeTabId();
		return id === null ? null : (this._tabs().find((t) => t.id === id) ?? null);
	});

	setTabs(value: OpenTab[]): void {
		this._tabs.set(value);
	}

	setActiveTabId(value: string | null): void {
		this._activeTabId.set(value);
	}

	/** Applies a partial update to one tab, leaving the rest untouched. */
	patchTab(id: string, patch: Partial<OpenTab>): void {
		this._tabs.update((tabs) => tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)));
	}
}
