# Coax CLI

Run `.http` files headlessly with inline assertions. Built for CI, smoke tests, contract verification, and scheduled monitoring.

## Install

**Via the bundled desktop install** (macOS / Windows / Linux): after installing Coax, the `coax` binary ships in the app bundle. Add it to your `PATH` via the desktop app's first-run prompt, or symlink it manually.

**Via npm** (recommended for CI runners):

```sh
npm install --global @nhaschools/coax-cli
```

**Standalone binary**: download from [GitHub Releases](https://github.com/NationalHeritageAcademies/coax/releases) and put the binary on your `PATH`.

## Usage

```sh
coax run <file...> [options]
```

### Options

| Flag | Default | Purpose |
|---|---|---|
| `-e, --env <name>` | none | Load vars from `<name>.env.json` next to the .http file |
| `-r, --request <title>` | none | Only run requests whose `### title` or `# @name` matches |
| `-v, --var <key=value>` | none | Override a variable; repeatable |
| `-o, --output <reporter>` | `pretty` | `pretty` (terminal) or `junit` (XML for CI dashboards) |
| `-t, --timeout <ms>` | `30000` | Per-request timeout in milliseconds |
| `-k, --insecure` | off | Skip TLS cert validation (for self-signed dev servers — matches `curl -k`) |
| `--fail-fast` | off | Stop at the first failed request or assertion |
| `--no-color` | off | Disable ANSI colors (auto when stdout is not a TTY) |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | All requests succeeded, all assertions passed |
| `1` | At least one assertion failed |
| `2` | At least one request failed (network, timeout, invalid URL) |
| `3` | Parse error or CLI usage error |

### Examples

Run a single file:

```sh
coax run api.http
```

Filter by request:

```sh
coax run api.http --request "Login"
```

Override a variable from your shell environment:

```sh
coax run api.http --var apiKey=$STAGING_API_KEY --var baseUrl=https://staging.example.com
```

Use a `.env.json` environment file:

```sh
coax run api.http --env staging
```

Emit JUnit XML for CI integration:

```sh
coax run api.http --output junit > results.xml
```

## Assertion syntax

Inline assertions live above the request line (after `### title`, alongside `# @name`):

```http
### Get user
# @name getUser
# @test status == 200
# @test $.user.email exists
# @test $.user.id == 42
# @test responseTime < 500
# @test headers.content-type contains "application/json"
GET https://api.example.test/users/42
```

### Grammar

`<left> <operator> [<right>]`

**Left side:**

| Form | Meaning |
|---|---|
| `status` | HTTP status code |
| `responseTime` | Response time in milliseconds |
| `headers.<name>` | Response header by name (case-insensitive) |
| `$.path.to.value` | JSONPath into the parsed JSON body |

**Operators:**

| Op | Meaning | Notes |
|---|---|---|
| `==` | Equal | Numeric coercion: `200 == "200"` is true |
| `!=` | Not equal | |
| `<` `<=` `>` `>=` | Numeric comparison | Fails cleanly if either side is non-numeric |
| `contains` | String contains | Both sides must be strings |
| `exists` | Value is present and non-null | No right side |

**Right side:**

| Form | Example |
|---|---|
| Number | `200`, `-1`, `0.5` |
| Quoted string | `"application/json"`, `'rick'` |
| Boolean | `true`, `false` |
| Null | `null` |
| Bare string | `application/json` (no spaces) |
| Variable reference | `{{userId}}` — resolved before assertion is parsed |

## Environment files

Drop one or more `*.env.json` files next to your `.http` file and select one with `--env <name>`. The CLI reads the same format the Coax desktop app uses, so a workspace round-trips between local editing and CI without changes.

```
my-workspace/
  api.http
  dev.env.json       ← { "name": "dev",     "vars": [...] }
  staging.env.json   ← { "name": "staging", "vars": [...] }
  prod.env.json      ← { "name": "prod",    "vars": [...] }
```

Each file's `name` field is what `--env` matches on (not the filename, though the convention is to keep them aligned).

### Variable precedence (highest wins)

1. `--var key=value` flags on the command line
2. Vars from the `--env <name>` file
3. `@var = value` declarations at the top of the `.http` file

### Secrets

Secrets in an env file (`{ "key": "apiKey", "isSecret": true, "secretId": "..." }`) live in the OS keychain when authored in the desktop. The CLI can't read the keychain, so it looks for an env var:

```sh
export COAX_SECRET_APIKEY=sk_live_xxx
coax run api.http --env prod
```

Missing secrets become warnings, not errors — the run continues with the unsecured vars available.

Scope: the CLI only searches the same directory as the `.http` file. Walking ancestor directories like the desktop does is deferred until someone asks; it requires a defined workspace root.

## Response chaining

The CLI threads each response into the resolver context, so chain references in later requests just work:

```http
### Login
# @name login
POST {{baseUrl}}/login
Content-Type: application/json

{ "user": "rick" }

### Get my profile
# @test status == 200
GET {{baseUrl}}/users/{{login.response.body.$.userId}}
Authorization: Bearer {{login.response.body.$.token}}
```

Requests are run in file order. If request B references A, just put A above B.

## CI integration

See `docs/cli-example/.github/workflows/coax.yml` for a complete GitHub Actions example.

```yaml
- name: Run API smoke tests
  run: |
    npx @nhaschools/coax-cli run tests/smoke.http \
      --output junit > coax-results.xml
```

## Roadmap (post-MVP)

- Block-form assertions (multi-line `@test { ... }`)
- JSON reporter with versioned schema
- `--chain <name>` to run just one chain + its dependencies
