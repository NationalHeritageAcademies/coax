// Imperative text-prompt / confirm dialogs using the native <dialog>
// element with showModal(). Native dialogs render in the browser's top
// layer, so they sit ABOVE any open <hu-dialog> (which also uses the top
// layer) regardless of z-index. window.prompt is a no-op in Electron's
// renderer; this is the replacement.
//
// Deliberately framework-free (like toast.ts): callers await a value from
// arbitrary code paths — event handlers, IPC callbacks — and mounting a
// throwaway Angular component for a one-shot prompt would drag change
// detection into what is a self-contained modal microtask. Styling comes
// from the same tokens.css custom properties the rest of the app uses.
//
// Each call mounts a fresh <dialog> at document.body, shows it modal, and
// awaits the user's choice. The dialog is removed on resolve so two
// successive prompts don't pile up.

export async function promptInline(promptText: string, placeholder: string, initialValue?: string): Promise<string | null> {
	return new Promise((resolve) => {
		const dlg = document.createElement('dialog');
		dlg.className = 'hu-prompt-dialog';
		dlg.innerHTML = `
			<div class="hu-prompt-form">
				<label class="hu-prompt-label">${escapeHtml(promptText)}</label>
				<input class="hu-input hu-prompt-input" type="text" placeholder="${escapeAttr(placeholder)}" value="${escapeAttr(initialValue ?? '')}" />
				<div class="hu-prompt-actions">
					<button type="button" data-action="cancel" class="hu-prompt-btn">Cancel</button>
					<button type="button" data-action="ok" class="hu-prompt-btn hu-prompt-btn--primary">OK</button>
				</div>
			</div>
		`;
		applyPromptStyles(dlg);
		document.body.appendChild(dlg);
		const input = dlg.querySelector<HTMLInputElement>('.hu-prompt-input');
		const close = (val: string | null): void => {
			try {
				dlg.close();
			} catch {
				/* already closing */
			}
			dlg.remove();
			resolve(val);
		};
		const submit = (): void => {
			close((input?.value ?? '').trim() || null);
		};
		dlg.addEventListener('click', (e: Event) => {
			const t = e.target as HTMLElement;
			const action = t.closest('[data-action]')?.getAttribute('data-action');
			if (action === 'cancel') {
				e.preventDefault();
				close(null);
			} else if (action === 'ok') {
				e.preventDefault();
				submit();
			}
		});
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
			input?.focus();
			input?.select();
		});
	});
}

export async function confirmInline(promptText: string, okLabel = 'Delete'): Promise<boolean> {
	return new Promise((resolve) => {
		const dlg = document.createElement('dialog');
		dlg.className = 'hu-prompt-dialog';
		dlg.innerHTML = `
			<div class="hu-prompt-form">
				<div class="hu-prompt-message">${escapeHtml(promptText)}</div>
				<div class="hu-prompt-actions">
					<button type="button" data-action="cancel" class="hu-prompt-btn">Cancel</button>
					<button type="button" data-action="ok" class="hu-prompt-btn hu-prompt-btn--danger">${escapeHtml(okLabel)}</button>
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
		dlg.addEventListener('click', (e: Event) => {
			const t = e.target as HTMLElement;
			const action = t.closest('[data-action]')?.getAttribute('data-action');
			if (action === 'cancel') {
				e.preventDefault();
				close(false);
			} else if (action === 'ok') {
				e.preventDefault();
				close(true);
			}
		});
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
// helper self-contained. The buttons are styled here rather than reusing
// the hu-button component because this DOM is built outside Angular.
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
		.hu-prompt-dialog .hu-prompt-btn {
			cursor: pointer;
			font: inherit;
			font-size: 12px;
			padding: 5px 12px;
			border-radius: var(--hu-radius-sm);
			border: 1px solid transparent;
			background: transparent;
			color: var(--hu-text-secondary);
		}
		.hu-prompt-dialog .hu-prompt-btn:hover { color: var(--hu-text-primary); background: var(--hu-bg-active); }
		.hu-prompt-dialog .hu-prompt-btn--primary {
			background: var(--hu-accent);
			border-color: var(--hu-accent);
			color: var(--hu-accent-on);
		}
		.hu-prompt-dialog .hu-prompt-btn--primary:hover { background: var(--hu-accent-hover); border-color: var(--hu-accent-hover); color: var(--hu-accent-on); }
		.hu-prompt-dialog .hu-prompt-btn--danger {
			background: var(--hu-danger);
			border-color: var(--hu-danger);
			color: #fff;
		}
		.hu-prompt-dialog .hu-prompt-btn--danger:hover { background: color-mix(in srgb, var(--hu-danger) 88%, #000); color: #fff; }
	`;
	dlg.appendChild(styleEl);
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
	return escapeHtml(s).replace(/"/g, '&quot;');
}
