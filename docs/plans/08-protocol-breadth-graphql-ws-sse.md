# Plan: GraphQL, WebSocket, Server-Sent Events

## Why
GraphQL is table-stakes in 2026. WebSocket/SSE are the difference between "REST client" and "API client." Insomnia/Bruno have these; without them we leave money on the table from any team doing real-time work.

## Goal
First-class support for three new transports with idiomatic `.http`-file representations, integrated into the same request/response UI flow.

## Transport: GraphQL

### Syntax
```http
### List users with their orders
# @graphql
POST {{baseUrl}}/graphql

{
  "query": "query Users($limit: Int) { users(limit: $limit) { id email orders { total } } }",
  "variables": { "limit": 10 },
  "operationName": "Users"
}
```

Or, more ergonomic:
```http
### List users with their orders
# @graphql
# @operation Users
POST {{baseUrl}}/graphql

query Users($limit: Int) {
  users(limit: $limit) {
    id email
    orders { total }
  }
}

# @variables {
#   "limit": 10
# }
```

### Features
- **Schema introspection** (cached locally per endpoint) for autocomplete + go-to-definition in the query editor.
- **Operation picker** when a file has multiple `query`/`mutation`/`subscription` blocks.
- **Subscription support** via WebSocket — see WS section.
- **Response viewer:** errors array gets its own tab; data gets a JSON tree.

## Transport: WebSocket

### Syntax
```http
### Live order feed
WS wss://{{host}}/orders
Authorization: Bearer {{token}}

# @send {"action":"subscribe","channel":"orders"}
# @send {"action":"ping"}
```

### UX
- Request panel becomes a **persistent connection panel**:
  - Connect/Disconnect button.
  - Send pane (Monaco) — message editor with "Send" + saved-messages dropdown from `# @send` directives in the file.
  - Receive log — chronological list of messages, JSON-parsed where possible, filterable.
- Connections persist while the tab is open. Closing the tab disconnects.
- Errors and close codes surfaced clearly.

## Transport: Server-Sent Events

### Syntax
```http
### Order events
GET {{baseUrl}}/events
Accept: text/event-stream
```

The `Accept: text/event-stream` header triggers SSE mode automatically. Could alternatively use `# @sse` directive — pick one, recommend the `Accept` route since it matches RFC behavior.

### UX
- Like WebSocket but read-only. Rolling event log with auto-parse of `event:` / `data:` / `id:` fields.
- "Disconnect" button.

## Architecture

```
src/runner/
  http.ts            existing
  graphql.ts         NEW (thin wrapper over http.ts + schema cache)
  websocket.ts       NEW
  sse.ts             NEW
  dispatch.ts        NEW — route by transport
src/runner/schemas/  NEW — local cache of introspected schemas
src/ui/components/
  request-tab.ts     dispatch to subcomponent by transport
  ws-panel.ts        NEW
  sse-panel.ts       NEW
  graphql-panel.ts   NEW
```

The runner worker grows a connection registry for stateful transports (WS/SSE). Disconnects on app quit; surfaces connection errors via the same IPC channel as HTTP responses.

## CLI implications
- `coax run` with a WS or SSE request: define semantics. Suggested:
  - WS: send all `# @send` messages, wait up to `--timeout`, exit. Assertions can match `received[*]`.
  - SSE: collect events until `--timeout` or `--events N`, then evaluate assertions.
- GraphQL: just an HTTP POST; runs as today.

## Work breakdown
1. **GraphQL** (smallest lift):
   - Parser recognizes `# @graphql`, captures operation + variables.
   - Serializer round-trips it.
   - Schema introspection module; cache to `.coax/schemas/`.
   - Monaco GraphQL language service integration.
   - Operation picker UI.
2. **WebSocket:**
   - Runner adds `ws` (already a transitive dep through undici? if not, add `ws` package).
   - Connection registry in worker.
   - WS panel UI with send/receive log.
3. **SSE:**
   - Use undici's native EventSource-style streaming (or `eventsource` package).
   - SSE panel UI.
4. **CLI semantics** for WS/SSE in `coax run`.
5. **Docs:** add sections to `docs/http-file-format.md`, examples for each in `examples/`.

## Risks / open questions
- **GraphQL operation parser:** writing a from-scratch GraphQL operation parser is a yak shave. Use `graphql-js` (heavy dep but the right call).
- **WebSocket binary frames:** support text only in v1; add binary later if asked.
- **Schema cache invalidation:** when do we refetch? Manual refresh button + 24h TTL.
- **Connection limits:** cap open WS connections (5? 10?) to avoid resource leaks if a user opens many tabs.

## Definition of done
- GraphQL request with introspection autocomplete works against a real endpoint (e.g. GitHub's public GraphQL API).
- WebSocket panel connects, sends, receives, disconnects cleanly.
- SSE panel streams events without leaking the connection on tab close.
- `coax run` evaluates assertions against WS/SSE message logs.
- Each transport documented with a working example in `examples/`.
