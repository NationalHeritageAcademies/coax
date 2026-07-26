// <hu-app-frame>
//
// The shell: header bar, sidebar tree, draggable splitter, main pane, and
// status bar all live inside a CSS grid on the host. The grid's first
// column width is driven by a CSS custom property `--hu-sidebar-width`,
// which the splitter drag handler updates directly on the host. This keeps
// the drag gesture from re-rendering the template — re-rendering would
// unmount Monaco (and lose its selection/scroll/undo state).
//
// The main pane swaps between a "no tab selected" empty state and a
// <hu-request-tab> keyed by tab id; we use the `repeat` directive so the
// request-tab node is recreated when the active tab changes, guaranteeing
// the child's connected/disconnected lifecycle fires in the right order
// (without this, two request tabs can coexist during the transition).
//
// The env-manager modal is mounted at document.body (outside the grid) so
// its fixed-position overlay isn't constrained by the layout.

import { MelodicComponent, html, css } from '@melodicdev/core';
import { repeat } from '@melodicdev/core/template';
import type { IElementRef, OnCreate, OnDestroy } from '@melodicdev/core/components';
import { rpc } from '@ipc/renderer';
import type { AppSettings } from '@ipc/types';
import { loadWorkspaceData } from '../store/lifecycle.js';
import { activeWorkspace, activeTabId, collections, tabs as tabsSignal, updateReady } from '../store/state.js';
import { pickAndOpenWorkspace } from '../store/lifecycle.js';
import { promptInline } from './prompt.js';
import { showToast } from './toast.js';


const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 600;
const DEFAULT_SIDEBAR = 280;

@MelodicComponent({
  selector: 'hu-app-frame',
  template: (c: AppFrameComponent) => {
    const id = c.activeTabId();
    const tab = id ? c.tabs().find((t) => t.id === id) : null;

    // Win/Linux hide the native menu bar (titleBarStyle: 'hidden' — see
    // src/app/main.ts), so the brand mark doubles as the entry point to the
    // application menu. macOS keeps its real menu bar, so the mark there is
    // purely decorative and the click is a no-op.
    const showMenuButton = window.httpui.platform !== 'darwin';

    return html`
      <div class="header" @dblclick=${c.handleHeaderDblClick}>
        <div
          class="brand"
          title=${showMenuButton ? 'Application menu' : 'Coax — coax a response'}
          @click=${c.handleBrandClick}
        >
          <div class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <defs>
                <linearGradient id="hu-mark-grad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stop-color="#3b82f6" />
                  <stop offset="100%" stop-color="#22d3ee" />
                </linearGradient>
              </defs>
              <circle cx="16" cy="16" r="12" fill="none" stroke="url(#hu-mark-grad)" stroke-width="3.5" />
              <circle cx="16" cy="16" r="7" fill="none" stroke="url(#hu-mark-grad)" stroke-width="1.4" />
              <circle cx="16" cy="16" r="2.2" fill="url(#hu-mark-grad)" />
            </svg>
          </div>
          <span class="brand-name">Coax</span>
          ${showMenuButton
            ? html`<ml-icon class="brand-caret" icon="caret-down" size="sm"></ml-icon>`
            : ''}
        </div>
        <hu-env-switcher class="env-switcher"></hu-env-switcher>
        <hu-tab-strip class="tab-strip"></hu-tab-strip>
        <div class="header-actions" @ml:select=${c.handleImportSelect}>
          <ml-dropdown placement="bottom-end">
            <ml-button slot="trigger" variant="ghost" size="sm" title="Import…">
              <ml-icon icon="download-simple" size="sm"></ml-icon>
            </ml-button>
            <ml-dropdown-item value="import-http" icon="download-simple"
              >Import .http…</ml-dropdown-item
            >
            <ml-dropdown-item value="import-swagger-url" icon="globe"
              >Import Swagger from URL…</ml-dropdown-item
            >
            <ml-dropdown-item value="import-swagger-file" icon="file-arrow-down"
              >Import Swagger from file…</ml-dropdown-item
            >
          </ml-dropdown>
          <ml-button variant="ghost" size="sm" title="Export collection" @ml:click=${c.exportHttp}>
            <ml-icon icon="upload-simple" size="sm"></ml-icon>
          </ml-button>
          <ml-button
            variant="ghost"
            size="sm"
            title="Quick reference — variables, chaining, overrides…"
            @ml:click=${c.openHelp}
          >
            <ml-icon icon="question" size="sm"></ml-icon>
          </ml-button>
          <ml-button variant="ghost" size="sm" title="Settings" @ml:click=${c.openSettings}>
            <ml-icon icon="gear" size="sm"></ml-icon>
          </ml-button>
          ${c.updateReady()
            ? html`<button
                type="button"
                class="update-pill"
                title="A new Coax version has been downloaded. Click to restart and install."
                @click=${c.handleRestartForUpdate}
              >
                Restart to update
              </button>`
            : ''}
          <hu-theme-toggle></hu-theme-toggle>
        </div>
      </div>

      <div class="sidebar-pane">
        <hu-sidebar-tree></hu-sidebar-tree>
      </div>

      <div class="splitter" @mousedown=${c.handleSplitterDown}></div>

      <main class="main">
        ${tab
          ? repeat(
              [tab],
              (t) => t.id,
              (t) =>
                html`<hu-request-tab
                  data-tab-id=${t.id}
                  data-request-id=${t.requestId}
                  class="request-tab"
                ></hu-request-tab>`,
            )
          : html`
              <div class="empty-state">
                <div class="empty-mark" aria-hidden="true">
                  <svg viewBox="0 0 64 64">
                    <defs>
                      <linearGradient id="hu-empty-grad" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stop-color="#3b82f6" />
                        <stop offset="100%" stop-color="#22d3ee" />
                      </linearGradient>
                    </defs>
                    <circle cx="32" cy="32" r="25" fill="none" stroke="url(#hu-empty-grad)" stroke-width="7" />
                    <circle cx="32" cy="32" r="15" fill="none" stroke="url(#hu-empty-grad)" stroke-width="2" />
                    <circle cx="32" cy="32" r="8" fill="none" stroke="url(#hu-empty-grad)" stroke-width="2" />
                    <circle cx="32" cy="32" r="4" fill="url(#hu-empty-grad)" />
                  </svg>
                </div>
                ${c.activeWorkspace() === null
                  ? html`
                      <h1 class="empty-title">Open a workspace folder</h1>
                      <p class="empty-msg">
                        A Coax workspace is just a folder of <code>.http</code> files.
                        Pick a folder to get started — Coax will adopt any existing
                        <code>.http</code> files it finds.
                      </p>
                      <div class="empty-actions">
                        <ml-button
                          variant="primary"
                          size="md"
                          @ml:click=${c.handlePickFolder}
                        >
                          <ml-icon slot="icon-start" icon="folder-open"></ml-icon>
                          Open Workspace Folder…
                        </ml-button>
                      </div>
                    `
                  : html`
                      <h1 class="empty-title">Your API workspace is just a <code>.http</code> file.</h1>
                      <p class="empty-msg">
                        Open a <code>.http</code> file, import a Swagger / OpenAPI spec, or pick a
                        request from the sidebar to get started.
                      </p>
                      <div class="empty-actions" @ml:select=${c.handleImportSelect}>
                        <ml-dropdown placement="bottom-start">
                          <ml-button slot="trigger" variant="primary" size="md">
                            <ml-icon slot="icon-start" icon="download-simple"></ml-icon>
                            Import…
                          </ml-button>
                          <ml-dropdown-item value="import-http" icon="download-simple"
                            >Import .http…</ml-dropdown-item
                          >
                          <ml-dropdown-item value="import-swagger-url" icon="globe"
                            >Import Swagger from URL…</ml-dropdown-item
                          >
                          <ml-dropdown-item value="import-swagger-file" icon="file-arrow-down"
                            >Import Swagger from file…</ml-dropdown-item
                          >
                        </ml-dropdown>
                        <ml-button variant="ghost" size="md" @ml:click=${c.openHelp}>
                          <ml-icon slot="icon-start" icon="question"></ml-icon>
                          Quick reference
                        </ml-button>
                      </div>
                      <div class="empty-shortcuts">
                        <span><kbd>⌘</kbd><kbd>/</kbd> help</span>
                        <span class="dot">·</span>
                        <a class="text-link" href="#" @click=${c.handleSwitchWorkspace}>
                          Switch workspace folder
                        </a>
                        <span class="dot">·</span>
                        <a
                          class="text-link"
                          href="https://coax.melodic.dev/docs/cli"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Run <code>.http</code> files in CI →
                        </a>
                      </div>
                    `}
              </div>
            `}
      </main>

      <hu-status-bar class="status-bar"></hu-status-bar>
    `;
  },
  styles: () => css`
    :host {
      display: grid;
      grid-template-columns: var(--hu-sidebar-width, ${DEFAULT_SIDEBAR}px) 4px 1fr;
      grid-template-rows: 48px 1fr 24px;
      height: 100vh;
      overflow: hidden;
    }

    /* Header ------------------------------------------------------------- */
    .header {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 0 16px;
      background: var(--hu-bg-elevated);
      border-bottom: 1px solid var(--hu-border);
      box-shadow: var(--hu-shadow-xs);
      min-width: 0;
      position: relative;
      z-index: 1;
      /* The OS title bar is hidden (see src/app/main.ts) so the header
         doubles as the window's drag region. Interactive children below
         opt out via -webkit-app-region: no-drag. */
      -webkit-app-region: drag;
    }
    /* Reserve room for the macOS traffic-light buttons (top-left). The
       buttons sit on top of the window so without this padding the brand
       mark collides with them. Win/Linux draw min/max/close in the top-
       right via Electron's titleBarOverlay, so no left padding needed. */
    :host([data-platform='darwin']) .header {
      padding-left: 80px;
    }
    /* Win/Linux titleBarOverlay reserves the right ~120px for system
       buttons; keep our header-actions away from that strip. */
    :host(:not([data-platform='darwin'])) .header {
      padding-right: 144px;
    }
    /* Every interactive surface in the header has to opt out of the drag
       region or clicks get swallowed by the window-drag handler. */
    .header ml-button,
    .header ml-dropdown,
    .header ml-dropdown-item,
    .header .header-actions,
    .header .env-switcher,
    .header .theme-toggle,
    .header a,
    .header button,
    .header input,
    .header [role='button'] {
      -webkit-app-region: no-drag;
    }
    /* .tab-strip stays draggable as a whole so the empty area beside the
       last tab works as a drag handle / dblclick-to-zoom target. The
       individual .tab elements inside the strip opt back out (see
       tab-strip.ts shadow CSS) so clicking a tab still selects it. */
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex-shrink: 0;
      padding: 4px 6px 4px 4px;
      margin-right: 4px;
      border-radius: 8px;
    }
    /* On Win/Linux the brand is the application-menu trigger: opt out of the
       window-drag region so the click registers, and give it button affordance
       (pointer + hover). On macOS it stays part of the drag handle. */
    :host(:not([data-platform='darwin'])) .brand {
      -webkit-app-region: no-drag;
      cursor: pointer;
    }
    :host(:not([data-platform='darwin'])) .brand:hover {
      background: var(--hu-bg-hover, rgb(255 255 255 / 0.06));
    }
    .brand-caret {
      color: var(--hu-text-secondary);
      margin-left: -2px;
      flex-shrink: 0;
    }
    /* Header brand mark — visually matches the app icon and the empty-state
       mark: a dark navy card with a subtle vertical gradient + top highlight
       + faint border, holding the brand-gradient glyph. Keeping these
       three surfaces in sync is the easiest way for "the app icon" to feel
       like the same object as the in-app branding. */
    .brand-mark {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: linear-gradient(180deg, #1a2238 0%, #0a1020 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-shadow:
        inset 0 1px 0 rgb(255 255 255 / 0.10),
        inset 0 0 0 1px rgb(255 255 255 / 0.06),
        var(--hu-shadow-sm);
      position: relative;
    }
    .brand-mark::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(180deg, rgb(255 255 255 / 0.08) 0%, transparent 50%);
      pointer-events: none;
    }
    .brand-mark svg {
      width: 22px;
      height: 22px;
      display: block;
      position: relative;
      z-index: 1;
    }
    .brand-name {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.015em;
      color: var(--hu-text-primary);
    }
    .env-switcher {
      flex-shrink: 0;
    }
    .tab-strip {
      flex: 1;
      min-width: 0;
      height: 100%;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
      margin-left: auto;
    }
    /* "Restart to update" pill — only rendered while electron-updater
       has a staged update waiting (the updateReady signal is non-null).
       Click swaps the binary via app:quitAndInstall. */
    .update-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--hu-accent-on, white);
      background: var(--hu-accent);
      border: none;
      border-radius: var(--hu-radius-md);
      cursor: pointer;
      font-family: inherit;
      transition: filter 120ms ease;
    }
    .update-pill:hover {
      filter: brightness(1.08);
    }

    /* Sidebar + splitter ------------------------------------------------- */
    .sidebar-pane {
      grid-column: 1;
      grid-row: 2;
      overflow: hidden;
      min-width: 0;
    }
    .splitter {
      grid-column: 2;
      grid-row: 2;
      background: var(--hu-border);
      cursor: col-resize;
      transition: background var(--hu-motion-base) var(--hu-ease-out);
    }
    .splitter:hover {
      background: var(--hu-accent);
    }

    /* Main pane ---------------------------------------------------------- */
    .main {
      grid-column: 3;
      grid-row: 2;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
      background: var(--hu-bg-base);
    }
    .request-tab {
      flex: 1;
      height: 100%;
    }

    /* Empty state -------------------------------------------------------- */
    /* IMPORTANT: do NOT put text-align:center on .empty-state. Inherited
       text-align bleeds through Shadow DOM into the dropdown menu's
       label slot, which makes the import-menu item labels render
       centered with a huge gap from their icons. Center the prose
       explicitly on each text element instead.
       (And do NOT write the word "slot" inside angle brackets in this
       file — html and css are the same tagged-template parser in
       Melodic, so it gets interpreted as an HTML tag and nukes every
       CSS rule that follows.) */
    .empty-state {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      padding: 48px 32px;
      background:
        radial-gradient(
          ellipse 60% 50% at 50% 30%,
          var(--hu-accent-subtle) 0%,
          transparent 70%
        ),
        var(--hu-bg-base);
    }
    /* Empty-state mark — same dark card aesthetic as the app icon and
       header brand mark, in light and dark mode. We hard-code the dark
       palette here rather than using --hu-bg-elevated so the mark always
       presents the same way the OS icon does. */
    .empty-mark {
      width: 80px;
      height: 80px;
      border-radius: 20px;
      background: linear-gradient(180deg, #1a2238 0%, #0a1020 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 24px;
      box-shadow:
        inset 0 1px 0 rgb(255 255 255 / 0.10),
        inset 0 0 0 1px rgb(255 255 255 / 0.06),
        var(--hu-shadow-lg);
      position: relative;
      animation: hu-mark-float 4s var(--hu-ease-in-out) infinite;
    }
    .empty-mark::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(180deg, rgb(255 255 255 / 0.08) 0%, transparent 50%);
      pointer-events: none;
    }
    .empty-mark svg {
      width: 56px;
      height: 56px;
      position: relative;
      z-index: 1;
    }
    @keyframes hu-mark-float {
      0%,
      100% {
        transform: translateY(0);
      }
      50% {
        transform: translateY(-3px);
      }
    }
    .empty-title {
      margin: 0 0 8px 0;
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.02em;
      text-align: center;
      color: var(--hu-text-primary);
      background: var(--hu-gradient-brand);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .empty-msg {
      margin: 0 0 24px 0;
      max-width: 420px;
      font-size: 14px;
      line-height: 1.6;
      text-align: center;
      color: var(--hu-text-secondary);
    }
    .empty-msg code {
      font-family: var(--hu-font-mono);
      font-size: 12px;
      padding: 1px 6px;
      background: var(--hu-bg-elevated);
      border: 1px solid var(--hu-border);
      border-radius: var(--hu-radius-sm);
      color: var(--hu-accent);
    }
    .empty-actions {
      display: flex;
      gap: 12px;
      margin-bottom: 36px;
    }
    .empty-shortcuts {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--hu-text-muted);
      font-size: 12px;
    }
    .empty-shortcuts kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      margin-right: 2px;
      background: var(--hu-bg-elevated);
      border: 1px solid var(--hu-border);
      border-bottom-width: 2px;
      border-radius: var(--hu-radius-sm);
      font-family: var(--hu-font-mono);
      font-size: 10px;
      color: var(--hu-text-secondary);
    }
    .empty-shortcuts .dot {
      opacity: 0.5;
    }
    .empty-shortcuts .text-link {
      color: var(--hu-text-link, #3b82f6);
      text-decoration: none;
      font-size: 12px;
    }
    .empty-shortcuts .text-link:hover {
      text-decoration: underline;
    }

    /* Status bar --------------------------------------------------------- */
    .status-bar {
      grid-column: 1 / -1;
      grid-row: 3;
    }

    @media (prefers-reduced-motion: reduce) {
      .empty-mark {
        animation: none;
      }
    }
  `,
})
class AppFrameComponent implements IElementRef, OnCreate, OnDestroy {
  elementRef!: HTMLElement;
  activeTabId = activeTabId;
  tabs = tabsSignal;
  activeWorkspace = activeWorkspace;
  updateReady = updateReady;

  private _envManager: HTMLElement | null = null;
  private _helpDialog: HTMLElement | null = null;
  private _installCliDialog: HTMLElement | null = null;
  private _settingsDialog: HTMLElement | null = null;
  private _welcomeDialog: HTMLElement | null = null;
  private _sidebarWidth = (() => {
    const stored =
      typeof localStorage !== 'undefined' ? localStorage.getItem('hu-sidebar-width') : null;
    const n = stored ? Number(stored) : NaN;
    return Number.isFinite(n) && n >= MIN_SIDEBAR && n <= MAX_SIDEBAR ? n : DEFAULT_SIDEBAR;
  })();
  private _dragging = false;
  private _dragStartX = 0;
  private _dragStartWidth = 0;

  onCreate(): void {
    // Apply the persisted sidebar width as a CSS var on the host.
    this.elementRef.style.setProperty('--hu-sidebar-width', `${this._sidebarWidth}px`);

    // Tag the host with the OS platform so CSS can branch (mainly: reserve
    // padding for macOS traffic lights vs. the Win/Linux title-bar overlay
    // strip — see styles above). `window.httpui.platform` comes from the
    // preload script.
    this.elementRef.setAttribute('data-platform', window.httpui.platform);

    // Application-menu events for the import/export flows. Each menu item
    // fires a document-level CustomEvent in ui/main.ts, and we react here.
    document.addEventListener('hu:menu-import-http', this._handleMenuImportHttp);
    document.addEventListener(
      'hu:menu-import-swagger-url',
      this._handleMenuImportSwaggerUrl,
    );
    document.addEventListener(
      'hu:menu-import-swagger-file',
      this._handleMenuImportSwaggerFile,
    );
    document.addEventListener('hu:menu-export-collection', this._handleMenuExport);

    // Mount the env-manager modal at the body level so its fixed-position
    // overlay isn't constrained by the grid.
    this._envManager = document.createElement('hu-env-manager');
    document.body.appendChild(this._envManager);
    // Same for the help dialog. Opened via the `hu:open-help` document event
    // dispatched by the brand-area click in the header.
    this._helpDialog = document.createElement('hu-help-dialog');
    document.body.appendChild(this._helpDialog);
    // Install-CLI dialog — opened via `hu:open-install-cli` dispatched by
    // the Help → "Install CLI…" menu item (src/app/menu.ts).
    this._installCliDialog = document.createElement('hu-install-cli-dialog');
    document.body.appendChild(this._installCliDialog);
    // Settings dialog — opened via `hu:open-settings` dispatched by the
    // Preferences… menu item (Mac: Coax → Preferences, Win/Linux: File →
    // Preferences) on Cmd/Ctrl+,.
    this._settingsDialog = document.createElement('hu-settings-dialog');
    document.body.appendChild(this._settingsDialog);
    // First-run welcome dialog — auto-opens on first launch via
    // _maybeShowWelcome() below; flips hasSeenWelcome on dismissal so
    // subsequent launches stay quiet.
    this._welcomeDialog = document.createElement('hu-welcome-dialog');
    document.body.appendChild(this._welcomeDialog);
    void this._maybeShowWelcome();

    // Global ⌘/ shortcut → open help. Registered on document so it fires
    // regardless of which shadow-rooted component currently has focus.
    document.addEventListener('keydown', this._handleGlobalKeydown);
  }

  openHelp = (): void => {
    document.dispatchEvent(new CustomEvent('hu:open-help'));
  };

  openSettings = (): void => {
    document.dispatchEvent(new CustomEvent('hu:open-settings'));
  };

  // ⌘/ (and ⌘? — same physical key on US layouts with Shift) opens help.
  // Bail if the user is typing into a text field so we don't hijack the
  // keystroke while they're editing.
  private _handleGlobalKeydown = (e: KeyboardEvent): void => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key !== '/' && e.key !== '?') return;
    e.preventDefault();
    this.openHelp();
  };

  onDestroy(): void {
    // Drag listeners live on document so we always clean them up here, even
    // if the user disconnected mid-drag (mouseup never fires). Same for the
    // body-level cursor/userSelect hints.
    document.removeEventListener('mousemove', this._handleSplitterMove);
    document.removeEventListener('mouseup', this._handleSplitterUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (this._envManager) {
      this._envManager.remove();
      this._envManager = null;
    }
    if (this._helpDialog) {
      this._helpDialog.remove();
      this._helpDialog = null;
    }
    if (this._installCliDialog) {
      this._installCliDialog.remove();
      this._installCliDialog = null;
    }
    if (this._settingsDialog) {
      this._settingsDialog.remove();
      this._settingsDialog = null;
    }
    if (this._welcomeDialog) {
      this._welcomeDialog.remove();
      this._welcomeDialog = null;
    }
    document.removeEventListener('keydown', this._handleGlobalKeydown);
    document.removeEventListener('hu:menu-import-http', this._handleMenuImportHttp);
    document.removeEventListener(
      'hu:menu-import-swagger-url',
      this._handleMenuImportSwaggerUrl,
    );
    document.removeEventListener(
      'hu:menu-import-swagger-file',
      this._handleMenuImportSwaggerFile,
    );
    document.removeEventListener('hu:menu-export-collection', this._handleMenuExport);
  }

  private _handleMenuImportHttp = (): void => {
    void this.importHttp();
  };
  private _handleMenuImportSwaggerUrl = (): void => {
    void this.importSwaggerFromUrl();
  };
  private _handleMenuImportSwaggerFile = (): void => {
    void this.importSwaggerFromFile();
  };
  private _handleMenuExport = (): void => {
    void this.exportHttp();
  };

  handleSplitterDown = (e: MouseEvent): void => {
    this._dragging = true;
    this._dragStartX = e.clientX;
    this._dragStartWidth = this._sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', this._handleSplitterMove);
    document.addEventListener('mouseup', this._handleSplitterUp);
    e.preventDefault();
  };

  private _handleSplitterMove = (e: MouseEvent): void => {
    if (!this._dragging) return;
    const dx = e.clientX - this._dragStartX;
    const newWidth = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, this._dragStartWidth + dx));
    this._sidebarWidth = newWidth;
    // Direct CSS var update on the host — never trigger a full re-render
    // during drag; that would unmount sub-components (including Monaco) and
    // lose their state (selection, scroll, undo stack).
    this.elementRef.style.setProperty('--hu-sidebar-width', `${newWidth}px`);
  };

  private _handleSplitterUp = (): void => {
    if (!this._dragging) return;
    this._dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', this._handleSplitterMove);
    document.removeEventListener('mouseup', this._handleSplitterUp);
    try {
      localStorage.setItem('hu-sidebar-width', String(this._sidebarWidth));
    } catch {
      // localStorage may be unavailable (e.g. file:// in some sandboxes).
      // Persistence is a nicety; the in-memory value still works for the
      // current session.
    }
  };

  handlePickFolder = async (): Promise<void> => {
    try {
      await pickAndOpenWorkspace();
    } catch (err) {
      console.error('pickAndOpenWorkspace failed:', err);
    }
  };

  // Invoked when the user clicks the "Restart to update" pill in the
  // header. Tells the main process to quit, swap the on-disk binary,
  // and relaunch via electron-updater's quitAndInstall.
  handleRestartForUpdate = (): void => {
    void rpc({ kind: 'app:quitAndInstall' });
  };

  // First-launch welcome. Reads app-settings; if hasSeenWelcome is false,
  // dispatches the document event the welcome-dialog component listens for.
  private _maybeShowWelcome = async (): Promise<void> => {
    try {
      const settings = await rpc<AppSettings>({ kind: 'app:settings:get' });
      if (!settings.hasSeenWelcome) {
        document.dispatchEvent(new CustomEvent('hu:open-welcome'));
      }
    } catch (err) {
      console.warn('maybeShowWelcome failed:', err);
    }
  };

  // Double-click on the header → zoom (the standard macOS title-bar
  // gesture). With our custom title bar (titleBarStyle: hiddenInset) the
  // system's automatic zoom doesn't always fire, so the renderer dispatches
  // it via IPC. Bail if the dblclick landed on an interactive control —
  // those shouldn't trigger a window resize.
  handleHeaderDblClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (
      target.closest(
        'ml-button, ml-dropdown, ml-dropdown-item, button, input, a, [role="button"], .header-actions, .env-switcher, .theme-toggle',
      )
    ) {
      return;
    }
    // The tab strip is the host of <hu-tab-strip>; event retargeting makes
    // it the visible target for clicks inside its shadow root. If the original
    // composed target was an actual .tab element, the strip's shadow CSS has
    // already opt-ed that node out of drag — so we only bail when the dblclick
    // composed path actually hits a tab.
    const path = e.composedPath() as Element[];
    if (path.some((el) => el instanceof Element && el.classList?.contains('tab'))) {
      return;
    }
    void rpc({ kind: 'app:windowAction', action: 'zoom' });
  };

  // Brand-mark click. On Win/Linux the native menu bar is hidden, so this is
  // the only way to reach File/Edit/View/Help — pop the app menu just below
  // the brand. macOS has the real menu bar, so we leave the click inert there.
  handleBrandClick = (e: MouseEvent): void => {
    if (window.httpui.platform === 'darwin') return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    void rpc({ kind: 'app:popupAppMenu', x: rect.left, y: rect.bottom });
  };

  handleSwitchWorkspace = async (e: Event): Promise<void> => {
    e.preventDefault();
    try {
      await pickAndOpenWorkspace();
    } catch (err) {
      console.error('pickAndOpenWorkspace failed:', err);
    }
  };

  handleImportSelect = (e: Event): void => {
    const ev = e as CustomEvent<{ value: string }>;
    const value = ev.detail?.value;
    if (!value) return;
    switch (value) {
      case 'import-http':
        void this.importHttp();
        break;
      case 'import-swagger-url':
        void this.importSwaggerFromUrl();
        break;
      case 'import-swagger-file':
        void this.importSwaggerFromFile();
        break;
    }
  };

  importHttp = async (): Promise<void> => {
    try {
      const dialogResult = await rpc<{ path: string | null }>({ kind: 'dialog:openHttp' });
      if (!dialogResult.path) return;
      await rpc<{
        collectionId: string;
        stats: { requests: number; variables: number; folders: number };
      }>({
        kind: 'http:import',
        path: dialogResult.path,
      });
      const ws = activeWorkspace();
      if (ws) await loadWorkspaceData(ws.id);
    } catch (err: unknown) {
      console.error('Import failed:', err);
      showToast(`Import failed: ${(err as Error).message}`, 'error');
    }
  };

  importSwaggerFromUrl = async (): Promise<void> => {
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
      const ws = activeWorkspace();
      if (ws) await loadWorkspaceData(ws.id);
    } catch (err: unknown) {
      showToast(`Swagger import failed: ${(err as Error).message}`, 'error');
    }
  };

  importSwaggerFromFile = async (): Promise<void> => {
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
      const ws = activeWorkspace();
      if (ws) await loadWorkspaceData(ws.id);
    } catch (err: unknown) {
      showToast(`Swagger import failed: ${(err as Error).message}`, 'error');
    }
  };

  exportHttp = async (): Promise<void> => {
    try {
      const cols = collections();
      if (cols.length === 0) {
        showToast('No collections to export.', 'warning');
        return;
      }
      // v1 limitation: when multiple collections exist, just export the first
      // and surface a notice. A proper picker is a separate feature — using
      // window.prompt is a no-op in Electron's renderer, so doing nothing is
      // worse than picking sensibly + telling the user.
      const c = cols[0]!;
      if (cols.length > 1) {
        showToast(`Exporting "${c.name}" (multi-collection picker coming soon).`, 'info');
      }

      const dialogResult = await rpc<{ path: string | null }>({
        kind: 'dialog:saveHttp',
        defaultName: `${c.name}.http`,
      });
      if (!dialogResult.path) return;

      const result = await rpc<{
        written: true;
        path: string;
        warnings: { kind: string; requestId?: string; detail: string }[];
      }>({
        kind: 'collection:export',
        collectionId: c.id,
        targetPath: dialogResult.path,
      });

      if (result.warnings.length > 0) {
        const warnText = result.warnings.map((w) => `• ${w.kind}: ${w.detail}`).join('\n');
        showToast(
          `Exported to ${result.path}\n\n${result.warnings.length} warning(s):\n${warnText}`,
          'warning',
          8000,
        );
      } else {
        showToast(`Exported to ${result.path}`, 'success');
      }
    } catch (err: unknown) {
      console.error('Export failed:', err);
      showToast(`Export failed: ${(err as Error).message}`, 'error', 6000);
    }
  };
}

export { AppFrameComponent };
