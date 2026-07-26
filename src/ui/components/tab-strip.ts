// <hu-tab-strip>
//
// Horizontal strip of open request tabs across the top of the workspace.
// Holds three signals as instance fields so ComponentBase.observe() wires up
// auto-subscriptions: the tabs list, the active tab id, and the request rows
// (we look up name/method off the requests map by tab.requestId).
//
// A single delegated @click on the wrapper handles both tab activation and
// per-tab close, so adding a tab doesn't grow the listener count.
// Right-click on a tab opens a Chrome-style context menu (Close / Close
// Others / Close to the Right / Close All).

import { MelodicComponent, html, css, signal } from '@melodicdev/core';
import { tabs, activeTabId, requests } from '../store/state.js';
import { rpc } from '@ipc/renderer';
import type { OpenTab } from '../store/model.js';

interface ContextMenuState {
  x: number;
  y: number;
  tabId: string;
}

@MelodicComponent({
  selector: 'hu-tab-strip',
  template: (c: TabStripComponent) => {
    const list = c.tabs();
    const active = c.activeTabId();
    const reqMap = new Map(c.requests().map((r) => [r.id, r]));
    const menu = c.contextMenu();

    if (list.length === 0) {
      return html`<div class="empty">No open tabs</div>`;
    }

    return html`
      <div class="strip" @click=${c.handleClick} @contextmenu=${c.handleContextMenu}>
        ${list.map((t: OpenTab) => {
          const r = reqMap.get(t.requestId);
          const isActive = t.id === active;
          const fullLabel = r?.name || r?.url || t.id;
          // Cap visible label so the strip doesn't overflow horizontally;
          // full label remains in the title tooltip.
          const trunc = fullLabel.length > 24 ? fullLabel.slice(0, 21) + '…' : fullLabel;
          return html`
            <div
              class="tab"
              data-tab-id=${t.id}
              data-active=${String(isActive)}
              title=${fullLabel}
            >
              ${r ? html`<hu-method-badge method=${r.method}></hu-method-badge>` : ''}
              <span class="label">${trunc}${t.isDirty ? ' •' : ''}</span>
              <span class="close" data-action="close" data-tab-id=${t.id}>
                <ml-icon icon="x" size="xs"></ml-icon>
              </span>
            </div>
          `;
        })}
      </div>
      ${menu ? renderContextMenu(c, menu) : ''}
    `;
  },
  styles: () => css`
    :host {
      display: block;
      height: 100%;
    }
    .strip {
      display: flex;
      align-items: stretch;
      height: 100%;
      overflow-x: auto;
      /* overflow-x: auto reserves space for a horizontal scrollbar, which
         eats a few pixels of vertical room; tabs with height:100% then push
         past the available height and the browser flips on a vertical
         scrollbar too. Pin overflow-y so it can't happen. */
      overflow-y: hidden;
      scrollbar-width: thin;
    }
    .empty {
      padding: 0 12px;
      color: var(--hu-text-muted);
      font-size: 12px;
      display: flex;
      align-items: center;
      height: 100%;
      font-style: italic;
      opacity: 0.7;
    }
    .tab {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      height: 100%;
      cursor: pointer;
      max-width: 240px;
      flex-shrink: 0;
      color: var(--hu-text-secondary);
      position: relative;
      /* The strip host inherits -webkit-app-region:drag from .header so its
         empty area can be grabbed/dblclicked to move/zoom the window. Tabs
         themselves must opt back out so clicks select them. */
      -webkit-app-region: no-drag;
      transition:
        background var(--hu-motion-fast) var(--hu-ease-out),
        color var(--hu-motion-fast) var(--hu-ease-out);
      /* Inset bottom indicator strip — sits behind content, only the active
         tab reveals it. Inset spacing (left/right) gives the strip a
         "tucked-in" feel rather than running full width. */
    }
    .tab::after {
      content: '';
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: 0;
      height: 2px;
      border-radius: 2px 2px 0 0;
      background: var(--hu-accent);
      transform: scaleX(0);
      transform-origin: center;
      transition: transform var(--hu-motion-base) var(--hu-ease-out);
    }
    .tab:hover {
      background: var(--hu-bg-hover);
      color: var(--hu-text-primary);
    }
    .tab[data-active='true'] {
      background: var(--hu-bg-base);
      color: var(--hu-text-primary);
    }
    .tab[data-active='true']::after {
      transform: scaleX(1);
    }
    .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: -0.005em;
    }
    .close {
      opacity: 0.5;
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--hu-radius-sm);
      font-size: 14px;
      line-height: 1;
      transition:
        background var(--hu-motion-fast) var(--hu-ease-out),
        opacity var(--hu-motion-fast) var(--hu-ease-out);
    }
    .close:hover {
      opacity: 1;
      background: var(--hu-bg-active);
    }
    .tab[data-active='true'] .close {
      opacity: 0.7;
    }

    /* Context menu — fixed-positioned at cursor coordinates. A backdrop
       captures any outside click and dismisses the menu. */
    .ctx-backdrop {
      position: fixed;
      inset: 0;
      z-index: 99;
      /* No background — invisible, just a hit target for outside-clicks. */
    }
    .ctx-menu {
      position: fixed;
      z-index: 100;
      min-width: 180px;
      padding: 4px;
      background: var(--hu-bg-elevated);
      border: 1px solid var(--hu-border);
      border-radius: var(--hu-radius-md);
      box-shadow: var(--hu-shadow-lg);
      display: flex;
      flex-direction: column;
      font-size: 13px;
      color: var(--hu-text-primary);
      /* Must opt out of the drag region or clicks never reach the items. */
      -webkit-app-region: no-drag;
    }
    .ctx-item {
      padding: 6px 10px;
      border-radius: var(--hu-radius-sm);
      cursor: pointer;
      user-select: none;
    }
    .ctx-item[data-disabled='true'] {
      color: var(--hu-text-muted);
      cursor: default;
    }
    .ctx-item:not([data-disabled='true']):hover {
      background: var(--hu-bg-hover);
    }
  `,
})
class TabStripComponent {
  tabs = tabs;
  activeTabId = activeTabId;
  requests = requests;
  contextMenu = signal<ContextMenuState | null>(null);

  handleClick = async (e: Event): Promise<void> => {
    const target = e.target as HTMLElement;
    const closeBtn = target.closest<HTMLElement>('.close');
    if (closeBtn) {
      const id = closeBtn.dataset.tabId;
      if (id) {
        await this.closeTabs([id]);
      }
      e.stopPropagation();
      return;
    }
    const tab = target.closest<HTMLElement>('.tab');
    if (tab) {
      const id = tab.dataset.tabId;
      if (id) this.activeTabId.set(id);
    }
  };

  handleContextMenu = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const tab = target.closest<HTMLElement>('.tab');
    if (!tab) return;
    const id = tab.dataset.tabId;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    this.contextMenu.set({ x: e.clientX, y: e.clientY, tabId: id });
  };

  closeContextMenu = (): void => {
    this.contextMenu.set(null);
  };

  closeTabs = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    // Optimistic: drop from local list first, then fire IPC. If IPC fails the
    // worst case is the row reappears on next list refresh.
    this.tabs.set(this.tabs().filter((t) => !idSet.has(t.id)));
    if (this.activeTabId() && idSet.has(this.activeTabId()!)) {
      const remaining = this.tabs();
      this.activeTabId.set(remaining.length > 0 ? remaining[0]!.id : null);
    }
    for (const id of ids) {
      try {
        await rpc<{ tabId: string }>({ kind: 'tabs:close', tabId: id });
      } catch (err) {
        console.error('tabs:close failed:', err);
      }
    }
  };
}

function renderContextMenu(c: TabStripComponent, menu: ContextMenuState) {
  const all = c.tabs();
  const idx = all.findIndex((t) => t.id === menu.tabId);
  const toRight = idx >= 0 ? all.slice(idx + 1).map((t) => t.id) : [];
  const others = all.filter((t) => t.id !== menu.tabId).map((t) => t.id);

  const items: { label: string; disabled: boolean; onClick: () => void | Promise<void> }[] = [
    {
      label: 'Close',
      disabled: false,
      onClick: () => c.closeTabs([menu.tabId]),
    },
    {
      label: 'Close Others',
      disabled: others.length === 0,
      onClick: () => c.closeTabs(others),
    },
    {
      label: 'Close Tabs to the Right',
      disabled: toRight.length === 0,
      onClick: () => c.closeTabs(toRight),
    },
    {
      label: 'Close All',
      disabled: false,
      onClick: () => c.closeTabs(all.map((t) => t.id)),
    },
  ];

  return html`
    <div class="ctx-backdrop" @mousedown=${c.closeContextMenu} @contextmenu=${(e: Event) => { e.preventDefault(); c.closeContextMenu(); }}></div>
    <div class="ctx-menu" style="left: ${menu.x}px; top: ${menu.y}px">
      ${items.map(
        (it) => html`
          <div
            class="ctx-item"
            data-disabled=${String(it.disabled)}
            @click=${async (e: Event) => {
              e.stopPropagation();
              if (it.disabled) return;
              c.closeContextMenu();
              await it.onClick();
            }}
          >
            ${it.label}
          </div>
        `,
      )}
    </div>
  `;
}

export { TabStripComponent };
