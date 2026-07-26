# Plan: CLI runner + response assertions

## Why
**This is the flagship.** No competitor in the `.http`-file niche has a polished CLI runner. With it, Coax stops being "a Postman alternative" and starts being "the API tool that runs in CI" — a category move that justifies a price hike when you eventually add team-tier pricing, and that gives marketing a clean narrative.

## Goal
Ship `coax run` as a first-class command that executes a single request, a chain, or an entire collection headlessly. Output is human-friendly by default and machine-readable on demand (JSON, JUnit).

## Usage

```bash
coax run path/to/file.http
coax run path/to/file.http --request "Get user by id"
coax run path/to/file.http --chain getToken
coax run path/to/file.http --env dev
coax run path/to/file.http --var apiKey=$API_KEY
coax run path/to/file.http --output json
coax run path/to/file.http --output junit > results.xml
coax run path/to/file.http --timeout 10s --fail-fast
```

### Exit codes
- `0` — all requests succeeded, all assertions passed
- `1` — at least one assertion failed
- `2` — request failed (network, timeout, non-2xx without `--ignore-status`)
- `3` — parse error / invalid CLI usage
- `4` — license invalid or expired

## Assertion syntax

Inline form (one assertion per line, attached to the request below):
```http
### Get user by id
# @name getUser
# @test status == 200
# @test $.user.email exists
# @test $.user.id == {{userId}}
# @test responseTime < 500ms
# @test headers.content-type contains "application/json"
GET {{baseUrl}}/users/{{userId}}
```

Block form (for readability when many assertions):
```http
# @test {
#   status: 200
#   $.user.email: exists
#   $.user.id: == {{userId}}
#   responseTime: < 500ms
#   headers.content-type: contains "application/json"
# }
```

### Assertion grammar
- **Left side:** `status` | `responseTime` | `headers.<name>` | JSONPath (`$.foo.bar`) | regex match.
- **Operators:** `==`, `!=`, `<`, `<=`, `>`, `>=`, `contains`, `matches` (regex), `exists`, `is null`, `is number`, `is string`, `is array`, `is object`.
- **Right side:** literal, variable reference (`{{userId}}`), or another assertion-friendly expression.

## Architecture

```
src/cli/           NEW — Node-only entry point, no Electron
  main.ts          arg parsing (commander), orchestrator
  reporters/
    pretty.ts      colorized terminal output
    json.ts        structured machine output
    junit.ts       JUnit XML for CI integrations
src/assertions/    NEW — parser + evaluator for @test syntax
  grammar.ts
  evaluator.ts
src/parser/        existing — already Electron-free, reuse as-is
src/resolver/      existing — already Electron-free, reuse as-is
src/runner/        existing — extract worker into a Node-only module
```

The whole point of how `parser` / `resolver` / `runner` were structured (no Electron deps) is to enable this. Validate that assumption early: try to import each from a Node-only context and fix any leaks.

## Packaging

- Build with **esbuild** → single-file Node bundle.
- Ship three ways:
  1. Bundled with the desktop app at `Coax.app/Contents/Resources/coax` (macOS) / equivalent on Windows/Linux. Desktop install offers a "Install CLI to PATH" prompt that symlinks to `/usr/local/bin/coax` (with elevated rights on Linux).
  2. Standalone install: `npm i -g @melodicdev/coax-cli` (publishes the same bundle).
  3. Standalone download: notarized macOS binary, signed Windows .exe, Linux x86_64 + arm64 tarballs on GitHub releases.

## License integration

- CLI checks for activation blob in order:
  1. `COAX_LICENSE_KEY` env var → trigger activation if not yet activated, cache result.
  2. `~/.coax/license` (cached activation blob).
  3. The desktop app's `safeStorage` key (only on the same machine, only if desktop is installed).
- CI mode: `COAX_LICENSE_KEY` only. Detected via `CI=true` environment var. Skips machine-ID hashing differences across container rebuilds by storing activation against the license key, not the machine.

## Work breakdown
1. **Validate dep-cleanliness.** Try importing `parser`, `resolver`, `runner` from a bare Node script. Fix any Electron leaks. (Probably small — likely just `safeStorage` references; those can be stubbed.)
2. **Scaffold `src/cli/main.ts`** with `commander` arg parsing.
3. **Build `src/assertions/`** — grammar + evaluator. Test extensively against fixture responses.
4. **Reporters** — pretty (default, color-aware, falls back to plain in non-TTY), json, junit.
5. **`run` orchestration** — load file, resolve env, execute request/chain, evaluate assertions, dispatch to reporter.
6. **License gating** for the CLI (env var path, cache path).
7. **esbuild packaging config** — single-file output per target platform.
8. **Distribution wiring:**
   - electron-builder: bundle CLI binary into the .app/.exe.
   - npm publish workflow for `@melodicdev/coax-cli`.
   - GitHub release upload for standalone binaries.
9. **Examples:**
   - `examples/ci/.github/workflows/coax.yml` — runs assertions on PR.
   - `examples/ci/.gitlab-ci.yml`.
   - `examples/assertions.http` showing every assertion operator.
10. **Docs:** `docs/cli.md` (full reference), section in `docs/user-guide.md` ("Run from CI").
11. **"Install CLI to PATH"** post-install prompt in the desktop app's first-run flow.

## Risks / open questions
- **Worker reuse:** `src/runner/worker.ts` was built for Electron's utility process. Verify it runs unmodified under plain Node `worker_threads`, or extract a Node-only variant.
- **Assertion grammar bikeshed:** keep it small. Resist the urge to make this a DSL. If it can't be expressed in one line, suggest pre-request scripts (plan 05) instead.
- **CI activation slot churn:** if every CI build is a fresh container, you'll exhaust 3 activations fast. Mitigate by storing activation per license-key (not per machine) when `CI=true` is set, and re-issuing without a slot decrement.
- **Output format stability:** the JSON reporter becomes API surface. Version it: `{"version": 1, ...}`.

## Definition of done
- `coax run examples/assertions.http` exits 0; deliberately broken assertion exits 1.
- JUnit output passes a `xmllint --schema` check against the JUnit XSD.
- macOS bundle and standalone .pkg both ship a working binary.
- Sample GitHub Actions workflow in `examples/ci/` runs green against the bundled examples.
- `docs/cli.md` covers every flag and exit code.
- License works in both desktop-paired mode and CI mode.
