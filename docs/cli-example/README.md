# Coax CLI examples

| File | What it shows |
|---|---|
| `api.http` | A small assertion suite that runs against `https://httpbin.org/` — exercises status, JSONPath, header, response-time, and chained-response assertions. |
| `.github/workflows/coax.yml` | A complete GitHub Actions workflow that installs the CLI, runs the suite, and uploads JUnit XML. |

Run locally:

```sh
coax run docs/cli-example/api.http
```

See `docs/cli.md` for the full CLI reference.
