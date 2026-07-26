// <hu-help-dialog>
//
// A short reference for the syntax users hit most often: variables, chaining
// requests through their last response, per-request overrides, secrets, and
// built-in tokens. Mounted at body level by app-frame and opened via a
// document-level `hu:open-help` event (dispatched from the brand area in
// the header).
//
// The content lives here as html` templates rather than markdown so we can
// style code samples consistently with the rest of the app's tokens
// without pulling in a markdown renderer for one screen.

import { MelodicComponent, html, css } from '@melodicdev/core';
import type { IElementRef } from '@melodicdev/core/components';

type DialogElement = HTMLElement & { component: { open(): void; close(): void } };

@MelodicComponent({
  selector: 'hu-help-dialog',
  template: (c: HelpDialogComponent) => html`
    <ml-dialog style="--ml-dialog-max-width: 760px;">
      <div slot="dialog-header" class="dialog-header-row">
        <strong>Coax — Quick Reference</strong>
        <ml-button variant="ghost" size="sm" title="Close (Esc)" @ml:click=${c.close}>
          <ml-icon icon="x" size="sm"></ml-icon>
        </ml-button>
      </div>

      <div class="body">
        ${renderVariablesSection()}
        ${renderChainingSection()}
        ${renderOverridesSection()}
        ${renderSecretsSection()}
        ${renderBuiltinsSection()}
        ${renderImportSection()}
        ${renderAuthoringSection()}
      </div>
    </ml-dialog>
  `,
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
    /* No padding or overflow here — the ml-dialog body slot already
       provides both; stacking them produced a second scrollbar. */
    .body {
      color: var(--hu-text-primary);
      font-size: 13px;
      line-height: 1.55;
    }
    h3 {
      font-size: 14px;
      font-weight: 600;
      margin: 18px 0 6px;
      color: var(--hu-text-primary);
    }
    h3:first-child {
      margin-top: 0;
    }
    p {
      margin: 6px 0;
      color: var(--hu-text-secondary);
    }
    ul {
      margin: 6px 0 6px 18px;
      padding: 0;
      color: var(--hu-text-secondary);
    }
    li {
      margin: 4px 0;
    }
    code {
      font-family: var(--hu-font-mono, ui-monospace, monospace);
      font-size: 12px;
      background: var(--hu-bg-active);
      color: var(--hu-text-primary);
      padding: 1px 5px;
      border-radius: 3px;
    }
    pre {
      font-family: var(--hu-font-mono, ui-monospace, monospace);
      font-size: 12px;
      background: var(--hu-bg-active);
      color: var(--hu-text-primary);
      padding: 8px 12px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 6px 0 10px;
    }
    .tip {
      font-size: 12px;
      color: var(--hu-text-muted);
      font-style: italic;
    }
  `,
})
class HelpDialogComponent implements IElementRef {
  elementRef!: HTMLElement;

  onCreate(): void {
    document.addEventListener('hu:open-help', this._handleOpen);
  }

  onDestroy(): void {
    document.removeEventListener('hu:open-help', this._handleOpen);
  }

  private _handleOpen = (): void => {
    this._dialog()?.open();
  };

  private _dialog(): DialogElement['component'] | null {
    const el = this.elementRef.shadowRoot?.querySelector('ml-dialog') as DialogElement | null;
    return el?.component ?? null;
  }

  open = (): void => {
    this._dialog()?.open();
  };

  close = (): void => {
    this._dialog()?.close();
  };
}

function renderVariablesSection() {
  return html`
    <h3>Variables</h3>
    <p>
      Anywhere in a URL, header, or body, write
      <code>{{name}}</code> and Coax substitutes the value at send time.
      Names resolve in this order (highest precedence first):
    </p>
    <ul>
      <li><strong>Request overrides</strong> — set on the Vars tab of the request.</li>
      <li>
        <strong>Folder environments</strong> — the active env on the request's folder, then
        each parent folder, then the collection root. Deeper wins.
      </li>
      <li>
        <strong>Collection defaults</strong> — top-of-file <code>@key = value</code> lines
        in imported <code>.http</code> documents.
      </li>
    </ul>
    <p class="tip">
      The Vars tab shows every key resolved for the request, plus where the value comes
      from. Click any value cell to override it for this request only.
    </p>
  `;
}

function renderChainingSection() {
  return html`
    <h3>Chaining requests</h3>
    <p>
      Use one request's last response inside another. Steps:
    </p>
    <ul>
      <li>
        Open the source request. Set
        <strong>Chain name</strong> (the field above the URL bar) to something like
        <code>getToken</code>. Send the request once so a response is stored.
      </li>
      <li>
        In any other request in the same collection ancestry, reference the response by
        chain name:
        <pre>Authorization: Bearer {{getToken.response.body.$.access_token}}</pre>
      </li>
    </ul>
    <p>Syntax:</p>
    <ul>
      <li><code>{{name.response.body.&lt;path&gt;}}</code> — JSONPath into the parsed JSON body.</li>
      <li><code>{{name.response.body.$.x.y[0]}}</code> — full JSONPath is supported.</li>
      <li><code>{{name.response.body.x.y}}</code> — leading <code>$.</code> is optional.</li>
      <li><code>{{name.response.headers.location}}</code> — pull a response header (case-insensitive).</li>
    </ul>
    <p class="tip">
      Chain names are scoped to the collection ancestry. Two collections can both have a
      <code>getToken</code> without colliding.
    </p>
  `;
}

function renderOverridesSection() {
  return html`
    <h3>Per-request variable overrides</h3>
    <p>
      Need to point a single request at a different value without editing the env? On
      the request's <strong>Vars</strong> tab, click any value cell. The cell becomes an
      input; type, then Tab or Enter to save. Clear the input to remove the override.
    </p>
    <p>
      Secret rows show <code>[secret]</code>. Click the row to choose
      <strong>plaintext</strong> (stored as plain text on this request) or
      <strong>secret</strong> (encrypted with the rest of your secrets).
    </p>
    <p>
      Overrides round-trip through <code>.http</code> export as
      <code>#&nbsp;@override key value</code> directives between
      <code>### title</code> and the method line. Secret overrides export as
      <code>#&nbsp;@override:secret key</code> (no value) — the importer leaves the
      stored value empty until you set it.
    </p>
  `;
}

function renderSecretsSection() {
  return html`
    <h3>Secrets</h3>
    <p>
      Env values marked secret are encrypted at rest (Electron <code>safeStorage</code>)
      and never appear in plaintext on disk or in exports. The Vars panel renders them as
      <code>[secret]</code>. Export writes
      <code>PASTE_&lt;KEY&gt;_HERE</code> placeholders instead of the value, so an exported
      collection is safe to share.
    </p>
    <p class="tip">
      Manage secrets in <strong>Manage envs</strong> (the gear on any folder row).
    </p>
  `;
}

function renderBuiltinsSection() {
  return html`
    <h3>Built-in variables</h3>
    <ul>
      <li><code>{{$timestamp}}</code> — seconds since epoch.</li>
      <li><code>{{$isoTimestamp}}</code> — ISO-8601, e.g. <code>2026-05-18T14:32:00.000Z</code>.</li>
      <li><code>{{$guid}}</code> — random v4 UUID.</li>
      <li><code>{{$randomInt 1 100}}</code> — random integer in <code>[lo, hi)</code>.</li>
    </ul>
  `;
}

function renderImportSection() {
  return html`
    <h3>Importing</h3>
    <p>
      The COLLECTIONS <code>+</code> menu (top of the sidebar) imports from two sources:
    </p>
    <ul>
      <li>
        <strong>.http file</strong> — the format used by VS Code REST Client and JetBrains
        HTTP Client. <code>### title</code> separates requests, <code>@var = value</code>
        at the top become collection-level variables.
      </li>
      <li>
        <strong>Swagger / OpenAPI</strong> — pick a JSON or YAML file, or paste a URL.
        Coax generates one folder per tag, one request per operation, scaffolds
        URL/headers/auth from the spec, and seeds a <code>From swagger</code> env at the
        collection root with the resolved <code>baseUrl</code>.
      </li>
    </ul>
  `;
}

function renderAuthoringSection() {
  return html`
    <h3>.http file authoring</h3>
    <p>Coax-extended directives recognized on a request block:</p>
    <ul>
      <li>
        <code># @name &lt;chainName&gt;</code> — sets the request's chain name on import.
      </li>
      <li>
        <code># @override &lt;key&gt; &lt;value&gt;</code> — request-scoped plaintext override.
      </li>
      <li>
        <code># @override:secret &lt;key&gt;</code> — request-scoped secret override
        (no value in the file; supply it in the app).
      </li>
      <li>
        <code># @graphql</code> — render the body as a GraphQL query.
      </li>
      <li>
        <code>&lt; ./path/to/body.json</code> — load the body from a file at send time.
      </li>
    </ul>
  `;
}

export { HelpDialogComponent };
