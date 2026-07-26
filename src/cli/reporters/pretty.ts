import type { Reporter, RunRecord } from './types.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

export interface PrettyOptions {
  /** When false, all ANSI escapes are stripped (CI logs, non-TTY). */
  color: boolean;
  /** Stream to write to. Defaults to process.stdout. */
  out?: NodeJS.WritableStream;
}

export function createPrettyReporter(opts: PrettyOptions): Reporter {
  const out = opts.out ?? process.stdout;
  const color = opts.color;
  const c = (code: string, text: string): string => (color ? `${code}${text}${C.reset}` : text);

  return {
    start(filename) {
      out.write(c(C.dim, `Coax · ${filename}\n\n`));
    },
    record(r) {
      const mark = r.result.ok && allAssertionsPassed(r) ? c(C.green, '✓') : c(C.red, '✗');
      const title = r.name ?? r.title;
      const route = `${r.method} ${shortUrl(r.url)}`;
      const ms = r.result.ms ? `${r.result.ms}ms` : '';
      const summary = r.result.ok
        ? c(C.dim, `${String(r.result.status)} ${ms}`)
        : c(C.red, `${r.result.category}: ${r.result.message}`);
      out.write(`${mark} ${pad(title, 32)} ${c(C.dim, pad(route, 36))} ${summary}\n`);

      for (const a of r.assertions) {
        const m = a.ok ? c(C.green, '  ✓') : c(C.red, '  ✗');
        const right = a.ok ? '' : c(C.dim, `  → ${a.error ?? 'failed'}`);
        out.write(`${m} ${a.raw}${right}\n`);
      }
      if (r.assertions.length > 0 || !r.result.ok) out.write('\n');
    },
    finish(s) {
      const pass = `${s.passedRequests} passed`;
      const fail = `${s.failedRequests} failed`;
      const assertSummary = s.totalAssertions
        ? `, ${s.totalAssertions} assertions (${s.passedAssertions} passed, ${s.failedAssertions} failed)`
        : '';
      const line = `${s.failedRequests === 0 ? c(C.green, pass) : pass}, ${
        s.failedRequests === 0 ? fail : c(C.red, fail)
      }${assertSummary}`;
      out.write(`${line}\n`);
      out.write(c(C.dim, `Elapsed ${s.elapsedMs}ms\n`));
    },
  };
}

function allAssertionsPassed(r: RunRecord): boolean {
  return r.assertions.every((a) => a.ok);
}

function shortUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.pathname}${parsed.search}`.slice(0, 40);
  } catch {
    return u.slice(0, 40);
  }
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}
