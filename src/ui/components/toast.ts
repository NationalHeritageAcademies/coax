// Lightweight toast helper for transient user-visible messages.
//
// Why this exists: Electron's renderer process makes window.alert /
// window.prompt / window.confirm into silent no-ops, so any code path that
// previously used those is broken from the user's perspective. This helper
// renders a short-lived banner inside the existing DOM instead.
//
// Intentionally framework-free (no Melodic dependency) so it stays drop-in
// usable from anywhere in the renderer.

let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (container) return container;
  container = document.createElement('div');
  container.id = 'hu-toast-container';
  container.style.cssText = `
    position: fixed;
    bottom: 32px;
    right: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 9999;
    pointer-events: none;
  `;
  document.body.appendChild(container);
  return container;
}

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  durationMs?: number;
  /**
   * Action invoked when the user clicks the toast. The toast dismisses
   * either way. When provided, an "actionLabel" suffix is appended so
   * the click affordance is obvious.
   */
  onClick?: () => void;
  /** Short suffix appended after the message (e.g. "Reveal in Finder"). */
  actionLabel?: string;
}

export function showToast(
  message: string,
  kind: ToastKind = 'info',
  optionsOrDuration: number | ToastOptions = 4000,
): void {
  const options: ToastOptions =
    typeof optionsOrDuration === 'number'
      ? { durationMs: optionsOrDuration }
      : optionsOrDuration;
  // Default is 4s. `durationMs: 0` (or any non-positive number) means
  // "sticky" — only dismissed by the user clicking it. Convenient for
  // sticky-until-acknowledged messages like "Update ready, click to
  // restart" that mustn't time out and disappear silently.
  const durationMs = options.durationMs ?? 4000;
  const sticky = durationMs <= 0;

  const c = ensureContainer();
  const colorVar = ({
    info: 'var(--hu-info)',
    success: 'var(--hu-accent)',
    warning: 'var(--hu-warning)',
    error: 'var(--hu-danger)',
  } satisfies Record<ToastKind, string>)[kind];

  const toast = document.createElement('div');
  toast.style.cssText = `
    pointer-events: auto;
    background: var(--hu-bg-elevated);
    border: 1px solid var(--hu-border-strong);
    border-left: 3px solid ${colorVar};
    color: var(--hu-text-primary);
    padding: 10px 16px;
    border-radius: var(--hu-radius-md);
    box-shadow: var(--hu-shadow-md);
    max-width: 420px;
    font-size: 13px;
    line-height: 1.4;
    transform: translateX(120%);
    transition: transform 200ms ease;
    cursor: pointer;
    white-space: pre-wrap;
  `;
  toast.textContent = message;

  if (options.actionLabel) {
    const action = document.createElement('div');
    action.textContent = options.actionLabel;
    action.style.cssText = `
      margin-top: 4px;
      font-size: 12px;
      color: ${colorVar};
      text-decoration: underline;
    `;
    toast.appendChild(action);
  }

  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    toast.style.transform = 'translateX(120%)';
    setTimeout(() => { toast.remove(); }, 220);
  };

  toast.addEventListener('click', () => {
    if (options.onClick) {
      try {
        options.onClick();
      } catch (err) {
        console.error('toast onClick failed:', err);
      }
    }
    dismiss();
  });
  c.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => { toast.style.transform = 'translateX(0)'; });

  if (!sticky) setTimeout(dismiss, durationMs);
}
