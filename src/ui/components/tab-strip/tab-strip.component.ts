import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rpc } from '@ipc/renderer';
import type { OpenTab, RequestRow } from '../../store/model';
import { TabsStateService } from '../../store/tabs-state.service';
import { WorkspaceStateService } from '../../store/workspace-state.service';
import { MethodBadgeComponent } from '../method-badge/method-badge.component';
import { IconComponent } from '../ui';

interface ContextMenuState {
	x: number;
	y: number;
	tabId: string;
}

interface TabView {
	tab: OpenTab;
	request: RequestRow | undefined;
	fullLabel: string;
	/** Capped so the strip doesn't overflow; full label stays in the tooltip. */
	truncatedLabel: string;
}

/**
 * Horizontal strip of open request tabs across the top of the workspace.
 * Right-click on a tab opens a Chrome-style context menu (Close / Close
 * Others / Close to the Right / Close All).
 */
@Component({
	selector: 'hu-tab-strip',
	templateUrl: './tab-strip.component.html',
	styleUrls: ['./tab-strip.component.scss'],
	imports: [IconComponent, MethodBadgeComponent],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class TabStripComponent {
	protected readonly tabsState = inject(TabsStateService);
	private readonly workspace = inject(WorkspaceStateService);

	protected readonly contextMenu = signal<ContextMenuState | null>(null);

	protected readonly views = computed<TabView[]>(() => {
		const reqMap = new Map(this.workspace.requests().map((r) => [r.id, r]));
		return this.tabsState.tabs().map((tab) => {
			const request = reqMap.get(tab.requestId);
			const fullLabel = request?.name || request?.url || tab.id;
			return {
				tab,
				request,
				fullLabel,
				truncatedLabel: fullLabel.length > 24 ? fullLabel.slice(0, 21) + '…' : fullLabel
			};
		});
	});

	protected readonly contextMenuItems = computed(() => {
		const menu = this.contextMenu();
		if (!menu) return [];
		const all = this.tabsState.tabs();
		const idx = all.findIndex((t) => t.id === menu.tabId);
		const toRight = idx >= 0 ? all.slice(idx + 1).map((t) => t.id) : [];
		const others = all.filter((t) => t.id !== menu.tabId).map((t) => t.id);
		return [
			{ label: 'Close', disabled: false, ids: [menu.tabId] },
			{ label: 'Close Others', disabled: others.length === 0, ids: others },
			{ label: 'Close Tabs to the Right', disabled: toRight.length === 0, ids: toRight },
			{ label: 'Close All', disabled: false, ids: all.map((t) => t.id) }
		];
	});

	protected activate(tabId: string): void {
		this.tabsState.setActiveTabId(tabId);
	}

	protected handleContextMenu(e: MouseEvent, tabId: string): void {
		e.preventDefault();
		e.stopPropagation();
		this.contextMenu.set({ x: e.clientX, y: e.clientY, tabId });
	}

	protected closeContextMenu(): void {
		this.contextMenu.set(null);
	}

	protected async handleMenuItem(item: { disabled: boolean; ids: string[] }, e: Event): Promise<void> {
		e.stopPropagation();
		if (item.disabled) return;
		this.closeContextMenu();
		await this.closeTabs(item.ids);
	}

	async closeTabs(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const idSet = new Set(ids);
		// Optimistic: drop from local list first, then fire IPC. If IPC fails the
		// worst case is the row reappears on next list refresh.
		const remaining = this.tabsState.tabs().filter((t) => !idSet.has(t.id));
		this.tabsState.setTabs(remaining);
		const active = this.tabsState.activeTabId();
		if (active !== null && idSet.has(active)) {
			this.tabsState.setActiveTabId(remaining.length > 0 ? remaining[0]!.id : null);
		}
		for (const id of ids) {
			try {
				await rpc<{ tabId: string }>({ kind: 'tabs:close', tabId: id });
			} catch (err) {
				console.error('tabs:close failed:', err);
			}
		}
	}
}
