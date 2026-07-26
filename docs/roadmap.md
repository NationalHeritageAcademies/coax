# Coax roadmap

> **Strategy:** keep Coax file-based, local-first, and git-native. Differentiate from Postman/Insomnia by being a tool that fits *inside* developer workflows (text files, git, CI) instead of replacing them with a cloud workspace. Coax is free and open source (MIT).

## Phases

Each phase aims for a shippable release that's independently marketable.

### Phase 0 — Foundation (target: v0.2, ~3 weeks) — shipped
- [Telemetry: Sentry crash reporting](plans/01-telemetry-sentry.md) — opt-in, content-free
- Marketing one-pager — coax.melodic.dev, downloads + demo GIF

**Milestone:** Coax is released, and you know when it crashes.

### Phase 1 — CLI revolution (target: v0.3, ~5 weeks)
Build the differentiator no competitor in this niche has.
- [CLI runner + response assertions](plans/04-cli-runner-and-assertions.md) — `coax run`, `# @test` syntax, CI-friendly exit codes, JUnit reporter

**Milestone:** Coax slots into CI/CD pipelines.

### Phase 2 — Feature parity & onboarding (target: v0.4, ~6 weeks)
Remove the switching cost from Postman/Insomnia and close the most-asked-for gaps.
- [Pre-request scripts](plans/05-pre-request-scripts.md)
- [Importers: Postman / Insomnia / Bruno](plans/06-importers.md)
- [Folder-level auth & variable inheritance](plans/07-folder-level-auth-and-vars.md)

**Milestone:** Realistic migration target for any Postman user.

### Phase 3 — Protocol breadth (target: v0.5, ~5 weeks)
- [GraphQL, WebSocket, Server-Sent Events](plans/08-protocol-breadth-graphql-ws-sse.md)

**Milestone:** Real-time-protocol parity with Insomnia/Bruno.

### Phase 4 — Git as the sync story (target: v1.0, ~4 weeks)
Lean hard into the local-first, plain-text advantage.
- [Git polish](plans/09-git-polish.md) — workspace status, diff view for `.http` files, auto-format on save, commit-from-app

**Milestone:** v1.0. Marketing pivot from "Postman alternative" to "the API tool that lives in your repo."

## Cross-cutting principles

- **No tracking without consent.** All telemetry opt-in, content-free, documented in `docs/privacy.md`.
- **No phone-home, period.** The app works offline forever.
- **`.http` files remain the source of truth.** Every feature must round-trip through the file format, or be marked clearly as Coax-specific metadata (e.g. `# @` directives that other `.http` tools ignore safely).
- **The CLI and desktop ship from the same repo with the same parser/resolver/runner code.** Don't fork the logic.
- **No feature ships without docs.** A feature that isn't in `docs/user-guide.md` doesn't exist.
