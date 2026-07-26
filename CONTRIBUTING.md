# Contributing to Coax

Thanks for your interest in improving Coax! Bug reports, feature requests,
docs fixes, and pull requests are all welcome.

## Dev setup

Requirements: **Node 20+** and npm. Native modules (better-sqlite3) compile
during install, so you'll need a working C++ toolchain (Xcode CLT on macOS,
build-essential on Linux, VS Build Tools on Windows).

```bash
git clone https://github.com/MelodicDevelopment/coax.git
cd coax
npm install
npm run dev        # launch the app with hot reload
```

No `.env.local` is needed for development. The optional variables in
`.env.example` only matter for official signed/notarized release builds and
opt-in crash reporting.

## Running tests

```bash
npm test               # Vitest unit + integration suite
npm run test:watch     # Vitest in watch mode
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
```

End-to-end tests drive the real packaged Electron app via Playwright:

```bash
npm run test:e2e
```

The `pretest:e2e` hook builds the app and rebuilds better-sqlite3 for
Electron's Node ABI first, so the first run takes a few minutes.

## Project layout

See the [Project layout](README.md#project-layout) section of the README.
The short version: `src/parser`, `src/resolver`, `src/assertions`, and
`src/runner` are pure TypeScript with no Electron dependency and are the
easiest places to start; `src/app` is the Electron main process; `src/ui`
is the renderer (Melodic web components).

## Pull requests

- For anything beyond a small fix, **open an issue first** so we can agree
  on the approach before you invest time.
- Keep PRs focused — one change per PR.
- Add or update tests for behavior you change. `npm test` and
  `npm run typecheck` must pass.
- Match the existing code style (Prettier + ESLint are configured; run
  `npm run lint`).
- Caution with `eslint --fix`: the `no-unnecessary-type-assertion` fixer can
  strip assertions that drive generic inference (e.g. on `querySelector`/
  `closest` calls) and silently break the type check — always run
  `npm run typecheck` after auto-fixing.
- Describe *why* in the PR body, not just what.

## Reporting bugs

Use the bug report issue template. Include your OS, Coax version, and a
minimal `.http` file that reproduces the problem when relevant — that turns
most bugs into quick fixes.

## Security

If you find a vulnerability — especially around the encrypted-secrets store
or the renderer↔main IPC surface — please **do not** open a public issue.
See [SECURITY.md](SECURITY.md) for how to report it privately.
