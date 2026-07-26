// Imperative text-prompt / confirm dialogs using the native <dialog>
// element with showModal(). Native dialogs render in the browser's top
// layer, so they sit ABOVE any open ml-dialog (which also uses the top
// layer) regardless of z-index. window.prompt is a no-op in Electron's
// renderer; this is the replacement.
//
// Each call mounts a fresh <dialog> at document.body, shows it modal, and
// awaits the user's choice. The dialog is removed on resolve so two
// successive prompts don't pile up.

export async function promptInline(
  promptText: string,
  placeholder: string,
  initialValue?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'hu-prompt-dialog';
    dlg.innerHTML = `
      <div class="hu-prompt-form">
        <label class="hu-prompt-label">${escapeHtml(promptText)}</label>
        <ml-input class="hu-prompt-input" type="text" placeholder="${escapeAttr(placeholder)}" value="${escapeAttr(initialValue ?? '')}"></ml-input>
        <div class="hu-prompt-actions">
          <ml-button data-action="cancel" variant="ghost" size="sm">Cancel</ml-button>
          <ml-button data-action="ok" variant="primary" size="sm">OK</ml-button>
        </div>
      </div>
    `;
    applyPromptStyles(dlg);
    document.body.appendChild(dlg);
    const input = dlg.querySelector<HTMLElement & { value: string }>('.hu-prompt-input');
    const close = (val: string | null): void => {
      try {
        dlg.close();
      } catch {
        /* already closing */
      }
      dlg.remove();
      resolve(val);
    };
    const submit = (): void => { close((input?.value ?? '').trim() || null); };
    const onClick = (e: Event): void => {
      const t = e.target as HTMLElement;
      const action = t.closest('[data-action]')?.getAttribute('data-action');
      if (action === 'cancel') {
        e.preventDefault();
        close(null);
      } else if (action === 'ok') {
        e.preventDefault();
        submit();
      }
    };
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('ml:click', onClick);
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      }
    });
    // The native dialog also dispatches `cancel` on Esc; intercept so we
    // resolve with null rather than letting it close uncontrolled.
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    dlg.showModal();
    queueMicrotask(() => {
      const inner = input?.shadowRoot?.querySelector('input') as HTMLInputElement | null;
      inner?.focus();
      inner?.select();
    });
  });
}

export async function confirmInline(
  promptText: string,
  okLabel = 'Delete',
): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'hu-prompt-dialog';
    dlg.innerHTML = `
      <div class="hu-prompt-form">
        <div class="hu-prompt-message">${escapeHtml(promptText)}</div>
        <div class="hu-prompt-actions">
          <ml-button data-action="cancel" variant="ghost" size="sm">Cancel</ml-button>
          <ml-button data-action="ok" variant="danger" size="sm">${escapeHtml(okLabel)}</ml-button>
        </div>
      </div>
    `;
    applyPromptStyles(dlg);
    document.body.appendChild(dlg);
    const close = (val: boolean): void => {
      try {
        dlg.close();
      } catch {
        /* already closing */
      }
      dlg.remove();
      resolve(val);
    };
    const onClick = (e: Event): void => {
      const t = e.target as HTMLElement;
      const action = t.closest('[data-action]')?.getAttribute('data-action');
      if (action === 'cancel') {
        e.preventDefault();
        close(false);
      } else if (action === 'ok') {
        e.preventDefault();
        close(true);
      }
    };
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('ml:click', onClick);
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });
    dlg.showModal();
  });
}

// Style each native dialog inline. Adding this once on document.head would
// be slightly more efficient, but the styles are short and this keeps the
// component self-contained.
function applyPromptStyles(dlg: HTMLDialogElement): void {
  dlg.style.cssText = `
    background: var(--hu-bg-elevated);
    color: var(--hu-text-primary);
    border: 1px solid var(--hu-border-strong);
    border-radius: var(--hu-radius-md);
    padding: 0;
    min-width: 320px;
    max-width: 480px;
  `;
  // The native ::backdrop is set via a style element appended once per
  // instance — simpler than adopting a stylesheet because <dialog>'s
  // backdrop pseudo-element doesn't react to inline styles.
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .hu-prompt-dialog::backdrop { background: rgba(0,0,0,0.4); }
    .hu-prompt-dialog .hu-prompt-form { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .hu-prompt-dialog .hu-prompt-label { font-size: 12px; color: var(--hu-text-secondary); }
    .hu-prompt-dialog .hu-prompt-message { font-size: 13px; color: var(--hu-text-primary); }
    .hu-prompt-dialog .hu-prompt-actions { display: flex; gap: 6px; justify-content: flex-end; }
  `;
  dlg.appendChild(styleEl);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
