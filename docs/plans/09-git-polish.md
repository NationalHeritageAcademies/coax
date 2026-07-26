# Plan: Git polish — lean into the local-first story

## Why
Phase 4 is the marketing pivot to v1.0. The thesis: a file-based HTTP tool's best sync mechanism is the one your editor already has — **git**. Make that workflow native and the "you don't need a cloud account" pitch becomes self-evident.

## Goals
Surface git state inside Coax, make `.http` files diff well, and lower the bar to the next commit. **Don't try to be a git client.** We're a thin overlay on top of the user's existing git workflow.

## Features

### 1. Workspace status indicator
- Status bar widget: `● clean` / `3 changes` / `2 changes · 1 ahead`.
- Hover: list of changed files.
- Click: open a small "Changes" panel listing files and basic actions (commit, discard, open in diff view).
- Implemented via `git status --porcelain=v2 --branch` shelled out from main process. No JS git library — we already require git for power users.

### 2. Diff view for `.http` files
- "Diff vs HEAD" button in the request tab header.
- Opens Monaco's built-in diff editor (`monaco.editor.createDiffEditor`) showing the request's file at HEAD vs working tree.
- Also available as a context menu item in the sidebar tree (file-level diff).

### 3. Commit & push
- File menu items: **Commit changes…** and **Push**.
- Commit dialog: text area for message (Monaco, gitcommit syntax mode), checklist of files to include, commit + author display.
- Honor existing git hooks; surface hook failures in the dialog (don't suppress).
- Push runs against the upstream (already configured by the user); show progress/output in a toast.
- Explicitly NOT in scope: branch management, merge UI, rebase, conflict resolution. Punt to the user's existing git tooling.

### 4. Auto-format `.http` files on save
- A canonical formatter: consistent header capitalization, single blank line between requests, sorted (or preserved-order? — preserved) query params, no trailing whitespace.
- **Idempotent** — formatting an already-formatted file produces no diff.
- Enable by default, toggle in settings.
- Surface in the marketing site as "git diffs you'll actually want to review."

### 5. Branch-aware environment files (optional)
- If `.coax/env.{branch}.json` exists, prefer it over `.coax/env.json`.
- Lets a user pin different API targets to different branches (e.g. `feature-x` branch points at staging-X).
- Pure file-naming convention — no UI commitment beyond surfacing which env file is active.

## Architecture
```
src/git/                 NEW
  status.ts              shell out to git, parse porcelain v2
  diff.ts                git show :path / git diff HEAD path
  commit.ts              git commit, git push
  hooks.ts               watch .git/ for HEAD/index changes (chokidar)
src/ui/components/
  status-bar-git.ts      NEW — widget
  changes-panel.ts       NEW
  commit-dialog.ts       NEW
  diff-view.ts           NEW (Monaco diff editor host)
src/parser/formatter.ts  NEW — canonical formatter, idempotent
```

Detect git presence at workspace open by checking for `.git/` in the workspace folder or any parent. No git → hide all git UI gracefully (don't nag).

## Work breakdown
1. Build `src/git/` shell-out helpers + tests against a real git repo fixture.
2. Watch `.git/HEAD` and `.git/index` with chokidar; debounce updates to the status widget.
3. Build status-bar-git component.
4. Build changes panel.
5. Build diff view using Monaco diff editor.
6. Build commit dialog; wire to `git commit` and surface hook errors.
7. Build formatter; tests for idempotency on a corpus of real-world `.http` files.
8. Wire format-on-save (configurable).
9. Implement branch-aware env file loading.
10. Update marketing site with "git-native" section + screenshot/GIF.
11. Update `docs/user-guide.md` with a "Working with git" section.

## Risks / open questions
- **Windows git path detection.** `git` may not be in PATH on Windows; check standard install locations and prompt with "Install git" link if missing — gracefully, not blockingly.
- **Format-on-save vs unsaved diff churn.** If a user has an open tab with unsaved edits and they hit format-on-save, the in-tab buffer must reflect the formatted version. Decision: format on `Cmd+S`, not on blur or autosave.
- **Performance.** `git status` on a huge repo can be slow. Cap status frequency to once every 2s; use `git status --no-optional-locks` to avoid blocking other git operations.
- **Auth for `git push`.** We just shell out; if their git is set up to push (SSH key, credential helper), it works. If not, we show the error. Not our job to fix git auth.

## Definition of done
- Workspace status updates within ~1s of `git commit` from a terminal.
- "Diff vs HEAD" shows the right thing for a request that was edited and saved.
- Commit dialog produces a real commit (visible in `git log`), respects pre-commit hooks.
- Formatter is round-trip idempotent against every `.http` file in `examples/`.
- Branch-aware env switching works when changing branches with the workspace open.
- Marketing site has a git-native section.
