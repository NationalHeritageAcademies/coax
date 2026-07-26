// <hu-method-badge method="GET">
//
// Small, color-coded HTTP method pill rendered inline. The color comes from the
// CSS method tokens defined in tokens.css. We use color-mix() for the background
// so the pill stays themed (light mode shows a 15%-tint of the method color),
// keeping a single source of truth for method colors.

import { MelodicComponent, html, css } from '@melodicdev/core';

const METHOD_COLOR: Record<string, string> = {
  GET: 'var(--hu-method-get)',
  POST: 'var(--hu-method-post)',
  PUT: 'var(--hu-method-put)',
  PATCH: 'var(--hu-method-patch)',
  DELETE: 'var(--hu-method-delete)',
  HEAD: 'var(--hu-method-head)',
  OPTIONS: 'var(--hu-method-options)',
};

@MelodicComponent({
  selector: 'hu-method-badge',
  attributes: ['method'],
  template: (c: MethodBadgeComponent) => {
    const m = (c.method ?? 'GET').toUpperCase();
    const color = METHOD_COLOR[m] ?? METHOD_COLOR.GET!;
    return html`<span class="badge" style="--badge-color: ${color}">${m}</span>`;
  },
  styles: () => css`
    :host {
      display: inline-flex;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: var(--hu-font-mono);
      font-size: 10px;
      font-weight: 700;
      padding: 3px 7px;
      border-radius: var(--hu-radius-sm);
      color: var(--badge-color);
      background: color-mix(in srgb, var(--badge-color) 14%, transparent);
      box-shadow:
        inset 0 0 0 1px color-mix(in srgb, var(--badge-color) 22%, transparent),
        var(--hu-highlight-inset);
      letter-spacing: 0.06em;
      line-height: 1;
      min-width: 48px;
      flex-shrink: 0;
      font-feature-settings: 'tnum', 'ss01';
    }
  `,
})
class MethodBadgeComponent {
  method = 'GET';
}

export { MethodBadgeComponent };
