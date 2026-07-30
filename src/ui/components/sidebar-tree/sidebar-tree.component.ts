import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rpc } from '@ipc/renderer';
import type { Collection, Directory, OpenTab, RequestRow } from '../../store/model';
import { TabsStateService } from '../../store/tabs-state.service';
import { WorkspaceFacade } from '../../store/workspace.facade';
import { WorkspaceStateService } from '../../store/workspace-state.service';
import { MethodBadgeComponent } from '../method-badge/method-badge.component';
import { confirmInline, promptInline } from '../prompt';
import { showToast } from '../toast';
import { ButtonComponent, DropdownComponent, DropdownItemComponent, DropdownSeparatorComponent, IconComponent } from '../ui';

export interface TreeMenuItem {
	value?: string;
	label?: string;
	icon?: string;
	destructive?: boolean;
	separator?: boolean;
}

/**
 * One visible row of the sidebar. The recursive Melodic render helpers
 * became a computed depth-first flatten (children of unexpanded nodes are
 * skipped), so the template is a single @for.
 */
interface TreeNode {
	kind: 'directory' | 'collection' | 'request';
	/** Stable identity for @for tracking: `d:<id>`, `c:<id>`, `r:<id>`. */
	key: string;
	id: string;
	label: string;
	depth: number;
	/** directory/collection: whether the subtree is expanded. */
	open: boolean;
	/** directory: child count; collection: request count. */
	count: number;
	/** request rows only. */
	method: string;
	active: boolean;
	menu: TreeMenuItem[];
	// Drag/drop wiring — read by the delegated handlers via data attributes.
	dragCollectionId: string | null;
	dragDirectoryId: string | null;
	dragRequestId: string | null;
	dropTargetFolderId: string | null;
	dropTargetCollectionId: string | null;
	dropTargetDirectoryId: string | null;
}

/**
 * Hand-rolled hierarchical tree for the left sidebar: directories (real
 * on-disk subfolders), collections (.http files) and requests, with
 * color-coded method badges, hover-revealed kebab menus, and drag-and-drop
 * re-parenting for all four node types.
 */
@Component({
	selector: 'hu-sidebar-tree',
	templateUrl: './sidebar-tree.component.html',
	styleUrls: ['./sidebar-tree.component.scss'],
	imports: [ButtonComponent, DropdownComponent, DropdownItemComponent, DropdownSeparatorComponent, IconComponent, MethodBadgeComponent],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class SidebarTreeComponent {
	private readonly workspace = inject(WorkspaceStateService);
	private readonly tabsState = inject(TabsStateService);
	private readonly facade = inject(WorkspaceFacade);

	/**
	 * Expanded nodes, keyed `d:<id>` (directories) / `c:<id>` (collections).
	 * Replaced (not mutated) on toggle so the signal fires.
	 */
	private readonly expanded = signal(new Set<string>());

	protected readonly hasCollections = computed(() => this.workspace.collections().length > 0);

	private readonly activeRequestId = computed(() => this.tabsState.activeTab()?.requestId ?? null);

	protected readonly nodes = computed<TreeNode[]>(() => {
		const out: TreeNode[] = [];
		this.walkDirectoryChildren(null, 0, out);
		return out;
	});

	protected toggle(node: TreeNode): void {
		if (node.kind === 'request') {
			void this.openRequest(node.id);
			return;
		}
		const next = new Set(this.expanded());
		if (next.has(node.key)) next.delete(node.key);
		else next.add(node.key);
		this.expanded.set(next);
	}

	// ---- tree flattening -------------------------------------------------

	/**
	 * Flatten the children of a workspace directory: nested directories first,
	 * then multi-request collections, then single-request collections — each
	 * tier alphabetical within itself. This puts the "containers" together at
	 * the top, with leaf-like single requests last: easier to scan and matches
	 * the user's mental hierarchy (most-grouping → least-grouping).
	 * `null` matches the implicit anonymous root directory.
	 */
	private walkDirectoryChildren(parentDirectoryId: string | null, depth: number, out: TreeNode[]): void {
		const allDirectories = this.workspace.directories();
		const allCollections = this.workspace.collections();
		const allRequests = this.workspace.requests();

		const here =
			parentDirectoryId === null ? allDirectories.find((d) => d.parentDirectoryId === undefined) : allDirectories.find((d) => d.id === parentDirectoryId);
		if (!here) {
			// No workspace root yet (fresh empty workspace) — render flat so the
			// user still sees their collections.
			for (const col of allCollections) this.walkCollection(col, depth, out);
			return;
		}

		const byName = <T extends { sortOrder: number; name: string }>(a: T, b: T): number => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
		const childDirs = allDirectories.filter((d) => d.parentDirectoryId === here.id).sort(byName);
		const dirCollections = allCollections.filter((c) => c.directoryId === here.id);
		const requestCount = (collectionId: string): number => allRequests.filter((r) => r.collectionId === collectionId).length;
		const multiReq = dirCollections.filter((c) => requestCount(c.id) !== 1).sort(byName);
		const singleReq = dirCollections.filter((c) => requestCount(c.id) === 1).sort(byName);

		for (const d of childDirs) this.walkDirectory(d, depth, out);
		for (const c of multiReq) this.walkCollection(c, depth, out);
		for (const c of singleReq) this.walkCollection(c, depth, out);
	}

	private walkDirectory(d: Directory, depth: number, out: TreeNode[]): void {
		const key = `d:${d.id}`;
		const isOpen = this.expanded().has(key);
		const childDirCount = this.workspace.directories().filter((x) => x.parentDirectoryId === d.id).length;
		const childCollCount = this.workspace.collections().filter((c) => c.directoryId === d.id).length;
		out.push({
			kind: 'directory',
			key,
			id: d.id,
			label: d.name,
			depth,
			open: isOpen,
			count: childDirCount + childCollCount,
			method: '',
			active: false,
			menu: [
				{ value: `directory-new-collection:${d.id}`, label: 'New collection', icon: 'plus' },
				{ value: `directory-new-subdirectory:${d.id}`, label: 'New folder', icon: 'folder-plus' },
				{ value: `directory-import-http:${d.id}`, label: 'Import .http here…', icon: 'download-simple' },
				{ value: `directory-manage-envs:${d.id}`, label: 'Manage envs…', icon: 'gear' },
				{ separator: true },
				{ value: `directory-export:${d.id}`, label: 'Export subtree…', icon: 'upload-simple' },
				{ value: `directory-rename:${d.id}`, label: 'Rename', icon: 'pencil-simple' },
				{ separator: true },
				{ value: `directory-delete:${d.id}`, label: 'Delete', icon: 'trash', destructive: true }
			],
			dragCollectionId: null,
			dragDirectoryId: d.id,
			dragRequestId: null,
			dropTargetFolderId: null,
			dropTargetCollectionId: null,
			dropTargetDirectoryId: d.id
		});
		if (isOpen) this.walkDirectoryChildren(d.id, depth + 1, out);
	}

	private walkCollection(c: Collection, depth: number, out: TreeNode[]): void {
		const collectionRequests = this.workspace.requests().filter((r) => r.collectionId === c.id);

		// Single-request collections render as the request itself. The .http
		// file is just a wrapper around one request; an extra "folder" row to
		// expand for a single child is noise.
		if (collectionRequests.length === 1) {
			this.pushRequest(collectionRequests[0]!, depth, c.rootFolderId, out);
			return;
		}

		const key = `c:${c.id}`;
		const isOpen = this.expanded().has(key);
		out.push({
			kind: 'collection',
			key,
			id: c.id,
			label: c.name,
			depth,
			open: isOpen,
			count: collectionRequests.length,
			method: '',
			active: false,
			menu: [
				{ value: `collection-new-request:${c.id}`, label: 'New request', icon: 'plus' },
				{ value: `collection-import-http:${c.id}`, label: 'Import .http here…', icon: 'download-simple' },
				{ value: `collection-manage-envs:${c.id}`, label: 'Manage envs…', icon: 'gear' },
				{ separator: true },
				{ value: `collection-rename:${c.id}`, label: 'Rename', icon: 'pencil-simple' },
				{ value: `collection-export:${c.id}`, label: 'Export…', icon: 'upload-simple' },
				{ separator: true },
				{ value: `collection-delete:${c.id}`, label: 'Delete', icon: 'trash', destructive: true }
			],
			dragCollectionId: c.id,
			dragDirectoryId: null,
			dragRequestId: null,
			dropTargetFolderId: c.rootFolderId,
			dropTargetCollectionId: c.id,
			dropTargetDirectoryId: null
		});
		if (isOpen) {
			for (const r of collectionRequests) this.pushRequest(r, depth + 1, c.rootFolderId, out);
		}
	}

	private pushRequest(r: RequestRow, depth: number, hostRootFolderId: string, out: TreeNode[]): void {
		out.push({
			kind: 'request',
			key: `r:${r.id}`,
			id: r.id,
			label: r.name || r.url,
			depth,
			open: false,
			count: 0,
			method: r.method,
			active: r.id === this.activeRequestId(),
			menu: [
				{ value: `request-open:${r.id}`, label: 'Open', icon: 'arrow-square-out' },
				{ value: `request-rename:${r.id}`, label: 'Rename', icon: 'pencil-simple' },
				{ value: `request-duplicate:${r.id}`, label: 'Duplicate', icon: 'copy' },
				{ value: `request-export:${r.id}`, label: 'Export…', icon: 'upload-simple' },
				{ separator: true },
				{ value: `request-delete:${r.id}`, label: 'Delete', icon: 'trash', destructive: true }
			],
			dragCollectionId: null,
			dragDirectoryId: null,
			dragRequestId: r.id,
			dropTargetFolderId: hostRootFolderId,
			dropTargetCollectionId: null,
			dropTargetDirectoryId: null
		});
	}

	// ---- drag & drop -----------------------------------------------------
	// Delegated on the tree wrapper; reads the data-* attributes the template
	// stamps on each row, so nested rows resolve via closest().

	private lastDropHover: HTMLElement | null = null;

	protected handleDragStart(ev: DragEvent): void {
		const target = ev.target as HTMLElement;
		if (!ev.dataTransfer) return;
		// Drag-source priority: collection → directory → folder → request. The
		// first matching ancestor of the drag-started element wins so nested rows
		// emit the correct dataTransfer MIME.
		const collectionRow = target.closest<HTMLElement>('[data-collection-id]');
		if (collectionRow?.dataset.collectionId) {
			ev.dataTransfer.setData('application/x-hu-collection-id', collectionRow.dataset.collectionId);
			ev.dataTransfer.effectAllowed = 'move';
			return;
		}
		const directoryRow = target.closest<HTMLElement>('[data-directory-id]');
		if (directoryRow?.dataset.directoryId) {
			ev.dataTransfer.setData('application/x-hu-directory-id', directoryRow.dataset.directoryId);
			ev.dataTransfer.effectAllowed = 'move';
			return;
		}
		const folderRow = target.closest<HTMLElement>('[data-folder-id]');
		if (folderRow?.dataset.folderId) {
			ev.dataTransfer.setData('application/x-hu-folder-id', folderRow.dataset.folderId);
			ev.dataTransfer.effectAllowed = 'move';
			return;
		}
		const requestRow = target.closest<HTMLElement>('[data-request-id]');
		if (!requestRow?.dataset.requestId) return;
		ev.dataTransfer.setData('application/x-hu-request-id', requestRow.dataset.requestId);
		ev.dataTransfer.effectAllowed = 'move';
	}

	protected handleDragOver(ev: DragEvent): void {
		const types = ev.dataTransfer?.types ?? [];
		const isFolderDrag = types.includes('application/x-hu-folder-id');
		const isCollectionDrag = types.includes('application/x-hu-collection-id');
		const isRequestDrag = types.includes('application/x-hu-request-id');
		const isDirectoryDrag = types.includes('application/x-hu-directory-id');
		if (!isFolderDrag && !isCollectionDrag && !isRequestDrag && !isDirectoryDrag) return;
		ev.preventDefault(); // signals "drop allowed"
		if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
		const target = ev.target as HTMLElement;
		// Per-drag-type drop targets:
		//   collection → another collection row (becomes child)
		//   directory  → another directory row (becomes child)
		//   request    → folder or directory (folder = move into; directory = new
		//                single-request .http)
		//   folder     → another folder
		const selector = isCollectionDrag
			? '[data-drop-target-collection-id]'
			: isDirectoryDrag
				? '[data-drop-target-directory-id]'
				: isRequestDrag
					? '[data-drop-target-folder-id], [data-drop-target-directory-id]'
					: '[data-drop-target-folder-id]';
		const row = target.closest<HTMLElement>(selector);
		if (!row) return;
		if (this.lastDropHover && this.lastDropHover !== row) {
			this.lastDropHover.removeAttribute('data-drop-hover');
		}
		row.setAttribute('data-drop-hover', '');
		this.lastDropHover = row;
	}

	protected handleDragLeave(ev: DragEvent): void {
		const row = (ev.target as HTMLElement).closest<HTMLElement>(
			'[data-drop-target-folder-id], [data-drop-target-collection-id], [data-drop-target-directory-id]'
		);
		const next = ev.relatedTarget as Node | null;
		if (row && (!next || !row.contains(next))) {
			row.removeAttribute('data-drop-hover');
			if (this.lastDropHover === row) this.lastDropHover = null;
		}
	}

	protected async handleDrop(ev: DragEvent): Promise<void> {
		ev.preventDefault();
		if (this.lastDropHover) {
			this.lastDropHover.removeAttribute('data-drop-hover');
			this.lastDropHover = null;
		}
		const target = ev.target as HTMLElement;
		const collectionId = ev.dataTransfer?.getData('application/x-hu-collection-id');
		if (collectionId) {
			const targetRow = target.closest<HTMLElement>('[data-drop-target-collection-id]');
			const newParentCollectionId = targetRow?.dataset.dropTargetCollectionId ?? null;
			if (!newParentCollectionId || newParentCollectionId === collectionId) return;
			try {
				await rpc({ kind: 'collection:reparent', collectionId, newParentCollectionId });
				await this.refresh();
			} catch (err) {
				console.error('collection:reparent failed:', err);
				showToast(`Move failed: ${(err as Error).message}`, 'error');
			}
			return;
		}
		const directoryDragId = ev.dataTransfer?.getData('application/x-hu-directory-id');
		if (directoryDragId) {
			const targetRow = target.closest<HTMLElement>('[data-drop-target-directory-id]');
			const newParentDirectoryId = targetRow?.dataset.dropTargetDirectoryId;
			if (!newParentDirectoryId || newParentDirectoryId === directoryDragId) return;
			try {
				await rpc({ kind: 'directory:reparent', id: directoryDragId, newParentDirectoryId });
				await this.refresh();
			} catch (err) {
				console.error('directory:reparent failed:', err);
				showToast(`Move failed: ${(err as Error).message}`, 'error');
			}
			return;
		}
		const folderId = ev.dataTransfer?.getData('application/x-hu-folder-id');
		if (folderId) {
			const targetRow = target.closest<HTMLElement>('[data-drop-target-folder-id]');
			const newParentFolderId = targetRow?.dataset.dropTargetFolderId;
			if (!newParentFolderId || newParentFolderId === folderId) return;
			try {
				await rpc({ kind: 'folder:reparent', folderId, newParentFolderId });
				await this.refresh();
			} catch (err) {
				console.error('folder:reparent failed:', err);
				showToast(`Move failed: ${(err as Error).message}`, 'error');
			}
			return;
		}
		const requestId = ev.dataTransfer?.getData('application/x-hu-request-id');
		if (!requestId) return;
		// Folder/collection drop is the inner-most target — try that first
		// (closest() walks ancestors, so a request dropped on a collection
		// row inside an expanded directory finds the collection, not the
		// directory). If no folder target is in the hover chain, fall back
		// to the enclosing directory: drop on a directory creates a new
		// single-request .http there.
		const folderRow = target.closest<HTMLElement>('[data-drop-target-folder-id]');
		const newFolderId = folderRow?.dataset.dropTargetFolderId;
		if (newFolderId) {
			try {
				await rpc({ kind: 'request:reparent', requestId, newFolderId });
				await this.refresh();
			} catch (err) {
				console.error('request:reparent failed:', err);
				showToast(`Move failed: ${(err as Error).message}`, 'error');
			}
			return;
		}
		const dirRow = target.closest<HTMLElement>('[data-drop-target-directory-id]');
		const directoryId = dirRow?.dataset.dropTargetDirectoryId;
		if (directoryId) {
			try {
				await rpc({ kind: 'request:moveToDirectory', requestId, directoryId });
				await this.refresh();
			} catch (err) {
				console.error('request:moveToDirectory failed:', err);
				showToast(`Move failed: ${(err as Error).message}`, 'error');
			}
		}
	}

	// ---- menu routing ----------------------------------------------------

	/**
	 * Every kebab / header dropdown in the tree routes here. The value is
	 * `action:targetId` (top-level actions have no target id).
	 */
	protected async handleMenuSelect(value: string): Promise<void> {
		if (!value) return;
		const idx = value.indexOf(':');
		const action = idx < 0 ? value : value.slice(0, idx);
		const id = idx < 0 ? '' : value.slice(idx + 1);
		try {
			switch (action) {
				case 'new-collection':
					await this.newCollection();
					break;
				case 'new-folder-top':
					await this.newSubdirectoryTopLevel();
					break;
				case 'workspace-manage-envs': {
					// Open the env manager scoped to the workspace's implicit root
					// directory so it expands the Workspace section.
					const root = this.workspace.directories().find((d) => d.parentDirectoryId === undefined);
					if (!root) {
						showToast('No active workspace', 'error');
						break;
					}
					document.dispatchEvent(new CustomEvent('hu:open-env-manager', { detail: { directoryId: root.id } }));
					break;
				}
				case 'directory-new-collection':
					await this.newCollectionInDirectory(id);
					break;
				case 'directory-new-subdirectory':
					await this.newSubdirectory(id);
					break;
				case 'directory-import-http':
					await this.importHttpIntoDirectory(id);
					break;
				case 'directory-manage-envs':
					document.dispatchEvent(new CustomEvent('hu:open-env-manager', { detail: { directoryId: id } }));
					break;
				case 'directory-export':
					await this.exportNode('directory', id);
					break;
				case 'directory-rename':
					await this.renameDirectory(id);
					break;
				case 'directory-delete':
					await this.deleteDirectory(id);
					break;
				case 'import-http-top':
					await this.importHttpTopLevel();
					break;
				case 'import-swagger-url':
					await this.importSwaggerFromUrl();
					break;
				case 'import-swagger-file':
					await this.importSwaggerFromFile();
					break;
				case 'collection-new-request':
					await this.newRequestInCollection(id);
					break;
				case 'collection-import-http':
					await this.importHttpInto(id);
					break;
				case 'collection-manage-envs': {
					// Open env-manager focused on this collection's root folder.
					const col = this.workspace.collections().find((c) => c.id === id);
					if (col) {
						document.dispatchEvent(new CustomEvent('hu:open-env-manager', { detail: { folderId: col.rootFolderId } }));
					}
					break;
				}
				case 'collection-rename':
					await this.renameCollection(id);
					break;
				case 'collection-delete':
					await this.deleteCollection(id);
					break;
				case 'request-open':
					await this.openRequest(id);
					break;
				case 'request-rename':
					await this.renameRequest(id);
					break;
				case 'request-duplicate':
					await rpc({ kind: 'request:duplicate', requestId: id });
					await this.refresh();
					break;
				case 'request-export':
					await this.exportNode('request', id);
					break;
				case 'collection-export':
					await this.exportNode('collection', id);
					break;
				case 'request-delete':
					await this.deleteRequest(id);
					break;
			}
		} catch (err) {
			console.error(`menu action ${action} failed:`, err);
			showToast(`Action failed: ${(err as Error).message}`, 'error');
		}
	}

	// ---- actions ---------------------------------------------------------

	private async refresh(): Promise<void> {
		const ws = this.workspace.activeWorkspace();
		if (ws) await this.facade.loadWorkspaceData(ws.id);
	}

	private async openRequest(requestId: string): Promise<void> {
		try {
			const tab = await rpc<OpenTab>({ kind: 'tabs:open', requestId });
			const list = this.tabsState.tabs();
			if (!list.find((t) => t.id === tab.id)) this.tabsState.setTabs([...list, tab]);
			this.tabsState.setActiveTabId(tab.id);
		} catch (err) {
			console.error('open tab failed:', err);
		}
	}

	private async newCollection(): Promise<void> {
		const ws = this.workspace.activeWorkspace();
		if (!ws) {
			showToast('No active workspace', 'error');
			return;
		}
		const name = await promptInline('New collection name', 'Untitled');
		if (!name) return;
		try {
			await rpc({ kind: 'collection:create', workspaceId: ws.id, name });
			await this.refresh();
		} catch (err) {
			showToast(`Create collection failed: ${(err as Error).message}`, 'error');
		}
	}

	private async newRequestInCollection(collectionId: string): Promise<void> {
		const col = this.workspace.collections().find((c) => c.id === collectionId);
		if (!col) return;
		const name = await promptInline('New request name', 'Untitled');
		if (!name) return;
		// "Loose at collection root" means folder_id NULL — matches how
		// http:import creates requests with no section divider.
		await rpc({
			kind: 'request:create',
			parent: { collectionId },
			draft: { name, method: 'GET', url: 'https://', headers: [] }
		});
		await this.refresh();
	}

	private async newCollectionInDirectory(directoryId: string): Promise<void> {
		const ws = this.workspace.activeWorkspace();
		if (!ws) return;
		const name = await promptInline('New collection name', 'Untitled');
		if (!name) return;
		await rpc({ kind: 'collection:create', workspaceId: ws.id, name, directoryId });
		await this.refresh();
	}

	private async newSubdirectory(parentDirectoryId: string): Promise<void> {
		const ws = this.workspace.activeWorkspace();
		if (!ws) return;
		const name = await promptInline('New folder name', 'new-folder');
		if (!name) return;
		try {
			await rpc({ kind: 'directory:create', workspaceId: ws.id, name, parentDirectoryId });
			await this.refresh();
		} catch (err) {
			showToast(`Create folder failed: ${(err as Error).message}`, 'error');
		}
	}

	/**
	 * Create a folder at the workspace root. Resolves the root-directory id
	 * (the synthetic directory with parentDirectoryId === undefined) and
	 * delegates to the shared subdirectory creator.
	 */
	private async newSubdirectoryTopLevel(): Promise<void> {
		const root = this.workspace.directories().find((d) => d.parentDirectoryId === undefined);
		if (!root) {
			showToast('No workspace open.', 'error');
			return;
		}
		await this.newSubdirectory(root.id);
	}

	private async importHttpIntoDirectory(directoryId: string): Promise<void> {
		const dialogResult = await rpc<{ path: string | null }>({ kind: 'dialog:openHttp' });
		if (!dialogResult.path) return;
		await rpc<{ collectionId: string }>({ kind: 'http:import', path: dialogResult.path, directoryId });
		await this.refresh();
	}

	private async renameDirectory(directoryId: string): Promise<void> {
		const dir = this.workspace.directories().find((d) => d.id === directoryId);
		if (!dir) return;
		const name = await promptInline('Rename folder', dir.name, dir.name);
		if (!name || name === dir.name) return;
		try {
			await rpc({ kind: 'directory:rename', id: directoryId, name });
			await this.refresh();
		} catch (err) {
			showToast(`Rename folder failed: ${(err as Error).message}`, 'error');
		}
	}

	private async deleteDirectory(directoryId: string): Promise<void> {
		const dir = this.workspace.directories().find((d) => d.id === directoryId);
		if (!dir) return;
		const ok = await confirmInline(`Delete folder "${dir.name}" and everything inside it? This cannot be undone.`);
		if (!ok) return;
		try {
			await rpc({ kind: 'directory:delete', id: directoryId });
			await this.refresh();
		} catch (err) {
			showToast(`Delete folder failed: ${(err as Error).message}`, 'error');
		}
	}

	private async renameCollection(collectionId: string): Promise<void> {
		const col = this.workspace.collections().find((c) => c.id === collectionId);
		if (!col) return;
		const name = await promptInline('Rename collection', col.name, col.name);
		if (!name || name === col.name) return;
		await rpc({ kind: 'collection:rename', id: collectionId, name });
		await this.refresh();
	}

	private async deleteCollection(collectionId: string): Promise<void> {
		const col = this.workspace.collections().find((c) => c.id === collectionId);
		if (!col) return;
		const ok = await confirmInline(`Delete collection "${col.name}" and everything in it? This cannot be undone.`);
		if (!ok) return;
		await rpc({ kind: 'collection:delete', id: collectionId });
		await this.refresh();
	}

	private async importHttpInto(parentCollectionId: string): Promise<void> {
		const dialogResult = await rpc<{ path: string | null }>({ kind: 'dialog:openHttp' });
		if (!dialogResult.path) return;
		await rpc<{ collectionId: string }>({ kind: 'http:import', path: dialogResult.path, parentCollectionId });
		await this.refresh();
	}

	private async importHttpTopLevel(): Promise<void> {
		const dialogResult = await rpc<{ path: string | null }>({ kind: 'dialog:openHttp' });
		if (!dialogResult.path) return;
		await rpc<{ collectionId: string }>({ kind: 'http:import', path: dialogResult.path });
		await this.refresh();
	}

	private async importSwaggerFromUrl(): Promise<void> {
		const url = await promptInline('Swagger / OpenAPI URL', '', 'https://example.com/swagger/v1/swagger.json');
		if (!url) return;
		try {
			const r = await rpc<{ stats: { operations: number; tags: number } }>({ kind: 'swagger:import', source: { kind: 'url', url } });
			showToast(`Imported ${r.stats.operations} operations across ${r.stats.tags} tag${r.stats.tags === 1 ? '' : 's'}`, 'success');
			await this.refresh();
		} catch (err) {
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
		} catch (err) {
			showToast(`Swagger import failed: ${(err as Error).message}`, 'error');
		}
	}

	private async renameRequest(requestId: string): Promise<void> {
		const req = this.workspace.requests().find((r) => r.id === requestId);
		if (!req) return;
		const name = await promptInline('Rename request', req.name, req.name);
		if (!name || name === req.name) return;
		await rpc({ kind: 'request:rename', requestId, name });
		await this.refresh();
	}

	private async deleteRequest(requestId: string): Promise<void> {
		const req = this.workspace.requests().find((r) => r.id === requestId);
		if (!req) return;
		const ok = await confirmInline(`Delete request "${req.name}"? This cannot be undone.`);
		if (!ok) return;
		await rpc({ kind: 'request:delete', requestId });
		await this.refresh();
	}

	private async exportNode(nodeKind: 'request' | 'collection' | 'directory', nodeId: string): Promise<void> {
		let defaultName = 'export.http';
		if (nodeKind === 'directory') {
			const d = this.workspace.directories().find((x) => x.id === nodeId);
			if (d) defaultName = `${d.name || 'workspace'}.http`;
		} else if (nodeKind === 'request') {
			const r = this.workspace.requests().find((x) => x.id === nodeId);
			if (r) defaultName = `${r.name || 'request'}.http`;
		} else {
			const c = this.workspace.collections().find((x) => x.id === nodeId);
			if (c) defaultName = `${c.name}.http`;
		}
		const result = await rpc<{ path: string | null }>({ kind: 'dialog:saveHttp', defaultName });
		if (!result.path) return;
		await rpc({ kind: 'tree:export', nodeKind, nodeId, targetPath: result.path });
		const exportedPath = result.path;
		// navigator.userAgent is the DOM-native way to sniff the host OS from
		// the renderer (process.platform is only reliable in main / preload).
		const ua = navigator.userAgent;
		const revealLabel = ua.includes('Mac') ? 'Reveal in Finder' : ua.includes('Win') ? 'Reveal in Explorer' : 'Reveal in file manager';
		showToast(`Exported to ${exportedPath}`, 'success', {
			durationMs: 7000,
			actionLabel: revealLabel,
			onClick: () => {
				void rpc({ kind: 'shell:revealInFolder', path: exportedPath });
			}
		});
	}
}
