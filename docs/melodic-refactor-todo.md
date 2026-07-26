# Melodic framework refactor — TODO

The app was originally built with plain `extends HTMLElement` web components, then we incrementally adopted Melodic's `<ml-*>` form controls for inputs/buttons. The next phase is converting **all custom components** to be authored on the Melodic framework itself (`@MelodicComponent` decorator + `html`/`css` template + signal-based reactivity).

This is a substantial undertaking but pays back in eliminated render bugs (Monaco rebuilds, focus loss, panel ghosting, click-handler races) and in idiomatic alignment with the rest of the stack.

## Pattern reference (validated in batch 1)

```ts
import { MelodicComponent, html, css } from '@melodicdev/core';
import { mySignal } from '../store/state.js';

@MelodicComponent({
  selector: 'hu-foo',
  attributes: ['name'],   // optional: observed attributes auto-bind to camelCase fields
  template: (c: FooComponent) => {
    c.someSignal();   // Reading a signal in the template subscribes for re-renders
    return html`
      <div class="root">
        <span>${c.label}</span>
        <button @click=${c.handleClick}>${c.value}</button>
      </div>
    `;
  },
  styles: () => css`
    :host { display: block; }
    .root { padding: 8px; }
  `,
})
class FooComponent {
  // External signal held as a field — ComponentBase.observe() auto-subscribes
  someSignal = mySignal;

  // Local reactive state — mutating triggers scheduleRender (microtask-batched)
  value = 0;
  label = 'Hello';

  handleClick = (): void => { this.value++; };
}
```

Key learnings (from `node_modules/@melodicdev/core/lib/components/classes/component-base.class.js`):

- `ComponentBase.observe()` walks instance fields. Signals are detected via `isSignal()` and auto-subscribed; renders are scheduled on signal change. Disconnection auto-unsubscribes via the framework's `_unsubscribers`.
- Plain reactive fields go through a `set` accessor that calls `scheduleRender()`.
- Getters are preserved but only re-evaluated on render — they don't trigger re-renders themselves. If a getter depends on a signal, the signal must also be read in the template (or held as a field) for reactivity.
- Lifecycle hooks (presence-detected): `onInit`, `onCreate`, `onRender`, `onDestroy`, `onAttributeChange`, `onPropertyChange`.
- Attributes with kebab-case names auto-bind to camelCase fields and coerce booleans (`present` = true, `"false"`/absent = false).
- Shadow DOM + global styles are wired automatically; `:host` selector works as expected.
- Decorator works under TC39 standard decorators (no `experimentalDecorators` flag needed).

## Status

| # | Component | Status | Lines (approx) | Notes |
|---|---|---|---|---|
| 1 | `hu-method-badge` | ✅ Done | ~30 | First conversion — confirmed pattern |
| 2 | `hu-status-bar` | ✅ Done | ~30 | First signal-binding conversion |
| 3 | `hu-theme-toggle` | ✅ Done | ~50 | Signal + click handler — note explicit signal read in template |
| 4 | `hu-monaco-editor` | ⬜ Pending | ~100 | External lifecycle (Monaco editor) — onCreate/onDestroy critical |
| 5 | `hu-tab-strip` | ⬜ Pending | ~100 | Lists + click delegation |
| 6 | `hu-sidebar-tree` | ⬜ Pending | ~200 | Hierarchical render + local expanded state |
| 7 | `hu-env-switcher` | ⬜ Pending | ~250 | Dropdown + inline form + recover button |
| 8 | `hu-env-manager` | ⬜ Pending | ~500 | Modal — consider splitting into hu-env-list / hu-env-detail / hu-env-vars-table |
| 9 | `hu-app-frame` | ⬜ Pending | ~250 | Grid layout + splitter + import/export wiring |
| 10 | `hu-request-tab` | ⬜ Pending | ~1500 | The big one — should be split into sub-components |

## Suggested order

1. `hu-monaco-editor` — small but tricky (external lifecycle); proves Melodic plays well with imperatively-managed children
2. `hu-tab-strip` — easy template + simple click delegation
3. `hu-sidebar-tree` — hierarchical templates with local state
4. `hu-env-switcher` — multi-signal + inline form pattern
5. `hu-env-manager` — modal + larger surface; consider splitting
6. `hu-app-frame` — layout root + splitter drag handlers (the only place where direct DOM manipulation may still be needed)
7. **Split `hu-request-tab`** into many small components first, then convert each:
   - `hu-request-bar` (method/url/send + chain name)
   - `hu-request-subtabs` (the params/headers/body/auth/vars/curl tab strip + active panel)
   - `hu-params-panel`
   - `hu-headers-panel`
   - `hu-body-panel`
   - `hu-auth-panel`
   - `hu-vars-panel`
   - `hu-curl-panel`
   - `hu-response-pane`
   - `hu-response-status` (status pill)
   - `hu-response-body-panel`
   - `hu-response-headers-panel`
   - `hu-response-raw-panel`

## Bigger-picture todos (post-refactor)

These aren't component conversions but related framework alignment:

- **Audit non-form native controls**. Replace remaining native `<input>`/`<select>`/`<button>`/`<textarea>` with `<ml-*>` equivalents where Melodic has one. Only known holdouts: env-switcher's `<select>` with `<optgroup>` (`<ml-select>` doesn't support optgroups — may need a `hu-grouped-select` Melodic component); inline prompt overlay in env-manager.
- **Use `@melodicdev/core/forms`** for request body / KV grid editing. Get validation, dirty tracking, and form-state from the framework instead of hand-rolled.
- **Use `@melodicdev/core/state`** for the renderer store (`src/ui/store/state.ts`). Currently we use bare signals; the state module may give us better store semantics.
- **Use `@melodicdev/core/http`** patterns as inspiration for `src/ipc/renderer.ts`. The current rpc helper is minimal; Melodic's http module's interceptor / observable patterns may be useful.
- **Use `@melodicdev/core/injection`** if any cross-component dependency injection makes sense (e.g., a settings service injected into multiple components).
- **Document Melodic patterns** in `docs/architecture.md` (or `CONTRIBUTING.md`) once everything's converted, so future contributors don't re-make the original mistake.

## Why this matters (so we don't lose the thread)

A chunk of bugs we've been firefighting were direct consequences of the `innerHTML = '...'` pattern:

- Monaco editor recreated on every render → focus loss, scroll loss
- `<ml-input>` keystroke focus stealing → had to disable per-keystroke re-renders
- Panel content duplication / ghosting → would be impossible with template diffing
- `app-frame.refresh()` race conditions → required manual `removeChild` loop fix
- Verbose subscribe/unsubscribe boilerplate in every `connectedCallback`/`disconnectedCallback`

A Melodic-native component diffs the template, only updating changed parts and leaving Monaco / `<ml-input>` instances alive across state updates. Most of the layout and rendering bug-chasing in recent sessions wouldn't have happened.
