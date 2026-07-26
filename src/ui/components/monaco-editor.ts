// <http-monaco-editor>
//
// Monaco-backed code editor wrapped as a Melodic component. The template is
// intentionally a single static host div — Monaco manages its own DOM inside
// that div and we don't want re-renders to disturb it. Attribute/property
// changes flow through onPropertyChange (the framework wires attributes to
// reactive properties), where we call Monaco's imperative API instead of
// re-rendering.
//
// Attributes / reactive properties:
//   value      — current text content
//   language   — monaco language id (json, javascript, typescript, html, plaintext, shell, ...)
//   readonly   — boolean attribute (presence = true)
//
// Events:
//   ml:change  — detail: { value: string }, fired on user edits

import { MelodicComponent, html, css } from '@melodicdev/core';
import type { IElementRef, OnCreate, OnDestroy, OnPropertyChange } from '@melodicdev/core/components';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { getResolvedTheme, onThemeChange } from '@melodicdev/components/theme';

// Wire Monaco's worker loader. Vite's `?worker` suffix resolves these as
// constructable Worker classes. We only enable JSON syntactically — TS/CSS/HTML
// language workers can be added later if/when those bodies need them.
(globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    return new editorWorker();
  },
};

// Monaco injects its stylesheets into document.head; those don't pierce
// shadow DOM, so when an <http-monaco-editor> sits inside any ancestor
// shadow root (e.g. <hu-request-tab>'s) the editor's internal layout
// breaks — text escapes the editor's bounds because none of Monaco's
// overflow/scroll/positioning rules apply.
//
// We mirror every <style> element in document.head into each shadow root
// that contains a Monaco editor, as adoptedStyleSheets. A MutationObserver
// on document.head keeps the mirror current as Monaco injects more
// styles lazily (language workers, theme switches).
const monacoAdoptedShadowRoots = new Set<ShadowRoot>();
let monacoCachedSheets: CSSStyleSheet[] = [];
let monacoHeadObserver: MutationObserver | null = null;

function reapplyToAllRoots(): void {
  for (const r of monacoAdoptedShadowRoots) applyMonacoSheetsTo(r);
}

function cloneSheetFromText(text: string): CSSStyleSheet | null {
  if (text.length === 0) return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    return sheet;
  } catch {
    return null;
  }
}

function refreshMonacoSheets(): void {
  const next: CSSStyleSheet[] = [];
  for (const el of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    if (el instanceof HTMLStyleElement) {
      // Inline <style> tags — what Vite emits per-module in dev.
      const sheet = cloneSheetFromText(el.textContent ?? '');
      if (sheet) next.push(sheet);
      continue;
    }
    if (el instanceof HTMLLinkElement) {
      // Vite's production build concatenates every CSS import (including
      // Monaco's own stylesheets) into a single bundled <link>. We have to
      // pull rules from these or Monaco's layout rules never reach the
      // shadow root and editor lines escape into the surrounding page.
      //
      // Skip Melodic-tagged sheets: Melodic adopts those itself via
      // applyGlobalStyles, no need to double-adopt.
      if (el.hasAttribute('melodic-styles')) continue;
      if (!el.sheet) {
        // Stylesheet hasn't finished loading yet — re-run once it does.
        // Monaco creation can race the bundled CSS load; without this hook
        // the first editor in the session renders with no styles.
        el.addEventListener(
          'load',
          () => {
            refreshMonacoSheets();
            reapplyToAllRoots();
          },
          { once: true },
        );
        continue;
      }
      try {
        const text = Array.from(el.sheet.cssRules).map((rule) => rule.cssText).join('\n');
        const sheet = cloneSheetFromText(text);
        if (sheet) next.push(sheet);
      } catch {
        // SecurityError reading cssRules on a cross-origin sheet — skip.
        // (Google Fonts and friends are loaded into shadow roots via
        // CSS-variable inheritance rather than rule mirroring, so missing
        // them here is fine.)
      }
    }
  }
  monacoCachedSheets = next;
}

function applyMonacoSheetsTo(root: ShadowRoot): void {
  // Drop any previously-cached sheets so this root tracks the latest set.
  const baseline = root.adoptedStyleSheets.filter(
    (s) => !monacoCachedSheets.includes(s),
  );
  root.adoptedStyleSheets = [...baseline, ...monacoCachedSheets];
}

function ensureMonacoStylesIn(root: ShadowRoot): void {
  monacoAdoptedShadowRoots.add(root);
  if (!monacoHeadObserver) {
    monacoHeadObserver = new MutationObserver(() => {
      refreshMonacoSheets();
      reapplyToAllRoots();
    });
    monacoHeadObserver.observe(document.head, { childList: true });
  }
  refreshMonacoSheets();
  applyMonacoSheetsTo(root);
}

@MelodicComponent({
  selector: 'http-monaco-editor',
  attributes: ['value', 'language', 'readonly'],
  // Shadow template is just a slot. Monaco injects its stylesheet into
  // document.head; that doesn't pierce shadow DOM, so we mount the editor
  // into a light-DOM child of the host element and let the shadow root
  // project it via <slot>. Without this Monaco's layout (overflow, scroll
  // containment) breaks and the editor's lines escape into the surrounding
  // page.
  template: () => html`<slot></slot>`,
  styles: () => css`
    :host {
      display: block;
      min-height: 120px;
    }
  `,
})
class MonacoEditorComponent implements IElementRef, OnCreate, OnDestroy, OnPropertyChange {
  elementRef!: HTMLElement;

  // Observed properties — reactive setters call onPropertyChange, which syncs
  // to Monaco's imperative API. We never read these in the template.
  value = '';
  language = 'plaintext';
  readonly = false;

  // Private (underscore prefix excludes from observe()) — Monaco's editor
  // instance and lifecycle disposers.
  private _editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private _themeUnsub: (() => void) | null = null;
  private _suppressChange = false;
  private _host: HTMLDivElement | null = null;

  onCreate(): void {
    // Mount Monaco into the LIGHT DOM (a child of the host element) so its
    // global stylesheet — injected into document.head by monaco.editor.create
    // — actually applies. Inside the shadow root the global styles are
    // blocked and Monaco's internal layout breaks (rows escape, scrollbars
    // vanish). The shadow template's <slot> projects this child for display.
    this._host = document.createElement('div');
    this._host.style.cssText = 'width:100%;height:100%;min-height:120px';
    this.elementRef.appendChild(this._host);

    this._editor = monaco.editor.create(this._host, {
      value: this.value,
      language: this.language,
      readOnly: this.readonly,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
      wordWrap: 'on',
    });

    this._editor.onDidChangeModelContent(() => {
      if (this._suppressChange) return;
      this.elementRef.dispatchEvent(
        new CustomEvent('ml:change', {
          detail: { value: this._editor?.getValue() ?? '' },
          bubbles: true,
          composed: true,
        }),
      );
    });

    // Sync Monaco's theme with the host app. Without this, the editor stays
    // on the default light theme even when the rest of the UI is in dark
    // mode, producing a glaring white box. monaco.editor.setTheme is global —
    // every editor on the page picks up the change.
    this._applyTheme();
    this._themeUnsub = onThemeChange(() => { this._applyTheme(); });

    // Mirror Monaco's document.head stylesheets into whichever shadow root
    // contains this editor. Without this, Monaco's layout rules don't apply
    // (rows escape, scrollbars vanish) when the editor sits inside another
    // component's shadow DOM.
    const root = this.elementRef.getRootNode();
    if (root instanceof ShadowRoot) ensureMonacoStylesIn(root);
  }

  onPropertyChange(prop: string, _old: unknown, val: unknown): void {
    if (!this._editor) return;
    if (prop === 'value' && typeof val === 'string' && this._editor.getValue() !== val) {
      this._suppressChange = true;
      this._editor.setValue(val);
      this._suppressChange = false;
    } else if (prop === 'language' && typeof val === 'string') {
      const model = this._editor.getModel();
      if (model) monaco.editor.setModelLanguage(model, val);
    } else if (prop === 'readonly') {
      this._editor.updateOptions({ readOnly: Boolean(val) });
    }
  }

  onDestroy(): void {
    this._themeUnsub?.();
    this._themeUnsub = null;
    this._editor?.dispose();
    this._editor = null;
    if (this._host) {
      this._host.remove();
      this._host = null;
    }
  }

  private _applyTheme(): void {
    const resolved = getResolvedTheme();
    monaco.editor.setTheme(resolved === 'dark' ? 'vs-dark' : 'vs');
  }
}

export { MonacoEditorComponent };
