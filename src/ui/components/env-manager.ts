// <hu-env-manager>
//
// Wraps an <ml-dialog> as the modal shell — native <dialog> in the
// browser's top layer, so we sidestep stacking-context concerns. The
// dialog's content is a two-pane grid: left aside lists envs per scope,
// right section shows the selected env's detail (name, scope,
// activate/delete actions, vars table with inline edit-on-blur, an "add
// variable" inline form, and a "mark secret" password-swap flow).
//
// Open via the document-level `hu:open-env-manager` event dispatched from
// app-frame's gear button. ml-dialog handles Escape and backdrop-click
// closing on its own.

import { MelodicComponent, html, css, signal } from '@melodicdev/core';
import type { Signal } from '@melodicdev/core/signals';
import type { IElementRef, OnCreate, OnDestroy } from '@melodicdev/core/components';
import { rpc } from '@ipc/renderer';
import { collections, directories, environments, folders, requests, activeWorkspace } from '../store/state.js';
import { loadWorkspaceData } from '../store/lifecycle.js';
import { showToast } from './toast.js';
import { promptInline } from './prompt.js';
import type { Collection, Directory, Environment, Folder, RequestRow } from '../store/model.js';

interface VarRow {
  id: string;
  key: string;
  valuePlain?: string;
  isSecret: boolean;
}

// ml-dialog's wrapper element exposes its inner user-component via a
// `.component` getter (defined by ComponentBase). The DialogComponent's
// `open()` / `close()` methods live there. Framework filter strips
// instance methods from the host wrapper, so we go through `.component`.
type DialogElement = HTMLElement & { component: { open(): void; close(): void } };

@MelodicComponent({
  selector: 'hu-env-manager',
  template: (c: EnvManagerComponent) => {
    const cols = c.collections();
    const allFolders = c.folders();
    const envs = c.environments();

    const selectedId = c.selectedEnvId();
    const selected = selectedId ? (envs.find((e) => e.id === selectedId) ?? null) : null;
    // Stale selection (e.g. the env was deleted) — clear it on the next tick.
    if (selectedId && !selected) {
      queueMicrotask(() => { c.selectedEnvId.set(null); });
    }
    // Kick off a var-list fetch on first render after selection changes.
    if (selectedId && c.envVars() === null && !c.envVarsLoading) {
      void c.loadVars(selectedId);
    }

    const allDirs = c.directories();
    const allReqs = c.requests();
    const root = allDirs.find((d) => d.parentDirectoryId === undefined);
    return html`
      <ml-dialog style="--ml-dialog-max-width: 1100px;">
        <div slot="dialog-header" class="dialog-header-row">
          <strong>Environments</strong>
          <ml-button variant="ghost" size="sm" title="Close (Esc)" @ml:click=${c.close}>
            <ml-icon icon="x" size="sm"></ml-icon>
          </ml-button>
        </div>

        <div class="modal-grid">
          <aside class="env-list">
            ${root
              ? renderDirectorySubtree(c, root, allDirs, cols, allFolders, allReqs, envs, selectedId, 0)
              : ''}
          </aside>

          <section class="env-detail">
            ${selected ? renderEnvDetail(c, selected, allFolders) : renderEmptyDetail()}
          </section>
        </div>
      </ml-dialog>
    `;
  },
  styles: () => css`
    :host {
      display: contents;
    }
    .dialog-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      font-size: 14px;
    }
    .modal-grid {
      display: grid;
      grid-template-columns: 260px 1fr;
      width: 100%;
      height: 100%;
      min-height: 480px;
      overflow: hidden;
    }
    .env-list {
      border-right: 1px solid var(--hu-border);
      overflow-y: auto;
      padding: 8px 0;
    }
    .env-detail {
      overflow-y: auto;
      padding: 16px 20px;
    }
    .section-head {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 14px 6px 0;
      color: var(--hu-text-muted);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: default;
    }
    .section-head .chev-btn {
      flex-shrink: 0;
    }
    .section-head-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .no-envs {
      padding: 4px 14px;
      color: var(--hu-text-muted);
      font-size: 12px;
      font-style: italic;
    }
    .env-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      cursor: pointer;
      color: var(--hu-text-secondary);
      background: transparent;
      border-left: 2px solid transparent;
    }
    .env-row[data-selected='true'] {
      color: var(--hu-text-primary);
      background: var(--hu-bg-active);
      border-left-color: var(--hu-accent);
    }
    .active-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--hu-accent);
      border: 1px solid var(--hu-accent);
      flex-shrink: 0;
    }
    .active-dot[data-active='false'] {
      background: transparent;
      border-color: var(--hu-border-strong);
    }
    .env-row-name {
      flex: 1;
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .empty-detail {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--hu-text-muted);
      text-align: center;
      gap: 12px;
    }
    .empty-detail strong {
      color: var(--hu-accent);
    }
    .detail-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 4px;
    }
    .detail-name {
      font-size: 16px;
    }
    .active-pill {
      background: var(--hu-accent);
      color: white;
      padding: 2px 8px;
      border-radius: var(--hu-radius-sm);
      font-size: 11px;
      font-weight: 600;
    }
    .detail-actions {
      margin-left: auto;
    }
    .scope-label {
      color: var(--hu-text-muted);
      font-size: 12px;
      margin-bottom: 16px;
    }
    .vars-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .vars-table thead tr {
      border-bottom: 1px solid var(--hu-border);
    }
    .vars-table thead th {
      text-align: left;
      color: var(--hu-text-muted);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 8px;
    }
    .vars-table tbody tr {
      border-bottom: 1px solid var(--hu-border);
    }
    .vars-table td {
      padding: 6px 8px;
    }
    .key-cell {
      font-family: var(--hu-font-mono);
      color: var(--hu-text-primary);
      width: 35%;
    }
    .secret-label {
      color: var(--hu-text-muted);
      font-style: italic;
    }
    .var-actions {
      width: 100px;
      display: flex;
      gap: 4px;
      align-items: center;
      justify-content: flex-end;
    }
    .secret-row {
      background: var(--hu-bg-hover);
    }
    .secret-row-inner {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .secret-row-label {
      color: var(--hu-text-secondary);
      font-size: 12px;
    }
    .loading {
      color: var(--hu-text-muted);
      font-size: 13px;
    }
  `,
})
class EnvManagerComponent implements IElementRef, OnCreate, OnDestroy {
  elementRef!: HTMLElement;
  directories = directories;
  collections = collections;
  environments = environments;
  folders = folders;
  requests = requests;

  selectedEnvId = signal<string | null>(null);
  // When opened from a context-menu on a specific collection or folder, only
  // that subtree is rendered in the left aside (so the user isn't distracted
  // by every top-level collection in the workspace). null = show everything,
  // which is the right default if the dialog is ever opened without a
  // specific scope (e.g. a future top-level "Envs" entry).
  scopeCollectionId = signal<string | null>(null);
  // Folder ids whose subtree is collapsed in the env-manager left aside.
  // Default: all expanded — replace the set with a copy on toggle so the
  // signal fires.
  collapsedFolders = signal(new Set<string>());
  envVars: Signal<VarRow[] | null> = signal<VarRow[] | null>(null);
  addingVar = signal(false);
  settingSecretForVarId = signal<string | null>(null);

  // Plain field — read inside the template guard but not mutated through
  // the framework's reactive setter (avoids a feedback loop when loadVars
  // flips it).
  envVarsLoading = false;

  // One-shot focus flag: set when entering add-var or set-secret mode so the
  // next onRender focuses the newly-rendered input.
  private _focusAfterRender: 'new-key' | 'secret-input' | null = null;

  onCreate(): void {
    // Listen for the document-level open event dispatched by app-frame's
    // gear button. Document-level eventing avoids the timing fragility of
    // attaching a method to the host element after createElement.
    document.addEventListener('hu:open-env-manager', this._handleOpenEvent);
    this.elementRef.addEventListener('focusout', this._handleBlur, true);
    this.elementRef.addEventListener('ml:change', this._handleBlur);
    // ml-dialog dispatches the native <dialog> 'close' event when the user
    // hits Escape or clicks the backdrop. Reset transient state then.
    this.elementRef.addEventListener('close', this._handleDialogClose, true);
  }

  onDestroy(): void {
    document.removeEventListener('hu:open-env-manager', this._handleOpenEvent);
    this.elementRef.removeEventListener('focusout', this._handleBlur, true);
    this.elementRef.removeEventListener('ml:change', this._handleBlur);
    this.elementRef.removeEventListener('close', this._handleDialogClose, true);
  }

  onRender(): void {
    if (!this._focusAfterRender) return;
    const sel = this._focusAfterRender === 'new-key' ? '.new-key' : '.secret-input';
    this._focusAfterRender = null;
    const root = this.elementRef.shadowRoot;
    if (!root) return;
    focusMlInput(root.querySelector(sel));
  }

  private _dialog(): DialogElement['component'] | null {
    const el = this.elementRef.shadowRoot?.querySelector('ml-dialog') as DialogElement | null;
    return el?.component ?? null;
  }

  private _handleOpenEvent = (e: Event): void => {
    // Default the tree to fully collapsed each time the dialog opens, then
    // expand the ancestry of whatever scope the caller focused (folder or
    // directory) so the targeted node is visible.
    const allCollapseKeys = [
      ...folders().map((f) => f.id),
      ...directories().map((d) => `dir:${d.id}`),
    ];
    const collapsed = new Set(allCollapseKeys);
    const detail = (e as CustomEvent<{ folderId?: string; directoryId?: string }>).detail;
    const folderId = detail?.folderId;
    const directoryId = detail?.directoryId;

    if (folderId) {
      const byId = new Map(folders().map((f) => [f.id, f]));
      let cur: string | undefined = folderId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        collapsed.delete(cur);
        cur = byId.get(cur)?.parentFolderId;
      }
    } else if (directoryId) {
      const byId = new Map(directories().map((d) => [d.id, d]));
      let cur: string | undefined = directoryId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        collapsed.delete(`dir:${cur}`);
        cur = byId.get(cur)?.parentDirectoryId;
      }
    }
    this.collapsedFolders.set(collapsed);

    if (folderId) {
      const firstEnv = environments().find((env) => env.folderId === folderId);
      this.selectedEnvId.set(firstEnv ? firstEnv.id : null);
      if (firstEnv) this.envVars.set(null);
    } else if (directoryId) {
      const firstEnv = environments().find((env) => env.directoryId === directoryId);
      this.selectedEnvId.set(firstEnv ? firstEnv.id : null);
      if (firstEnv) this.envVars.set(null);
    }
    this._dialog()?.open();
  };

  private _handleDialogClose = (): void => {
    // Reset transient state so the next open starts fresh — selection and
    // any open inline forms go back to their initial values.
    this.selectedEnvId.set(null);
    this.envVars.set(null);
    this.addingVar.set(false);
    this.scopeCollectionId.set(null);
    this.settingSecretForVarId.set(null);
  };

  open = (): void => {
    this._dialog()?.open();
  };

  close = (): void => {
    this._dialog()?.close();
  };

  selectEnv = (envId: string): void => {
    this.selectedEnvId.set(envId);
    this.envVars.set(null);
    this.addingVar.set(false);
    this.settingSecretForVarId.set(null);
  };

  startAddVar = (): void => {
    this._focusAfterRender = 'new-key';
    this.addingVar.set(true);
  };

  cancelAddVar = (): void => {
    this.addingVar.set(false);
  };

  startSetSecret = (varId: string): void => {
    this._focusAfterRender = 'secret-input';
    this.settingSecretForVarId.set(varId);
  };

  cancelSetSecret = (): void => {
    this.settingSecretForVarId.set(null);
  };

  toggleFolderCollapse = (folderId: string): void => {
    const next = new Set(this.collapsedFolders());
    if (next.has(folderId)) next.delete(folderId);
    else next.add(folderId);
    this.collapsedFolders.set(next);
  };

  handleAddEnv = async (folderId: string): Promise<void> => {
    const name = await promptInline('New env name?', 'production');
    if (!name) return;
    try {
      const env = await rpc<Environment>({ kind: 'env:create', folderId, name });
      const ws = activeWorkspace();
      if (ws) await loadWorkspaceData(ws.id);
      this.selectedEnvId.set(env.id);
      this.envVars.set(null);
    } catch (err) {
      showToast(`Create env failed: ${(err as Error).message}`, 'error');
    }
  };

  handleAddDirectoryEnv = async (directoryId: string): Promise<void> => {
    const name = await promptInline('New env name?', 'production');
    if (!name) return;
    try {
      const env = await rpc<Environment>({ kind: 'env:create', directoryId, name });
      const ws = activeWorkspace();
      if (ws) await loadWorkspaceData(ws.id);
      this.selectedEnvId.set(env.id);
      this.envVars.set(null);
    } catch (err) {
      showToast(`Create env failed: ${(err as Error).message}`, 'error');
    }
  };

  handleActivate = async (envId: string): Promise<void> => {
    try {
      await rpc({ kind: 'env:setActive', envId });
      const ws = activeWorkspace();
      if (ws) await loadWorkspaceData(ws.id);
    } catch (err) {
      showToast(`Activate failed: ${(err as Error).message}`, 'error');
    }
  };

  handleRenameEnv = async (envId: string): Promise<void> => {
    const env = environments().find((e) => e.id === envId);
    if (!env) return;
    const name = await promptInline('Rename env', env.name, env.name);
    if (!name || name === env.name) return;
    try {
      await rpc({ kind: 'env:rename', envId, name });
      const ws = activeWorkspace();
      if (ws) await loadWorkspaceData(ws.id);
    } catch (err) {
      showToast(`Rename failed: ${(err as Error).message}`, 'error');
    }
  };

  handleDeleteEnv = async (envId: string): Promise<void> => {
    try {
      await rpc({ kind: 'env:delete', envId });
      showToast('Env deleted', 'success');
      this.selectedEnvId.set(null);
      this.envVars.set(null);
      const ws = activeWorkspace();
      if (ws) await loadWorkspaceData(ws.id);
    } catch (err) {
      showToast(`Delete failed: ${(err as Error).message}`, 'error');
    }
  };

  handleConfirmAddVar = async (): Promise<void> => {
    const root = this.elementRef.shadowRoot;
    if (!root) return;
    // ml-input mirrors its current text on the host as a `.value` property,
    // so this read works whether the wrapper is a native input or ml-input.
    const keyInput = root.querySelector<HTMLElement & { value: string }>('.new-key');
    const valueInput = root.querySelector<HTMLElement & { value: string }>('.new-value');
    const key = keyInput?.value.trim() ?? '';
    const value = valueInput?.value ?? '';
    const envId = this.selectedEnvId();
    if (!key || !envId) {
      focusMlInput(keyInput);
      return;
    }
    try {
      await rpc({ kind: 'var:create', envId, key, valuePlain: value });
      this.addingVar.set(false);
      await this.loadVars(envId);
    } catch (err) {
      showToast(`Add var failed: ${(err as Error).message}`, 'error');
    }
  };

  handleConfirmSecret = async (varId: string): Promise<void> => {
    const root = this.elementRef.shadowRoot;
    if (!root) return;
    const input = root.querySelector<HTMLElement & { value: string }>('.secret-input');
    const plaintext = input?.value ?? '';
    try {
      await rpc({ kind: 'var:setSecret', varId, plaintext });
      this.settingSecretForVarId.set(null);
      const envId = this.selectedEnvId();
      if (envId) await this.loadVars(envId);
    } catch (err) {
      showToast(`Set secret failed: ${(err as Error).message}`, 'error');
    }
  };

  handleDeleteVar = async (varId: string): Promise<void> => {
    try {
      await rpc({ kind: 'var:delete', varId });
      const envId = this.selectedEnvId();
      if (envId) await this.loadVars(envId);
    } catch (err) {
      showToast(`Delete var failed: ${(err as Error).message}`, 'error');
    }
  };

  handleAddVarKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void this.handleConfirmAddVar();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.addingVar.set(false);
    }
  };

  handleSecretKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const varId = this.settingSecretForVarId();
      if (varId) void this.handleConfirmSecret(varId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.settingSecretForVarId.set(null);
    }
  };

  async loadVars(envId: string): Promise<void> {
    this.envVarsLoading = true;
    try {
      const list = await rpc<VarRow[]>({ kind: 'var:list', envId });
      this.envVars.set(list);
    } catch (err) {
      console.error('var:list failed:', err);
      this.envVars.set([]);
    } finally {
      this.envVarsLoading = false;
    }
  }

  // Save a var value on blur. Hooked to both `focusout` (native) and
  // `ml:change` (ml-input fires this on blur).
  //
  // We can't rely on `e.target` here: by the time the event reaches the
  // env-manager's host-level listener it's been retargeted across the
  // ml-input shadow boundary AND the env-manager shadow boundary, so the
  // target is the env-manager host element, not the ml-input the user was
  // editing. Walking `composedPath()` finds the original ml-input regardless
  // of retargeting.
  private _handleBlur = async (e: Event): Promise<void> => {
    const mlInput = e
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.classList.contains('var-value'),
      );
    if (!mlInput) return;
    const varId = mlInput.dataset.varId;
    if (!varId) return;
    const newValue = extractValue(e, mlInput);
    const existing = this.envVars()?.find((v) => v.id === varId);
    if (!existing || existing.valuePlain === newValue) return;
    try {
      await rpc({ kind: 'var:setPlain', varId, valuePlain: newValue });
      // Mutate locally — the row's `<ml-input>` is still mounted and stays
      // in sync via the user's edit, so we don't need a re-render here.
      existing.valuePlain = newValue;
    } catch (err) {
      showToast(`Save failed: ${(err as Error).message}`, 'error');
    }
  };
}

/**
 * Renders one collection's full subtree: the collection's implicit root
 * folder (labeled with the collection's display name), its descendant
 * folders, and any child collections nested below it. Indentation comes
 * from a `depth` parameter that grows by one for each level.
 */
/**
 * Render the children of a directory (sub-directories first, then
 * collections in this directory). Directly mirrors how the sidebar walks
 * the workspace tree — anything visible there is visible here, with the
 * addition of envs at each scope.
 */
/**
 * A "single-request collection" — one with exactly one request and no
 * folders. The sidebar collapses these to render as just the request, and
 * here in env-manager we absorb their envs into the parent directory's
 * section so the user doesn't see the same name twice.
 */
function isSingleRequestCollection(
  col: Collection,
  allFolders: Folder[],
  allRequests: RequestRow[],
): boolean {
  const folderCount = allFolders.filter((f) => f.parentFolderId === col.rootFolderId).length;
  const reqCount = allRequests.filter((r) => r.collectionId === col.id).length;
  return reqCount === 1 && folderCount === 0;
}

function renderDirectoryChildren(
  c: EnvManagerComponent,
  parentDirectoryId: string,
  allDirectories: Directory[],
  allCollections: Collection[],
  allFolders: Folder[],
  allRequests: RequestRow[],
  allEnvs: Environment[],
  selectedId: string | null,
  depth: number,
): ReturnType<typeof html>[] {
  const childDirs = allDirectories
    .filter((d) => d.parentDirectoryId === parentDirectoryId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const dirCollections = allCollections
    .filter((col) => col.directoryId === parentDirectoryId)
    .filter((col) => !isSingleRequestCollection(col, allFolders, allRequests))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  return [
    ...childDirs.map((d) =>
      renderDirectorySubtree(
        c,
        d,
        allDirectories,
        allCollections,
        allFolders,
        allRequests,
        allEnvs,
        selectedId,
        depth,
      ),
    ),
    ...dirCollections.map((col) =>
      renderCollectionSubtree(c, col, allFolders, allEnvs, selectedId, depth),
    ),
  ];
}

function renderDirectorySubtree(
  c: EnvManagerComponent,
  dir: Directory,
  allDirectories: Directory[],
  allCollections: Collection[],
  allFolders: Folder[],
  allRequests: RequestRow[],
  allEnvs: Environment[],
  selectedId: string | null,
  depth: number,
): ReturnType<typeof html> {
  const collapsed = c.collapsedFolders();
  // Reuse the same collapsed-set keyed by a "dir:" prefix so directory
  // collapse state doesn't collide with folder/collection ids.
  const collapseKey = `dir:${dir.id}`;
  const isCollapsed = collapsed.has(collapseKey);

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

  // The workspace root directory is stored with name='' (see migration 006).
  // Surface a friendly label so the section header isn't blank.
  const label = dir.name === '' ? 'Workspace' : dir.name;

  return html`
    <div>
      ${renderScopeSection(c, {
        kind: 'directory',
        id: dir.id,
        collapseKey,
        label,
        depth,
        envs: [...dirEnvs, ...absorbedEnvs],
        selectedId,
        collapsed,
      })}
      ${isCollapsed
        ? ''
        : renderDirectoryChildren(
            c,
            dir.id,
            allDirectories,
            allCollections,
            allFolders,
            allRequests,
            allEnvs,
            selectedId,
            depth + 1,
          )}
    </div>
  `;
}

function renderCollectionSubtree(
  c: EnvManagerComponent,
  collection: Collection,
  allFolders: Folder[],
  allEnvs: Environment[],
  selectedId: string | null,
  depth: number,
): ReturnType<typeof html> {
  const collapsed = c.collapsedFolders();
  const isCollapsed = collapsed.has(collection.rootFolderId);
  const rootChildren = allFolders.filter(
    (f) => f.parentFolderId === collection.rootFolderId,
  );
  return html`
    <div>
      ${renderFolderSection(
        c,
        collection.rootFolderId,
        collection.name,
        depth,
        allEnvs,
        selectedId,
        collapsed,
      )}
      ${isCollapsed
        ? ''
        : rootChildren.map((f) =>
            renderFolderSubtree(c, f, allFolders, allEnvs, selectedId, depth + 1, collapsed),
          )}
    </div>
  `;
}

function renderFolderSubtree(
  c: EnvManagerComponent,
  folder: Folder,
  allFolders: Folder[],
  allEnvs: Environment[],
  selectedId: string | null,
  depth: number,
  collapsed: Set<string>,
): ReturnType<typeof html> {
  const isCollapsed = collapsed.has(folder.id);
  const children = allFolders.filter((f) => f.parentFolderId === folder.id);
  return html`
    <div>
      ${renderFolderSection(c, folder.id, folder.name, depth, allEnvs, selectedId, collapsed)}
      ${isCollapsed
        ? ''
        : children.map((f: Folder) =>
            renderFolderSubtree(c, f, allFolders, allEnvs, selectedId, depth + 1, collapsed),
          )}
    </div>
  `;
}

function renderFolderSection(
  c: EnvManagerComponent,
  folderId: string,
  label: string,
  depth: number,
  allEnvs: Environment[],
  selectedId: string | null,
  collapsed: Set<string>,
) {
  return renderScopeSection(c, {
    kind: 'folder',
    id: folderId,
    collapseKey: folderId,
    label,
    depth,
    envs: allEnvs.filter((e) => e.folderId === folderId),
    selectedId,
    collapsed,
  });
}

interface ScopeRenderArgs {
  kind: 'folder' | 'directory';
  id: string;
  collapseKey: string;
  label: string;
  depth: number;
  envs: Environment[];
  selectedId: string | null;
  collapsed: Set<string>;
}

function renderScopeSection(c: EnvManagerComponent, args: ScopeRenderArgs) {
  const { kind, id, collapseKey, label, depth, envs, selectedId, collapsed } = args;
  const isCollapsed = collapsed.has(collapseKey);
  // Indent past the chevron column so labels at the same depth align.
  const padLeft = 8 + depth * 14;
  const addTitle = kind === 'directory' ? 'Create env in this folder' : 'Create env in this folder';
  const addClick = () =>
    kind === 'directory' ? c.handleAddDirectoryEnv(id) : c.handleAddEnv(id);
  return html`
    <div>
      <div class="section-head" style=${`padding-left: ${padLeft}px`}>
        <ml-button
          class="chev-btn"
          variant="ghost"
          size="sm"
          title=${isCollapsed ? 'Expand' : 'Collapse'}
          @ml:click=${() => { c.toggleFolderCollapse(collapseKey); }}
        >
          <ml-icon icon=${isCollapsed ? 'caret-right' : 'caret-down'} size="xs"></ml-icon>
        </ml-button>
        <span class="section-head-label">${label}</span>
        <ml-button variant="ghost" size="sm" title=${addTitle} @ml:click=${addClick}>+</ml-button>
      </div>
      ${isCollapsed
        ? ''
        : envs.length === 0
          ? html`<div class="no-envs" style=${`padding-left: ${padLeft + 18}px`}>No envs</div>`
          : envs.map(
              (e) => html`
                <div
                  class="env-row"
                  data-selected=${String(e.id === selectedId)}
                  style=${`padding-left: ${padLeft + 18}px`}
                  @click=${() => { c.selectEnv(e.id); }}
                >
                  <span class="active-dot" data-active=${String(e.isActive)}></span>
                  <span class="env-row-name">${e.name}</span>
                </div>
              `,
            )}
    </div>
  `;
}

function renderEmptyDetail() {
  return html`
    <div class="empty-detail">
      <ml-icon icon="folder" size="lg" style="opacity:0.5"></ml-icon>
      <div style="font-size:13px">Select an environment to view its variables</div>
      <div style="font-size:12px">or click <strong>+</strong> next to a scope to create one.</div>
    </div>
  `;
}

function renderEnvDetail(c: EnvManagerComponent, env: Environment, allFolders: Folder[]) {
  const folder = allFolders.find((f) => f.id === env.folderId);
  const scopeLabel = folder ? `Folder: ${folder.name}` : 'Folder: (unknown)';
  return html`
    <div>
      <div class="detail-header">
        <strong class="detail-name">${env.name}</strong>
        ${env.isActive
          ? html`<span class="active-pill">ACTIVE</span>`
          : html`<ml-button
              variant="outline"
              size="sm"
              @ml:click=${() => c.handleActivate(env.id)}
              >Activate</ml-button
            >`}
        <span class="detail-actions">
          <ml-button
            variant="ghost"
            size="sm"
            title="Rename env"
            @ml:click=${() => c.handleRenameEnv(env.id)}
          >
            <ml-icon icon="pencil-simple" size="sm"></ml-icon>
          </ml-button>
          <ml-button
            variant="ghost"
            size="sm"
            title="Delete env"
            @ml:click=${() => c.handleDeleteEnv(env.id)}
          >
            <ml-icon icon="trash" size="sm"></ml-icon>
          </ml-button>
        </span>
      </div>
      <div class="scope-label">${scopeLabel}</div>
      ${renderVarsTable(c)}
    </div>
  `;
}

function renderVarsTable(c: EnvManagerComponent) {
  const vars = c.envVars();
  if (vars === null) return html`<div class="loading">Loading…</div>`;
  return html`
    <table class="vars-table">
      <thead>
        <tr>
          <th class="key-cell">Key</th>
          <th>Value</th>
          <th class="var-actions"></th>
        </tr>
      </thead>
      <tbody>
        ${vars.map((v) => renderVarRow(c, v))}
        ${c.addingVar()
          ? html`
              <tr>
                <td>
                  <ml-input
                    class="new-key"
                    size="sm"
                    type="text"
                    placeholder="key"
                    style="width:100%"
                    @keydown=${c.handleAddVarKeyDown}
                  ></ml-input>
                </td>
                <td>
                  <ml-input
                    class="new-value"
                    size="sm"
                    type="text"
                    placeholder="value"
                    style="width:100%"
                    @keydown=${c.handleAddVarKeyDown}
                  ></ml-input>
                </td>
                <td style="display:flex;gap:4px">
                  <ml-button variant="primary" size="sm" @ml:click=${c.handleConfirmAddVar}>Add</ml-button>
                  <ml-button variant="ghost" size="sm" @ml:click=${c.cancelAddVar}>Cancel</ml-button>
                </td>
              </tr>
            `
          : html`
              <tr>
                <td colspan="3">
                  <ml-button variant="ghost" size="sm" @ml:click=${c.startAddVar}>+ Add variable</ml-button>
                </td>
              </tr>
            `}
      </tbody>
    </table>
  `;
}

function renderVarRow(c: EnvManagerComponent, v: VarRow) {
  const isEditingSecret = c.settingSecretForVarId() === v.id;
  return html`
    <tr>
      <td class="key-cell">${v.key}</td>
      <td>
        ${v.isSecret
          ? html`<span class="secret-label">[secret]</span>`
          : html`<ml-input
              class="var-value"
              data-var-id=${v.id}
              size="sm"
              type="text"
              value=${v.valuePlain ?? ''}
              style="width:100%"
            ></ml-input>`}
      </td>
      <td class="var-actions">
        ${!v.isSecret
          ? html`<ml-button
              variant="outline"
              size="sm"
              title="Mark as secret"
              @ml:click=${() => { c.startSetSecret(v.id); }}
            >
              <ml-icon icon="lock" size="xs"></ml-icon>
            </ml-button>`
          : ''}
        <ml-button
          variant="ghost"
          size="sm"
          title="Delete variable"
          @ml:click=${() => c.handleDeleteVar(v.id)}
        >
          <ml-icon icon="x" size="xs"></ml-icon>
        </ml-button>
      </td>
    </tr>
    ${isEditingSecret
      ? html`
          <tr class="secret-row">
            <td colspan="3">
              <div class="secret-row-inner">
                <span class="secret-row-label">Set secret value:</span>
                <ml-input
                  class="secret-input"
                  size="sm"
                  type="password"
                  placeholder="value"
                  style="flex:1"
                  @keydown=${c.handleSecretKeyDown}
                ></ml-input>
                <ml-button
                  variant="primary"
                  size="sm"
                  @ml:click=${() => c.handleConfirmSecret(v.id)}
                  >Save</ml-button
                >
                <ml-button variant="ghost" size="sm" @ml:click=${c.cancelSetSecret}>Cancel</ml-button>
              </div>
            </td>
          </tr>
        `
      : ''}
  `;
}


// Pull the input's current text value out of an event regardless of whether
// it was fired by a native form element (target.value) or a Melodic form
// element (CustomEvent with detail.value). When the caller has already
// resolved the actual ml-input via composedPath(), passing it as `fallback`
// gives the most reliable value — by the time the listener runs, ml-input
// has already written the latest text to its `.value` property.
function extractValue(e: Event, fallback?: HTMLElement & { value?: unknown }): string {
  const detail = (e as CustomEvent).detail as { value?: unknown } | null | undefined;
  if (detail && typeof detail === 'object' && 'value' in detail && typeof detail.value === 'string') {
    return detail.value;
  }
  if (fallback && typeof fallback.value === 'string') {
    return fallback.value;
  }
  const t = e.target as { value?: unknown } | null;
  return typeof t?.value === 'string' ? t.value : '';
}

// Focus the inner native <input> inside an ml-input. The host element doesn't
// delegate focus, so .focus() on it is a no-op.
function focusMlInput(el: Element | null): void {
  if (!el) return;
  const inner = el.shadowRoot?.querySelector('input') as HTMLInputElement | null;
  inner?.focus();
}

export { EnvManagerComponent };
