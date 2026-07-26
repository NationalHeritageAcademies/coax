// <hu-telemetry-consent>
//
// First-run modal asking the user whether to opt in to anonymous crash
// reporting. Mounted from `src/ui/main.ts` only when:
//   - SENTRY_DSN is configured in the build (otherwise the dialog has nothing
//     to gate), AND
//   - the user has never been asked (settings.consent === null).
//
// Either choice persists immediately via the `telemetry:set` IPC; toggling
// later goes through the regular settings UI (see help-dialog / future
// settings panel). The decision takes effect for crash capture on next
// launch — see the comment in telemetry/init.ts for why we don't re-init
// mid-session.
//
// Built on Melodic `<ml-dialog>`. ml-dialog uses the native <dialog> element
// under the hood and is opened/closed imperatively via its `.component.open()`
// API — the `?open=` attribute does NOT control visibility (see help-dialog.ts
// for the same pattern). We open it from `onCreate` after the renderer mounts,
// gated on a defensive auto-dismiss check in case settings have changed since
// bootstrap decided to mount us.

import { MelodicComponent, html, css, signal } from '@melodicdev/core';
import type { IElementRef, OnCreate, OnDestroy } from '@melodicdev/core/components';
import { rpc } from '@ipc/renderer';
import { showToast } from './toast.js';

type DialogElement = HTMLElement & { component: { open(): void; close(): void } };

@MelodicComponent({
  selector: 'hu-telemetry-consent',
  template: (c: TelemetryConsentComponent) => html`
    <ml-dialog style="--ml-dialog-max-width: 560px;" @ml:close=${c.handleDismiss}>
      <div slot="dialog-header" class="dialog-header-row">
        <strong>Help improve Coax</strong>
      </div>

      <div class="content">
        <p class="lede">
          Coax is built by a small team. If something crashes, we'd love to know — but only
          with your permission, and only at a level that respects your data.
        </p>

        <div class="card card--ok">
          <ml-icon class="icon" icon="check-circle" size="md"></ml-icon>
          <div>
            <div class="card-title">What we collect</div>
            <ul>
              <li>Crash stack traces</li>
              <li>Operating system + Coax version</li>
              <li>The component or feature that crashed</li>
            </ul>
          </div>
        </div>

        <div class="card card--never">
          <ml-icon class="icon" icon="x-circle" size="md"></ml-icon>
          <div>
            <div class="card-title">What we never collect</div>
            <ul>
              <li>URLs, hostnames, or API endpoints</li>
              <li>Request or response bodies</li>
              <li>Headers, tokens, or credentials</li>
              <li>The contents of your <code>.http</code> files</li>
              <li>Workspace, collection, or request names</li>
            </ul>
          </div>
        </div>

        <p class="footnote">
          You can change this any time in Settings. Crash reports are sent to
          <strong>Sentry</strong>. See the
          <a href="#" @click=${c.handleOpenPrivacy}>privacy doc</a> for the full list of
          fields and how scrubbing works.
        </p>
      </div>

      <div slot="dialog-footer" class="footer">
        <ml-button variant="ghost" @ml:click=${c.handleDecline} ?disabled=${c.saving()}>
          No thanks
        </ml-button>
        <ml-button variant="primary" @ml:click=${c.handleAccept} ?loading=${c.saving()}>
          <ml-icon slot="icon-start" icon="check"></ml-icon>
          Send crash reports
        </ml-button>
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
      width: 100%;
      font-size: 14px;
    }
    .content {
      display: flex;
      flex-direction: column;
      gap: 16px;
      font-size: 13px;
      line-height: 1.55;
      color: var(--hu-text-secondary);
    }
    .lede {
      margin: 0;
      color: var(--hu-text-primary);
      font-size: 14px;
    }
    .card {
      display: flex;
      gap: 12px;
      padding: 14px 16px;
      border-radius: var(--hu-radius-lg);
      border: 1px solid var(--hu-border);
      background: var(--hu-bg-elevated);
    }
    .card--ok {
      background: color-mix(in srgb, var(--hu-success) 6%, var(--hu-bg-elevated));
      border-color: color-mix(in srgb, var(--hu-success) 20%, var(--hu-border));
    }
    .card--ok .icon {
      color: var(--hu-success);
    }
    .card--never {
      background: color-mix(in srgb, var(--hu-danger) 6%, var(--hu-bg-elevated));
      border-color: color-mix(in srgb, var(--hu-danger) 20%, var(--hu-border));
    }
    .card--never .icon {
      color: var(--hu-danger);
    }
    .card-title {
      font-weight: 600;
      color: var(--hu-text-primary);
      margin-bottom: 4px;
      font-size: 13px;
    }
    .card ul {
      margin: 0;
      padding-left: 18px;
    }
    .card li {
      margin: 2px 0;
    }
    .icon {
      flex-shrink: 0;
      margin-top: 2px;
    }
    .footnote {
      margin: 0;
      font-size: 12px;
      color: var(--hu-text-muted);
    }
    .footnote a {
      color: var(--hu-accent);
      text-decoration: none;
      font-weight: 500;
    }
    .footnote a:hover {
      text-decoration: underline;
    }
    .footnote code {
      font-family: var(--hu-font-mono);
      font-size: 11px;
      padding: 1px 5px;
      background: var(--hu-bg-elevated);
      border: 1px solid var(--hu-border);
      border-radius: var(--hu-radius-sm);
    }
    .footer {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      width: 100%;
    }
  `,
})
class TelemetryConsentComponent implements IElementRef, OnCreate, OnDestroy {
  elementRef!: HTMLElement;
  saving = signal(false);

  onCreate(): void {
    // Defensively re-check consent state on mount: bootstrap decided to
    // mount us based on a `consent: null` snapshot, but another process /
    // window could have decided in the meantime. If it has, silently close.
    // Otherwise, open the underlying <ml-dialog> imperatively — same pattern
    // as <hu-help-dialog> and <hu-env-manager>; the `?open` attribute on
    // ml-dialog does NOT control visibility.
    void this._mountAndMaybeOpen();
  }

  onDestroy(): void {
    // ml-dialog handles its own teardown on element removal.
  }

  private async _mountAndMaybeOpen(): Promise<void> {
    try {
      const settings = await rpc<{ consent: boolean | null }>({ kind: 'telemetry:get' });
      if (settings.consent !== null) {
        // Already decided — never open. Just remove ourselves.
        this._removeFromDom(0);
        return;
      }
    } catch {
      // Can't read settings — fall through and open the dialog anyway,
      // since asking the user is safer than silently disabling.
    }
    this._dialog()?.open();
  }

  handleAccept = async (): Promise<void> => {
    await this._save(true, 'Crash reporting on');
  };

  handleDecline = async (): Promise<void> => {
    await this._save(false, 'Crash reporting off');
  };

  /**
   * Dismissing via Escape or the backdrop is treated as an explicit "No
   * thanks" — we never want to leave the user in an undecided state where
   * we'd ask again on next launch. Guard against re-entrance during save.
   */
  handleDismiss = async (): Promise<void> => {
    if (this.saving()) return;
    // Only persist if the user hasn't already answered. Without this guard
    // the close event from `handleAccept`/`handleDecline` would re-fire the
    // save with the wrong value.
    try {
      const settings = await rpc<{ consent: boolean | null }>({ kind: 'telemetry:get' });
      if (settings.consent !== null) return;
    } catch {
      /* fall through */
    }
    await this._save(false, 'Crash reporting off');
  };

  handleOpenPrivacy = (e: Event): void => {
    e.preventDefault();
    showToast('Privacy details: see docs/privacy.md', 'info', 5000);
  };

  private async _save(consent: boolean, message: string): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      await rpc({ kind: 'telemetry:set', consent });
      showToast(message, 'success', 3000);
      this._dialog()?.close();
      this._removeFromDom(220);
    } catch (err) {
      console.error('telemetry:set failed:', err);
      showToast(`Couldn't save preference: ${(err as Error).message}`, 'error');
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * The ml-dialog component lives one level deep inside our shadow root.
   * Get its component facade so we can call `.open()` / `.close()` —
   * matches the pattern in help-dialog.ts and env-manager.ts.
   */
  private _dialog(): DialogElement['component'] | null {
    const el = this.elementRef.shadowRoot?.querySelector('ml-dialog') as DialogElement | null;
    return el?.component ?? null;
  }

  private _removeFromDom(delayMs: number): void {
    // Defer removal so the dialog close animation can complete.
    setTimeout(() => { this.elementRef.remove(); }, delayMs);
  }
}

export { TelemetryConsentComponent };
