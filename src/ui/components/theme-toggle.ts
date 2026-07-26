// <hu-theme-toggle>
//
// A light/dark toggle. Each click flips to the OPPOSITE of the currently
// *resolved* theme, so a single click always produces a visible change. (An
// earlier light → dark → system cycle had a dead click: starting from
// 'system' on a light OS, the first click went system → light — visually
// identical — so it took two clicks to reach dark.) 'system' is still the
// initial default until the user first toggles; it just isn't in the cycle.
//
// The icon reflects the resolved (light|dark) theme. We hold the `theme`
// signal as an instance field so ComponentBase.observe() auto-subscribes and
// re-renders the icon whenever the mode changes.

import { MelodicComponent, html, css } from '@melodicdev/core';
import { applyTheme, getResolvedTheme } from '@melodicdev/components/theme';
import { theme } from '../store/state.js';

@MelodicComponent({
  selector: 'hu-theme-toggle',
  template: (c: ThemeToggleComponent) => {
    // Read the signal so the framework re-renders on change.
    c.theme();
    const icon = getResolvedTheme() === 'dark' ? 'moon' : 'sun';
    return html`
      <ml-button variant="ghost" aria-label="Toggle theme" @ml:click=${c.handleClick}>
        <ml-icon icon=${icon}></ml-icon>
      </ml-button>
    `;
  },
  styles: () => css`
    :host {
      display: inline-flex;
    }
  `,
})
class ThemeToggleComponent {
  theme = theme;

  handleClick = (): void => {
    // Flip based on what's actually showing, not the stored mode. This avoids
    // the two-click problem where 'system' resolves to the same appearance as
    // the next mode in a fixed cycle.
    const next: 'light' | 'dark' = getResolvedTheme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    applyTheme(next);
  };
}

export { ThemeToggleComponent };
