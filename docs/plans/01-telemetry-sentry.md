# Plan: Sentry crash reporting

## Why
v0.1 ships with zero signal when the app crashes on a user's machine. The most actionable telemetry at the lowest brand cost is crash reporting, not usage analytics. We'll do this; we won't do usage analytics yet.

## Scope
- **In:** `@sentry/electron` in main + renderer. Native crash capture via Electron Crashpad → Sentry. Opt-in dialog on first launch. Settings toggle. Source-map upload as part of release builds.
- **Out:** Funnels, feature-usage events, A/B infrastructure. Defer until there's a specific question we can't answer without them.

## Approach
- DSN from `SENTRY_DSN` build-time env var. No DSN = no init = no network calls. CI provides the DSN; local dev builds don't have it.
- **Opt-in UX:** on first launch (after the welcome state, not before it), modal:
  > Send anonymous crash reports to help fix bugs? Crash data only — no URLs, headers, or request bodies. You can change this in Settings.
  Default Off; explicit "Allow" / "No thanks" buttons. Persist choice in SQLite `settings` table.
- **Scrubbing** in `beforeSend`:
  - Strip workspace file paths → `<workspace>/...`
  - Strip any `http(s)://` URL found in breadcrumbs, messages, stack traces
  - Strip env variable names (we have them indexed; replace `{{anyKnownName}}` with `{{var}}`)
  - Drop anything that looks like content from a `.http` file (e.g. lines starting with a known HTTP verb)
  - Sentry built-in PII filter as a backstop
- **Source maps:** upload via `@sentry/cli` in the `npm run package` step, gated on `SENTRY_AUTH_TOKEN`.

## Work breakdown
1. Add `@sentry/electron`; init main + renderer behind `SENTRY_DSN` presence check.
2. Build first-run consent dialog (`src/ui/components/telemetry-consent.ts`); persist in SQLite settings table.
3. Add settings UI toggle (no restart required).
4. Implement scrubber in `beforeSend` for both processes; unit-test it against fixture events containing URLs, secrets, file paths.
5. Wire source-map upload into electron-builder hook for mac/win/linux.
6. Create Sentry project; configure release/environment tagging + new-issue alerts.
7. Write `docs/privacy.md`; link from settings UI and marketing site.

## Risks / open questions
- **Crashpad under hardenedRuntime:** verify the Crashpad helper signs correctly inside the notarized bundle. Probably fine but test on a clean Mac.
- **Renderer crashes from native modules (better-sqlite3):** confirm these surface to Sentry — not just console.
- **First-run timing:** dialog appears *after* the welcome screen, not before. Don't make the user's first impression a permissions ask.

## Definition of done
- Forced crash in a packaged build → event visible in Sentry within 30s, with readable stack via source maps.
- Scrubber unit tests pass for URL, header, body, file-path, and var-name patterns.
- Toggle works without restart.
- `docs/privacy.md` describes exactly what is collected; marketing site links to it.
