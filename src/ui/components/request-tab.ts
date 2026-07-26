// <hu-request-tab>
//
// The main request workspace: chain-name row, method+URL+Send bar, draggable
// request pane with sub-tabs (Params / Headers / Body / Auth / Vars / cURL),
// splitter, and response pane with sub-tabs (Body / Headers / Raw).
//
// The local request draft (`draft`) is held as a non-reactive object — the
// template reads it directly, but mutating fields like draft.url doesn't
// trigger a re-render. That preserves focus while the user types in the URL
// or KV inputs. When we DO want a re-render after a draft mutation (body
// kind change, headers add/remove, etc.) we bump the `draftVersion` signal,
// which the template reads as a subscribe-only side effect.
//
// Other UI state is held as signals so flipping them re-renders: subTab,
// respSubTab, sendInFlight, response, varDebug, envVars, the two inline-
// form toggles. Loading flags stay as plain underscore fields so we don't
// re-render when the in-flight state toggles (the render only cares about
// the resulting data).
//
// The splitter drag intentionally bypasses the template — it sets a CSS
// custom property on the host directly. A drag-triggered re-render would
// unmount Monaco and lose its selection/scroll/undo state.

import { MelodicComponent, html, css, signal } from '@melodicdev/core';
import { unsafeHTML } from '@melodicdev/core/template';
import type { IElementRef, OnCreate, OnDestroy, OnRender } from '@melodicdev/core/components';
import { rpc } from '@ipc/renderer';
import type { RequestSendResult, SentRequest } from '@ipc/types';
import { requests as requestsSignal } from '../store/state.js';
import { toCurl } from './curl.js';

interface RequestDraftLocal {
  /** Display name on the sidebar tree + tab strip. Editable in the request pane. */
  name: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body?: { kind: string; raw: string };
  auth?: { kind: string; data?: Record<string, string> };
  // Identifier used by response-chaining (`{{name.response.body.$.x}}`).
  // Optional — most requests won't set this. Persisted via the `chainName`
  // field on the saved request.
  chainName?: string;
}

type SubTab = 'params' | 'headers' | 'body' | 'auth' | 'vars' | 'curl';
type RespSubTab = 'body' | 'headers' | 'raw';
type Response = RequestSendResult['result'] | null;

// In-memory cache of per-request UI state — last response, the wire-form
// of the sent request, and which sub-tab + response sub-tab the user had
// open. Survives tab-switches (the component is destroyed and recreated,
// but the Map lives at module scope) but is wiped on app close — by
// design, not persisted to disk.
interface SessionState {
  response?: NonNullable<Response>;
  sentRequest?: SentRequest | null;
  subTab?: SubTab;
  respSubTab?: RespSubTab;
}
const sessionResponses = new Map<string, SessionState>();

function patchSession(key: string, patch: SessionState): void {
  const existing = sessionResponses.get(key) ?? {};
  sessionResponses.set(key, { ...existing, ...patch });
}
interface VarDebugRow { name: string; value?: string; source?: string; isSecret?: boolean }
// One rung of the resolver chain that contributes vars to the request.
// folderName labels the source for the Vars sub-tab badge; envName labels
// the active env at that folder. `vars` is empty when no env is active at
// that level — the level is shown anyway so the UI surfaces the chain.
type EnvVarsList = {
  envId: string;
  envName: string;
  folderName: string;
  vars: { id: string; key: string; valuePlain?: string; isSecret: boolean }[];
}[];

const MIN_REQUEST_PANE = 120;
const DEFAULT_REQUEST_PANE = 360;
const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((v) => ({
  value: v,
  label: v,
}));
const BODY_KIND_OPTIONS = ['none', 'text', 'json', 'form', 'multipart', 'graphql'].map((v) => ({
  value: v,
  label: v,
}));
const AUTH_KIND_OPTIONS = ['none', 'bearer', 'basic', 'api-key'].map((v) => ({
  value: v,
  label: v,
}));

@MelodicComponent({
  selector: 'hu-request-tab',
  attributes: ['data-tab-id', 'data-request-id'],
  template: (c: RequestTabComponent) => {
    // Read these signals to subscribe; the actual values are pulled from
    // `c.draft` (non-reactive) and these signals once below.
    c.draftVersion();
    const draft = c.draft;
    const response = c.response();
    const sendInFlight = c.sendInFlight();

    return html`
      <div class="name-row">
        <ml-input
          class="request-name"
          type="text"
          size="md"
          placeholder="Request name"
          .value=${draft.name}
          style="flex:1;font-weight:600;"
          @ml:input=${c.handleInput}
          @ml:change=${c.handleInput}
        ></ml-input>
      </div>
      <div class="chain-row">
        <span>Chain name:</span>
        <ml-input
          class="chain-name"
          type="text"
          size="sm"
          placeholder="e.g. getToken (lets other requests use {{name.response.body.$.x}})"
          .value=${draft.chainName ?? ''}
          style="flex:1;max-width:480px;"
          @ml:input=${c.handleInput}
          @ml:change=${c.handleInput}
        ></ml-input>
      </div>

      <div class="req-bar">
        <ml-select
          class="method"
          size="md"
          style="width: 110px;"
          .options=${METHOD_OPTIONS}
          .value=${draft.method}
          @ml:change=${c.handleInput}
        ></ml-select>
        <ml-input
          class="url"
          type="text"
          placeholder="https://example.com/path"
          .value=${draft.url}
          style="flex: 1; min-width: 0;"
          @ml:input=${c.handleInput}
          @ml:change=${c.handleInput}
        ></ml-input>
        <ml-button
          variant="primary"
          ?loading=${sendInFlight}
          @ml:click=${c.handleSend}
          >${sendInFlight ? 'Sending' : 'Send'}</ml-button
        >
      </div>

      <div class="request-pane">${renderRequestSubTabs(c)}</div>

      <div class="splitter" @mousedown=${c.handleSplitterDown}></div>

      <div class="response-pane">
        <div class="response-status">${renderResponseStatus(c, response)}</div>
        ${renderResponseSubTabs(c, response)}
      </div>
    `;
  },
  styles: () => css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      min-width: 0;
    }
    .name-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px 8px;
    }
    .chain-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 16px 0;
      color: var(--hu-text-muted);
      font-size: 11px;
      background: var(--hu-bg-elevated);
      flex-shrink: 0;
    }
    .req-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      background: var(--hu-bg-elevated);
      border-bottom: 1px solid var(--hu-border);
      flex-shrink: 0;
      min-width: 0;
    }
    /* Give the URL input visual weight — it's the most important control on
       the screen, so a slightly bolder font + monospace digits + a soft
       focus ring make it feel like the central action. */
    .req-bar .url {
      font-family: var(--hu-font-mono);
      font-size: 13px;
      font-feature-settings: 'cv02', 'cv03', 'tnum';
    }
    .req-bar .url::part(input) {
      letter-spacing: -0.005em;
    }
    .req-bar ml-button {
      min-width: 88px;
    }
    .request-pane {
      height: var(--hu-request-pane-height, ${DEFAULT_REQUEST_PANE}px);
      min-height: ${MIN_REQUEST_PANE}px;
      min-width: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .splitter {
      height: 6px;
      cursor: row-resize;
      background: var(--hu-border);
      border-top: 1px solid var(--hu-border);
      border-bottom: 1px solid var(--hu-border);
      flex-shrink: 0;
      transition: background 120ms ease;
    }
    .splitter:hover {
      background: var(--hu-accent);
    }
    .response-pane {
      flex: 1;
      min-height: 80px;
      min-width: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .response-status {
      display: flex;
      align-items: center;
      padding: 10px 16px;
      border-bottom: 1px solid var(--hu-border);
      min-height: 36px;
      background: var(--hu-bg-elevated);
      flex-shrink: 0;
      min-width: 0;
    }
    .sub-tabs {
      flex: 1;
      min-height: 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .sub-tab-strip {
      display: flex;
      align-items: stretch;
      border-bottom: 1px solid var(--hu-border);
      flex-shrink: 0;
      background: var(--hu-bg-elevated);
      padding: 0 6px;
      gap: 2px;
    }
    .sub-tab-btn {
      background: transparent;
      border: none;
      color: var(--hu-text-secondary);
      padding: 10px 14px 9px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      position: relative;
      transition:
        background var(--hu-motion-fast) var(--hu-ease-out),
        color var(--hu-motion-fast) var(--hu-ease-out);
    }
    .sub-tab-btn::after {
      content: '';
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 0;
      height: 2px;
      border-radius: 2px 2px 0 0;
      background: var(--hu-accent);
      transform: scaleX(0);
      transform-origin: center;
      transition: transform var(--hu-motion-base) var(--hu-ease-out);
    }
    .sub-tab-btn:hover {
      color: var(--hu-text-primary);
      background: var(--hu-bg-hover);
    }
    .sub-tab-btn[data-active='true'] {
      color: var(--hu-text-primary);
      font-weight: 600;
    }
    .sub-tab-btn[data-active='true']::after {
      transform: scaleX(1);
    }
    .sub-tab-btn:focus-visible {
      outline: 2px solid var(--hu-accent);
      outline-offset: -2px;
      border-radius: var(--hu-radius-sm);
    }
    .sub-tab-host {
      flex: 1;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      background: var(--hu-bg-base);
      display: flex;
      flex-direction: column;
    }
    .sub-panel {
      flex: 1;
      min-height: 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .sub-panel[data-scroll='auto'] {
      overflow: auto;
    }
    .sub-panel[data-scroll='hidden'] {
      overflow: hidden;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      color: white;
      border-radius: var(--hu-radius-md);
      font-family: var(--hu-font-mono);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.01em;
      box-shadow:
        var(--hu-highlight-inset),
        var(--hu-shadow-xs);
    }
    .status-meta {
      color: var(--hu-text-secondary);
      margin-left: 14px;
      font-size: 12px;
      font-family: var(--hu-font-mono);
      font-feature-settings: 'tnum';
    }
    .no-response {
      color: var(--hu-text-muted);
      font-style: italic;
      font-size: 12px;
    }
    .response-empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--hu-text-muted);
      font-size: 13px;
      font-style: italic;
    }
    .editor-wrap {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      border: 1px solid var(--hu-border);
      border-radius: var(--hu-radius-md);
    }
    .editor-wrap http-monaco-editor {
      position: absolute;
      inset: 0;
      display: block;
    }
    .response-text {
      flex: 1;
      min-height: 0;
      min-width: 0;
      overflow: auto;
      padding: 12px;
      font-family: var(--hu-font-mono);
      font-size: 12px;
      color: var(--hu-text-primary);
      white-space: pre-wrap;
      word-break: break-all;
    }
    .kv-table {
      width: 100%;
      border-collapse: collapse;
    }
    .kv-table thead th {
      text-align: left;
      color: var(--hu-text-muted);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 8px 10px;
    }
    .kv-table td {
      padding: 2px 10px;
    }
    .body-panel,
    .auth-panel,
    .params-panel,
    .headers-panel,
    .vars-panel,
    .curl-panel {
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      /* Allow children to shrink below their content's intrinsic min-width;
         without this, long unbreakable strings (JWTs) keep the table wider
         than the viewport even with table-layout: fixed. */
      min-width: 0;
    }
    .var-section {
      min-width: 0;
    }
    .body-panel,
    .curl-panel {
      flex: 1;
      min-height: 0;
      box-sizing: border-box;
    }
    .body-empty {
      padding: 24px;
      text-align: center;
      color: var(--hu-text-muted);
      font-size: 13px;
    }
    /* Note block above the Vars table — horizontal padding matches the
       kv-table cells (10px) so the label and helper text align with the
       column header row below it. */
    .vars-note {
      padding: 0 10px;
      margin-bottom: 8px;
    }
    .vars-note-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--hu-text-muted);
      padding: 8px 0 4px;
    }
    .vars-help {
      color: var(--hu-text-muted);
      font-size: 11px;
      line-height: 1.5;
    }
    .vars-help code {
      font-family: var(--hu-font-mono);
      background: var(--hu-bg-hover);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .var-section h4 {
      margin: 0 0 8px;
      font-size: 0.95em;
      color: var(--hu-text-secondary);
    }
    .secret-mask {
      letter-spacing: 0.2em;
    }
    .empty-envs {
      padding: 16px;
      text-align: center;
      color: var(--hu-text-muted);
      font-size: 13px;
    }
    .empty-envs strong[data-tone='accent'] {
      color: var(--hu-accent);
    }
    .empty-envs strong[data-tone='warning'] {
      color: var(--hu-warning);
    }
    /* The Vars and refs panels reuse the .kv-table styling from Headers/
       Params so all three panels look identical. Only Vars-specific bits
       live below. */
    .var-section .kv-table {
      table-layout: fixed;
    }
    .var-section .kv-table td {
      overflow-wrap: anywhere;
      word-break: break-all;
      max-width: 0;
    }
    .var-section .var-from {
      font-size: 11.5px;
      color: var(--hu-text-secondary);
    }
    .var-section .var-from-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .var-section .overridden-pill {
      display: inline-block;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--hu-bg-active);
      color: var(--hu-text-secondary);
      letter-spacing: 0.02em;
    }
    .var-section .var-source {
      font-family: var(--hu-font-mono);
    }
    .refs-table td.ref-src {
      font-size: 0.85em;
      color: var(--hu-text-secondary);
    }
    .secret-input-row {
      background: var(--hu-bg-hover);
    }
    .secret-input-row-inner {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .secret-input-row-inner strong {
      color: var(--hu-text-primary);
      font-family: var(--hu-font-mono);
    }
    .curl-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
    }
  `,
})
class RequestTabComponent implements IElementRef, OnCreate, OnDestroy, OnRender {
  elementRef!: HTMLElement;

  // Non-reactive — mutating fields on this object never triggers a re-render.
  // Bump `draftVersion` to force one (used after structural changes like
  // adding a header or switching body kind, not URL keystrokes).
  draft: RequestDraftLocal = { name: '', method: 'GET', url: '', headers: [] };
  draftVersion = signal(0);

  // Reactive — flipping these re-renders the template.
  response = signal<Response>(null);
  // The wire-form of the last request, post variable resolution. Used by
  // the Raw response transcript so what's shown matches what the server
  // received rather than the template the user typed.
  sentRequest = signal<SentRequest | null>(null);
  subTab = signal<SubTab>('params');
  respSubTab = signal<RespSubTab>('body');
  sendInFlight = signal(false);
  varDebug = signal<VarDebugRow[] | null>(null);
  envVars = signal<EnvVarsList | null>(null);
  overrides = signal<{ key: string; valuePlain?: string; isSecret: boolean }[] | null>(null);
  /** Key of the override-row currently in edit mode (input visible). */
  editingOverrideKey = signal<string | null>(null);
  /**
   * When a secret row is clicked the user picks plaintext or secret — this
   * routes the next save to either `valuePlain` or `valueSecret`. Tracks the
   * choice from the picker through to commit.
   */
  editingOverrideKind = signal<'plain' | 'secret'>('plain');
  /** Key of the secret row currently showing its plaintext/secret picker. */
  secretPickerKey = signal<string | null>(null);

  // Underscore-prefixed so the framework's observe() skips them.
  private _varDebugLoading = false;
  private _envVarsLoading = false;
  private _overridesLoading = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _requestPaneHeight: number = (() => {
    const stored =
      typeof localStorage !== 'undefined' ? localStorage.getItem('hu-request-pane-height') : null;
    const n = stored ? Number(stored) : NaN;
    return Number.isFinite(n) && n >= MIN_REQUEST_PANE ? n : DEFAULT_REQUEST_PANE;
  })();
  private _dragging = false;
  private _dragStartY = 0;
  private _dragStartHeight = 0;
  // Focus-after-render targets. Set when we open an inline form so the next
  // render moves focus into the freshly-mounted ml-input.
  private _focusNext: '.override-value' | null = null;

  get tabId(): string {
    return this.elementRef.dataset.tabId ?? 'unknown';
  }
  get requestId(): string {
    return this.elementRef.dataset.requestId ?? '';
  }

  bumpDraft(): void {
    this.draftVersion.update((n) => n + 1);
  }

  scheduleSave(): void {
    if (this._saveTimer !== null) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      void this.save();
    }, 500);
  }

  async save(): Promise<void> {
    const id = this.requestId;
    if (!id) return;
    try {
      const trimmedName = this.draft.name.trim();
      const patch: Record<string, unknown> = {
        // Skip name when empty so we don't overwrite the stored value with
        // a blank — the input stays editable but the persisted name doesn't
        // disappear if the user clears it.
        ...(trimmedName !== '' ? { name: trimmedName } : {}),
        method: this.draft.method,
        url: this.draft.url,
        headers: this.draft.headers,
        // Always include chainName so blanking the field actually clears the
        // stored value. `null` is the explicit "clear" signal honored by
        // Repos.Requests.update; `undefined` would be a no-op.
        chainName: this.draft.chainName ?? null,
      };
      if (this.draft.body !== undefined) patch.body = this.draft.body;
      if (this.draft.auth !== undefined) patch.auth = this.draft.auth;
      await rpc({ kind: 'request:save', requestId: id, patch: patch });
      // Reflect name changes in the sidebar tree and tab strip without a
      // round-trip — both read from this signal.
      if (trimmedName !== '') {
        const list = requestsSignal();
        const idx = list.findIndex((r) => r.id === id);
        if (idx >= 0 && list[idx]!.name !== trimmedName) {
          const next = [...list];
          next[idx] = { ...list[idx]!, name: trimmedName };
          requestsSignal.set(next);
        }
      }
    } catch (err) {
      // Quiet failure: autosave runs frequently and we don't toast on each.
      console.error('autosave failed:', err);
    }
  }

  async loadDraft(): Promise<void> {
    const id = this.requestId;
    if (!id) return;
    try {
      const r = await rpc<{
        id: string;
        name: string;
        method: string;
        url: string;
        headers: { key: string; value: string }[];
        bodyText: string;
        bodyKind: string;
        auth: { kind: string; data?: Record<string, string> };
        chainName?: string;
      }>({ kind: 'request:get', requestId: id });
      const next: RequestDraftLocal = {
        name: r.name,
        method: r.method,
        url: r.url,
        headers: r.headers,
      };
      if (r.bodyText !== '' || r.bodyKind !== 'none') {
        next.body = { kind: r.bodyKind, raw: r.bodyText };
      }
      if (r.auth) {
        next.auth = r.auth;
      }
      if (r.chainName !== undefined) {
        next.chainName = r.chainName;
      }
      this.draft = next;
      this.bumpDraft();
    } catch (err) {
      console.error('loadDraft failed:', err);
    }
  }

  async fetchVarDebug(): Promise<void> {
    const id = this.requestId;
    if (!id) {
      this.varDebug.set([]);
      this._varDebugLoading = false;
      return;
    }
    try {
      const r = await rpc<{ refs: VarDebugRow[] }>({ kind: 'var:resolve', requestId: id });
      this.varDebug.set(r.refs);
    } catch (err) {
      console.error('var:resolve failed:', err);
      this.varDebug.set([]);
    } finally {
      this._varDebugLoading = false;
    }
  }

  async fetchEnvVars(): Promise<void> {
    const id = this.requestId;
    if (!id) {
      this.envVars.set([]);
      this._envVarsLoading = false;
      return;
    }
    try {
      const r = await rpc<{
        chain: {
          scopeKind: 'folder' | 'directory';
          scopeId: string;
          scopeName: string;
          env: { id: string; name: string; isActive: boolean } | null;
        }[];
      }>({ kind: 'env:listForRequest', requestId: id });
      const out: EnvVarsList = [];
      // The chain comes root → leaf so the UI naturally reads outer-to-inner.
      // Only include steps that have an active env — steps without one have
      // nothing to display.
      for (const step of r.chain) {
        if (!step.env) continue;
        const vars = await rpc<
          { id: string; key: string; valuePlain?: string; isSecret: boolean }[]
        >({ kind: 'var:list', envId: step.env.id });
        out.push({
          envId: step.env.id,
          envName: step.env.name,
          folderName: step.scopeName,
          vars,
        });
      }
      this.envVars.set(out);
    } catch (err) {
      console.error('env:listForRequest / var:list failed:', err);
      this.envVars.set([]);
    } finally {
      this._envVarsLoading = false;
    }
  }

  maskHeaderKeysForCurl(): Set<string> {
    // For v1, mask Authorization. Future: also mask any header whose value is
    // a known secret var.
    return new Set(['authorization']);
  }

  // === lifecycle ===

  onCreate(): void {
    // Apply the persisted splitter height as a CSS var on the host.
    this.elementRef.style.setProperty('--hu-request-pane-height', `${this._requestPaneHeight}px`);
    // Blur saves for per-request override values: capture-phase for focusout
    // (which doesn't bubble) plus ml:change for ml-input wrappers. Both flow
    // through the same handler that filters by target class.
    this.elementRef.addEventListener('focusout', this._handleOverrideBlur, true);
    this.elementRef.addEventListener('ml:change', this._handleOverrideBlur);
    // Restore last response + which sub-tabs were active for this request
    // from the in-memory session cache — so tab-switching back to a request
    // shows its previous response AND the same sub-tab the user left it
    // on. Cache lives only for the lifetime of the app process; it's
    // never written to disk.
    const cacheKey = this.requestId || this.tabId;
    const cached = sessionResponses.get(cacheKey);
    if (cached) {
      if (cached.response !== undefined) this.response.set(cached.response);
      if (cached.sentRequest !== undefined) this.sentRequest.set(cached.sentRequest);
      if (cached.subTab !== undefined) this.subTab.set(cached.subTab);
      if (cached.respSubTab !== undefined) this.respSubTab.set(cached.respSubTab);
    }
    void this.loadDraft();
  }

  onRender(): void {
    if (this._focusNext) {
      const sel = this._focusNext;
      this._focusNext = null;
      const root = this.elementRef.shadowRoot;
      if (root) focusMlInput(root.querySelector(sel));
    }
  }

  onDestroy(): void {
    this.elementRef.removeEventListener('focusout', this._handleOverrideBlur, true);
    this.elementRef.removeEventListener('ml:change', this._handleOverrideBlur);
    document.removeEventListener('mousemove', this._handleSplitterMove);
    document.removeEventListener('mouseup', this._handleSplitterUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Flush a pending autosave so the trailing edit isn't lost when the user
    // closes the tab or navigates away inside the debounce window.
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      void this.save();
    }
  }

  // === splitter drag ===

  handleSplitterDown = (e: MouseEvent): void => {
    this._dragging = true;
    this._dragStartY = e.clientY;
    this._dragStartHeight = this._requestPaneHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', this._handleSplitterMove);
    document.addEventListener('mouseup', this._handleSplitterUp);
    e.preventDefault();
  };

  private _handleSplitterMove = (e: MouseEvent): void => {
    if (!this._dragging) return;
    const dy = e.clientY - this._dragStartY;
    const newHeight = Math.max(MIN_REQUEST_PANE, this._dragStartHeight + dy);
    this._requestPaneHeight = newHeight;
    // Direct CSS-var update — never re-render during drag, that would dispose
    // & recreate Monaco and lose its selection/scroll/undo state.
    this.elementRef.style.setProperty('--hu-request-pane-height', `${newHeight}px`);
  };

  private _handleSplitterUp = (): void => {
    if (!this._dragging) return;
    this._dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', this._handleSplitterMove);
    document.removeEventListener('mouseup', this._handleSplitterUp);
    try {
      localStorage.setItem('hu-request-pane-height', String(this._requestPaneHeight));
    } catch {
      // localStorage may be unavailable (e.g. file:// in some sandboxes).
    }
  };

  // === input handling ===

  // Both native (input/change) and Melodic (ml:input/ml:change) events flow
  // through here. Melodic events carry { value } in detail; native events
  // expose target.value directly. extractValue prefers detail.value when
  // present so the rest of the logic doesn't need to branch.
  handleInput = (e: Event): void => {
    const target = e.target as HTMLElement & { value?: string; dataset: DOMStringMap };
    const value = extractValue(e);

    if (target.classList.contains('request-name')) {
      this.draft.name = value;
      this.scheduleSave();
      this.bumpDraft();
      return;
    }
    if (target.classList.contains('method')) {
      this.draft.method = value;
      this.scheduleSave();
      return;
    }
    if (target.classList.contains('url')) {
      this.draft.url = value;
      this.scheduleSave();
      // No re-render on URL keystrokes — that would steal focus from the
      // ml-input and break typing. The Params panel only needs the parsed
      // URL when the user opens it, and the input already shows the live
      // value.
      return;
    }
    if (target.classList.contains('chain-name')) {
      // Empty string clears the chain name. Persisted as NULL via save().
      // Using delete to keep the property absent under
      // exactOptionalPropertyTypes.
      if (value === '') delete this.draft.chainName;
      else this.draft.chainName = value;
      this.scheduleSave();
      return;
    }
    if (target.classList.contains('body-kind')) {
      if (value === 'none') {
        delete this.draft.body;
      } else {
        this.draft.body = { kind: value, raw: this.draft.body?.raw ?? '' };
      }
      this.scheduleSave();
      this.bumpDraft();
      return;
    }
    if (target.classList.contains('auth-kind')) {
      this.draft.auth = { kind: value, data: {} };
      this.scheduleSave();
      this.bumpDraft();
      return;
    }
    if (target.classList.contains('auth-field')) {
      const field = target.dataset.field;
      if (this.draft.auth && field) {
        this.draft.auth.data = { ...(this.draft.auth.data ?? {}), [field]: value };
        this.scheduleSave();
      }
      return;
    }
    if (target.classList.contains('kv-input')) {
      const tr = target.closest('tr');
      const tbody = target.closest<HTMLElement>('.kv-rows');
      if (!tr || !tbody) return;
      const group = tbody.dataset.group;
      const index = Number(tr.dataset.index);
      const field = target.dataset.field;
      if (group === 'params') {
        // Template-safe — works for both `{{baseUrl}}/x?a=1` and real URLs.
        const { base, params } = splitUrlAtQuery(this.draft.url);
        if (params[index]) {
          if (field === 'key') params[index].key = value;
          if (field === 'value') params[index].value = value;
          this.draft.url = joinUrlWithParams(base, params);
          this.scheduleSave();
        }
      } else if (group === 'headers') {
        if (this.draft.headers[index]) {
          if (field === 'key') this.draft.headers[index].key = value;
          if (field === 'value') this.draft.headers[index].value = value;
          this.scheduleSave();
        }
      }
    }
  };

  handleMonacoChange = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('body-editor')) {
      const value = (e as CustomEvent<{ value: string }>).detail?.value ?? '';
      if (this.draft.body) {
        this.draft.body.raw = value;
        this.scheduleSave();
      }
    }
  };

  // === sub-tab handling ===

  selectSubTab = (tab: SubTab): void => {
    // When leaving Vars, drop the cached envVars/varDebug so the next visit
    // re-fetches fresh (picks up env-switcher / IPC mutations).
    if (this.subTab() === 'vars' && tab !== 'vars') {
      this.varDebug.set(null);
      this.envVars.set(null);
      this.overrides.set(null);
    }
    this.subTab.set(tab);
    patchSession(this.requestId || this.tabId, { subTab: tab });
  };

  selectRespSubTab = (tab: RespSubTab): void => {
    this.respSubTab.set(tab);
    patchSession(this.requestId || this.tabId, { respSubTab: tab });
  };

  // === send ===

  handleSend = async (): Promise<void> => {
    if (this.sendInFlight()) return;
    this.sendInFlight.set(true);
    try {
      const r = await rpc<RequestSendResult>({
        kind: 'request:send',
        tabId: this.tabId,
        requestId: this.requestId || this.tabId,
        draftJson: {
          method: this.draft.method,
          url: this.draft.url,
          headers: this.draft.headers,
          ...(this.draft.body ? { body: this.draft.body } : {}),
          ...(this.draft.auth ? { auth: this.draft.auth } : {}),
        },
      });
      this.response.set(r.result);
      this.sentRequest.set(r.sentRequest);
      patchSession(this.requestId || this.tabId, {
        response: r.result,
        sentRequest: r.sentRequest,
      });
    } catch (err: unknown) {
      const errResponse: NonNullable<Response> = {
        id: 'err',
        ok: false,
        category: 'unknown',
        message: (err as Error).message,
      };
      this.response.set(errResponse);
      this.sentRequest.set(null);
      patchSession(this.requestId || this.tabId, {
        response: errResponse,
        sentRequest: null,
      });
    } finally {
      this.sendInFlight.set(false);
    }
  };

  // === KV grid (params / headers) ===

  addKVRow = (group: 'params' | 'headers'): void => {
    if (group === 'headers') {
      this.draft.headers.push({ key: '', value: '' });
    } else {
      const { base, params } = splitUrlAtQuery(this.draft.url);
      params.push({ key: '', value: '' });
      this.draft.url = joinUrlWithParams(base, params);
    }
    this.bumpDraft();
  };

  removeKVRow = (group: 'params' | 'headers', index: number): void => {
    if (group === 'headers') {
      this.draft.headers.splice(index, 1);
    } else {
      const { base, params } = splitUrlAtQuery(this.draft.url);
      params.splice(index, 1);
      this.draft.url = joinUrlWithParams(base, params);
    }
    this.bumpDraft();
  };

  // === cURL ===

  handleCopyCurl = async (): Promise<void> => {
    const curl = toCurl(
      {
        method: this.draft.method,
        url: this.draft.url,
        headers: this.draft.headers,
        ...(this.draft.body ? { body: this.draft.body } : {}),
      },
      this.maskHeaderKeysForCurl(),
    );
    try {
      await navigator.clipboard.writeText(curl);
    } catch {
      /* */
    }
  };

  // === vars sub-tab actions ===

  handleRevealSecret = (name: string): void => {
    const vars = this.varDebug();
    if (!vars) return;
    const entry = vars.find((v) => v.name === name);
    if (!entry) return;
    // The decrypted value is already in entry.value (var:resolve calls
    // buildScopesForRequest which decrypts via Secrets). We only flip the
    // mask flag; the value never round-trips. Re-mask after 10 s so a stale
    // panel doesn't keep secrets visible indefinitely.
    entry.isSecret = false;
    this.varDebug.set([...vars]);
    setTimeout(() => {
      const list = this.varDebug();
      if (!list) return;
      const cur = list.find((v) => v.name === name);
      if (cur) {
        cur.isSecret = true;
        this.varDebug.set([...list]);
      }
    }, 10000);
  };

  startOverride = (key: string, kind: 'plain' | 'secret' = 'plain'): void => {
    this._focusNext = '.override-value';
    this.editingOverrideKind.set(kind);
    this.secretPickerKey.set(null);
    this.editingOverrideKey.set(key);
  };

  cancelOverrideEdit = (): void => {
    this.editingOverrideKey.set(null);
    this.secretPickerKey.set(null);
  };

  clearOverride = async (key: string): Promise<void> => {
    const id = this.requestId;
    if (!id) return;
    try {
      await rpc({ kind: 'request:overrides:delete', requestId: id, key });
      this.overrides.set(null);
      this.varDebug.set(null);
    } catch (err) {
      console.error('request:overrides:delete failed:', err);
    }
  };

  // Save (or delete) a var override from the always-on input in the Vars
  // panel. Empty value → delete the override and revert to the env value.
  // Mirrors commitOverride but doesn't depend on editingOverrideKey state,
  // because the new Vars panel renders inputs unconditionally rather than
  // toggling between view/edit modes.
  saveVarOverride = async (
    key: string,
    kind: 'plain' | 'secret',
    e: Event,
  ): Promise<void> => {
    const id = this.requestId;
    if (!id) return;
    const value = extractValue(e).trim();
    try {
      if (value === '') {
        await rpc({ kind: 'request:overrides:delete', requestId: id, key });
      } else if (kind === 'secret') {
        await rpc({
          kind: 'request:overrides:set',
          requestId: id,
          key,
          valueSecret: value,
        });
      } else {
        await rpc({
          kind: 'request:overrides:set',
          requestId: id,
          key,
          valuePlain: value,
        });
      }
      this.overrides.set(null);
      this.varDebug.set(null);
    } catch (err) {
      console.error('saveVarOverride failed:', err);
    }
  };

  handleOverrideKeyDown = (e: KeyboardEvent, key: string): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void this.commitOverride(key, e);
    } else if (e.key === 'Tab') {
      // Commit synchronously with the keystroke, then let Tab do its normal
      // focus navigation. The follow-up focusout fires after editingOverrideKey
      // is already cleared, so _handleOverrideBlur correctly bails and we
      // don't double-commit.
      void this.commitOverride(key, e);
      // Do not preventDefault — let Tab move focus to the next field.
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelOverrideEdit();
    }
  };

  commitOverride = async (
    key: string,
    e: Event,
    resolvedInput?: HTMLElement & { value?: unknown },
  ): Promise<void> => {
    const id = this.requestId;
    if (!id) {
      this.cancelOverrideEdit();
      return;
    }
    const isSecret = this.editingOverrideKind() === 'secret';
    // Snapshot then clear edit state — the next render shows the read-only cell
    // even before the RPC resolves, which feels snappier and avoids a double
    // event firing (focusout after Enter).
    this.editingOverrideKey.set(null);
    const value = extractValue(e, resolvedInput).trim();
    try {
      if (value === '') {
        await rpc({ kind: 'request:overrides:delete', requestId: id, key });
      } else if (isSecret) {
        await rpc({ kind: 'request:overrides:set', requestId: id, key, valueSecret: value });
      } else {
        await rpc({ kind: 'request:overrides:set', requestId: id, key, valuePlain: value });
      }
      this.overrides.set(null);
      this.varDebug.set(null);
    } catch (err) {
      console.error('request:overrides:set/delete failed:', err);
    }
  };

  // Blur handler for override value inputs. Persist on blur (not keystroke) so
  // we don't write-amplify and so the input stays responsive. After save,
  // drop both the overrides cache and the var debug refs so the next Vars
  // visit refetches.
  // Why composedPath: by the time the listener fires at the request-tab
  // host level, the event has crossed the ml-input shadow boundary AND the
  // request-tab shadow boundary, so `e.target` has been retargeted to the
  // request-tab host. composedPath() preserves the original chain so we can
  // find the actual ml-input that was edited. Same fix in env-manager.ts.
  private _handleOverrideBlur = async (e: Event): Promise<void> => {
    const mlInput = e
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.classList.contains('override-value'),
      );
    if (!mlInput) return;
    const key = mlInput.dataset.varKey;
    if (!key) return;
    // Only commit if we're still in edit mode for this key — the Enter handler
    // may have cleared editingOverrideKey already, in which case the RPC fired.
    if (this.editingOverrideKey() !== key) return;
    await this.commitOverride(key, e, mlInput);
  };

  // Kicks off all three Vars fetches if needed. Called as a side effect of the
  // Vars panel rendering — same lazy-load pattern as the original.
  ensureVarsLoaded(): void {
    if (this.varDebug() === null && !this._varDebugLoading) {
      this._varDebugLoading = true;
      void this.fetchVarDebug();
    }
    if (this.envVars() === null && !this._envVarsLoading) {
      this._envVarsLoading = true;
      void this.fetchEnvVars();
    }
    if (this.overrides() === null && !this._overridesLoading) {
      this._overridesLoading = true;
      void this.fetchOverrides();
    }
  }

  async fetchOverrides(): Promise<void> {
    const id = this.requestId;
    if (!id) {
      this.overrides.set([]);
      this._overridesLoading = false;
      return;
    }
    try {
      const r = await rpc<{ overrides: { key: string; valuePlain?: string; isSecret: boolean }[] }>({
        kind: 'request:overrides:list',
        requestId: id,
      });
      this.overrides.set(r.overrides);
    } catch (err) {
      console.error('request:overrides:list failed:', err);
      this.overrides.set([]);
    } finally {
      this._overridesLoading = false;
    }
  }
}

// === renderers ===

function renderRequestSubTabs(c: RequestTabComponent) {
  const tabs: { key: SubTab; label: string }[] = [
    { key: 'params', label: 'Params' },
    { key: 'headers', label: 'Headers' },
    { key: 'body', label: 'Body' },
    { key: 'auth', label: 'Auth' },
    { key: 'vars', label: 'Vars' },
    { key: 'curl', label: 'cURL' },
  ];
  const active = c.subTab();
  return html`
    <div class="sub-tabs">
      <div class="sub-tab-strip">
        ${tabs.map(
          (t) => html`
            <button
              class="sub-tab-btn"
              data-active=${String(active === t.key)}
              @click=${() => { c.selectSubTab(t.key); }}
            >
              ${t.label}
            </button>
          `,
        )}
      </div>
      <div class="sub-tab-host">${renderActiveRequestPanel(c, active)}</div>
    </div>
  `;
}

function renderActiveRequestPanel(c: RequestTabComponent, active: SubTab) {
  const scroll = active === 'body' || active === 'curl' ? 'hidden' : 'auto';
  const inner =
    active === 'params'
      ? renderParamsPanel(c)
      : active === 'headers'
        ? renderHeadersPanel(c)
        : active === 'body'
          ? renderBodyPanel(c)
          : active === 'auth'
            ? renderAuthPanel(c)
            : active === 'vars'
              ? renderVarsPanel(c)
              : renderCurlPanel(c);
  return html`<div class="sub-panel" data-scroll=${scroll} data-active-tab=${active}>${inner}</div>`;
}

function renderParamsPanel(c: RequestTabComponent) {
  // Template-safe — works for `{{baseUrl}}/x` URLs that `new URL` rejects.
  const { params } = splitUrlAtQuery(c.draft.url);
  return html`<div class="params-panel">${renderKVGrid(c, 'params', params, 'Add param')}</div>`;
}

function renderHeadersPanel(c: RequestTabComponent) {
  return html`<div class="headers-panel">
    ${renderKVGrid(c, 'headers', c.draft.headers, 'Add header')}
  </div>`;
}

function renderKVGrid(
  c: RequestTabComponent,
  group: 'params' | 'headers',
  rows: { key: string; value: string }[],
  addLabel: string,
) {
  return html`
    <table class="kv-table">
      <thead>
        <tr>
          <th style="width:35%">Key</th>
          <th>Value</th>
          <th style="width:32px"></th>
        </tr>
      </thead>
      <tbody class="kv-rows" data-group=${group}>
        ${rows.map(
          (r, i) => html`
            <tr data-index=${i}>
              <td>
                <ml-input
                  class="kv-input"
                  data-field="key"
                  size="sm"
                  type="text"
                  .value=${r.key}
                  style="width:100%"
                  @ml:input=${c.handleInput}
                  @ml:change=${c.handleInput}
                ></ml-input>
              </td>
              <td>
                <ml-input
                  class="kv-input"
                  data-field="value"
                  size="sm"
                  type="text"
                  .value=${r.value}
                  style="width:100%"
                  @ml:input=${c.handleInput}
                  @ml:change=${c.handleInput}
                ></ml-input>
              </td>
              <td style="text-align:center">
                <ml-button
                  variant="ghost"
                  size="sm"
                  title="Remove"
                  @ml:click=${() => { c.removeKVRow(group, i); }}
                >
                  <ml-icon icon="x" size="xs"></ml-icon>
                </ml-button>
              </td>
            </tr>
          `,
        )}
        <tr>
          <td colspan="3" style="padding:8px 10px">
            <ml-button variant="ghost" size="sm" @ml:click=${() => { c.addKVRow(group); }}
              >+ ${addLabel}</ml-button
            >
          </td>
        </tr>
      </tbody>
    </table>
  `;
}

function renderBodyPanel(c: RequestTabComponent) {
  const kind = c.draft.body?.kind ?? 'none';
  const raw = c.draft.body?.raw ?? '';
  const lang = bodyKindToLanguage(kind);
  return html`
    <div class="body-panel">
      <ml-select
        class="body-kind"
        size="md"
        style="width:200px"
        .options=${BODY_KIND_OPTIONS}
        .value=${kind}
        @ml:change=${c.handleInput}
      ></ml-select>
      ${kind === 'none'
        ? html`<div class="body-empty">No body</div>`
        : html`
            <div class="editor-wrap">
              <http-monaco-editor
                class="body-editor"
                language=${lang}
                .value=${raw}
                @ml:change=${c.handleMonacoChange}
              ></http-monaco-editor>
            </div>
          `}
    </div>
  `;
}

function renderAuthPanel(c: RequestTabComponent) {
  const auth = c.draft.auth ?? { kind: 'none' };
  return html`
    <div class="auth-panel">
      <div style="display:flex;gap:8px;align-items:center">
        <span style="font-size:13px;color:var(--hu-text-secondary)">Auth kind:</span>
        <ml-select
          class="auth-kind"
          size="md"
          style="width:160px"
          .options=${AUTH_KIND_OPTIONS}
          .value=${auth.kind}
          @ml:change=${c.handleInput}
        ></ml-select>
      </div>
      ${renderAuthFields(c, auth)}
    </div>
  `;
}

function renderAuthFields(c: RequestTabComponent, auth: { kind: string; data?: Record<string, string> }) {
  const data = auth.data ?? {};
  if (auth.kind === 'bearer') {
    return html`<ml-input
      class="auth-field"
      data-field="token"
      label="Token"
      type="text"
      .value=${data.token ?? ''}
      @ml:input=${c.handleInput}
      @ml:change=${c.handleInput}
    ></ml-input>`;
  }
  if (auth.kind === 'basic') {
    return html`
      <ml-input
        class="auth-field"
        data-field="username"
        label="Username"
        type="text"
        .value=${data.username ?? ''}
        @ml:input=${c.handleInput}
        @ml:change=${c.handleInput}
      ></ml-input>
      <ml-input
        class="auth-field"
        data-field="password"
        label="Password"
        type="password"
        .value=${data.password ?? ''}
        @ml:input=${c.handleInput}
        @ml:change=${c.handleInput}
      ></ml-input>
    `;
  }
  if (auth.kind === 'api-key') {
    return html`
      <ml-input
        class="auth-field"
        data-field="header"
        label="Header name"
        type="text"
        .value=${data.header ?? 'X-API-Key'}
        @ml:input=${c.handleInput}
        @ml:change=${c.handleInput}
      ></ml-input>
      <ml-input
        class="auth-field"
        data-field="value"
        label="Value"
        type="text"
        .value=${data.value ?? ''}
        @ml:input=${c.handleInput}
        @ml:change=${c.handleInput}
      ></ml-input>
    `;
  }
  return html`<div style="color:var(--hu-text-muted);padding:8px">No auth</div>`;
}

function renderVarsPanel(c: RequestTabComponent) {
  // Lazy-load on first render of the panel — same pattern as the original.
  c.ensureVarsLoaded();
  return html`
    <div class="vars-panel">
      <div class="vars-note">
        <div class="vars-note-label">Note</div>
        <div class="vars-help">
          Use
          <code>{{name.response.body.$.field}}</code>
          to reference another named request's last response. Set the chain name on a request via
          the field above its URL bar.
        </div>
      </div>
      ${renderActiveEnvVarsSection(c)}
    </div>
  `;
}

// Single unified table of every var the request will resolve against, with
// per-row click-to-override. All env-var rows are read-only — the user goes to
// Manage Envs to change the underlying values. Orphan overrides (rows where
// the parent env var has been removed) are shown in their own subsection
// below the main table so they can be cleaned up.
function renderActiveEnvVarsSection(c: RequestTabComponent) {
  const list = c.envVars();
  const overrides = c.overrides();
  if (list === null || overrides === null) {
    return html`<section class="var-section">
      <div style="color:var(--hu-text-secondary)">Loading…</div>
    </section>`;
  }
  if (list.length === 0) {
    return html`<section class="var-section">
      <div class="empty-envs">
        <div style="margin-bottom:8px">No active environment in this request's chain.</div>
        <div style="font-size:12px">
          Open this folder's <strong data-tone="accent">Manage envs</strong> action to create one.
        </div>
      </div>
    </section>`;
  }

  interface Row {
    key: string;
    value: string;
    isSecret: boolean;
    source: string;
    overridden: boolean;
    /**
     * 'env' rows are resolved env vars (click-to-override applies).
     * 'chain', 'builtin', 'unresolved' come from referenced-but-not-in-env
     * tokens picked up via var:resolve. Those are read-only — overriding
     * `getToken.response.body.$.x` doesn't make sense.
     */
    kind: 'env' | 'chain' | 'builtin' | 'unresolved';
  }
  // Walk the env chain root → leaf so deeper folders overwrite shallower ones
  // — same deepest-wins semantics the resolver uses.
  const map = new Map<string, Row>();
  for (const env of list) {
    for (const v of env.vars) {
      map.set(v.key, {
        key: v.key,
        value: v.valuePlain ?? '',
        isSecret: v.isSecret,
        source: `${env.folderName} · ${env.envName}`,
        overridden: false,
        kind: 'env',
      });
    }
  }
  // Apply overrides (highest precedence). Track orphans for the section below.
  const orphans: { key: string; valuePlain?: string; isSecret: boolean }[] = [];
  for (const o of overrides) {
    const base = map.get(o.key);
    if (!base) {
      orphans.push(o);
      continue;
    }
    map.set(o.key, {
      key: o.key,
      value: o.isSecret ? '' : (o.valuePlain ?? ''),
      // A row's `isSecret` follows the override — a plaintext override on top
      // of a secret env var displays as plaintext on this request.
      isSecret: o.isSecret,
      source: 'This request',
      overridden: true,
      kind: 'env',
    });
  }
  // Fold in referenced tokens that aren't env vars — chain refs, built-ins,
  // and unresolved `{{x}}` references — so the table covers everything the
  // request actually uses. Chain and built-in rows are read-only; unresolved
  // rows are editable so the user can type a value to supply the missing var.
  // If an override already exists for an otherwise-unresolved key, fold it
  // into the main row so we don't double-render it as both unresolved AND
  // orphan.
  const refs = c.varDebug();
  if (refs) {
    for (const ref of refs) {
      if (map.has(ref.name)) continue;
      const existingOverride = overrides.find((o) => o.key === ref.name);
      if (existingOverride) {
        map.set(ref.name, {
          key: ref.name,
          value: existingOverride.isSecret ? '' : (existingOverride.valuePlain ?? ''),
          isSecret: existingOverride.isSecret,
          source: 'This request',
          overridden: true,
          // Treat as 'env' so the row gets the editable input + override clear.
          kind: 'env',
        });
        continue;
      }
      const kind: Row['kind'] =
        ref.source === 'chain'
          ? 'chain'
          : ref.source === 'builtin'
            ? 'builtin'
            : 'unresolved';
      map.set(ref.name, {
        key: ref.name,
        value: ref.value ?? '',
        isSecret: Boolean(ref.isSecret),
        source: ref.source ?? 'unresolved',
        overridden: false,
        kind,
      });
    }
  }
  const rows = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));

  return html`<section class="var-section">
    <table class="kv-table">
      <thead>
        <tr>
          <th style="width:30%">Key</th>
          <th>Value</th>
          <th style="width:24%">From</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => renderUnifiedVarRow(c, r))}
      </tbody>
    </table>
    ${orphans.length > 0
      ? html`<div style="margin-top:16px">
          <div style="font-size:0.85em;color:var(--hu-text-secondary);margin-bottom:4px">
            Overrides without a matching env var
          </div>
          <table class="kv-table">
            <thead>
              <tr>
                <th style="width:30%">Key</th>
                <th>Value</th>
                <th style="width:32px"></th>
              </tr>
            </thead>
            <tbody>
              ${orphans.map(
                (o) => html`
                  <tr data-orphan-key=${o.key}>
                    <td style="font-family:monospace">${o.key}</td>
                    <td>
                      ${o.isSecret
                        ? html`<span style="color:var(--hu-text-muted)">[secret]</span>`
                        : html`<span>${o.valuePlain ?? ''}</span>`}
                    </td>
                    <td style="text-align:center;width:32px">
                      <ml-button
                        variant="ghost"
                        size="sm"
                        title="Delete override"
                        @ml:click=${() => c.clearOverride(o.key)}
                      >
                        <ml-icon icon="x" size="xs"></ml-icon>
                      </ml-button>
                    </td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>`
      : ''}
  </section>`;
}

function renderUnifiedVarRow(
  c: RequestTabComponent,
  r: {
    key: string;
    value: string;
    isSecret: boolean;
    source: string;
    overridden: boolean;
    kind: 'env' | 'chain' | 'builtin' | 'unresolved';
  },
) {

  // Key cell: disabled input — visually consistent with the Params/Headers
  // tabs, but not editable since var names come from the env, not the user.
  const keyCell = html`<ml-input
    class="kv-input"
    size="sm"
    type="text"
    .value=${r.key}
    disabled
    style="width:100%"
  ></ml-input>`;

  // Value cell: always an input. Env rows + unresolved-template-ref rows
  // are editable; typing commits a per-request override. Chain / built-in
  // rows stay disabled (overriding `{{getToken.response.body.$.x}}` or
  // `{{$timestamp}}` doesn't make sense — those values come from elsewhere).
  let valueCell;
  if (r.kind === 'chain' || r.kind === 'builtin') {
    valueCell = html`<ml-input
      class="kv-input"
      size="sm"
      type="text"
      .value=${r.value}
      disabled
      style="width:100%"
    ></ml-input>`;
  } else if (r.kind === 'unresolved') {
    valueCell = html`<ml-input
      class="kv-input"
      data-var-key=${r.key}
      size="sm"
      type="text"
      .value=${r.value}
      placeholder="unresolved — type a value to override"
      style="width:100%"
      @ml:change=${(e: Event) => void c.saveVarOverride(r.key, 'plain', e)}
    ></ml-input>`;
  } else if (r.isSecret) {
    valueCell = html`<ml-input
      class="kv-input"
      data-var-key=${r.key}
      size="sm"
      type="password"
      placeholder=${r.overridden ? '••• overridden' : '••• secret (type to override)'}
      style="width:100%"
      @ml:change=${(e: Event) => void c.saveVarOverride(r.key, 'secret', e)}
    ></ml-input>`;
  } else {
    valueCell = html`<ml-input
      class="kv-input"
      data-var-key=${r.key}
      size="sm"
      type="text"
      .value=${r.value}
      style="width:100%"
      @ml:change=${(e: Event) => void c.saveVarOverride(r.key, 'plain', e)}
    ></ml-input>`;
  }

  return html`
    <tr data-var-key=${r.key}>
      <td>${keyCell}</td>
      <td>${valueCell}</td>
      <td class="var-from">
        ${r.overridden
          ? html`<span class="var-from-row">
              <span class="overridden-pill">overridden</span>
              <ml-button
                variant="ghost"
                size="xs"
                title="Clear override and revert to the env value"
                @ml:click=${() => c.clearOverride(r.key)}
              >
                <ml-icon icon="x" size="xs"></ml-icon>
              </ml-button>
            </span>`
          : html`<span class="var-source">${r.source}</span>`}
      </td>
    </tr>
  `;
}

function renderCurlPanel(c: RequestTabComponent) {
  const curl = toCurl(
    {
      method: c.draft.method,
      url: c.draft.url,
      headers: c.draft.headers,
      ...(c.draft.body ? { body: c.draft.body } : {}),
    },
    c.maskHeaderKeysForCurl(),
  );
  return html`
    <div class="curl-panel">
      <div class="curl-header-row">
        <span style="color:var(--hu-text-secondary);font-size:0.9em">Equivalent cURL</span>
        <ml-button variant="ghost" @ml:click=${c.handleCopyCurl}>Copy</ml-button>
      </div>
      <div class="editor-wrap">
        <http-monaco-editor language="shell" readonly .value=${curl}></http-monaco-editor>
      </div>
    </div>
  `;
}

function renderResponseStatus(c: RequestTabComponent, r: Response) {
  if (!r) return html`<span class="no-response">No response yet</span>`;
  if (r.ok) {
    return html`
      <span class="status-pill" style=${`background:${statusColor(r.status)}`}
        >${r.status}</span
      >
      <span class="status-meta">${r.ms} ms · ${formatBytes(r.sizeBytes)}</span>
    `;
  }
  const unresolved = findUnresolvedTokens(c);
  if (r.category === 'invalid' && unresolved.length > 0) {
    return html`
      <span class="status-pill" style="background:var(--hu-danger)">UNRESOLVED VARS</span>
      <span class="status-meta">
        ${unresolved.map((u) => html`<code>${u}</code>`).reduce<unknown>(
          (acc, el, i) => (i === 0 ? [el] : [...(acc as unknown[]), ', ', el]),
          [],
        )}
        · open
        <a
          href="#"
          class="text-link"
          @click=${(e: MouseEvent) => {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent('hu:open-env-manager'));
          }}
          >Manage Envs</a
        >
        to set an active environment
      </span>
    `;
  }
  return html`
    <span class="status-pill" style="background:var(--hu-danger)"
      >${r.category.toUpperCase()}</span
    >
    <span class="status-meta">${r.message}</span>
  `;
}

// Scan the request's URL, headers, and body for `{{name}}` tokens — used to
// produce a friendlier error than "Invalid URL" when the user fires a
// request that has unresolved template variables (almost always because no
// env is active in this folder's chain).
function findUnresolvedTokens(c: RequestTabComponent): string[] {
  const found = new Set<string>();
  const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;
  const collect = (s: string): void => {
    for (const match of s.matchAll(TOKEN)) {
      const name = match[1]!;
      // Skip chain references and built-ins — those aren't fixed by
      // setting an active env, so the "Manage Envs" hint would mislead.
      if (name.includes('.response.')) continue;
      if (name.startsWith('$')) continue;
      found.add(`{{${name}}}`);
    }
  };
  collect(c.draft.url);
  for (const h of c.draft.headers) {
    collect(h.key);
    collect(h.value);
  }
  if (c.draft.body) collect(c.draft.body.raw);
  return [...found];
}

function renderResponseSubTabs(c: RequestTabComponent, r: Response) {
  const tabs: RespSubTab[] = ['body', 'headers', 'raw'];
  const active = c.respSubTab();
  return html`
    <div class="sub-tabs">
      <div class="sub-tab-strip">
        ${tabs.map(
          (t) => html`
            <button
              class="sub-tab-btn"
              data-active=${String(active === t)}
              @click=${() => { c.selectRespSubTab(t); }}
            >
              ${t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          `,
        )}
      </div>
      <div class="sub-tab-host">${renderActiveResponsePanel(c, r, active)}</div>
    </div>
  `;
}

function renderActiveResponsePanel(c: RequestTabComponent, r: Response, active: RespSubTab) {
  if (!r) {
    return html`<div class="response-empty">
      No response yet — click Send to make a request.
    </div>`;
  }
  if (active === 'body') {
    const lang = responseLanguage(r);
    const text = responseBodyText(r);
    return html`
      <div class="sub-panel" data-scroll="hidden">
        <http-monaco-editor
          language=${lang}
          readonly
          .value=${text}
          style="display:block;flex:1;min-height:0;width:100%;"
        ></http-monaco-editor>
      </div>
    `;
  }
  if (active === 'headers') {
    return html`<div class="response-text">${responseHeadersPreview(r)}</div>`;
  }
  return html`<div class="response-text">${responseRawPreview(c, r)}</div>`;
}

// === pure helpers ===

function bodyKindToLanguage(kind: string): string {
  if (kind === 'json' || kind === 'graphql') return 'json';
  return 'plaintext';
}

// Map HTTP status code to a semantic color from the design tokens. We reuse
// the method tokens for 2xx/3xx so the response chrome echoes the rest of
// the UI palette without introducing new tokens.
function statusColor(status: number): string {
  if (status >= 200 && status < 300) return 'var(--hu-method-post)';
  if (status >= 300 && status < 400) return 'var(--hu-method-get)';
  if (status >= 400 && status < 500) return 'var(--hu-warning)';
  return 'var(--hu-danger)';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function responseBodyText(r: NonNullable<Response>): string {
  if (!r.ok) return `${r.category}: ${r.message}`;
  if (r.bodyBytes.byteLength === 0) return '(empty body)';
  try {
    const text = new TextDecoder().decode(r.bodyBytes);
    if (text.trim() === '') return '(empty body)';
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  } catch {
    return `(binary — ${r.bodyBytes.byteLength} bytes)`;
  }
}

function responseLanguage(r: NonNullable<Response>): string {
  if (!r.ok) return 'plaintext';
  const ct = (r.headers['content-type'] ?? '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('html')) return 'html';
  return 'plaintext';
}

function responseHeadersPreview(r: NonNullable<Response>): string {
  if (!r.ok) return '';
  if (Object.keys(r.headers).length === 0) return '(no headers)';
  return Object.entries(r.headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

// Curl/HTTPie-style transcript: request lines prefixed with "> ", response
// lines with "< ". Reads from c.sentRequest (the wire-form returned by
// the runner) so the transcript shows resolved variables — not the
// template the user typed. Falls back to the current draft if a send
// hasn't completed yet (e.g. just-loaded tab with a cached response).
function responseRawPreview(c: RequestTabComponent, r: NonNullable<Response>): string {
  const sent = c.sentRequest();
  const method = (sent?.method ?? c.draft.method).toUpperCase();
  const url = sent?.url ?? c.draft.url;
  const headers = sent?.headers ?? c.draft.headers;
  const body = sent?.body ?? c.draft.body;

  const reqLine = `${method} ${url} HTTP/1.1`;
  const reqHeaders = headers
    .filter((h) => h.key.trim() !== '')
    .map((h) => `${h.key}: ${h.value}`)
    .join('\n');
  const reqBody = body?.raw ?? '';

  if (!r.ok) {
    return [
      `> ${reqLine}`,
      reqHeaders ? `> ${reqHeaders.split('\n').join('\n> ')}` : '',
      reqBody ? `>\n> ${reqBody.split('\n').join('\n> ')}` : '',
      '',
      `< ERROR (${r.category})`,
      `< ${r.message}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const respHeaders = responseHeadersPreview(r);
  const respBody = responseBodyText(r);
  return [
    `> ${reqLine}`,
    reqHeaders ? `> ${reqHeaders.split('\n').join('\n> ')}` : '',
    reqBody ? `>\n> ${reqBody.split('\n').join('\n> ')}` : '',
    '',
    `< HTTP/1.1 ${r.status}`,
    `< ${respHeaders.split('\n').join('\n< ')}`,
    `<`,
    respBody,
  ].join('\n');
}

// Pull the input's current text value out of an event regardless of whether
// it was fired by a native form element (target.value) or a Melodic form
// element (CustomEvent with detail.value).
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

// unsafeHTML is unused here but re-exported so it stays in the dependency
// graph; the framework auto-tree-shakes if no template references it. Keep
// the import for now in case future content needs to render trusted HTML.
void unsafeHTML;

// -----------------------------------------------------------------------------
// Template-safe URL/query helpers
// -----------------------------------------------------------------------------
//
// Coax URLs frequently use template syntax like `{{baseUrl}}/api/Guardian`
// which is not a valid URL — `new URL(...)` throws on it. The previous
// implementation used the URL API for query-param manipulation, which meant
// every Params-tab action (add row, edit row, remove row, render) silently
// no-op'd for any request whose URL is a template.
//
// Split the query string off manually at the first `?`. Everything before
// is the base (preserved verbatim, including `{{...}}` tokens); everything
// after is `&`-separated key=value pairs. No percent-encoding round-trip:
// the strings the user typed (keys and values, possibly themselves
// containing template tokens) flow through unchanged.

interface ParamRow {
  key: string;
  value: string;
}

function splitUrlAtQuery(url: string): { base: string; params: ParamRow[] } {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return { base: url, params: [] };
  const base = url.slice(0, qIdx);
  const queryStr = url.slice(qIdx + 1);
  if (queryStr === '') return { base, params: [] };
  const params: ParamRow[] = queryStr.split('&').map((kv) => {
    const eq = kv.indexOf('=');
    if (eq === -1) return { key: kv, value: '' };
    return { key: kv.slice(0, eq), value: kv.slice(eq + 1) };
  });
  return { base, params };
}

function joinUrlWithParams(base: string, params: ParamRow[]): string {
  if (params.length === 0) return base;
  return `${base}?${params.map((p) => `${p.key}=${p.value}`).join('&')}`;
}

export { RequestTabComponent };
