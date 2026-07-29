import { Injectable, inject } from '@angular/core';
import { rpc } from '@ipc/renderer';
import type { Collection, Directory, Environment, Folder, OpenTab, RequestRow, Workspace } from './model';
import { TabsStateService } from './tabs-state.service';
import { WorkspaceStateService } from './workspace-state.service';

/**
 * Orchestrates workspace loading. This is the only writer of
 * {@link WorkspaceStateService}; components read the signals and call these
 * methods rather than mutating state directly.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceFacade {
	private readonly state = inject(WorkspaceStateService);
	private readonly tabsState = inject(TabsStateService);

	/**
	 * The main process auto-opens the most-recently-used workspace folder during
	 * initHandlers() if one exists and is still on disk. We ask for whatever is
	 * currently open, set it active, and load its data. If null the renderer shows
	 * the no-workspace-picked UI with a "Pick a folder" button.
	 */
	async bootstrap(): Promise<void> {
		const current = await rpc<Workspace | null>({ kind: 'workspace:current' });
		const recent = await rpc<{ path: string; name: string }[]>({ kind: 'workspace:list' });
		this.state.setWorkspaces(recent.map((r) => ({ id: r.path, name: r.name, path: r.path })));
		if (current !== null) {
			this.state.setActiveWorkspace(current);
			await this.loadWorkspaceData(current.id);
		}
	}

	/**
	 * Show the OS folder picker and open the chosen folder as a workspace.
	 * Re-runs the data load so the sidebar reflects the new folder.
	 */
	async pickAndOpenWorkspace(): Promise<void> {
		const result = await rpc<{ canceled: true } | { canceled: false; folderPath: string }>({ kind: 'workspace:pickFolder' });
		if (result.canceled) return;
		const opened = await rpc<Workspace>({ kind: 'workspace:open', folderPath: result.folderPath });
		this.state.setActiveWorkspace(opened);
		await this.loadWorkspaceData(opened.id);
	}

	/** Closes the workspace and clears in-memory state back to the empty view. */
	async closeCurrentWorkspace(): Promise<void> {
		await rpc({ kind: 'workspace:close' });
		this.state.clear();
		this.tabsState.setTabs([]);
		this.tabsState.setActiveTabId(null);
	}

	async loadWorkspaceData(workspaceId: string): Promise<void> {
		const [dirs, cols] = await Promise.all([
			rpc<Directory[]>({ kind: 'directory:list', workspaceId }),
			rpc<Collection[]>({ kind: 'collection:list', workspaceId })
		]);
		this.state.setDirectories(dirs);
		this.state.setCollections(cols);

		const allFolders: Folder[] = [];
		const allRequests: RequestRow[] = [];
		for (const c of cols) {
			const [fs, rs] = await Promise.all([rpc<Folder[]>({ kind: 'folder:list', collectionId: c.id }), rpc<RequestRow[]>({ kind: 'request:list', collectionId: c.id })]);
			allFolders.push(...fs);
			allRequests.push(...rs);
		}
		this.state.setFolders(allFolders);
		this.state.setRequests(allRequests);

		// Envs come in two flavors post-006:
		//   - folder-scoped (inside a collection — inline @vars, attached to the
		//     collection's root folder or a deeper folder via @folder directives)
		//   - directory-scoped (workspace-level — adopted from .env.json files)
		// Fetch both sets and union them.
		const folderIdsForEnvs = [...cols.map((c) => c.rootFolderId), ...allFolders.map((f) => f.id)];
		const [folderEnvLists, dirEnvLists] = await Promise.all([
			Promise.all(folderIdsForEnvs.map((fid) => rpc<Environment[]>({ kind: 'env:list', folderId: fid }))),
			Promise.all(dirs.map((d) => rpc<Environment[]>({ kind: 'env:listByDirectory', directoryId: d.id })))
		]);
		this.state.setEnvironments([...folderEnvLists.flat(), ...dirEnvLists.flat()]);

		const openTabs = await rpc<OpenTab[]>({ kind: 'tabs:list' });
		this.tabsState.setTabs(openTabs);
	}
}
