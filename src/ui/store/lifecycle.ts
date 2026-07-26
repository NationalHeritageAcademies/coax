import { rpc } from '@ipc/renderer';
import {
  workspaces,
  activeWorkspace,
  directories,
  collections,
  folders,
  requests,
  environments,
  tabs,
} from './state.js';
import type {
  Workspace,
  Directory,
  Collection,
  Folder,
  RequestRow,
  Environment,
  OpenTab,
} from './model.js';

export async function bootstrapRenderer(): Promise<void> {
  // The main process auto-opens the most-recently-used workspace folder
  // during initHandlers() if one exists and is still on disk. We ask for
  // the currently-open workspace (if any), set it as active, and load
  // its data. If null → renderer shows the no-workspace-picked UI and
  // surfaces a "Pick a folder" button that dispatches workspace:pickFolder
  // + workspace:open.
  const current = await rpc<Workspace | null>({ kind: 'workspace:current' });
  // Recent workspaces (for any future "open recent" menu) — separate list.
  const recent = await rpc<{ path: string; name: string }[]>({ kind: 'workspace:list' });
  workspaces.set(
    recent.map((r) => ({ id: r.path, name: r.name, path: r.path })),
  );
  if (current !== null) {
    activeWorkspace.set(current);
    await loadWorkspaceData(current.id);
  }
}

/**
 * Show the OS folder picker and open the chosen folder as a workspace.
 * Re-runs the data load so the sidebar reflects whatever's in the new folder.
 */
export async function pickAndOpenWorkspace(): Promise<void> {
  const result = await rpc<{ canceled: true } | { canceled: false; folderPath: string }>(
    { kind: 'workspace:pickFolder' },
  );
  if (result.canceled) return;
  const opened = await rpc<Workspace>({
    kind: 'workspace:open',
    folderPath: result.folderPath,
  });
  activeWorkspace.set(opened);
  await loadWorkspaceData(opened.id);
}

/**
 * Close the current workspace. Clears the in-memory signals so the
 * sidebar returns to the empty / no-workspace-open state.
 */
export async function closeCurrentWorkspace(): Promise<void> {
  await rpc({ kind: 'workspace:close' });
  activeWorkspace.set(null);
  directories.set([]);
  collections.set([]);
  folders.set([]);
  requests.set([]);
  environments.set([]);
  tabs.set([]);
}

export async function loadWorkspaceData(workspaceId: string): Promise<void> {
  const [dirs, cols] = await Promise.all([
    rpc<Directory[]>({ kind: 'directory:list', workspaceId }),
    rpc<Collection[]>({ kind: 'collection:list', workspaceId }),
  ]);
  directories.set(dirs);
  collections.set(cols);

  const allFolders: Folder[] = [];
  const allRequests: RequestRow[] = [];
  for (const c of cols) {
    const [fs, rs] = await Promise.all([
      rpc<Folder[]>({ kind: 'folder:list', collectionId: c.id }),
      rpc<RequestRow[]>({ kind: 'request:list', collectionId: c.id }),
    ]);
    allFolders.push(...fs);
    allRequests.push(...rs);
  }
  folders.set(allFolders);
  requests.set(allRequests);

  // Envs come in two flavors post-006:
  //   - folder-scoped (inside a collection — inline @vars, attached to the
  //     collection's root folder or a deeper folder via @folder directives)
  //   - directory-scoped (workspace-level — adopted from .env.json files)
  // Fetch both sets and union them into the renderer's signal.
  const folderIdsForEnvs = [
    ...cols.map((c) => c.rootFolderId),
    ...allFolders.map((f) => f.id),
  ];
  const [folderEnvLists, dirEnvLists] = await Promise.all([
    Promise.all(folderIdsForEnvs.map((fid) => rpc<Environment[]>({ kind: 'env:list', folderId: fid }))),
    Promise.all(
      dirs.map((d) => rpc<Environment[]>({ kind: 'env:listByDirectory', directoryId: d.id })),
    ),
  ]);
  environments.set([...folderEnvLists.flat(), ...dirEnvLists.flat()]);

  const openTabs = await rpc<OpenTab[]>({ kind: 'tabs:list' });
  tabs.set(openTabs);
}
