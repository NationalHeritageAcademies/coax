# Future plan: GitHub-backed workspace sync

> **Status:** future, post-v1.0. Captured because the idea fits Coax's positioning unusually well and we don't want to lose the design thinking. Re-examine when v1.0 ships and cross-machine sync becomes a real user ask — not before.

## Why

Customers with more than one machine (laptop + desktop, home + work, dev + CI) want their collections, folders, requests, and environment variables to follow them. VS Code does this via its Settings Sync; Postman and Insomnia do it via their own cloud accounts. The mechanism is table stakes for any workspace-style tool above a certain adoption level.

The right time to build this is when individual-tier customers are asking — not before. v1.0 should ship lean and validate the core product loop first.

## Architectural choice

Two real options:

### A. Coax-hosted sync (rejected for v1)

Run a server. Customers sign in with a Coax account. Workspaces serialize and upload as encrypted blobs.

- **Pro:** turnkey UX, no third-party setup, single source of truth.
- **Con:** requires Coax-side infra, accounts, GDPR work, ongoing storage costs. Conflicts with the "no Coax servers, no account" posture that's baked into the marketing site, the EULA, and the privacy doc. We'd have to walk that back, which damages the brand.

### B. Customer's own GitHub repo (preferred)

Coax does local `git` operations against a repository the customer owns. The repo contains the workspace serialized as `.http` files in a folder structure.

- **Pro:** no Coax server, no account, no recurring cost. The repo is human-readable and useful even without Coax — every commit is just files. Compounds with Coax's local-first positioning rather than fighting it. Works offline (commits queue locally). Customer's existing git workflow (branches, history, code review) becomes free.
- **Con:** requires a GitHub Personal Access Token (or OAuth flow) and a repo the customer designates. UX has more steps on first setup than option A.

The right call for Coax: **B.** The product's whole value proposition is "your workspace is just files." Sync should be more files, not a black-box cloud service.

## Design questions to pin down

These are the decisions we'd settle before writing code. Listing them here so they don't get re-litigated mid-implementation.

### What gets synced

- **Sync:** collections, folders, requests, environment definitions, environment variable *non-secret* values, request-level overrides.
- **Never sync:** secret variable values. These live in the OS keychain (via `safeStorage`) and re-prompt per machine. Even pushing encrypted secrets to a git repo is too risky — repos leak, mirrors propagate, `git push --force` overwrites history.
- **Don't sync:** transient UI state (open tabs, splitter positions, dark/light theme override). Per-machine preferences should stay per-machine.

### Sync granularity

Per-workspace. The unit a customer thinks of as "my stuff" is the workspace. Per-collection would force re-mapping at pull time; per-machine would erase the cross-machine point.

### Auto-sync vs. manual

**Auto-pull on launch, auto-push on save/quit. Manual Push/Pull buttons as escape hatches.** Reasons:

- The painful UX failure mode is "I sat down at machine B, opened Coax, and my stuff isn't here" — auto-pull-on-launch fixes that without any background polling.
- Auto-push on save (debounced, so we don't push on every keystroke) plus a final push on quit means the *other* machine sees changes within seconds of you saving them, not the next time you remember to click Push.
- Two well-defined trigger points (launch, save) avoid the complexity of continuous polling, debouncing, rate limits, and "Coax is using CPU while idle" complaints.
- Manual buttons stay as escape hatches: "Pull now" if you know the other machine just pushed; "Push now" if you want immediate visibility before quitting.
- Active editing on both machines simultaneously is rare in practice; when it does happen, the conflict gets resolved at push time the same way any concurrent git collaboration does.

### Conflict resolution

Goal: most conflicts auto-resolve silently. Only true contradictions (same field of same request edited on both sides) ever reach the user.

#### Auto-merge strategy

Coax already has a `.http` parser and serializer with stable request identity (UUID per request, preserved in the file via a comment directive — to be added if not already present). That gives us everything we need to do a *semantic* three-way merge instead of git's default line-by-line merge.

The flow when a pull produces a git-level conflict on `collections/<name>.http`:

1. Coax reads the three versions git has staged: `BASE` (common ancestor), `OURS` (local), `THEIRS` (remote).
2. Parse all three into the in-memory request model.
3. Walk request-by-request, using UUIDs to match:
   - **Same UUID only on `OURS`** → request was added locally. Keep it.
   - **Same UUID only on `THEIRS`** → request was added on the other machine. Keep it.
   - **UUID present on `BASE` + `OURS` but not `THEIRS`** → deleted remotely. Respect the deletion.
   - **UUID present on `BASE` + `THEIRS` but not `OURS`** → deleted locally. Respect the deletion.
   - **UUID present on all three** → field-by-field merge (URL, headers, body, name, chainName):
     - If only one side changed a field, take that side's value.
     - If both sides changed the same field to the same value, take it (no conflict).
     - If both sides changed the same field to *different* values, this is a real conflict — flag for user resolution.
4. If no real conflicts were found, write the merged result back, stage it, and the pull completes silently.
5. If real conflicts remain, surface a dialog: "N requests have conflicting edits. Choose which version to keep for each, or open the .http file to merge by hand."

#### What this catches automatically

- Edited request A on machine 1, edited request B on machine 2 → both edits land. (The common case for any non-trivial workspace.)
- Edited the URL of request X on machine 1, edited the body of the same request X on machine 2 → both edits land.
- Added a new request on machine 1, deleted a different request on machine 2 → both changes land.
- Renamed a collection (one file → another) on one side, edited an unrelated request on the other → both changes land.

#### What still needs user input

- Edited the URL of request X on machine 1 *and* the URL of the same request X on machine 2 to different values. Coax can't guess which one you meant.
- Deleted request X on machine 1 but heavily edited it on machine 2 — ambiguous intent (did you forget to delete, or did you mean to keep your edits?).

For these, Coax shows a per-conflict dialog: side-by-side view of the two values with "Keep mine / Keep theirs / Edit by hand" buttons. Resolves the conflict in-app for the common case (a couple of conflicts); falls back to "open the file" for unusually messy merges.

#### Stable request identity in `.http`

The semantic merge depends on a stable per-request UUID being present in the serialized `.http` file. If the existing serializer doesn't emit it, we add a `# @id <uuid>` directive at the top of each request block — easy to add, ignored by other `.http` parsers (it's a comment), and survives round-trip through the existing parser without disturbing existing fields. **TODO when implementing:** verify whether `src/parser/serialize.ts` already writes a stable ID, and add the directive if not.

### Repo format

```
<repo>/
  README.md                  # auto-generated; explains what this repo is
  coax.workspace.json        # workspace metadata (name, id)
  collections/
    <collection-name>.http   # one file per top-level collection
  envs/
    <collection-name>.env.json   # non-secret env definitions per collection
  .gitignore                 # excludes anything we never want to sync
```

- **One `.http` per collection** — matches the product's whole "your API workspace is just a .http file" identity. The format already encodes folder structure via the existing serializer (`src/parser/serialize.ts`), so a collection's full tree round-trips through a single file. This is also exactly what `collection:export` produces today, which means the existing export path is the sync's serialization layer — no duplicate code, no second format to maintain.
- **Filenames track the collection name.** Renaming a collection renames the file, which is what a user would expect (and the new path shows in `git status` as a rename). Slug the name on write (`Scholar API` → `scholar-api.http`) to keep filenames portable across filesystems.
- **`.gitignore` we generate:** excludes secrets and any per-machine file, so a customer can't accidentally `git add .` something we wouldn't push.

### Trade-off acknowledged

One file per collection means concurrent edits to *different requests in the same collection* from two machines will produce a git-level conflict on that file, where one-file-per-request would have been a no-conflict merge at the git level. We accept that trade because:

1. The single-file format is the product's identity. Breaking it for sync would create two formats Coax has to support — `.http` for export/import, request-files for sync — and they'd inevitably drift.
2. **The semantic merge layer (see "Conflict resolution" below) auto-resolves the conflict before the user sees it.** Git complains; Coax silently fixes it. The user experience matches what one-file-per-request would give for free.
3. The remaining cases that *can't* auto-resolve (same field of same request, edited differently on both sides) would conflict in any format — they're true semantic conflicts, not artifacts of file granularity.

### Authentication

Personal Access Token, stored in `safeStorage`. Single token, single repo. We don't need full OAuth — PATs work for both public and private repos and don't require us to register a GitHub App. Document the minimum scopes (`repo` for private, `public_repo` for public).

OAuth via a GitHub App is a v2 polish item if PATs prove too friction-y for non-developer users (which is itself unlikely for an HTTP-client product).

## Zero-cost v1.0 prep step

The existing `collection:export` already produces the right shape — one `.http` file per collection. So the prep is mostly free.

Two small adds that pay off whether or not we ever build the full sync feature:

1. **Emit a stable `# @id <uuid>` directive per request** in the serializer (`src/parser/serialize.ts`). The semantic merge depends on it; adding it now means any `.http` files customers export today will be sync-compatible later, with no migration on their part. Cost: ~10 lines of code in the serializer, an equivalent reader in the parser, and a test that round-trips.

2. **"Export workspace" command** that writes every top-level collection as its own `.http` file into a folder the user picks, plus a `coax.workspace.json` metadata file. This is the sync repo layout, produced manually. Customers who want git-based sync can run that command, `git init`, commit, and push — fully manual, fully their own workflow, no Coax sync code involved. When real sync ships, the in-Coax push/pull is just "run that export, then run git, then run the import" — zero new file formats.

## Out of scope (explicit)

- **Merging across workspaces** — different concept, different problem.
- **Real-time collaboration** — two cursors in the same request. Not a fit for HTTP-client UX.
- **Hosted GitHub Enterprise on-prem** — single-tenant deployments. Open this back up only if we have a paying enterprise customer asking.
- **Other git hosts (GitLab, Bitbucket)** — only if a real customer asks. The implementation against `git` itself is host-agnostic; just the auth flow varies.

## When to re-open this plan

Look for these signals before investing:

1. Multiple individual-tier customers asking for cross-machine sync unprompted.
2. A churn pattern citing "I switched to Insomnia/Postman for sync."
3. v1.0 individual-tier revenue covering the engineering time to build it (a week minimum, probably two).

If those aren't all true, the answer is "still not yet, talk to me again next quarter."
