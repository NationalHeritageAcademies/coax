import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { rpc } from '@ipc/renderer';
import type { Collection, Directory, Environment, Folder, RequestRow } from '../../store/model';
import { WorkspaceFacade } from '../../store/workspace.facade';
import { WorkspaceStateService } from '../../store/workspace-state.service';
import { listenOnDocument } from '../../util/document-events';
import { promptInline } from '../prompt';
import { showToast } from '../toast';
import { ButtonComponent, DialogComponent, IconComponent } from '../ui';

interface VarRow {
	id: string;
	key: string;
	valuePlain?: string;
	isSecret: boolean;
}

/**
 * One row in the left aside: a directory or folder scope header. The
 * recursive Melodic render functions became this flat list — a computed
 * walks the workspace tree depth-first, skipping the children of collapsed
 * scopes, and the template is a plain @for over the result.
 */
interface ScopeSection {
	kind: 'folder' | 'directory';
	id: string;
	collapseKey: string;
	label: string;
	depth: number;
	envs: Environment[];
	collapsed: boolean;
}

/**
 * Environments manager dialog. The content is a two-pane grid: left aside
 * lists envs per scope (mirroring the sidebar's workspace tree), right
 * section shows the selected env's detail (name, scope, activate/delete
 * actions, vars table with inline edit-on-blur, an "add variable" inline
 * form, and a "mark secret" password-swap flow).
 *
 * Open via the document-level `hu:open-env-manager` event dispatched from
 * the sidebar's gear buttons; the event detail may carry a folderId or
 * directoryId to focus that scope.
 */
@Component({
	selector: 'hu-env-manager',
	templateUrl: './env-manager.component.html',
	styleUrls: ['./env-manager.component.scss'],
	imports: [ButtonComponent, DialogComponent, IconComponent],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class EnvManagerComponent {
	private readonly workspace = inject(WorkspaceStateService);
	private readonly facade = inject(WorkspaceFacade);

	protected readonly selectedEnvId = signal<string | null>(null);
	/**
	 * Scopes whose subtree is collapsed in the left aside. Directory keys are
	 * prefixed "dir:" so they can't collide with folder ids. Replaced (not
	 * mutated) on toggle so the signal fires.
	 */
	protected readonly collapsedScopes = signal(new Set<string>());
	protected readonly envVars = signal<VarRow[] | null>(null);
	protected readonly addingVar = signal(false);
	protected readonly settingSecretForVarId = signal<string | null>(null);

	private readonly dialog = viewChild.required(DialogComponent);
	private readonly newKeyInput = viewChild<ElementRef<HTMLInputElement>>('newKey');
	private readonly newValueInput = viewChild<ElementRef<HTMLInputElement>>('newValue');
	private readonly secretInput = viewChild<ElementRef<HTMLInputElement>>('secretValue');

	protected readonly selectedEnv = computed<Environment | null>(() => {
		const id = this.selectedEnvId();
		return id === null ? null : (this.workspace.environments().find((e) => e.id === id) ?? null);
	});

	protected readonly selectedScopeLabel = computed(() => {
		const env = this.selectedEnv();
		if (!env) return '';
		const folder = this.workspace.folders().find((f) => f.id === env.folderId);
		return folder ? `Folder: ${folder.name}` : 'Folder: (unknown)';
	});

	/** Depth-first walk of the workspace tree → flat list of scope sections. */
	protected readonly sections = computed<ScopeSection[]>(() => {
		const dirs = this.workspace.directories();
		const root = dirs.find((d) => d.parentDirectoryId === undefined);
		if (!root) return [];
		const out: ScopeSection[] = [];
		this.walkDirectory(root, 0, out);
		return out;
	});

	constructor() {
		listenOnDocument('hu:open-env-manager', (e) => {
			this.handleOpenEvent(e);
		});
	}

	/**
	 * Default the tree to fully collapsed each time the dialog opens, then
	 * expand the ancestry of whatever scope the caller focused (folder or
	 * directory) so the targeted node is visible.
	 */
	private handleOpenEvent(e: Event): void {
		const folders = this.workspace.folders();
		const directories = this.workspace.directories();
		const collapsed = new Set([...folders.map((f) => f.id), ...directories.map((d) => `dir:${d.id}`)]);
		const detail = (e as CustomEvent<{ folderId?: string; directoryId?: string }>).detail;
		const folderId = detail?.folderId;
		const directoryId = detail?.directoryId;

		if (folderId) {
			const byId = new Map(folders.map((f) => [f.id, f]));
			let cur: string | undefined = folderId;
			const seen = new Set<string>();
			while (cur && !seen.has(cur)) {
				seen.add(cur);
				collapsed.delete(cur);
				cur = byId.get(cur)?.parentFolderId;
			}
		} else if (directoryId) {
			const byId = new Map(directories.map((d) => [d.id, d]));
			let cur: string | undefined = directoryId;
			const seen = new Set<string>();
			while (cur && !seen.has(cur)) {
				seen.add(cur);
				collapsed.delete(`dir:${cur}`);
				cur = byId.get(cur)?.parentDirectoryId;
			}
		}
		this.collapsedScopes.set(collapsed);

		const envs = this.workspace.environments();
		const firstEnv = folderId
			? envs.find((env) => env.folderId === folderId)
			: directoryId
				? envs.find((env) => env.directoryId === directoryId)
				: undefined;
		if (folderId || directoryId) this.selectEnvOrNone(firstEnv?.id ?? null);
		this.dialog().open();
	}

	/**
	 * Reset transient state when the dialog closes (Esc, backdrop, or the X)
	 * so the next open starts fresh.
	 */
	protected handleDialogClosed(): void {
		this.selectedEnvId.set(null);
		this.envVars.set(null);
		this.addingVar.set(false);
		this.settingSecretForVarId.set(null);
	}

	close(): void {
		this.dialog().close();
	}

	protected selectEnv(envId: string): void {
		this.selectEnvOrNone(envId);
		this.addingVar.set(false);
		this.settingSecretForVarId.set(null);
	}

	private selectEnvOrNone(envId: string | null): void {
		this.selectedEnvId.set(envId);
		this.envVars.set(null);
		if (envId !== null) void this.loadVars(envId);
	}

	protected startAddVar(): void {
		this.addingVar.set(true);
		setTimeout(() => this.newKeyInput()?.nativeElement.focus());
	}

	protected cancelAddVar(): void {
		this.addingVar.set(false);
	}

	protected startSetSecret(varId: string): void {
		this.settingSecretForVarId.set(varId);
		setTimeout(() => this.secretInput()?.nativeElement.focus());
	}

	protected cancelSetSecret(): void {
		this.settingSecretForVarId.set(null);
	}

	protected toggleCollapse(collapseKey: string): void {
		const next = new Set(this.collapsedScopes());
		if (next.has(collapseKey)) next.delete(collapseKey);
		else next.add(collapseKey);
		this.collapsedScopes.set(next);
	}

	protected async handleAddEnv(section: ScopeSection): Promise<void> {
		const name = await promptInline('New env name?', 'production');
		if (!name) return;
		try {
			const env = await rpc<Environment>(
				section.kind === 'directory' ? { kind: 'env:create', directoryId: section.id, name } : { kind: 'env:create', folderId: section.id, name }
			);
			await this.reloadWorkspace();
			this.selectEnvOrNone(env.id);
		} catch (err) {
			showToast(`Create env failed: ${(err as Error).message}`, 'error');
		}
	}

	protected async handleActivate(envId: string): Promise<void> {
		try {
			await rpc({ kind: 'env:setActive', envId });
			await this.reloadWorkspace();
		} catch (err) {
			showToast(`Activate failed: ${(err as Error).message}`, 'error');
		}
	}

	protected async handleRenameEnv(envId: string): Promise<void> {
		const env = this.workspace.environments().find((e) => e.id === envId);
		if (!env) return;
		const name = await promptInline('Rename env', env.name, env.name);
		if (!name || name === env.name) return;
		try {
			await rpc({ kind: 'env:rename', envId, name });
			await this.reloadWorkspace();
		} catch (err) {
			showToast(`Rename failed: ${(err as Error).message}`, 'error');
		}
	}

	protected async handleDeleteEnv(envId: string): Promise<void> {
		try {
			await rpc({ kind: 'env:delete', envId });
			showToast('Env deleted', 'success');
			this.selectEnvOrNone(null);
			await this.reloadWorkspace();
		} catch (err) {
			showToast(`Delete failed: ${(err as Error).message}`, 'error');
		}
	}

	protected async handleConfirmAddVar(): Promise<void> {
		const keyInput = this.newKeyInput()?.nativeElement;
		const key = keyInput?.value.trim() ?? '';
		const value = this.newValueInput()?.nativeElement.value ?? '';
		const envId = this.selectedEnvId();
		if (!key || !envId) {
			keyInput?.focus();
			return;
		}
		try {
			await rpc({ kind: 'var:create', envId, key, valuePlain: value });
			this.addingVar.set(false);
			await this.loadVars(envId);
		} catch (err) {
			showToast(`Add var failed: ${(err as Error).message}`, 'error');
		}
	}

	protected async handleConfirmSecret(varId: string): Promise<void> {
		const plaintext = this.secretInput()?.nativeElement.value ?? '';
		try {
			await rpc({ kind: 'var:setSecret', varId, plaintext });
			this.settingSecretForVarId.set(null);
			const envId = this.selectedEnvId();
			if (envId) await this.loadVars(envId);
		} catch (err) {
			showToast(`Set secret failed: ${(err as Error).message}`, 'error');
		}
	}

	protected async handleDeleteVar(varId: string): Promise<void> {
		try {
			await rpc({ kind: 'var:delete', varId });
			const envId = this.selectedEnvId();
			if (envId) await this.loadVars(envId);
		} catch (err) {
			showToast(`Delete var failed: ${(err as Error).message}`, 'error');
		}
	}

	protected handleAddVarKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			e.preventDefault();
			void this.handleConfirmAddVar();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			this.addingVar.set(false);
		}
	}

	protected handleSecretKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			e.preventDefault();
			const varId = this.settingSecretForVarId();
			if (varId) void this.handleConfirmSecret(varId);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			this.settingSecretForVarId.set(null);
		}
	}

	/** Save a var value on blur; no-op if unchanged. */
	protected async handleVarBlur(v: VarRow, newValue: string): Promise<void> {
		if (v.valuePlain === newValue) return;
		try {
			await rpc({ kind: 'var:setPlain', varId: v.id, valuePlain: newValue });
			this.envVars.update((vars) => (vars === null ? null : vars.map((row) => (row.id === v.id ? { ...row, valuePlain: newValue } : row))));
		} catch (err) {
			showToast(`Save failed: ${(err as Error).message}`, 'error');
		}
	}

	private async loadVars(envId: string): Promise<void> {
		try {
			const list = await rpc<VarRow[]>({ kind: 'var:list', envId });
			this.envVars.set(list);
		} catch (err) {
			console.error('var:list failed:', err);
			this.envVars.set([]);
		}
	}

	private async reloadWorkspace(): Promise<void> {
		const ws = this.workspace.activeWorkspace();
		if (ws) await this.facade.loadWorkspaceData(ws.id);
	}

	// ---- tree flattening -------------------------------------------------

	private walkDirectory(dir: Directory, depth: number, out: ScopeSection[]): void {
		const collapsed = this.collapsedScopes();
		const allCollections = this.workspace.collections();
		const allFolders = this.workspace.folders();
		const allRequests = this.workspace.requests();
		const allEnvs = this.workspace.environments();

		// Envs visible at the directory level = directory-scoped envs + any envs
		// attached to the root folder of a single-request collection that lives
		// here. The sidebar collapses those collections to a request row, so
		// their envs would otherwise be unreachable in env-manager.
		const dirEnvs = allEnvs.filter((e) => e.directoryId === dir.id);
		const absorbedEnvs: Environment[] = [];
		for (const col of allCollections) {
			if (col.directoryId !== dir.id) continue;
			if (!isSingleRequestCollection(col, allFolders, allRequests)) continue;
			for (const e of allEnvs) {
				if (e.folderId === col.rootFolderId) absorbedEnvs.push(e);
			}
		}

		const collapseKey = `dir:${dir.id}`;
		const isCollapsed = collapsed.has(collapseKey);
		out.push({
			kind: 'directory',
			id: dir.id,
			collapseKey,
			// The workspace root directory is stored with name='' (see migration
			// 006). Surface a friendly label so the section header isn't blank.
			label: dir.name === '' ? 'Workspace' : dir.name,
			depth,
			envs: [...dirEnvs, ...absorbedEnvs],
			collapsed: isCollapsed
		});
		if (isCollapsed) return;

		const childDirs = this.workspace
			.directories()
			.filter((d) => d.parentDirectoryId === dir.id)
			.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
		const dirCollections = allCollections
			.filter((col) => col.directoryId === dir.id)
			.filter((col) => !isSingleRequestCollection(col, allFolders, allRequests))
			.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
		for (const d of childDirs) this.walkDirectory(d, depth + 1, out);
		for (const col of dirCollections) this.walkCollection(col, depth + 1, out);
	}

	private walkCollection(collection: Collection, depth: number, out: ScopeSection[]): void {
		const collapsed = this.collapsedScopes();
		const allFolders = this.workspace.folders();
		const isCollapsed = collapsed.has(collection.rootFolderId);
		out.push({
			kind: 'folder',
			id: collection.rootFolderId,
			collapseKey: collection.rootFolderId,
			label: collection.name,
			depth,
			envs: this.workspace.environments().filter((e) => e.folderId === collection.rootFolderId),
			collapsed: isCollapsed
		});
		if (isCollapsed) return;
		for (const f of allFolders.filter((f) => f.parentFolderId === collection.rootFolderId)) {
			this.walkFolder(f, depth + 1, out);
		}
	}

	private walkFolder(folder: Folder, depth: number, out: ScopeSection[]): void {
		const collapsed = this.collapsedScopes();
		const isCollapsed = collapsed.has(folder.id);
		out.push({
			kind: 'folder',
			id: folder.id,
			collapseKey: folder.id,
			label: folder.name,
			depth,
			envs: this.workspace.environments().filter((e) => e.folderId === folder.id),
			collapsed: isCollapsed
		});
		if (isCollapsed) return;
		for (const f of this.workspace.folders().filter((f) => f.parentFolderId === folder.id)) {
			this.walkFolder(f, depth + 1, out);
		}
	}
}

/**
 * A "single-request collection" — one with exactly one request and no
 * folders. The sidebar collapses these to render as just the request, and
 * here in env-manager we absorb their envs into the parent directory's
 * section so the user doesn't see the same name twice.
 */
function isSingleRequestCollection(col: Collection, allFolders: Folder[], allRequests: RequestRow[]): boolean {
	const folderCount = allFolders.filter((f) => f.parentFolderId === col.rootFolderId).length;
	const reqCount = allRequests.filter((r) => r.collectionId === col.id).length;
	return reqCount === 1 && folderCount === 0;
}
