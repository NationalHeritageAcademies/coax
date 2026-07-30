import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { rpc } from '@ipc/renderer';
import type { Environment } from '../../store/model';
import { TabsStateService } from '../../store/tabs-state.service';
import { WorkspaceFacade } from '../../store/workspace.facade';
import { WorkspaceStateService } from '../../store/workspace-state.service';
import { showToast } from '../toast';
import { ButtonComponent } from '../ui';

interface ChainStep {
	folderId: string;
	folderName: string;
	env: Environment | null;
	envs: Environment[];
}

/**
 * Per-folder env switcher rendered as a chain (root → leaf). Each folder
 * in the active request's chain becomes its own dropdown — the user picks
 * the active env at any level independently. Variables resolve via the
 * chain at send time, deepest-wins.
 *
 * When no request tab is open, the switcher collapses to a single
 * dropdown for the workspace's first collection's root folder.
 *
 * The "+ new env" affordance scopes to the currently-focused dropdown's
 * folder.
 */
@Component({
	selector: 'hu-env-switcher',
	templateUrl: './env-switcher.component.html',
	styleUrls: ['./env-switcher.component.scss'],
	imports: [ButtonComponent],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class EnvSwitcherComponent {
	private readonly workspace = inject(WorkspaceStateService);
	private readonly tabsState = inject(TabsStateService);
	private readonly facade = inject(WorkspaceFacade);

	protected readonly creating = signal(false);
	protected readonly createForFolderId = signal<string>('');

	private readonly newNameInput = viewChild<ElementRef<HTMLInputElement>>('newName');

	/**
	 * Derives the folder chain (root → leaf) for the active tab's request.
	 * Falls back to the first collection's root folder when no tab is open
	 * so the switcher still has somewhere to surface envs.
	 */
	protected readonly chain = computed<ChainStep[]>(() => {
		const tab = this.tabsState.activeTab();
		if (tab) {
			const req = this.workspace.requests().find((r) => r.id === tab.requestId);
			if (req) {
				const collection = this.workspace.collections().find((c) => c.id === req.collectionId);
				if (!collection) return [];
				return this.walkChain(req.folderId ?? collection.rootFolderId);
			}
		}
		const cols = this.workspace.collections();
		if (cols.length === 0) return [];
		return this.walkChain(cols[0]!.rootFolderId);
	});

	/**
	 * Nothing to show if the workspace has no folders (chain empty) or no
	 * folder in the chain has any envs at all — the gear button on each
	 * folder row in the sidebar handles env management now.
	 */
	protected readonly visible = computed(() => this.chain().some((s) => s.envs.length > 0));

	protected readonly createTargetName = computed(() => this.chain().find((s) => s.folderId === this.createForFolderId())?.folderName ?? 'folder');

	private walkChain(startFolderId: string): ChainStep[] {
		const folderById = new Map(this.workspace.folders().map((f) => [f.id, f]));
		const allEnvs = this.workspace.environments();
		const chain: ChainStep[] = [];
		const seen = new Set<string>();
		let current: string | undefined = startFolderId;
		while (current && !seen.has(current)) {
			seen.add(current);
			const f = folderById.get(current);
			if (!f) break;
			const envs = allEnvs.filter((e) => e.folderId === f.id);
			chain.push({
				folderId: f.id,
				folderName: f.name,
				env: envs.find((e) => e.isActive) ?? null,
				envs
			});
			current = f.parentFolderId;
		}
		chain.reverse();
		return chain;
	}

	protected startCreateFor(folderId: string): void {
		this.createForFolderId.set(folderId);
		this.creating.set(true);
		// The input renders on the next change-detection pass; focus after it lands.
		setTimeout(() => this.newNameInput()?.nativeElement.focus());
	}

	protected cancelCreate(): void {
		this.creating.set(false);
	}

	protected async handleChange(folderId: string, envId: string): Promise<void> {
		try {
			if (envId === '') {
				await rpc<{ folderId: string }>({ kind: 'env:clearActive', folderId });
			} else {
				await rpc<{ envId: string }>({ kind: 'env:setActive', envId });
			}
			const ws = this.workspace.activeWorkspace();
			if (ws) await this.facade.loadWorkspaceData(ws.id);
		} catch (err) {
			console.error('setActive env failed:', err);
		}
	}

	protected async handleNewNameKeyDown(e: KeyboardEvent): Promise<void> {
		if (e.key === 'Enter') {
			e.preventDefault();
			await this.createEnv();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			this.creating.set(false);
		}
	}

	protected async createEnv(): Promise<void> {
		const input = this.newNameInput()?.nativeElement;
		const name = input?.value.trim() ?? '';
		if (!name) return;
		const folderId = this.createForFolderId();
		if (!folderId) return;
		try {
			const env = await rpc<Environment>({ kind: 'env:create', folderId, name });
			await rpc<{ envId: string }>({ kind: 'env:setActive', envId: env.id });
			this.creating.set(false);
			const ws = this.workspace.activeWorkspace();
			if (ws) await this.facade.loadWorkspaceData(ws.id);
		} catch (err) {
			console.error('env:create failed:', err);
			showToast(`Failed to create env: ${(err as Error).message}`, 'error');
		}
	}
}
