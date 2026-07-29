import { Injectable, computed, signal } from '@angular/core';
import type { Collection, Directory, Environment, Folder, RequestRow, Workspace } from './model';

/**
 * Source of truth for everything loaded out of the open workspace.
 *
 * Writes funnel through the explicit setters below rather than exposing the
 * writable signals, so the only code that can mutate workspace state is the
 * facade that owns loading it (see `workspace.facade.ts`).
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceStateService {
	private readonly _workspaces = signal<Workspace[]>([]);
	private readonly _activeWorkspace = signal<Workspace | null>(null);
	private readonly _directories = signal<Directory[]>([]);
	private readonly _collections = signal<Collection[]>([]);
	private readonly _folders = signal<Folder[]>([]);
	private readonly _requests = signal<RequestRow[]>([]);
	private readonly _environments = signal<Environment[]>([]);

	readonly workspaces = this._workspaces.asReadonly();
	readonly activeWorkspace = this._activeWorkspace.asReadonly();
	readonly directories = this._directories.asReadonly();
	readonly collections = this._collections.asReadonly();
	readonly folders = this._folders.asReadonly();
	readonly requests = this._requests.asReadonly();
	readonly environments = this._environments.asReadonly();

	readonly hasWorkspace = computed(() => this._activeWorkspace() !== null);

	setWorkspaces(value: Workspace[]): void {
		this._workspaces.set(value);
	}

	setActiveWorkspace(value: Workspace | null): void {
		this._activeWorkspace.set(value);
	}

	setDirectories(value: Directory[]): void {
		this._directories.set(value);
	}

	setCollections(value: Collection[]): void {
		this._collections.set(value);
	}

	setFolders(value: Folder[]): void {
		this._folders.set(value);
	}

	setRequests(value: RequestRow[]): void {
		this._requests.set(value);
	}

	setEnvironments(value: Environment[]): void {
		this._environments.set(value);
	}

	/** Clears everything workspace-scoped — used when closing a workspace. */
	clear(): void {
		this._activeWorkspace.set(null);
		this._directories.set([]);
		this._collections.set([]);
		this._folders.set([]);
		this._requests.set([]);
		this._environments.set([]);
	}
}
