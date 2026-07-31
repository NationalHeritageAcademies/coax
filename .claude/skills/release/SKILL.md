---
name: release
description: Cut a full Coax release — bump the version everywhere it's tracked, write the release notes, verify, commit, push, tag, and watch the GitHub Actions build publish it. Use when the user says "cut a release", "ship this", "do a release", or runs `/release`.
---

# /release — full Coax release

Arguments (`$ARGUMENTS`, optional): `patch` (default), `minor`, `major`, or an
explicit version like `2.1.0`.

This repo's release pipeline: pushing a `vX.Y.Z` tag triggers
`.github/workflows/release.yml`, which builds signed + notarized
macOS/Windows/Linux installers from a single macOS runner (electron-builder
cross-builds; Windows signs via jsign + Azure Trusted Signing), attaches them
to the GitHub Release, and **publishes it using `release-notes/vX.Y.Z.md`**.

The notes are part of the release commit, not a post-build edit: the workflow's
preflight refuses to build a tag that has no notes file, and refuses one whose
`package.json` version disagrees with the tag. So the job here is bump → write
notes → verify → commit → tag; the pipeline does the rest.

## 1. Check the working tree

Run `git status` and `git diff`. Anything uncommitted is the content of this
release — read it well enough to describe it later. If there's nothing to
ship and no reason to release, stop and ask the user what they want shipped.

## 2. Compute the new version

The version lives in three places, always in lockstep:

- `package.json` (source of truth)
- `packages/coax-cli/package.json`
- `src/cli/main.ts` — the `const VERSION = '…'` near the top

Read the current version from `package.json`, then:

- no argument / `patch` → bump the patch number
- `minor` → bump minor, zero the patch
- `major` → bump major, zero minor and patch
- an explicit `x.y.z` → use it verbatim

Edit all three, then run `npm install --package-lock-only` so
`package-lock.json` picks up the new version.

The workflow's preflight compares the tag against `package.json` only (the
source of truth), so a stale `src/cli/main.ts` will not fail the build — keep
the three in lockstep yourself.

## 3. Write the release notes

Create `release-notes/vX.Y.Z.md`. **Line 1 is the release title**, then a blank
line, then the body:

```
Coax vX.Y.Z — <short highlight of the headline change>

<2–5 sentences or a short bullet list of what changed for a user, based on
git log <previous-tag>..HEAD. Written for someone deciding whether to update,
not a changelog robot.>
```

Rules that matter more than prose quality:

- **Only claim what shipped.** Don't call something new if a previous release
  already had it.
- **Mention platform coverage only when it changed.**
- **If the app identity changed**, say so and tell users what they have to do,
  because auto-update will not carry them across it.

This file is what the pipeline publishes. There is no post-build editing step.

## 4. Sanity-check before shipping

From the repo root:

- `npm run typecheck`
- `npx eslint .` (do NOT use `--fix` blindly — see CONTRIBUTING.md; one
  fixer can break the type check)
- `npm test`

Fix anything broken before proceeding — never tag a build you haven't
verified.

## 5. Commit and push

Write the commit message the way recent history does (`git log -5` for
tone): short imperative summary, e.g. `release: v2.1.0 — <headline>`.
Do **not** add a `Co-Authored-By` trailer (global rule, no exceptions).

Stage the versioned files explicitly (not `-A` blindly) — the three version
files, `package-lock.json`, and `release-notes/vX.Y.Z.md` — commit, `git push`.

## 6. Tag and push the tag

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

## 7. Watch the build publish it

```bash
sleep 5
gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId'
```

Then watch it as a **background** Bash command — the universal-mac build plus
notarization takes ~20–35 minutes; don't block or poll manually:

```bash
gh run watch <run-id> --exit-status
```

Tell the user the build is running and follow up when the notification
arrives. On success the last step has already published the release with the
notes from step 3 — there is nothing left to edit.

If it failed, diagnose with `gh run view <run-id> --log-failed` first:

- **Preflight** — missing `release-notes/vX.Y.Z.md`, or a tag that disagrees
  with `package.json`. Fix, delete the tag (`git push --delete origin vX.Y.Z`),
  and re-tag. Nothing was built, so nothing to clean up.
- **Packaging** — signing failures point at the `CSC_*`/`APPLE_*` secrets,
  `signing(win)` at `AZURE_*`/`TRUSTED_SIGNING_*`. The release stays a draft,
  so nothing shipped half-built.

Never publish a release that's missing a platform.

## 8. Report back

Report the release URL back to the user. Users install from the GitHub
Releases page directly; installed apps pick the new version up via
electron-updater's release feed. (The marketing website and its
`update-website.yml` bump workflow were removed from this repo — the site
was upstream-personal, not part of the NHA fork.)
