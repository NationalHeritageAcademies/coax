# Privacy

Coax collects no telemetry.

The only network traffic the app produces is:

- **The HTTP requests you author and send.** They go directly from your
  machine to the endpoint in the request — no proxy, no relay.
- **The auto-update check**, which asks GitHub Releases
  (`github.com/NationalHeritageAcademies/coax`) whether a newer version
  exists. Turn it off in **Settings → Updates** and the app makes no
  background calls at all.

Everything else stays local: workspaces, collections, requests, and
environment variables live in your workspace folder and in a SQLite
database under the app's user-data directory. Values you mark secret are
encrypted at rest with the operating system's keychain (Electron
`safeStorage`) and never leave your machine.

The upstream Melodic Development project shipped optional, opt-in Sentry
crash reporting. The National Heritage Academies fork removed it in v2.0.0
— there is no DSN, no consent dialog, and no crash-reporting code in the
binary.
