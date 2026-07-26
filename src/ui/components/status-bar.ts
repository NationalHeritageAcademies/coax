// <hu-status-bar>
//
// Footer bar showing the active workspace name + path. Subscribes to the
// `activeWorkspace` signal — when it changes (workspace switch), the
// framework re-renders automatically via ComponentBase.observe(), which
// detects signal-typed instance fields and wires up a subscription.

import { MelodicComponent, html, css } from '@melodicdev/core';
import { activeWorkspace } from '../store/state.js';

@MelodicComponent({
  selector: 'hu-status-bar',
  template: (c: StatusBarComponent) => {
    const ws = c.activeWorkspace();
    if (!ws) {
      return html`
        <span class="left">
          <span class="dot dot--muted"></span>
          <span>No workspace</span>
        </span>
        <span></span>
      `;
    }
    return html`
      <span class="left">
        <span class="dot"></span>
        <span class="name">${ws.name}</span>
        <span class="sep">·</span>
        <span class="path" title=${ws.path}>${ws.path}</span>
      </span>
      <span></span>
    `;
  },
  styles: () => css`
    :host {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid var(--hu-border);
      padding: 0 16px;
      font-family: var(--hu-font-mono);
      font-size: 11px;
      line-height: 1;
      color: var(--hu-text-muted);
      background: var(--hu-bg-elevated);
      height: 100%;
    }
    .left {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      overflow: hidden;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--hu-success);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--hu-success) 22%, transparent);
      flex-shrink: 0;
      position: relative;
    }
    .dot::after {
      /* Soft halo "pulse" that subtly breathes — telegraphs "alive and
         connected" without being distracting. Disabled under reduced-motion
         via the global media query in tokens.css. */
      content: '';
      position: absolute;
      inset: -2px;
      border-radius: inherit;
      background: var(--hu-success);
      opacity: 0.35;
      animation: hu-status-pulse 2.4s var(--hu-ease-in-out) infinite;
    }
    .dot--muted {
      background: var(--hu-text-muted);
      box-shadow: none;
    }
    .dot--muted::after {
      display: none;
    }
    @keyframes hu-status-pulse {
      0%,
      100% {
        transform: scale(1);
        opacity: 0.35;
      }
      50% {
        transform: scale(1.6);
        opacity: 0;
      }
    }
    .name {
      color: var(--hu-text-secondary);
      font-weight: 500;
    }
    .sep {
      opacity: 0.5;
    }
    .path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
})
class StatusBarComponent {
  // Holding the signal as an instance field lets ComponentBase.observe()
  // detect it via isSignal() and auto-subscribe, so renders happen whenever
  // the workspace switches.
  activeWorkspace = activeWorkspace;
}

export { StatusBarComponent };
