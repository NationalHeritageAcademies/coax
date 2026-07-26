# Privacy

Coax is a local-first developer tool. Everything you do — every workspace, collection, request, environment variable, secret, and response — lives **only on your machine**, in the application database under your OS's standard application data directory. We do not have a server. We do not have an account system. We cannot read your data.

This document covers the one narrow exception: **opt-in anonymous crash reporting**.

## TL;DR

- Crash reporting is **off by default**.
- You are asked **once**, on first launch, with a clear yes/no. Either choice is remembered.
- If you say "no thanks," **nothing is ever sent** anywhere.
- If you say yes, only crash data is sent — stripped of URLs, headers, response bodies, file contents, and variable values before transport.
- You can change your mind at any time in Settings.

## What gets collected (only if you opt in)

The crash reporting integration is built on [Sentry](https://sentry.io), an error-tracking service. When the application crashes or throws an unhandled exception, the following is sent:

- **Stack trace.** Function names, file names within the Coax codebase, and line numbers. Source maps allow us to translate the minified production bundle back to readable code locations.
- **Operating system.** "macOS 15", "Windows 11", "Ubuntu 24.04" — the broad family and version. Not your hostname, username, or any device identifier we don't control.
- **Coax version.** "Coax 0.2.1" — so we know which release introduced a regression.
- **Process name and component.** "main" vs "renderer", and the component that crashed (e.g. `request-tab`, `runner`).
- **Breadcrumbs.** A short trail of events leading up to the crash — UI clicks, navigation, IPC calls. Console logs are explicitly filtered out, since they often contain user content.

## What is never collected

Every event is processed through a scrubber before it leaves your machine. The scrubber strips, replacing each with a placeholder so the crash still groups meaningfully but the data is gone:

| What | Replaced with |
|------|---------------|
| Any URL (`https://...`, `http://...`) | `<url>` |
| Workspace and home directory paths | `<workspace>`, `<home>` |
| HTTP request lines from `.http` files | `<http-line>` |
| `Authorization:` header values | `Authorization: <redacted>` |
| Bearer tokens (`Bearer abc...`) | `Bearer <token>` |
| Basic auth blocks (`Basic dXNlcjpwYXNz`) | `Basic <token>` |
| `{{variableNames}}` from your workspace | `{{var}}` |
| Request headers, cookies, and request bodies | **dropped entirely** |
| Console log breadcrumbs | **dropped entirely** |

The scrubber runs in both the main process and the renderer process. Sentry's built-in PII filter runs as a second layer.

We additionally **do not** collect:
- Your name, email, IP address, or any account identifier (we don't have accounts).
- The content, name, or path of your `.http` files.
- Workspace, collection, folder, or request names.
- Environment variable names or values.
- Response bodies, headers, or status codes.
- The endpoints you talk to.

## Where the data goes

- **To Sentry's servers** (see [Sentry's privacy policy](https://sentry.io/privacy/)).
- **Not to us in any other form.** We don't operate any other telemetry pipeline. There is no usage analytics, no feature-flag service, no telemetry beacon, no auto-update phone-home.

## Configuring crash reporting

There are three layers of control:

1. **Build-time.** Crash reporting is only compiled into Coax builds that have a Sentry DSN configured (`SENTRY_DSN` build env). Builds without a DSN have **no code path** that could send data — the SDK is initialized as a no-op. Verify in the bundled app via the developer console: `window.__SENTRY__` will not be defined.
2. **User preference.** Even when a build has a DSN, no data is sent unless you explicitly opt in. Your preference is stored locally in the workspace SQLite database under the `app_settings.telemetry.crashReports` key. The first-launch dialog is the only time you'll be prompted; either answer is remembered indefinitely.
3. **Runtime toggle.** Switch it on or off any time in Settings. Changes take effect on the next launch (the SDK is one-shot per process to keep its internal state coherent).

## Verifying nothing is sent

You can confirm telemetry is inactive in any of these ways:

- **Inspect the binary.** Search the packaged app's resources for the string `sentry.io`. If your build has no DSN, the SDK's transport URL list is empty.
- **Network monitor.** Run Coax with Little Snitch (macOS), Wireshark, or `tcpdump`. With telemetry off, Coax makes no outbound connections except to the endpoints you explicitly send requests to.
- **Console.** With developer tools open, the Sentry SDK logs its initialization decision when running in development mode.

## Questions

If anything in this document is unclear or you spot something we missed — please open an issue at the Coax GitHub repository.

## Change log

- **2026-05-20.** Initial version covering crash reporting only. Updated when the policy changes.
