import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { parseHttpFile } from '@parser/parse.js';
import type { ParsedRequest } from '@parser/types.js';
import { resolve as resolveTemplate } from '@resolver/resolve.js';
import type { ResolverContext } from '@resolver/types.js';
import { runOne } from '@runner/worker.js';
import type { RequestSpec, ResponseEnvelope } from '@runner/types.js';

import { evaluate, parseAssertion } from '@assertions/index.js';
import type { Assertion, AssertionResult } from '@assertions/index.js';

import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import type { Reporter, RunRecord, RunSummary } from './reporters/types.js';

export interface RunOptions {
  reporter: Reporter;
  /** When set, only requests whose title (or @name) matches are executed. */
  requestFilter?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Stop at first failed request or assertion. */
  failFast?: boolean;
  /** CLI --var k=v overrides; highest priority for variable resolution. */
  varOverrides?: Record<string, string>;
  /**
   * Vars loaded from a matched *.env.json file; sit between request overrides
   * (highest) and collection defaults (lowest) in the resolver precedence.
   */
  envVars?: Record<string, string>;
  /** One-line notices printed before the run (e.g. env file warnings). */
  preRunMessages?: string[];
  /**
   * Skip TLS cert validation for every request. Off by default. Used for
   * self-signed dev certs via the CLI's --insecure flag (matches curl -k).
   */
  insecureTLS?: boolean;
}

export async function runFile(filePath: string, opts: RunOptions): Promise<ExitCodeValue> {
  const startWall = performance.now();
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (e) {
    process.stderr.write(`coax: cannot read ${filePath}: ${(e as Error).message}\n`);
    return ExitCode.UsageOrParseError;
  }

  let parsed;
  try {
    parsed = parseHttpFile(source);
  } catch (e) {
    process.stderr.write(`coax: parse error in ${filePath}: ${(e as Error).message}\n`);
    return ExitCode.UsageOrParseError;
  }

  for (const m of opts.preRunMessages ?? []) process.stderr.write(`coax: ${m}\n`);
  opts.reporter.start(filePath);

  const collectionDefaults: Record<string, string> = {};
  for (const v of parsed.variables) collectionDefaults[v.name] = v.value;
  const requestOverrides = opts.varOverrides ?? {};
  const chainFlat = opts.envVars ?? {};

  const responses: NonNullable<ResolverContext['responses']> = {};
  const summary: RunSummary = {
    totalRequests: 0,
    passedRequests: 0,
    failedRequests: 0,
    totalAssertions: 0,
    passedAssertions: 0,
    failedAssertions: 0,
    elapsedMs: 0,
  };

  const filtered = opts.requestFilter
    ? parsed.requests.filter((r) => matchesFilter(r, opts.requestFilter!))
    : parsed.requests;

  let highestExit: ExitCodeValue = ExitCode.Ok;

  for (const req of filtered) {
    const ctx: ResolverContext = {
      scopes: { request: requestOverrides, chainFlat, collectionDefaults },
      responses,
    };
    const spec = buildSpec(req, ctx, opts.timeoutMs, opts.insecureTLS);
    const result = await runOne(spec);

    summary.totalRequests += 1;

    const assertionResults: AssertionResult[] = [];
    if (result.ok) {
      summary.passedRequests += 1;
      const parsedBody = parseBody(result);
      if (req.name) {
        responses[req.name] = {
          status: result.status,
          headers: result.headers,
          body: parsedBody,
        };
      }
      for (const raw of req.tests ?? []) {
        const resolvedText = resolveTemplate(raw, ctx).text;
        const compiled = parseAssertion(resolvedText);
        if ('kind' in compiled && compiled.kind === 'parse-error') {
          assertionResults.push({ raw: resolvedText, ok: false, error: compiled.message });
          continue;
        }
        const a = compiled as Assertion;
        const er = evaluate(a, {
          status: result.status,
          responseTime: result.ms,
          headers: lowercaseKeys(result.headers),
          body: parsedBody,
        });
        assertionResults.push(er);
      }
      const failedHere = assertionResults.filter((a) => !a.ok).length;
      summary.totalAssertions += assertionResults.length;
      summary.passedAssertions += assertionResults.length - failedHere;
      summary.failedAssertions += failedHere;
      if (failedHere > 0) highestExit = worst(highestExit, ExitCode.AssertionFailed);
    } else {
      summary.failedRequests += 1;
      highestExit = worst(highestExit, ExitCode.RequestFailed);
    }

    const record: RunRecord = {
      title: req.title,
      ...(req.name !== undefined ? { name: req.name } : {}),
      method: req.method,
      url: spec.url,
      result: result.ok
        ? { ok: true, status: result.status, ms: result.ms }
        : { ok: false, category: result.category, message: result.message, ms: 0 },
      assertions: assertionResults,
    };
    opts.reporter.record(record);

    if (opts.failFast && highestExit !== ExitCode.Ok) break;
  }

  summary.elapsedMs = Math.round(performance.now() - startWall);
  opts.reporter.finish(summary);
  return highestExit;
}

function matchesFilter(req: ParsedRequest, filter: string): boolean {
  const needle = filter.toLowerCase();
  if (req.title.toLowerCase().includes(needle)) return true;
  if (req.name?.toLowerCase().includes(needle)) return true;
  return false;
}

function buildSpec(
  req: ParsedRequest,
  ctx: ResolverContext,
  timeoutMs?: number,
  insecureTLS?: boolean,
): RequestSpec {
  const url = resolveTemplate(req.url, ctx).text;
  const headers: Record<string, string> = {};
  for (const h of req.headers) headers[h.key] = resolveTemplate(h.value, ctx).text;

  const spec: RequestSpec = {
    id: req.id ?? `${req.method} ${req.url}`,
    method: req.method,
    url,
    headers,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(insecureTLS ? { insecureTLS: true } : {}),
  };
  if (req.body && req.body.kind !== 'none') {
    const raw = resolveTemplate(req.body.raw, ctx).text;
    spec.body = { kind: req.body.kind, raw };
  }
  return spec;
}

function parseBody(r: ResponseEnvelope): unknown {
  const text = new TextDecoder().decode(r.bodyBytes);
  const ct = (r.headers['content-type'] ?? '').toLowerCase();
  if (ct.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function lowercaseKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

const EXIT_RANK: Record<ExitCodeValue, number> = {
  [ExitCode.Ok]: 0,
  [ExitCode.AssertionFailed]: 1,
  [ExitCode.RequestFailed]: 2,
  [ExitCode.UsageOrParseError]: 3,
};

function worst(a: ExitCodeValue, b: ExitCodeValue): ExitCodeValue {
  return EXIT_RANK[a] >= EXIT_RANK[b] ? a : b;
}
