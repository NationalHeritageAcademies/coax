import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject } from '@angular/core';
import { rpc } from '@ipc/renderer';
import type { AppSettings } from '@ipc/types';
import { AppUpdateService } from '../../store/app-update.service';
import { TabsStateService } from '../../store/tabs-state.service';
import { WorkspaceFacade } from '../../store/workspace.facade';
import { WorkspaceStateService } from '../../store/workspace-state.service';
import { listenOnDocument } from '../../util/document-events';
import { EnvManagerComponent } from '../env-manager/env-manager.component';
import { EnvSwitcherComponent } from '../env-switcher/env-switcher.component';
import { HelpDialogComponent } from '../help-dialog/help-dialog.component';
import { InstallCliDialogComponent } from '../install-cli-dialog/install-cli-dialog.component';
import { promptInline } from '../prompt';
import { RequestTabComponent } from '../request-tab/request-tab.component';
import { SettingsDialogComponent } from '../settings-dialog/settings-dialog.component';
import { SidebarTreeComponent } from '../sidebar-tree/sidebar-tree.component';
import { StatusBarComponent } from '../status-bar/status-bar.component';
import { TabStripComponent } from '../tab-strip/tab-strip.component';
import { ThemeToggleComponent } from '../theme-toggle/theme-toggle.component';
import { showToast } from '../toast';
import { ButtonComponent, DropdownComponent, DropdownItemComponent, IconComponent } from '../ui';
import { WelcomeDialogComponent } from '../welcome-dialog/welcome-dialog.component';

const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 600;
const DEFAULT_SIDEBAR = 280;

/**
 * The shell: header bar, sidebar tree, draggable splitter, main pane, and
 * status bar all live inside a CSS grid on the host. The grid's first
 * column width is driven by a CSS custom property `--hu-sidebar-width`,
 * which the splitter drag handler updates directly on the host element.
 * This keeps the drag gesture entirely outside change detection —
 * re-rendering mid-drag would disturb Monaco (selection/scroll/undo state).
 *
 * The main pane swaps between a "no tab selected" empty state and a
 * <hu-request-tab>. The @for is tracked by tab id so the request-tab
 * component is destroyed and recreated when the active tab changes —
 * request-tab owns per-tab editor state that must not leak across tabs.
 *
 * The app-level dialogs (env-manager, help, install-cli, settings, welcome)
 * are hosted here; each uses the native <dialog> top layer, so their DOM
 * position imposes no stacking constraints.
 */
@Component({
	selector: 'hu-app-frame',
	templateUrl: './app-frame.component.html',
	styleUrls: ['./app-frame.component.scss'],
	imports: [
		ButtonComponent,
		DropdownComponent,
		DropdownItemComponent,
		EnvManagerComponent,
		EnvSwitcherComponent,
		HelpDialogComponent,
		IconComponent,
		InstallCliDialogComponent,
		RequestTabComponent,
		SettingsDialogComponent,
		SidebarTreeComponent,
		StatusBarComponent,
		TabStripComponent,
		ThemeToggleComponent,
		WelcomeDialogComponent
	],
	changeDetection: ChangeDetectionStrategy.OnPush,
	host: {
		'[attr.data-platform]': 'platform'
	}
})
export class AppFrameComponent {
	private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
	private readonly workspace = inject(WorkspaceStateService);
	private readonly tabsState = inject(TabsStateService);
	private readonly facade = inject(WorkspaceFacade);
	protected readonly appUpdate = inject(AppUpdateService);

	/**
	 * Tag the host with the OS platform so CSS can branch (mainly: reserve
	 * padding for macOS traffic lights vs. the Win/Linux title-bar overlay
	 * strip). Comes from the preload script.
	 */
	protected readonly platform = window.httpui.platform;

	/**
	 * Win/Linux hide the native menu bar (titleBarStyle: 'hidden' — see
	 * src/app/main.ts), so the brand mark doubles as the entry point to the
	 * application menu. macOS keeps its real menu bar, so the mark there is
	 * purely decorative and the click is a no-op.
	 */
	protected readonly showMenuButton = window.httpui.platform !== 'darwin';

	protected readonly hasWorkspace = computed(() => this.workspace.hasWorkspace());

	/**
	 * The active tab as a 0/1-element list: the template @for tracked by
	 * tab.id recreates <hu-request-tab> whenever the active tab id changes
	 * (and its @empty block is the no-tab empty state).
	 */
	protected readonly activeTabAsList = computed(() => {
		const tab = this.tabsState.activeTab();
		return tab === null ? [] : [tab];
	});

	private sidebarWidth = (() => {
		const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('hu-sidebar-width') : null;
		const n = stored ? Number(stored) : NaN;
		return Number.isFinite(n) && n >= MIN_SIDEBAR && n <= MAX_SIDEBAR ? n : DEFAULT_SIDEBAR;
	})();
	private dragging = false;
	private dragStartX = 0;
	private dragStartWidth = 0;

	constructor() {
		// Apply the persisted sidebar width as a CSS var on the host.
		this.host.nativeElement.style.setProperty('--hu-sidebar-width', `${this.sidebarWidth}px`);

		// Application-menu events for the import/export flows, re-dispatched as
		// document CustomEvents by RendererLifecycleService.
		listenOnDocument('hu:menu-import-http', () => {
			void this.importHttp();
		});
		listenOnDocument('hu:menu-import-swagger-url', () => {
			void this.importSwaggerFromUrl();
		});
		listenOnDocument('hu:menu-import-swagger-file', () => {
			void this.importSwaggerFromFile();
		});
		listenOnDocument('hu:menu-export-collection', () => {
			void this.exportHttp();
		});

		void this.maybeShowWelcome();

		// Global ⌘/ (and ⌘? — same physical key on US layouts with Shift)
		// opens help, no matter what has focus.
		const keyHandler = (e: KeyboardEvent): void => {
			if (!(e.metaKey || e.ctrlKey)) return;
			if (e.key !== '/' && e.key !== '?') return;
			e.preventDefault();
			this.openHelp();
		};
		document.addEventListener('keydown', keyHandler);

		// Splitter drag listeners live on document so a mid-drag unmount can't
		// leak them (mouseup would never fire on this component).
		inject(DestroyRef).onDestroy(() => {
			document.removeEventListener('keydown', keyHandler);
			document.removeEventListener('mousemove', this.handleSplitterMove);
			document.removeEventListener('mouseup', this.handleSplitterUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
		});
	}

	protected openHelp(): void {
		document.dispatchEvent(new CustomEvent('hu:open-help'));
	}

	protected openSettings(): void {
		document.dispatchEvent(new CustomEvent('hu:open-settings'));
	}

	protected handleSplitterDown(e: MouseEvent): void {
		this.dragging = true;
		this.dragStartX = e.clientX;
		this.dragStartWidth = this.sidebarWidth;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		document.addEventListener('mousemove', this.handleSplitterMove);
		document.addEventListener('mouseup', this.handleSplitterUp);
		e.preventDefault();
	}

	private readonly handleSplitterMove = (e: MouseEvent): void => {
		if (!this.dragging) return;
		const dx = e.clientX - this.dragStartX;
		const newWidth = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, this.dragStartWidth + dx));
		this.sidebarWidth = newWidth;
		// Direct CSS var update on the host — never trigger change detection
		// during drag; a re-render would disturb Monaco (selection, scroll,
		// undo stack).
		this.host.nativeElement.style.setProperty('--hu-sidebar-width', `${newWidth}px`);
	};

	private readonly handleSplitterUp = (): void => {
		if (!this.dragging) return;
		this.dragging = false;
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		document.removeEventListener('mousemove', this.handleSplitterMove);
		document.removeEventListener('mouseup', this.handleSplitterUp);
		try {
			localStorage.setItem('hu-sidebar-width', String(this.sidebarWidth));
		} catch {
			// localStorage may be unavailable (e.g. file:// in some sandboxes).
			// Persistence is a nicety; the in-memory value still works for the
			// current session.
		}
	};

	protected async handlePickFolder(): Promise<void> {
		try {
			await this.facade.pickAndOpenWorkspace();
		} catch (err) {
			console.error('pickAndOpenWorkspace failed:', err);
		}
	}

	protected async handleSwitchWorkspace(e: Event): Promise<void> {
		e.preventDefault();
		await this.handlePickFolder();
	}

	/**
	 * Invoked when the user clicks the "Restart to update" pill in the
	 * header. Tells the main process to quit, swap the on-disk binary,
	 * and relaunch via electron-updater's quitAndInstall.
	 */
	protected handleRestartForUpdate(): void {
		void rpc({ kind: 'app:quitAndInstall' });
	}

	/**
	 * First-launch welcome. Reads app-settings; if hasSeenWelcome is false,
	 * dispatches the document event the welcome-dialog component listens for.
	 */
	private async maybeShowWelcome(): Promise<void> {
		try {
			const settings = await rpc<AppSettings>({ kind: 'app:settings:get' });
			if (!settings.hasSeenWelcome) {
				document.dispatchEvent(new CustomEvent('hu:open-welcome'));
			}
		} catch (err) {
			console.warn('maybeShowWelcome failed:', err);
		}
	}

	/**
	 * Double-click on the header → zoom (the standard macOS title-bar
	 * gesture). With our custom title bar (titleBarStyle: hiddenInset) the
	 * system's automatic zoom doesn't always fire, so the renderer dispatches
	 * it via IPC. Bail if the dblclick landed on an interactive control —
	 * those shouldn't trigger a window resize. Tabs inside the strip also
	 * bail; the strip's empty area still works as a zoom target.
	 */
	protected handleHeaderDblClick(e: MouseEvent): void {
		const target = e.target as HTMLElement | null;
		if (!target) return;
		if (target.closest('button, input, a, [role="button"], hu-dropdown, hu-dropdown-item, hu-theme-toggle, .header-actions, .env-switcher, .tab')) {
			return;
		}
		void rpc({ kind: 'app:windowAction', action: 'zoom' });
	}

	/**
	 * Brand-mark click. On Win/Linux the native menu bar is hidden, so this is
	 * the only way to reach File/Edit/View/Help — pop the app menu just below
	 * the brand. macOS has the real menu bar, so we leave the click inert there.
	 */
	protected handleBrandClick(e: MouseEvent): void {
		if (window.httpui.platform === 'darwin') return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		void rpc({ kind: 'app:popupAppMenu', x: rect.left, y: rect.bottom });
	}

	protected handleImportSelect(value: string): void {
		switch (value) {
			case 'import-http':
				void this.importHttp();
				break;
			case 'import-swagger-url':
				void this.importSwaggerFromUrl();
				break;
			case 'import-swagger-file':
				void this.importSwaggerFromFile();
				break;
		}
	}

	private async importHttp(): Promise<void> {
		try {
			const dialogResult = await rpc<{ path: string | null }>({ kind: 'dialog:openHttp' });
			if (!dialogResult.path) return;
			await rpc<{ collectionId: string; stats: { requests: number; variables: number; folders: number } }>({
				kind: 'http:import',
				path: dialogResult.path
			});
			await this.refresh();
		} catch (err: unknown) {
			console.error('Import failed:', err);
			showToast(`Import failed: ${(err as Error).message}`, 'error');
		}
	}

	private async importSwaggerFromUrl(): Promise<void> {
		const url = await promptInline('Swagger / OpenAPI URL', '', 'https://example.com/swagger/v1/swagger.json');
		if (!url) return;
		try {
			const r = await rpc<{ stats: { operations: number; tags: number } }>({ kind: 'swagger:import', source: { kind: 'url', url } });
			showToast(`Imported ${r.stats.operations} operations across ${r.stats.tags} tag${r.stats.tags === 1 ? '' : 's'}`, 'success');
			await this.refresh();
		} catch (err: unknown) {
			showToast(`Swagger import failed: ${(err as Error).message}`, 'error');
		}
	}

	private async importSwaggerFromFile(): Promise<void> {
		const dialogResult = await rpc<{ path: string | null }>({ kind: 'dialog:openSwagger' });
		if (!dialogResult.path) return;
		try {
			const r = await rpc<{ stats: { operations: number; tags: number } }>({ kind: 'swagger:import', source: { kind: 'file', path: dialogResult.path } });
			showToast(`Imported ${r.stats.operations} operations across ${r.stats.tags} tag${r.stats.tags === 1 ? '' : 's'}`, 'success');
			await this.refresh();
		} catch (err: unknown) {
			showToast(`Swagger import failed: ${(err as Error).message}`, 'error');
		}
	}

	protected async exportHttp(): Promise<void> {
		try {
			const cols = this.workspace.collections();
			if (cols.length === 0) {
				showToast('No collections to export.', 'warning');
				return;
			}
			// v1 limitation: when multiple collections exist, just export the first
			// and surface a notice. A proper picker is a separate feature — using
			// window.prompt is a no-op in Electron's renderer, so doing nothing is
			// worse than picking sensibly + telling the user.
			const c = cols[0]!;
			if (cols.length > 1) {
				showToast(`Exporting "${c.name}" (multi-collection picker coming soon).`, 'info');
			}

			const dialogResult = await rpc<{ path: string | null }>({ kind: 'dialog:saveHttp', defaultName: `${c.name}.http` });
			if (!dialogResult.path) return;

			const result = await rpc<{ written: true; path: string; warnings: { kind: string; requestId?: string; detail: string }[] }>({
				kind: 'collection:export',
				collectionId: c.id,
				targetPath: dialogResult.path
			});

			if (result.warnings.length > 0) {
				const warnText = result.warnings.map((w) => `• ${w.kind}: ${w.detail}`).join('\n');
				showToast(`Exported to ${result.path}\n\n${result.warnings.length} warning(s):\n${warnText}`, 'warning', 8000);
			} else {
				showToast(`Exported to ${result.path}`, 'success');
			}
		} catch (err: unknown) {
			console.error('Export failed:', err);
			showToast(`Export failed: ${(err as Error).message}`, 'error', 6000);
		}
	}

	private async refresh(): Promise<void> {
		const ws = this.workspace.activeWorkspace();
		if (ws) await this.facade.loadWorkspaceData(ws.id);
	}
}
