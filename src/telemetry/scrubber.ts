// =============================================================================
// Sentry event scrubber
// =============================================================================
//
// Walks every Sentry event before it's sent and strips anything that could
// leak sensitive content from a user's workspace. We aggressively over-scrub:
// the cost of a false positive (less context on a crash) is far lower than
// the cost of a false negative (a real secret in our error logs).
//
// What we strip:
//   - URLs (http/https): a `.http` workspace is full of customer endpoints,
//     auth servers, internal API gateways. Replace the whole URL with
//     `<url>` in messages, breadcrumbs, exception values, and contexts.
//   - File paths: replace the user's home directory and workspace path with
//     `<home>` and `<workspace>` placeholders so a stack trace from
//     `/Users/jdoe/Code/proj/api.http` doesn't reveal who jdoe is.
//   - `.http`-shaped content: any line that opens with an HTTP verb is
//     almost certainly request body content from a user's file. Replace
//     with `<http-line>`.
//   - Common credential patterns: bearer tokens, basic auth blocks, and the
//     classic `Authorization:` header — even though we shouldn't be logging
//     these, a misbehaving dep could.
//   - Variable references the user named: any `{{...}}` token is a
//     workspace variable. Replace with `{{var}}`.
//
// What we DO NOT strip:
//   - Stack trace function names and module paths inside the bundled app —
//     these are necessary for triage. Source-mapped frames preserve the
//     module name from our codebase (e.g. `src/runner/host.ts:142`), which
//     is exactly the signal we want.
//
// Scrubbing happens in `beforeSend` in BOTH processes (main + renderer).
// The same code runs in both; only the input differs.

// Intentionally NO `node:*` imports — this module must build for both the
// main and renderer bundles. The renderer can't resolve Node built-ins, and
// it doesn't need to: the main process supplies the workspace root and home
// directory via `configureScrubber()` at boot.
import type { ErrorEvent, Event, EventHint } from '@sentry/electron';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const HTTP_LINE_PATTERN = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+.+$/gm;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._\-+/=]+/gi;
const AUTHORIZATION_HEADER_PATTERN = /Authorization:\s*[^\r\n]+/gi;
const BASIC_AUTH_PATTERN = /\bBasic\s+[A-Za-z0-9+/=]+/gi;
const TEMPLATE_VAR_PATTERN = /\{\{[^}]+\}\}/g;

/**
 * Configure where workspace files live so we can recognize and strip those
 * paths from event data. Called once at init time per process.
 *
 * Both fields are optional; whichever is omitted simply isn't masked. The
 * main process supplies both; the renderer typically supplies only
 * `workspaceRoot` since it has no notion of the OS home directory.
 */
export interface ScrubberConfig {
  workspaceRoot?: string;
  homeDir?: string;
}

let workspaceRoot: string | null = null;
let homeDir: string | null = null;

export function configureScrubber(config: ScrubberConfig): void {
  workspaceRoot = config.workspaceRoot ?? null;
  homeDir = config.homeDir ?? null;
}

/**
 * Scrub a single string. Public so it can be unit-tested in isolation.
 */
export function scrubString(input: string): string {
  if (!input) return input;

  let out = input;

  // Order matters: strip Authorization headers and Bearer tokens BEFORE URL
  // stripping. A "Bearer abcd" inside an Authorization header would get its
  // token portion scrubbed but the header label left intact otherwise.
  out = out.replace(AUTHORIZATION_HEADER_PATTERN, 'Authorization: <redacted>');
  out = out.replace(BEARER_PATTERN, 'Bearer <token>');
  out = out.replace(BASIC_AUTH_PATTERN, 'Basic <token>');

  // `.http`-style request lines BEFORE general URL stripping so we don't
  // leave a method+placeholder dangling.
  out = out.replace(HTTP_LINE_PATTERN, '<http-line>');

  out = out.replace(URL_PATTERN, '<url>');

  // Workspace paths. The workspace root match must come BEFORE the home
  // match, since the workspace is usually a subdirectory of home.
  if (workspaceRoot) {
    out = replaceAll(out, workspaceRoot, '<workspace>');
  }
  if (homeDir) {
    out = replaceAll(out, homeDir, '<home>');
  }

  out = out.replace(TEMPLATE_VAR_PATTERN, '{{var}}');

  return out;
}

function replaceAll(input: string, needle: string, replacement: string): string {
  if (!needle) return input;
  // `replaceAll` on plain strings is safer than building a regex from a
  // user-supplied path (no regex-special-char escape needed).
  return input.split(needle).join(replacement);
}

/**
 * The `beforeSend` hook. Runs on every Sentry event right before transport.
 * Returning the (possibly mutated) event sends it; returning `null` drops it.
 *
 * Generic over the event subtype (`ErrorEvent` vs `TransactionEvent`) so the
 * returned shape stays narrow enough for Sentry's typed `beforeSend` slot.
 */
export function scrubEvent<E extends Event>(event: E, _hint?: EventHint): E | null {
  if (event.message) {
    event.message = scrubString(event.message);
  }

  if (event.transaction) {
    event.transaction = scrubString(event.transaction);
  }

  scrubExceptions(event);
  scrubBreadcrumbs(event);
  scrubRequest(event);
  scrubContexts(event);
  scrubExtra(event);

  // Drop event-level tags that could carry URL/path content; we don't set
  // these ourselves, but a third-party integration might. (Stack tags from
  // Sentry's own SDK are safe and remain.)
  if (event.tags) {
    for (const key of Object.keys(event.tags)) {
      const value = event.tags[key];
      if (typeof value === 'string') {
        event.tags[key] = scrubString(value);
      }
    }
  }

  return event;
}

function scrubExceptions(event: Event): void {
  const values = event.exception?.values;
  if (!values) return;
  for (const ex of values) {
    if (ex.value) ex.value = scrubString(ex.value);
    if (ex.type) ex.type = scrubString(ex.type);
    if (!ex.stacktrace?.frames) continue;
    for (const frame of ex.stacktrace.frames) {
      if (frame.filename) frame.filename = scrubString(frame.filename);
      if (frame.module) frame.module = scrubString(frame.module);
      if (frame.abs_path) frame.abs_path = scrubString(frame.abs_path);
      // Pre/post/source context lines are user-code snippets the SDK pulled
      // from the running app. They can legitimately contain URLs from
      // template strings — scrub them just like message bodies.
      if (frame.pre_context) frame.pre_context = frame.pre_context.map(scrubString);
      if (frame.post_context) frame.post_context = frame.post_context.map(scrubString);
      if (frame.context_line) frame.context_line = scrubString(frame.context_line);
    }
  }
}

function scrubBreadcrumbs(event: Event): void {
  const crumbs = event.breadcrumbs;
  if (!crumbs) return;
  for (const c of crumbs) {
    if (c.message) c.message = scrubString(c.message);
    // `data` is freeform — could be `{ url, method, status }` for an http
    // breadcrumb, or arbitrary user content for `console` breadcrumbs.
    // Scrub all string leaves; preserve numbers and booleans.
    if (c.data) c.data = scrubObject(c.data);
  }
}

function scrubRequest(event: Event): void {
  const req = event.request;
  if (!req) return;
  if (req.url) req.url = scrubString(req.url);
  if (req.query_string && typeof req.query_string === 'string') {
    req.query_string = scrubString(req.query_string);
  }
  // Drop the entire cookies bag and headers bag — anything in either
  // (session cookies, authorization headers, x-api-key) is sensitive and
  // we don't need any of it for triage.
  if (req.cookies) delete req.cookies;
  if (req.headers) delete req.headers;
  if (req.data !== undefined) {
    // Request bodies almost always carry secrets we shouldn't log. The
    // field is typed `unknown` in Sentry's schema, so any value goes; we
    // use a stringy sentinel so the dashboard still shows "something was
    // here, scrubbed".
    req.data = '<redacted>';
  }
}

/**
 * Wrapper that matches Sentry's `beforeSend` shape exactly. Use this when
 * passing to `Sentry.init({ beforeSend })` so TS narrows correctly.
 */
export function scrubErrorEvent(event: ErrorEvent, hint?: EventHint): ErrorEvent | null {
  return scrubEvent<ErrorEvent>(event, hint);
}

function scrubContexts(event: Event): void {
  const contexts = event.contexts;
  if (!contexts) return;
  for (const key of Object.keys(contexts)) {
    const ctx = contexts[key];
    if (ctx && typeof ctx === 'object') {
      contexts[key] = scrubObject(ctx as Record<string, unknown>);
    }
  }
}

function scrubExtra(event: Event): void {
  if (!event.extra) return;
  event.extra = scrubObject(event.extra);
}

function scrubObject<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return scrubString(input) as T;
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return input.map((v) => scrubObject(v as unknown)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = scrubObject(v);
  }
  return out as T;
}
