// <hu-settings-dialog>
//
// App-level preferences. Single tab/section for now: "Network". The toggle
// flips `allowInsecureTLS` which the main process applies to every outbound
// request via undici's `connect: { rejectUnauthorized: false }`.
//
// Opened from the Preferences… menu item (macOS: Coax → Preferences,
// Win/Linux: File → Preferences) which sends `hu:menu-preferences` over IPC.
// The renderer dispatches that as a document-level `hu:open-settings` event
// which this component listens for.
//
// Settings live in <userData>/settings.json (sidecar — see
// src/app/app-settings.ts). The dialog reads on open and writes on each
// toggle. Saves are fast and synchronous from the user's perspective.

import { MelodicComponent, html, css, signal } from '@melodicdev/core';
import type { IElementRef, OnCreate, OnDestroy } from '@melodicdev/core/components';
import { rpc } from '@ipc/renderer';
import type { AppSettings } from '@ipc/types';

type DialogElement = HTMLElement & { component: { open(): void; close(): void } };

@MelodicComponent({
  selector: 'hu-settings-dialog',
  template: (c: SettingsDialogComponent) => html`
    <ml-dialog style="--ml-dialog-max-width: 560px;">
      <div slot="dialog-header" class="dialog-header-row">
        <strong>Settings</strong>
        <ml-button variant="ghost" size="sm" title="Close (Esc)" @ml:click=${c.close}>
          <ml-icon icon="x" size="sm"></ml-icon>
        </ml-button>
      </div>

      <div class="body">
        <section>
          <h4>Network</h4>

          <label class="row">
            <input
              type="checkbox"
              .checked=${c.allowInsecureTLS()}
              @change=${(e: Event) =>
                void c.setInsecureTLS((e.target as HTMLInputElement).checked)}
            />
            <div class="row-text">
              <div class="row-label">Allow insecure TLS certificates</div>
              <div class="row-status">${c.allowInsecureTLS() ? 'On — cert validation skipped' : 'Off — validation enforced'}</div>
              <div class="row-help">
                Skip certificate validation for every request. Use only for
                self-signed dev servers (mkcert, ASP.NET dev-certs, etc.) —
                production traffic over an unverified TLS connection can be
                silently MITM'd. Off by default.
              </div>
            </div>
          </label>
        </section>

        <section>
          <h4>Updates</h4>

          <label class="row">
            <input
              type="checkbox"
              .checked=${c.autoUpdate()}
              @change=${(e: Event) =>
                void c.setAutoUpdate((e.target as HTMLInputElement).checked)}
            />
            <div class="row-text">
              <div class="row-label">Check for updates automatically</div>
              <div class="row-status">${c.autoUpdate() ? 'On — checks on launch, prompts before installing' : 'Off — stay on the current version'}</div>
              <div class="row-help">
                When enabled, Coax checks for newer builds shortly after
                launch and downloads them in the background. You'll see
                a "Restart to install" prompt when one is ready —
                installs never happen without your click.
              </div>
            </div>
          </label>
        </section>
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
      font-size: 13px;
      color: var(--hu-text-secondary, var(--text-secondary));
    }
    section {
      margin-bottom: 18px;
    }
    section:last-child {
      margin-bottom: 0;
    }
    h4 {
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--hu-text-muted, var(--text-muted));
      margin: 0 0 10px;
      font-weight: 600;
    }
    .row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.12s ease-out;
    }
    .row:hover {
      background: var(--hu-bg-elevated, rgba(255, 255, 255, 0.04));
    }
    .row input[type='checkbox'] {
      margin-top: 2px;
      cursor: pointer;
      accent-color: var(--hu-accent, #3b82f6);
    }
    .row-text {
      flex: 1;
      min-width: 0;
    }
    .row-label {
      color: var(--hu-text-primary, var(--text-primary));
      font-weight: 500;
      font-size: 13.5px;
      margin-bottom: 4px;
    }
    .row-status {
      font-size: 11.5px;
      color: var(--hu-text-muted, var(--text-muted));
      margin-bottom: 4px;
    }
    .row-help {
      font-size: 12.5px;
      line-height: 1.5;
      color: var(--hu-text-secondary, var(--text-secondary));
    }
  `,
})
class SettingsDialogComponent implements IElementRef, OnCreate, OnDestroy {
  elementRef!: HTMLElement;

  // Signals so the template re-renders after the initial load from IPC.
  allowInsecureTLS = signal(false);
  autoUpdate = signal(true);

  onCreate(): void {
    document.addEventListener('hu:open-settings', this._handleOpen);
  }

  onDestroy(): void {
    document.removeEventListener('hu:open-settings', this._handleOpen);
  }

  private _handleOpen = async (): Promise<void> => {
    // Refresh from disk every open in case another window or external
    // edit changed the file. Cheap (single small JSON read).
    try {
      const current = await rpc<AppSettings>({ kind: 'app:settings:get' });
      this.allowInsecureTLS.set(current.allowInsecureTLS);
      this.autoUpdate.set(current.autoUpdate);
    } catch (err) {
      console.warn('settings:get failed:', err);
    }
    this._dialog()?.open();
  };

  setInsecureTLS = async (next: boolean): Promise<void> => {
    const previous = this.allowInsecureTLS();
    this.allowInsecureTLS.set(next);
    try {
      await rpc<AppSettings>({
        kind: 'app:settings:set',
        settings: { allowInsecureTLS: next },
      });
    } catch (err) {
      console.error('settings:set failed:', err);
      this.allowInsecureTLS.set(previous);
    }
  };

  setAutoUpdate = async (next: boolean): Promise<void> => {
    const previous = this.autoUpdate();
    this.autoUpdate.set(next);
    try {
      await rpc<AppSettings>({
        kind: 'app:settings:set',
        settings: { autoUpdate: next },
      });
    } catch (err) {
      console.error('settings:set failed:', err);
      this.autoUpdate.set(previous);
    }
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
