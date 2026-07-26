// <hu-sidebar-tree>
//
// Hand-rolled hierarchical tree for the left sidebar. The framework's
// <ml-sidebar> gave us a generic list with text labels; the dev-tool
// aesthetic calls for color-coded HTTP method badges and tighter visual
// density, so we render the rows directly.
//
// Five store signals are held as instance fields so the framework
// auto-subscribes and re-renders when collections/folders/requests are
// loaded, or when the active tab changes (so the highlighted row tracks
// the open request). Expanded state is held in a local signal so toggling
// a folder triggers a re-render too — we replace the Set on each toggle
// rather than mutating, so the framework's signal equality check fires.

import { MelodicComponent, html, css, signal } from '@melodicdev/core';
import { directories, collections, folders, requests, activeTabId, tabs, activeWorkspace } from '../store/state.js';
import { loadWorkspaceData } from '../store/lifecycle.js';
import { rpc } from '@ipc/renderer';
import type { Directory, Collection, Folder, RequestRow, OpenTab } from '../store/model.js';
import { promptInline, confirmInline } from './prompt.js';
import { showToast } from './toast.js';

@MelodicComponent({
  selector: 'hu-sidebar-tree',
  template: (c: SidebarTreeComponent) => {
    const dirs = c.directories();
    const cols = c.collections();
    const allFolders = c.folders();
    const allRequests = c.requests();
    const expanded = c.expanded();
    const activeReqId = (() => {
      const tabId = c.activeTabId();
      if (!tabId) return null;
      const tab = c.tabs().find((t: OpenTab) => t.id === tabId);
      return tab?.requestId ?? null;
    })();

    if (cols.length === 0) {
      return html`
        <div class="empty">
          <div class="empty-title">No collections yet</div>
          <div class="empty-hint">
            Click <strong>Import</strong> to load a .http file or Swagger / OpenAPI spec
          </div>
        </div>
      `;
    }

    return html`
      <div
        class="tree"
        @click=${c.handleClick}
        @ml:select=${c.handleMenuSelect}
        @dragstart=${c.handleDragStart}
        @dragover=${c.handleDragOver}
        @dragleave=${c.handleDragLeave}
        @drop=${c.handleDrop}
      >
        <div class="group-header">
          <span>Collections</span>
          <ml-dropdown placement="bottom-end" class="group-add">
            <ml-button slot="trigger" variant="ghost" size="sm" title="Add collection">
              <ml-icon icon="plus" size="xs"></ml-icon>
            </ml-button>
            <ml-dropdown-item value="new-collection" icon="folder-plus"
              >New collection</ml-dropdown-item
            >
            <ml-dropdown-item value="new-folder-top" icon="folder-plus"
              >New folder</ml-dropdown-item
            >
            <ml-dropdown-item value="workspace-manage-envs" icon="gear"
              >Manage envs (workspace)…</ml-dropdown-item
            >
            <ml-dropdown-item value="import-http-top" icon="download-simple"
              >Import .http…</ml-dropdown-item
            >
            <ml-dropdown-item value="import-swagger-url" icon="globe"
              >Import Swagger from URL…</ml-dropdown-item
            >
            <ml-dropdown-item value="import-swagger-file" icon="file-arrow-down"
              >Import Swagger from file…</ml-dropdown-item
            >
          </ml-dropdown>
        </div>
        ${renderDirectoryChildren(
          null,
          dirs,
          cols,
          allFolders,
          allRequests,
          activeReqId,
          expanded,
          0,
        )}
      </div>
    `;
  },
  styles: () => css`
    :host {
      display: block;
      background: var(--hu-bg-elevated);
      border-right: 1px solid var(--hu-border);
      width: 100%;
      height: 100%;
      overflow-y: auto;
      padding: 8px 0 16px;
    }
    .empty {
      padding: 24px 16px;
      text-align: center;
      color: var(--hu-text-muted);
      font-size: 13px;
    }
    .empty-title {
      margin-bottom: 6px;
      font-weight: 500;
      color: var(--hu-text-secondary);
    }
    .empty-hint {
      font-size: 12px;
      line-height: 1.5;
    }
    .empty-hint strong {
      color: var(--hu-accent);
      font-weight: 500;
    }
    .group-header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 10px 8px 8px 14px;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.08em;
      color: var(--hu-text-muted);
      text-transform: uppercase;
    }
    .group-header span {
      flex: 1;
    }
    .group-add {
      opacity: 0.5;
      transition: opacity var(--hu-motion-fast) var(--hu-ease-out);
    }
    .group-header:hover .group-add,
    .group-add:hover {
      opacity: 1;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      color: var(--hu-text-secondary);
      background: transparent;
      border-left: 2px solid transparent;
      transition:
        background var(--hu-motion-fast) var(--hu-ease-out),
        color var(--hu-motion-fast) var(--hu-ease-out),
        border-left-color var(--hu-motion-fast) var(--hu-ease-out);
      user-select: none;
      position: relative;
    }
    .row[data-active='true'] {
      color: var(--hu-text-primary);
      background: var(--hu-accent-subtle);
      border-left-color: var(--hu-accent);
      font-weight: 500;
    }
    .row:hover {
      background: var(--hu-bg-hover);
      color: var(--hu-text-primary);
    }
    .row[data-active='true']:hover {
      background: var(--hu-accent-subtle);
      filter: brightness(0.98);
    }
    .row[data-drop-hover] {
      outline: 2px solid var(--hu-accent);
      outline-offset: -2px;
      background: color-mix(in srgb, var(--hu-accent) 12%, transparent);
    }
    /* Per-row action menu. Faded by default so it doesn't compete with
       the row content; full opacity on row hover or when the menu is open
       so it's still discoverable. Pinned to a constant x-position via the
       row's right padding so every kebab in the tree lines up vertically. */
    .row-menu {
      margin-left: auto;
      opacity: 0.5;
      transition: opacity 120ms ease;
      flex-shrink: 0;
    }
    .row:hover .row-menu,
    .row-menu:hover,
    .row-menu[open] {
      opacity: 1;
    }
    .chev {
      opacity: 0.7;
      display: inline-flex;
    }
    .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .label-bold {
      font-weight: 500;
    }
    .label-13 {
      font-size: 13px;
    }
    /* Right-align the digits in a fixed-width slot. Without this each count
       sits at its own width and the visual x-position drifts row to row
       (e.g. "2" vs "17"). With text-align:right and a min-width every count
       right edge falls on the same vertical line, and the kebab that follows
       ends up at the same offset on every row too. */
    .count {
      font-size: 11px;
      color: var(--hu-text-muted);
      min-width: 1.75rem;
      text-align: right;
      flex-shrink: 0;
    }
  `,
})
class SidebarTreeComponent {
  directories = directories;
  collections = collections;
  folders = folders;
  requests = requests;
  activeTabId = activeTabId;
  tabs = tabs;
  expanded = signal(new Set<string>());

  handleNewCollection = async (): Promise<void> => {
    const ws = activeWorkspace();
    if (!ws) {
      showToast('No active workspace', 'error');
      return;
    }
    const name = await promptInline('New collection name', 'Untitled');
    if (!name) return;
    try {
      await rpc({ kind: 'collection:create', workspaceId: ws.id, name });
      await this._refresh();
    } catch (err) {
      showToast(`Create collection failed: ${(err as Error).message}`, 'error');
    }
  };

  handleDragStart = (e: Event): void => {
    const ev = e as DragEvent;
    const target = ev.target as HTMLElement;
    if (!ev.dataTransfer) return;
    // Drag-source priority: collection → directory → folder → request. The
    // first matching ancestor of the drag-started element wins so nested rows
    // emit the correct dataTransfer MIME.
    const collectionRow = target.closest<HTMLElement>('[data-collection-id]');
    if (collectionRow) {
      const collectionId = collectionRow.dataset.collectionId;
      if (collectionId) {
        ev.dataTransfer.setData('application/x-hu-collection-id', collectionId);
        ev.dataTransfer.effectAllowed = 'move';
        return;
      }
    }
    const directoryRow = target.closest<HTMLElement>('[data-directory-id]');
    if (directoryRow) {
      const directoryId = directoryRow.dataset.directoryId;
      if (directoryId) {
        ev.dataTransfer.setData('application/x-hu-directory-id', directoryId);
        ev.dataTransfer.effectAllowed = 'move';
        return;
      }
    }
    const folderRow = target.closest<HTMLElement>('[data-folder-id]');
    if (folderRow) {
      const folderId = folderRow.dataset.folderId;
      if (folderId) {
        ev.dataTransfer.setData('application/x-hu-folder-id', folderId);
        ev.dataTransfer.effectAllowed = 'move';
        return;
      }
    }
    const requestRow = target.closest<HTMLElement>('[data-request-id]');
    if (!requestRow) return;
    const requestId = requestRow.dataset.requestId;
    if (!requestId) return;
    ev.dataTransfer.setData('application/x-hu-request-id', requestId);
    ev.dataTransfer.effectAllowed = 'move';
  };

  handleDragOver = (e: Event): void => {
    const ev = e as DragEvent;
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
    if (this._lastDropHover && this._lastDropHover !== row) {
      this._lastDropHover.removeAttribute('data-drop-hover');
    }
    row.setAttribute('data-drop-hover', '');
    this._lastDropHover = row;
  };

  handleDragLeave = (e: Event): void => {
    const ev = e as DragEvent;
    const row = (ev.target as HTMLElement).closest<HTMLElement>(
      '[data-drop-target-folder-id], [data-drop-target-collection-id], [data-drop-target-directory-id]',
    );
    const next = ev.relatedTarget as Node | null;
    if (row && (!next || !row.contains(next))) {
      row.removeAttribute('data-drop-hover');
      if (this._lastDropHover === row) this._lastDropHover = null;
    }
  };

  handleDrop = async (e: Event): Promise<void> => {
    const ev = e as DragEvent;
    ev.preventDefault();
    if (this._lastDropHover) {
      this._lastDropHover.removeAttribute('data-drop-hover');
      this._lastDropHover = null;
    }
    const target = ev.target as HTMLElement;
    const collectionId = ev.dataTransfer?.getData('application/x-hu-collection-id');
    if (collectionId) {
      // Collection drop — accept onto any collection row (becomes child),
      // or onto whitespace at the tree root (handled elsewhere later).
      const targetRow = target.closest<HTMLElement>('[data-drop-target-collection-id]');
      const newParentCollectionId = targetRow?.dataset.dropTargetCollectionId ?? null;
      if (!newParentCollectionId || newParentCollectionId === collectionId) return;
      try {
        await rpc({
          kind: 'collection:reparent',
          collectionId,
          newParentCollectionId,
        });
        await this._refresh();
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
        await rpc({
          kind: 'directory:reparent',
          id: directoryDragId,
          newParentDirectoryId,
        });
        await this._refresh();
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
        await this._refresh();
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
        await this._refresh();
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
        await this._refresh();
      } catch (err) {
        console.error('request:moveToDirectory failed:', err);
        showToast(`Move failed: ${(err as Error).message}`, 'error');
      }
    }
  };

  private _lastDropHover: HTMLElement | null = null;

  /**
   * Dispatched by every <ml-dropdown> in the tree on `ml:select`. The value
   * is `action:targetId`. Routes to the appropriate handler. Each handler
   * dispatches its own IPC call and refreshes the workspace.
   */
  handleMenuSelect = async (e: Event): Promise<void> => {
    const ev = e as CustomEvent<{ value: string }>;
    const value = ev.detail?.value;
    if (!value) return;
    // Some top-level actions (header dropdown) have no target id — split on
    // the first `:` if present; otherwise treat the whole value as the action.
    const idx = value.indexOf(':');
    const action = idx < 0 ? value : value.slice(0, idx);
    const id = idx < 0 ? '' : value.slice(idx + 1);
    try {
      switch (action) {
        case 'new-collection':
          await this.handleNewCollection();
          break;
        case 'new-folder-top':
          await this._newSubdirectoryTopLevel();
          break;
        case 'workspace-manage-envs': {
          // Open the env manager scoped to the workspace's implicit root
          // directory so it expands the Workspace section. The root is the
          // synthetic directory whose parentDirectoryId is undefined.
          const root = directories().find((d) => d.parentDirectoryId === undefined);
          if (!root) {
            showToast('No active workspace', 'error');
            break;
          }
          document.dispatchEvent(
            new CustomEvent('hu:open-env-manager', { detail: { directoryId: root.id } }),
          );
          break;
        }
        case 'directory-new-collection':
          await this._newCollectionInDirectory(id);
          break;
        case 'directory-new-subdirectory':
          await this._newSubdirectory(id);
          break;
        case 'directory-import-http':
          await this._importHttpIntoDirectory(id);
          break;
        case 'directory-manage-envs':
          document.dispatchEvent(
            new CustomEvent('hu:open-env-manager', { detail: { directoryId: id } }),
          );
          break;
        case 'directory-export':
          await this._exportNode('directory', id);
          break;
        case 'directory-rename':
          await this._renameDirectory(id);
          break;
        case 'directory-delete':
          await this._deleteDirectory(id);
          break;
        case 'import-http-top':
          await this._importHttpTopLevel();
          break;
        case 'import-swagger-url':
          await this._importSwaggerFromUrl();
          break;
        case 'import-swagger-file':
          await this._importSwaggerFromFile();
          break;
        case 'collection-new-request':
          await this._newRequestInCollection(id);
          break;
        case 'collection-import-http':
          await this._importHttpInto(id);
          break;
        case 'collection-manage-envs': {
          // Open env-manager focused on this collection's root folder.
          const col = collections().find((c) => c.id === id);
          if (col) {
            document.dispatchEvent(
              new CustomEvent('hu:open-env-manager', {
                detail: { folderId: col.rootFolderId },
              }),
            );
          }
          break;
        }
        case 'collection-rename':
          await this._renameCollection(id);
          break;
        case 'collection-delete':
          await this._deleteCollection(id);
          break;
        case 'collection-export':
          await this._exportNode('collection', id);
          break;
        case 'request-open':
          await this._openRequest(id);
          break;
        case 'request-rename':
          await this._renameRequest(id);
          break;
        case 'request-duplicate':
          await rpc({ kind: 'request:duplicate', requestId: id });
          await this._refresh();
          break;
        case 'request-export':
          await this._exportNode('request', id);
          break;
        case 'request-delete':
          await this._deleteRequest(id);
          break;
      }
    } catch (err) {
      console.error(`menu action ${action} failed:`, err);
      showToast(`Action failed: ${(err as Error).message}`, 'error');
    }
  };

  private async _refresh(): Promise<void> {
    const ws = activeWorkspace();
    if (ws) await loadWorkspaceData(ws.id);
  }

  private async _newRequestInCollection(collectionId: string): Promise<void> {
    const col = collections().find((c) => c.id === collectionId);
    if (!col) return;
    const name = await promptInline('New request name', 'Untitled');
    if (!name) return;
    // "Loose at collection root" means folder_id NULL — matches how
    // http:import creates requests with no section divider, and matches the
    // looseRequests filter in renderCollection.
    await rpc({
      kind: 'request:create',
      parent: { collectionId },
      draft: { name, method: 'GET', url: 'https://', headers: [] },
    });
    await this._refresh();
  }

  private async _newCollectionInDirectory(directoryId: string): Promise<void> {
    const ws = activeWorkspace();
    if (!ws) return;
    const name = await promptInline('New collection name', 'Untitled');
    if (!name) return;
    await rpc({ kind: 'collection:create', workspaceId: ws.id, name, directoryId });
    await this._refresh();
  }

  private async _newSubdirectory(parentDirectoryId: string): Promise<void> {
    const ws = activeWorkspace();
    if (!ws) return;
    const name = await promptInline('New folder name', 'new-folder');
    if (!name) return;
    try {
      await rpc({ kind: 'directory:create', workspaceId: ws.id, name, parentDirectoryId });
      await this._refresh();
    } catch (err) {
      showToast(`Create folder failed: ${(err as Error).message}`, 'error');
    }
  }

  // Create a folder at the workspace root. Resolves the root-directory id
  // (the synthetic directory with parentDirectoryId === undefined) and
  // delegates to the shared subdirectory creator.
  private async _newSubdirectoryTopLevel(): Promise<void> {
    const root = directories().find((d) => d.parentDirectoryId === undefined);
    if (!root) {
      showToast('No workspace open.', 'error');
      return;
    }
    await this._newSubdirectory(root.id);
  }

  private async _importHttpIntoDirectory(directoryId: string): Promise<void> {
    const dialogResult = await rpc<{ path: string | null }>({ kind: 'dialog:openHttp' });
    if (!dialogResult.path) return;
    await rpc<{ collectionId: string }>({
      kind: 'http:import',
      path: dialogResult.path,
      directoryId,
    });
    await this._refresh();
  }

  private async _renameDirectory(directoryId: string): Promise<void> {
    const dir = directories().find((d) => d.id === directoryId);
    if (!dir) return;
    const name = await promptInline('Rename folder', dir.name, dir.name);
    if (!name || name === dir.name) return;
    try {
      await rpc({ kind: 'directory:rename', id: directoryId, name });
      await this._refresh();
    } catch (err) {
      showToast(`Rename folder failed: ${(err as Error).message}`, 'error');
    }
  }

  private async _deleteDirectory(directoryId: string): Promise<void> {
    const dir = directories().find((d) => d.id === directoryId);
    if (!dir) return;
    const ok = await confirmInline(
      `Delete folder "${dir.name}" and everything inside it? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await rpc({ kind: 'directory:delete', id: directoryId });
      await this._refresh();
    } catch (err) {
      showToast(`Delete folder failed: ${(err as Error).message}`, 'error');
    }
  }

  private async _renameCollection(collectionId: string): Promise<void> {
    const col = collections().find((c) => c.id === collectionId);
    if (!col) return;
    const name = await promptInline('Rename collection', col.name, col.name);
    if (!name || name === col.name) return;
    await rpc({ kind: 'collection:rename', id: collectionId, name });
    await this._refresh();
  }

  private async _deleteCollection(collectionId: string): Promise<void> {
    const col = collections().find((c) => c.id === collectionId);
    if (!col) return;
    const ok = await confirmInline(
      `Delete collection "${col.name}" and everything in it? This cannot be undone.`,
    );
    if (!ok) return;
    await rpc({ kind: 'collection:delete', id: collectionId });
    await this._refresh();
  }

  private async _importHttpInto(parentCollectionId: string): Promise<void> {
    const dialogResult = await rpc<{ path: string | null }>({ kind: 'dialog:openHttp' });
    if (!dialogResult.path) return;
    await rpc<{ collectionId: string }>({
      kind: 'http:import',
      path: dialogResult.path,
      parentCollectionId,
    });
    await this._refresh();
  }

  private async _importHttpTopLevel(): Promise<void> {
    const dialogResult = await rpc<{ path: string | null }>({ kind: 'dialog:openHttp' });
    if (!dialogResult.path) return;
    await rpc<{ collectionId: string }>({
      kind: 'http:import',
      path: dialogResult.path,
    });
    await this._refresh();
  }

  private async _importSwaggerFromUrl(): Promise<void> {
    const url = await promptInline(
      'Swagger / OpenAPI URL',
      '',
      'https://example.com/swagger/v1/swagger.json',
    );
    if (!url) return;
    try {
      const r = await rpc<{ stats: { operations: number; tags: number } }>({
        kind: 'swagger:import',
        source: { kind: 'url', url },
      });
      showToast(
        `Imported ${r.stats.operations} operations across ${r.stats.tags} tag${r.stats.tags === 1 ? '' : 's'}`,
        'success',
      );
      await this._refresh();
    } catch (err) {
      showToast(`Swagger import failed: ${(err as Error).message}`, 'error');
    }
  }

  private async _importSwaggerFromFile(): Promise<void> {
    const dialogResult = await rpc<{ path: string | null }>({ kind: 'dialog:openSwagger' });
    if (!dialogResult.path) return;
    try {
      const r = await rpc<{ stats: { operations: number; tags: number } }>({
        kind: 'swagger:import',
        source: { kind: 'file', path: dialogResult.path },
      });
      showToast(
        `Imported ${r.stats.operations} operations across ${r.stats.tags} tag${r.stats.tags === 1 ? '' : 's'}`,
        'success',
      );
      await this._refresh();
    } catch (err) {
      showToast(`Swagger import failed: ${(err as Error).message}`, 'error');
    }
  }

  private async _renameRequest(requestId: string): Promise<void> {
    const req = requests().find((r) => r.id === requestId);
    if (!req) return;
    const name = await promptInline('Rename request', req.name, req.name);
    if (!name || name === req.name) return;
    await rpc({ kind: 'request:rename', requestId, name });
    await this._refresh();
  }

  private async _deleteRequest(requestId: string): Promise<void> {
    const req = requests().find((r) => r.id === requestId);
    if (!req) return;
    const ok = await confirmInline(`Delete request "${req.name}"? This cannot be undone.`);
    if (!ok) return;
    await rpc({ kind: 'request:delete', requestId });
    await this._refresh();
  }

  private async _openRequest(requestId: string): Promise<void> {
    const tab = await rpc<OpenTab>({ kind: 'tabs:open', requestId });
    const list = tabs();
    if (!list.find((t) => t.id === tab.id)) tabs.set([...list, tab]);
    activeTabId.set(tab.id);
  }

  private async _exportNode(
    nodeKind: 'request' | 'collection' | 'directory',
    nodeId: string,
  ): Promise<void> {
    let defaultName = 'export.http';
    if (nodeKind === 'directory') {
      const d = directories().find((x) => x.id === nodeId);
      if (d) defaultName = `${d.name || 'workspace'}.http`;
    } else if (nodeKind === 'request') {
      const r = requests().find((x) => x.id === nodeId);
      if (r) defaultName = `${r.name || 'request'}.http`;
    } else {
      const c = collections().find((x) => x.id === nodeId);
      if (c) defaultName = `${c.name}.http`;
    }
    const result = await rpc<{ path: string | null }>({
      kind: 'dialog:saveHttp',
      defaultName,
    });
    if (!result.path) return;
    await rpc({ kind: 'tree:export', nodeKind, nodeId, targetPath: result.path });
    const exportedPath = result.path;
    // navigator.userAgent is the DOM-native way to sniff the host OS from
    // the renderer (process.platform is only reliable in main / preload).
    const ua = navigator.userAgent;
    const revealLabel = ua.includes('Mac')
      ? 'Reveal in Finder'
      : ua.includes('Win')
        ? 'Reveal in Explorer'
        : 'Reveal in file manager';
    showToast(`Exported to ${exportedPath}`, 'success', {
      durationMs: 7000,
      actionLabel: revealLabel,
      onClick: () => {
        void rpc({ kind: 'shell:revealInFolder', path: exportedPath });
      },
    });
  }

  handleClick = async (e: Event): Promise<void> => {
    const target = e.target as HTMLElement;
    // Request rows take precedence — closest() returns the nearest match, so
    // clicking a request inside an expanded collection opens the request
    // rather than collapsing its parent.
    const reqRow = target.closest<HTMLElement>('[data-request-id]');
    if (reqRow) {
      const requestId = reqRow.dataset.requestId!;
      try {
        const tab = await rpc<OpenTab>({ kind: 'tabs:open', requestId });
        const list = tabs();
        if (!list.find((t) => t.id === tab.id)) tabs.set([...list, tab]);
        activeTabId.set(tab.id);
      } catch (err) {
        console.error('open tab failed:', err);
      }
      return;
    }
    const toggle = target.closest<HTMLElement>('[data-toggle]');
    if (toggle) {
      const key = toggle.dataset.toggle!;
      const next = new Set(this.expanded());
      if (next.has(key)) next.delete(key);
      else next.add(key);
      this.expanded.set(next);
    }
  };
}

/**
 * Render the children of a workspace directory: nested directories first
 * (alphabetical via sortOrder), then collections that live directly in
 * this directory. The workspace root is passed as `parentDirectoryId = null`;
 * `null` matches the implicit anonymous root directory (parentDirectoryId
 * undefined). Each nested directory recurses through this same helper.
 */
function renderDirectoryChildren(
  parentDirectoryId: string | null,
  allDirectories: Directory[],
  allCollections: Collection[],
  allFolders: Folder[],
  allRequests: RequestRow[],
  activeReqId: string | null,
  expanded: Set<string>,
  depth: number,
): ReturnType<typeof html>[] {
  // If we're at the workspace root, "this" directory is the row with
  // `parentDirectoryId === undefined`. Otherwise we're rendering the
  // children of a specific named directory and only want directories that
  // point at it.
  const here =
    parentDirectoryId === null
      ? allDirectories.find((d) => d.parentDirectoryId === undefined)
      : allDirectories.find((d) => d.id === parentDirectoryId);
  if (!here) {
    // No workspace root yet (fresh empty workspace) — render flat by
    // directoryId so the user still sees their collections.
    return allCollections.map((col) =>
      renderCollection(col, allCollections, allFolders, allRequests, activeReqId, expanded, depth),
    );
  }
  // Three-tier sort, each tier alphabetical within itself:
  //   1. Directories (real on-disk subfolders)
  //   2. Multi-request collections (.http files that render as folders)
  //   3. Single-request collections (.http files that collapse to the
  //      request row in the sidebar)
  // This puts the "containers" together at the top, with leaf-like
  // single requests last — easier to scan and matches the user's mental
  // hierarchy (most-grouping → least-grouping).
  const byName = <T extends { sortOrder: number; name: string }>(a: T, b: T): number =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

  const childDirs = allDirectories
    .filter((d) => d.parentDirectoryId === here.id)
    .sort(byName);
  const allDirCollections = allCollections.filter((c) => c.directoryId === here.id);
  const requestCount = (collectionId: string): number =>
    allRequests.filter((r) => r.collectionId === collectionId).length;
  const multiReqCollections = allDirCollections
    .filter((c) => requestCount(c.id) !== 1)
    .sort(byName);
  const singleReqCollections = allDirCollections
    .filter((c) => requestCount(c.id) === 1)
    .sort(byName);

  return [
    ...childDirs.map((d) =>
      renderDirectory(d, allDirectories, allCollections, allFolders, allRequests, activeReqId, expanded, depth),
    ),
    ...multiReqCollections.map((c) =>
      renderCollection(c, allCollections, allFolders, allRequests, activeReqId, expanded, depth),
    ),
    ...singleReqCollections.map((c) =>
      renderCollection(c, allCollections, allFolders, allRequests, activeReqId, expanded, depth),
    ),
  ];
}

/**
 * Render a directory (a real subdirectory on disk) as a tree node. Its
 * row mirrors a collection row visually — folder icon + name + count —
 * but its children are nested directories and collections, not folders +
 * requests. Expanded state is keyed `d:<id>` to avoid collisions with the
 * collection `c:<id>` keys.
 */
function renderDirectory(
  d: Directory,
  allDirectories: Directory[],
  allCollections: Collection[],
  allFolders: Folder[],
  allRequests: RequestRow[],
  activeReqId: string | null,
  expanded: Set<string>,
  depth: number,
): ReturnType<typeof html> {
  const key = `d:${d.id}`;
  const isOpen = expanded.has(key);
  const childDirCount = allDirectories.filter((x) => x.parentDirectoryId === d.id).length;
  const childCollCount = allCollections.filter((c) => c.directoryId === d.id).length;
  const total = childDirCount + childCollCount;
  return html`
    <div class="collection">
      <div
        class="row"
        data-toggle=${key}
        data-directory-id=${d.id}
        data-drop-target-directory-id=${d.id}
        draggable="true"
        style=${rowPadding(depth)}
      >
        <span class="chev">${chevron(isOpen)}</span>
        ${folderIcon()}
        <span class="label label-bold">${d.name}</span>
        <span class="count">${total}</span>
        ${rowMenu([
          { value: `directory-new-collection:${d.id}`, label: 'New collection', icon: 'plus' },
          { value: `directory-new-subdirectory:${d.id}`, label: 'New folder', icon: 'folder-plus' },
          { value: `directory-import-http:${d.id}`, label: 'Import .http here…', icon: 'download-simple' },
          { value: `directory-manage-envs:${d.id}`, label: 'Manage envs…', icon: 'gear' },
          { separator: true },
          { value: `directory-export:${d.id}`, label: 'Export subtree…', icon: 'upload-simple' },
          { value: `directory-rename:${d.id}`, label: 'Rename', icon: 'pencil-simple' },
          { separator: true },
          { value: `directory-delete:${d.id}`, label: 'Delete', icon: 'trash', destructive: true },
        ])}
      </div>
      ${
        isOpen
          ? html`
              <div>
                ${renderDirectoryChildren(
                  d.id,
                  allDirectories,
                  allCollections,
                  allFolders,
                  allRequests,
                  activeReqId,
                  expanded,
                  depth + 1,
                )}
              </div>
            `
          : ''
      }
    </div>
  `;
}


function renderCollection(
  c: Collection,
  allCollections: Collection[],
  allFolders: Folder[],
  allRequests: RequestRow[],
  activeReqId: string | null,
  expanded: Set<string>,
  depth: number,
): ReturnType<typeof html> {
  const isOpen = expanded.has(`c:${c.id}`);
  // Under the directories model a collection is a flat list of requests.
  // Internal folders no longer exist as a renderable concept.
  const collectionRequests = allRequests.filter((r) => r.collectionId === c.id);

  // Single-request collections render as the request itself. The .http
  // file is just a wrapper around one request; an extra "folder" row to
  // expand for a single child is noise.
  if (collectionRequests.length === 1) {
    return renderRequest(collectionRequests[0]!, depth, activeReqId, c.rootFolderId);
  }

  return html`
    <div class="collection">
      <div
        class="row"
        data-toggle=${`c:${c.id}`}
        data-collection-id=${c.id}
        data-drop-target-folder-id=${c.rootFolderId}
        data-drop-target-collection-id=${c.id}
        draggable="true"
        style=${rowPadding(depth)}
      >
        <span class="chev">${chevron(isOpen)}</span>
        ${collectionIcon()}
        <span class="label label-bold">${c.name}</span>
        <span class="count">${collectionRequests.length}</span>
        ${rowMenu([
          { value: `collection-new-request:${c.id}`, label: 'New request', icon: 'plus' },
          { value: `collection-import-http:${c.id}`, label: 'Import .http here…', icon: 'download-simple' },
          { value: `collection-manage-envs:${c.id}`, label: 'Manage envs…', icon: 'gear' },
          { separator: true },
          { value: `collection-rename:${c.id}`, label: 'Rename', icon: 'pencil-simple' },
          { value: `collection-export:${c.id}`, label: 'Export…', icon: 'upload-simple' },
          { separator: true },
          { value: `collection-delete:${c.id}`, label: 'Delete', icon: 'trash', destructive: true },
        ])}
      </div>
      ${
        isOpen
          ? html`
              <div>
                ${collectionRequests.map((r) => renderRequest(r, depth + 1, activeReqId, c.rootFolderId))}
              </div>
            `
          : ''
      }
    </div>
  `;
}
// allCollections / allFolders kept in the signature for backward compat
// with renderDirectoryChildren callers; unused inside this function now.

function renderRequest(
  r: RequestRow,
  depth: number,
  activeReqId: string | null,
  hostRootFolderId: string,
) {
  const isActive = r.id === activeReqId;
  const label = r.name || r.url;
  return html`
    <div
      class="row"
      data-request-id=${r.id}
      data-active=${String(isActive)}
      data-drop-target-folder-id=${hostRootFolderId}
      draggable="true"
      style=${rowPadding(depth)}
      title=${label}
    >
      <hu-method-badge method=${r.method}></hu-method-badge>
      <span class="label label-13">${label}</span>
      ${rowMenu([
        { value: `request-open:${r.id}`, label: 'Open', icon: 'arrow-square-out' },
        { value: `request-rename:${r.id}`, label: 'Rename', icon: 'pencil-simple' },
        { value: `request-duplicate:${r.id}`, label: 'Duplicate', icon: 'copy' },
        { value: `request-export:${r.id}`, label: 'Export…', icon: 'upload-simple' },
        { separator: true },
        { value: `request-delete:${r.id}`, label: 'Delete', icon: 'trash', destructive: true },
      ])}
    </div>
  `;
}

interface MenuItem {
  value?: string;
  label?: string;
  icon?: string;
  destructive?: boolean;
  separator?: boolean;
}

/**
 * Renders the row's hover-revealed kebab menu. The dropdown's ml:select
 * event bubbles up to the tree-wrapper handler in SidebarTreeComponent,
 * where the `value` string is parsed as `action:targetId` and routed.
 */
function rowMenu(items: MenuItem[]) {
  return html`
    <ml-dropdown placement="bottom-end" class="row-menu" @click=${stopRowClick}>
      <ml-button slot="trigger" variant="ghost" size="sm" title="Actions">
        <ml-icon icon="dots-three-vertical" size="xs"></ml-icon>
      </ml-button>
      ${items.map((it) =>
        it.separator
          ? html`<ml-dropdown-separator></ml-dropdown-separator>`
          : html`<ml-dropdown-item
              value=${it.value!}
              icon=${it.icon ?? ''}
              ?destructive=${it.destructive ?? false}
              >${it.label}</ml-dropdown-item
            >`,
      )}
    </ml-dropdown>
  `;
}

/**
 * Prevents the row's underlying click handler (which would expand/toggle the
 * row, open a request tab, etc.) from firing when the user just opened the
 * action menu. The dropdown's ml:select still bubbles to the wrapper.
 */
function stopRowClick(e: Event): void {
  e.stopPropagation();
}

function rowPadding(depth: number): string {
  // Only the left padding scales with depth — keep the right padding fixed
  // so kebab menus and counts line up at the same x across every row.
  return `padding: 6px 8px 6px ${14 + depth * 12}px`;
}

function chevron(open: boolean) {
  return html`<ml-icon icon=${open ? 'caret-down' : 'caret-right'} size="xs"></ml-icon>`;
}

function folderIcon() {
  return html`<ml-icon icon="folder" size="md"></ml-icon>`;
}

/**
 * Distinct from folderIcon so directories (real on-disk folders) and
 * collections (.http files holding multiple requests) read differently
 * in the sidebar. Both render as "openable" things, but a collection is
 * a list of requests in one file, not a container of files.
 */
function collectionIcon() {
  return html`<ml-icon icon="cards-three" size="md"></ml-icon>`;
}

export { SidebarTreeComponent };
