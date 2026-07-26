// <hu-env-switcher>
//
// Per-folder env switcher rendered as a chain (root → leaf). Each folder
// in the active request's chain becomes its own dropdown — the user picks
// the active env at any level independently. Variables resolve via the
// chain at send time, deepest-wins.
//
// When no request tab is open, the switcher collapses to a single
// dropdown for the workspace's first collection's root folder.
//
// The "+ new env" affordance scopes to the currently-focused dropdown's
// folder.

import { MelodicComponent, html, css, signal } from '@melodicdev/core';
import type { IElementRef, OnRender } from '@melodicdev/core/components';
import { rpc } from '@ipc/renderer';
import {
  environments,
  activeWorkspace,
  activeTabId,
  tabs,
  requests,
  collections,
  folders,
} from '../store/state.js';
import { loadWorkspaceData } from '../store/lifecycle.js';
import type { Environment } from '../store/model.js';
import { showToast } from './toast.js';

interface ChainStep {
  folderId: string;
  folderName: string;
  env: Environment | null;
}

@MelodicComponent({
  selector: 'hu-env-switcher',
  template: (c: EnvSwitcherComponent) => {
    // Read everything the chain derivation depends on so we re-render on change.
    c.activeTabId();
    c.tabs();
    c.requests();
    c.collections();
    c.folders();
    const allEnvs = c.environments();

    const chain = c.chainSteps();

    // Nothing to show if the workspace has no folders (chain empty) or no
    // folder in the chain has any envs at all — the gear button on each
    // folder row in the sidebar handles env management now.
    const anyEnvAvailable = chain.some(
      (s) => allEnvs.some((e) => e.folderId === s.folderId),
    );
    if (chain.length === 0 || !anyEnvAvailable) {
      return html``;
    }

    if (c.creating()) {
      const targetFolderId = c.createForFolderId();
      const targetStep = chain.find((s) => s.folderId === targetFolderId);
      return html`
        <div class="row">
          <span class="label">New env in ${targetStep?.folderName ?? 'folder'}:</span>
          <ml-input
            class="new-name"
            size="sm"
            type="text"
            placeholder="env name…"
            style="width:200px"
            @keydown=${c.handleNewNameKeyDown}
          ></ml-input>
          <ml-button variant="primary" size="sm" @ml:click=${c.createEnv}>Create</ml-button>
          <ml-button variant="ghost" size="sm" @ml:click=${c.cancelCreate}>Cancel</ml-button>
        </div>
      `;
    }

    return html`
      <div class="row">
        ${chain.map((step) => {
          const stepEnvs = allEnvs.filter((e) => e.folderId === step.folderId);
          const selected = step.env?.id ?? '';
          return html`
            <span class="folder-label" title=${`Folder: ${step.folderName}`}>${step.folderName}</span>
            <select
              class="select"
              data-folder-id=${step.folderId}
              .value=${selected}
              @change=${c.handleChange}
            >
              <option value="">— none —</option>
              ${stepEnvs.map(
                (e) => html`<option value=${e.id}>${e.name}</option>`,
              )}
            </select>
            <ml-button
              variant="ghost"
              size="sm"
              title=${`New env in ${step.folderName}`}
              @ml:click=${() => { c.startCreateFor(step.folderId); }}
              >+</ml-button
            >
          `;
        })}
      </div>
    `;
  },
  styles: () => css`
    :host {
      display: inline-flex;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--hu-text-secondary);
      flex-wrap: wrap;
    }
    .label {
      font-weight: 500;
    }
    .folder-label {
      font-weight: 500;
      color: var(--hu-text-muted);
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .select {
      padding: 4px 8px;
      border: 1px solid var(--hu-border-strong);
      border-radius: var(--hu-radius-sm);
      background: var(--hu-bg-base);
      color: var(--hu-text-primary);
      font-size: 12px;
      font-family: var(--hu-font-sans);
      cursor: pointer;
      min-width: 120px;
    }
  `,
})
class EnvSwitcherComponent implements IElementRef, OnRender {
  elementRef!: HTMLElement;
  environments = environments;
  activeTabId = activeTabId;
  tabs = tabs;
  requests = requests;
  collections = collections;
  folders = folders;
  creating = signal(false);
  createForFolderId = signal<string>('');

  private _focusOnNextRender = false;

  /**
   * Derives the folder chain (root → leaf) for the active tab's request.
   * Falls back to the first collection's root folder when no tab is open
   * so the switcher still has somewhere to surface envs.
   */
  chainSteps(): ChainStep[] {
    const tabId = activeTabId();
    if (tabId) {
      const tab = tabs().find((t) => t.id === tabId);
      const req = tab ? requests().find((r) => r.id === tab.requestId) : undefined;
      if (req) {
        const collection = collections().find((c) => c.id === req.collectionId);
        if (!collection) return [];
        const startFolder = req.folderId ?? collection.rootFolderId;
        return this._walkChain(startFolder);
      }
    }
    const cols = collections();
    if (cols.length === 0) return [];
    return this._walkChain(cols[0]!.rootFolderId);
  }

  private _walkChain(startFolderId: string): ChainStep[] {
    const allFolders = folders();
    const folderById = new Map(allFolders.map((f) => [f.id, f]));
    const allEnvs = environments();
    const chain: ChainStep[] = [];
    const seen = new Set<string>();
    let current: string | undefined = startFolderId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const f = folderById.get(current);
      if (!f) break;
      const env = allEnvs.find((e) => e.folderId === f.id && e.isActive) ?? null;
      chain.push({ folderId: f.id, folderName: f.name, env });
      current = f.parentFolderId;
    }
    chain.reverse();
    return chain;
  }

  onRender(): void {
    if (this._focusOnNextRender) {
      this._focusOnNextRender = false;
      const el = this.elementRef.shadowRoot?.querySelector('.new-name') as Element | null;
      const inner = el?.shadowRoot?.querySelector('input') as HTMLInputElement | null;
      inner?.focus();
    }
  }

  startCreateFor = (folderId: string): void => {
    this.createForFolderId.set(folderId);
    this._focusOnNextRender = true;
    this.creating.set(true);
  };

  cancelCreate = (): void => {
    this.creating.set(false);
  };

  handleChange = async (e: Event): Promise<void> => {
    const target = e.target as HTMLSelectElement;
    if (!target.classList.contains('select')) return;
    const folderId = target.dataset.folderId;
    if (!folderId) return;
    const envId = target.value;
    try {
      if (envId === '') {
        await rpc<{ folderId: string }>({ kind: 'env:clearActive', folderId });
      } else {
        await rpc<{ envId: string }>({ kind: 'env:setActive', envId });
      }
      const ws = activeWorkspace();
      if (ws) await loadWorkspaceData(ws.id);
    } catch (err) {
      console.error('setActive env failed:', err);
    }
  };

  handleNewNameKeyDown = async (e: Event): Promise<void> => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      await this.createEnv();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      this.creating.set(false);
    }
  };

  createEnv = async (): Promise<void> => {
    const input = this.elementRef.shadowRoot?.querySelector(
      '.new-name',
    ) as (HTMLElement & { value: string }) | null;
    if (!input) return;
    const name = input.value.trim();
    if (!name) return;
    const folderId = this.createForFolderId();
    if (!folderId) return;
    try {
      const env = await rpc<Environment>({ kind: 'env:create', folderId, name });
      await rpc<{ envId: string }>({ kind: 'env:setActive', envId: env.id });
      this.creating.set(false);
      const ws = activeWorkspace();
      if (ws) await loadWorkspaceData(ws.id);
    } catch (err) {
      console.error('env:create failed:', err);
      showToast(`Failed to create env: ${(err as Error).message}`, 'error');
    }
  };
}

export { EnvSwitcherComponent };
