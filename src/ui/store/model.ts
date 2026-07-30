// Mirror what the IPC layer returns. Keep these minimal — UI-shape data only.

export interface Workspace {
	id: string;
	name: string;
	path: string;
}

/**
 * A directory node in the workspace tree. The workspace root is the
 * implicit anonymous node with `name === ''` and no parent; every other
 * directory corresponds to an actual subdirectory on disk.
 */
export interface Directory {
	id: string;
	workspaceId: string;
	name: string;
	parentDirectoryId?: string;
	sortOrder: number;
}

export interface Collection {
	id: string;
	workspaceId: string;
	name: string;
	/** The directory this collection's .http file lives in. */
	directoryId: string;
	/** @deprecated retained as optional for older callers; always undefined under directories model. */
	parentCollectionId?: string;
	sortOrder: number;
	/** Folder id of the collection's implicit root folder. */
	rootFolderId: string;
}

export interface Folder {
	id: string;
	collectionId: string;
	name: string;
	parentFolderId?: string;
	sortOrder: number;
}

export interface RequestRow {
	id: string;
	collectionId: string;
	folderId?: string;
	name: string;
	method: string;
	url: string;
	headers: { key: string; value: string }[];
	bodyText: string;
	bodyKind: string;
	auth: { kind: string; data?: Record<string, string> };
	sortOrder: number;
}

export interface Environment {
	id: string;
	/** Set when this env attaches to a folder inside a collection (inline @vars). */
	folderId?: string;
	/** Set when this env attaches to a workspace directory (.env.json file). */
	directoryId?: string;
	name: string;
	isActive: boolean;
}

export interface OpenTab {
	id: string;
	requestId: string;
	sortOrder: number;
	isPinned: boolean;
	isDirty: boolean;
	draft?: Record<string, unknown>;
}

export type ThemeMode = 'light' | 'dark' | 'system';
