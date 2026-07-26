# @melodicdev/coax-cli

The headless runner for [Coax](https://coax.melodic.dev). Run `.http` files in CI, with inline assertions, JUnit output, and exit codes your build system actually understands.

```sh
npm install --global @melodicdev/coax-cli
```

## Quick start

Create a `.http` file with a request and one or more inline assertions:

```http
### Healthcheck
# @test status == 200
# @test responseTime < 500
GET https://api.example.com/health
```

Then run it:

```sh
coax run healthcheck.http
```

## Usage

```sh
coax run <file...> [options]
```

| Flag | Default | Purpose |
|---|---|---|
| `-e, --env <name>` | none | Load vars from `<name>.env.json` next to the .http file |
| `-r, --request <title>` | none | Only run requests whose title or `# @name` matches |
| `-v, --var <key=value>` | none | Override a variable; repeatable |
| `-o, --output <reporter>` | `pretty` | `pretty` (terminal) or `junit` (XML for CI dashboards) |
| `-t, --timeout <ms>` | `30000` | Per-request timeout in milliseconds |
| `-k, --insecure` | off | Skip TLS cert validation (for self-signed dev servers — matches `curl -k`) |
| `--fail-fast` | off | Stop at the first failed request or assertion |
| `--no-color` | off | Disable ANSI colors (auto-disabled on non-TTY) |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | All requests succeeded, all assertions passed |
| `1` | At least one assertion failed |
| `2` | At least one request failed (network, timeout, invalid URL) |
| `3` | Parse error or CLI usage error |

## Assertion syntax

`<left> <operator> [<right>]`

**Left side:** `status` · `responseTime` · `headers.<name>` · `$.jsonpath`

**Operators:** `==` · `!=` · `<` · `<=` · `>` · `>=` · `contains` · `exists`

**Right side:** number, quoted string, `true` / `false` / `null`, bare string, or `{{var}}` reference

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

## Environment files

Drop `*.env.json` files next to your `.http` file and select one with `--env <name>` — the same format Coax desktop uses.

```
my-workspace/
  api.http
  dev.env.json
  staging.env.json
  prod.env.json
```

```sh
coax run api.http --env staging
```

Secrets declared in an env file are looked up from `COAX_SECRET_<UPPERCASED_KEY>`:

```sh
export COAX_SECRET_APIKEY=sk_live_xxx
coax run api.http --env prod
```

Variable precedence (highest wins): `--var` flags → `--env <name>` file vars → top-of-file `@var` declarations.

## Response chaining

Reference a previous response in any later request:

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

Requests run in file order — put dependencies above their consumers.

## CI integration

GitHub Actions:

```yaml
- name: API smoke tests
  run: |
    npx @melodicdev/coax-cli run tests/smoke.http \
      --output junit > coax-results.xml
```

## Links

- [coax.melodic.dev](https://coax.melodic.dev) — the Coax desktop app
- [GitHub](https://github.com/MelodicDevelopment/coax) — source, issues, releases
- [Full CLI reference](https://github.com/MelodicDevelopment/coax/blob/main/docs/cli.md)
- [GitHub Actions example](https://github.com/MelodicDevelopment/coax/blob/main/docs/cli-example/.github/workflows/coax.yml)

## License

MIT © Melodic Development. See LICENSE.
