# Plan: Folder-level auth & variable inheritance

## Why
Quality-of-life feature Postman users assume exists. Currently every request in a folder restates the same auth header — duplicative and error-prone.

## Goal
Define auth, headers, or variables once at the folder level; have all requests in that folder inherit, with per-request override.

## File format
A `# @folder` block at the top of a `############` divider section:

```http
############
# @folder Users
# @auth bearer {{accessToken}}
# @header X-Tenant {{tenantId}}
# @var defaultLimit 50
############

### Get all users
GET {{baseUrl}}/users?limit={{defaultLimit}}

### Get user by id
GET {{baseUrl}}/users/{{userId}}
# (inherits auth and X-Tenant header from folder)

### Anonymous health check
# @auth none
GET {{baseUrl}}/users/health
# (overrides folder auth)
```

## Resolver changes

Layered scope order (existing): global → collection → request.
New order: **global → collection → folder → request.** Folder slots in between collection and request.

Auth + headers follow the same precedence: a per-request `# @auth` or explicit `Authorization` header overrides folder; `# @auth none` explicitly disables inherited auth.

## UI affordances
- In the request tab, show inherited values as **muted/badged** ("from folder: Users") with a click-to-override affordance.
- Sidebar folder context menu: "Edit folder settings…" → modal for auth/headers/vars.
- The folder block is just a `.http` comment block — it round-trips through any compliant `.http` editor.

## Work breakdown
1. Extend parser to recognize `# @folder` blocks inside `############` dividers; capture into a `Folder` node.
2. Extend serializer to emit folder blocks on save (round-trip preservation).
3. Extend resolver `Scope` to include folder layer.
4. Update request UI to surface inherited values and "override" affordance.
5. Build folder settings modal.
6. Tests:
   - Folder auth flows to child request when no override.
   - Per-request `# @auth none` disables it.
   - Header from folder + header from request → both sent.
   - Variable resolution at folder layer.
7. Update parser docs (`docs/http-file-format.md`).

## Risks / open questions
- **Compat with other `.http` editors.** Our folder block is just comments — VS Code REST Client and JetBrains will ignore it harmlessly. But if they hide comments and a user wonders "where did my auth go in VS Code?", we should document that.
- **Deeply nested folders.** Current divider model is flat. Decision: don't support nested folders in this phase; one level only. Reassess if asked for.

## Definition of done
- Folder-level auth + headers + vars resolve correctly via fixtures.
- Saving and reopening a file preserves folder blocks byte-for-byte where possible.
- UI clearly shows inherited values without making the request panel cluttered.
- `docs/http-file-format.md` documents folder syntax.
