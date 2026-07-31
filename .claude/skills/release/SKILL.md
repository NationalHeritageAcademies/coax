---
name: release
description: Cut a full Coax release — bump the version everywhere it's tracked, verify, commit, push, tag, wait on the GitHub Actions build, then write a real title/description and publish the draft GitHub release. Use when the user says "cut a release", "ship this", "do a release", or runs `/release`.
---

# /release — full Coax release

Arguments (`$ARGUMENTS`, optional): `patch` (default), `minor`, `major`, or an
explicit version like `1.4.0`.

This repo's release pipeline: pushing a `vX.Y.Z` tag triggers
`.github/workflows/release.yml`, which builds signed + notarized
macOS/Windows/Linux installers from a single macOS runner (electron-builder
cross-builds; Windows signs via jsign + Azure Trusted Signing) and uploads
them to a **draft** GitHub Release. The only manual steps are the ones
this skill automates: bump → verify → tag → publish with real notes.

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

## 3. Sanity-check before shipping

From the repo root:

- `npm run typecheck`
- `npx eslint .` (do NOT use `--fix` blindly — see CONTRIBUTING.md; one
  fixer can break the type check)
- `npm test`

Fix anything broken before proceeding — never tag a build you haven't
verified.

## 4. Commit and push

Write the commit message the way recent history does (`git log -5` for
tone): short imperative summary, e.g. `release: v1.3.2 — <headline>`.
Do **not** add a `Co-Authored-By` trailer (global rule, no exceptions).

Stage the versioned files explicitly (not `-A` blindly), commit, `git push`.

## 5. Tag and push the tag

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

## 6. Watch the build

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
arrives. If it failed, diagnose with `gh run view <run-id> --log-failed`
first — signing failures point at the CSC_*/APPLE_* secrets, `signing(win)`
failures at the AZURE_*/TRUSTED_SIGNING_* secrets. Never publish a release
that's missing a platform.

## 7. Write the release and publish it

The draft release `vX.Y.Z` now has all installers + auto-update manifests
attached but no real notes. Replace both and publish:

```bash
gh release edit vX.Y.Z \
  --title "Coax vX.Y.Z — <short highlight of the headline change>" \
  --notes "$(cat <<'EOF'
<2–5 sentences or a short bullet list of what changed for a user, based on
git log <previous-tag>..vX.Y.Z. Written for someone deciding whether to
update, not a changelog robot. Mention platforms only if coverage changed.>
EOF
)" \
  --draft=false --latest
```

## 8. Report back

Report the release URL back to the user. Users install from the GitHub
Releases page directly; installed apps pick the new version up via
electron-updater's release feed. (The marketing website and its
`update-website.yml` bump workflow were removed from this repo — the site
was upstream-personal, not part of the NHA fork.)
