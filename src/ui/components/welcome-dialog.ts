// <hu-welcome-dialog>
//
// First-run dialog shown on initial app launch. Two affordances:
//
//   1. Open a workspace folder — kicks the existing pickAndOpenWorkspace
//      flow. The right move for users who already have a folder of
//      .http files.
//   2. Try with examples — calls welcome:createSampleWorkspace which
//      prompts for a parent dir, writes a tiny "Coax Examples" folder
//      with one .http file (three requests against httpbin.org) and an
//      env file, then opens it as a workspace. The intent is a
//      <10-second "oh I get it" moment for new buyers.
//
// Gated by app-settings.hasSeenWelcome — dismissing the dialog (either
// button or the close X) flips the flag so the dialog never reappears.
// Reset path: edit <userData>/settings.json and set hasSeenWelcome to
// false (no in-app reset since it's not a meaningful repeat experience).

import { MelodicComponent, html, css } from '@melodicdev/core';
import type { IElementRef, OnCreate, OnDestroy } from '@melodicdev/core/components';
import { rpc } from '@ipc/renderer';
import type { AppSettings } from '@ipc/types';
import type { Workspace } from '../store/model.js';
import { activeWorkspace } from '../store/state.js';
import { loadWorkspaceData, pickAndOpenWorkspace } from '../store/lifecycle.js';

type DialogElement = HTMLElement & { component: { open(): void; close(): void } };

@MelodicComponent({
  selector: 'hu-welcome-dialog',
  template: (c: WelcomeDialogComponent) => html`
    <ml-dialog style="--ml-dialog-max-width: 560px;">
      <div slot="dialog-header" class="dialog-header-row">
        <strong>Welcome to Coax</strong>
        <ml-button variant="ghost" size="sm" title="Close (Esc)" @ml:click=${c.dismiss}>
          <ml-icon icon="x" size="sm"></ml-icon>
        </ml-button>
      </div>

      <div class="body">
        <p>
          Coax runs <code>.http</code> files — your API requests as plain text,
          version-controlled, runnable from the desktop and the CLI.
        </p>

        <div class="actions">
          <ml-button
            variant="primary"
            size="md"
            @ml:click=${c.handleOpenFolder}
          >
            <ml-icon slot="icon-start" icon="folder-open"></ml-icon>
            Open a folder
          </ml-button>
          <ml-button
            variant="secondary"
            size="md"
            @ml:click=${c.handleTryExamples}
          >
            <ml-icon slot="icon-start" icon="sparkle"></ml-icon>
            Try with examples
          </ml-button>
        </div>

        <p class="tip">
          "Try with examples" creates a small <code>Coax Examples</code>
          folder with a working collection so you can click Send and see
          a real response immediately.
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
    .body p {
      margin: 8px 0;
    }
    .body code {
      font-family: var(--hu-font-mono, monospace);
      font-size: 12.5px;
      background: var(--hu-bg-elevated, rgba(255, 255, 255, 0.05));
      padding: 1px 5px;
      border-radius: 3px;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin: 16px 0 12px;
      flex-wrap: wrap;
    }
    .tip {
      font-size: 12px;
      opacity: 0.75;
      margin-top: 10px;
    }
  `,
})
class WelcomeDialogComponent implements IElementRef, OnCreate, OnDestroy {
  elementRef!: HTMLElement;

  onCreate(): void {
    document.addEventListener('hu:open-welcome', this._handleOpen);
  }

  onDestroy(): void {
    document.removeEventListener('hu:open-welcome', this._handleOpen);
  }

  private _handleOpen = (): void => {
    this._dialog()?.open();
  };

  open = (): void => {
    this._dialog()?.open();
  };

  close = (): void => {
    this._dialog()?.close();
  };

  dismiss = async (): Promise<void> => {
    this.close();
    try {
      await rpc<AppSettings>({
        kind: 'app:settings:set',
        settings: { hasSeenWelcome: true },
      });
    } catch (err) {
      console.warn('failed to flag hasSeenWelcome:', err);
    }
  };

  handleOpenFolder = async (): Promise<void> => {
    await this.dismiss();
    try {
      await pickAndOpenWorkspace();
    } catch (err) {
      console.error('pickAndOpenWorkspace failed:', err);
    }
  };

  handleTryExamples = async (): Promise<void> => {
    try {
      const result = await rpc<{ canceled: true } | { canceled: false; folderPath: string }>({
        kind: 'welcome:createSampleWorkspace',
      });
      if (result.canceled) return; // leave dialog open so the user can pick again
      await this.dismiss();
      const opened = await rpc<Workspace>({
        kind: 'workspace:open',
        folderPath: result.folderPath,
      });
      activeWorkspace.set(opened);
      await loadWorkspaceData(opened.id);
    } catch (err) {
      console.error('createSampleWorkspace failed:', err);
    }
  };

  private _dialog(): DialogElement['component'] | null {
    const el = this.elementRef.shadowRoot?.querySelector('ml-dialog') as DialogElement | null;
    return el?.component ?? null;
  }
}
