// <hu-install-cli-dialog>
//
// Tells the user how to install the Coax CLI on their machine. Opened from
// Help → "Install CLI…" via a document-level `hu:open-install-cli` event
// (dispatched from the menu IPC bridge in src/ui/main.ts).
//
// The CLI ships as a separate npm package — @melodicdev/coax-cli — that
// requires Node 18+ on the user's machine. Bundling a standalone binary
// inside the desktop installer is on the roadmap; this dialog explains
// the current install path until then.

import { MelodicComponent, html, css } from '@melodicdev/core';
import type { IElementRef } from '@melodicdev/core/components';

type DialogElement = HTMLElement & { component: { open(): void; close(): void } };

const INSTALL_CMD = 'npm install --global @melodicdev/coax-cli';
const SAMPLE_CMD = 'coax run path/to/tests.http';
const DOCS_URL = 'https://coax.melodic.dev/docs/cli';

@MelodicComponent({
  selector: 'hu-install-cli-dialog',
  template: (c: InstallCliDialogComponent) => html`
    <ml-dialog style="--ml-dialog-max-width: 640px;">
      <div slot="dialog-header" class="dialog-header-row">
        <strong>Install the Coax CLI</strong>
        <ml-button variant="ghost" size="sm" title="Close (Esc)" @ml:click=${c.close}>
          <ml-icon icon="x" size="sm"></ml-icon>
        </ml-button>
      </div>

      <div class="body">
        <p>
          The Coax CLI runs your <code>.http</code> files headlessly — for CI pipelines,
          smoke tests, contract verification, and synthetic monitoring. Same file format
          as the desktop app.
        </p>

        <h4>1. Install via npm</h4>
        <p class="tip">Requires Node 18+ on your machine.</p>
        ${renderCopyBlock(INSTALL_CMD, c)}

        <h4>2. Run a file</h4>
        ${renderCopyBlock(SAMPLE_CMD, c)}

        <p class="links">
          Full reference, assertion syntax, CI examples →
          <a href="${DOCS_URL}" target="_blank" rel="noreferrer">${DOCS_URL}</a>
        </p>
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
    .body {
      font-size: 13.5px;
      line-height: 1.55;
      color: var(--hu-text-secondary, var(--text-secondary));
    }
    .body h4 {
      font-size: 13px;
      margin: 18px 0 6px;
      color: var(--hu-text-primary, var(--text-primary));
    }
    .body p {
      margin: 6px 0;
    }
    .body code {
      font-family: var(--hu-font-mono, monospace);
      font-size: 12.5px;
      background: var(--hu-bg-elevated, rgba(255, 255, 255, 0.05));
      padding: 1px 5px;
      border-radius: 3px;
    }
    .tip {
      font-size: 12px;
      opacity: 0.75;
      margin-top: 0;
    }
    .copy-block {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 4px 0 8px;
      background: var(--hu-bg-elevated, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--hu-border, rgba(255, 255, 255, 0.08));
      border-radius: 6px;
      padding: 8px 10px;
      font-family: var(--hu-font-mono, monospace);
      font-size: 12.5px;
    }
    .copy-block pre {
      margin: 0;
      flex: 1;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--hu-text-primary, var(--text-primary));
    }
    .copy-btn {
      cursor: pointer;
      border: 1px solid var(--hu-border, rgba(255, 255, 255, 0.12));
      background: transparent;
      color: var(--hu-text-secondary, var(--text-secondary));
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11.5px;
      font-family: inherit;
    }
    .copy-btn:hover {
      color: var(--hu-text-primary, var(--text-primary));
      border-color: var(--hu-border-strong, rgba(255, 255, 255, 0.2));
    }
    .copy-btn.copied {
      color: var(--hu-success, #4ade80);
      border-color: currentColor;
    }
    .links {
      margin-top: 18px;
      font-size: 12.5px;
    }
    .links a {
      color: var(--hu-accent, #3b82f6);
      text-decoration: none;
    }
    .links a:hover {
      text-decoration: underline;
    }
  `,
})
class InstallCliDialogComponent implements IElementRef {
  elementRef!: HTMLElement;

  onCreate(): void {
    document.addEventListener('hu:open-install-cli', this._handleOpen);
  }

  onDestroy(): void {
    document.removeEventListener('hu:open-install-cli', this._handleOpen);
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

  copy = async (text: string, btn: HTMLButtonElement): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add('copied');
      const originalLabel = btn.textContent ?? 'Copy';
      btn.textContent = 'Copied';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = originalLabel;
      }, 1500);
    } catch {
      // Clipboard write can fail in unusual sandboxes; ignore silently
      // rather than surface a low-value error to the user.
    }
  };
}

function renderCopyBlock(cmd: string, c: InstallCliDialogComponent) {
  return html`
    <div class="copy-block">
      <pre>${cmd}</pre>
      <button
        type="button"
        class="copy-btn"
        title="Copy to clipboard"
        @click=${(e: Event) => void c.copy(cmd, e.currentTarget as HTMLButtonElement)}
      >
        Copy
      </button>
    </div>
  `;
}
