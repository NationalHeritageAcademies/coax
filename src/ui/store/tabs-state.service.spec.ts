import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TabsStateService } from './tabs-state.service';
import { rendererTestProviders } from '../test-setup';
import type { OpenTab } from './model';

function makeTab(id: string): OpenTab {
	return { id, requestId: `req-${id}`, isDirty: false } as OpenTab;
}

describe('TabsStateService', () => {
	function setup(): TabsStateService {
		TestBed.configureTestingModule({ providers: rendererTestProviders() });
		return TestBed.inject(TabsStateService);
	}

	it('activeTab resolves the tab matching activeTabId, or null', () => {
		const svc = setup();
		expect(svc.activeTab()).toBeNull();

		svc.setTabs([makeTab('a'), makeTab('b')]);
		svc.setActiveTabId('b');
		expect(svc.activeTab()?.requestId).toBe('req-b');

		svc.setActiveTabId('gone');
		expect(svc.activeTab()).toBeNull();
	});

	it('patchTab updates one tab and leaves the rest untouched', () => {
		const svc = setup();
		svc.setTabs([makeTab('a'), makeTab('b')]);
		svc.patchTab('a', { isDirty: true });
		expect(svc.tabs().find((t) => t.id === 'a')?.isDirty).toBe(true);
		expect(svc.tabs().find((t) => t.id === 'b')?.isDirty).toBe(false);
	});
});
