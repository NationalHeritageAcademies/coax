import type { Reporter, RunRecord } from './types.js';

export interface JUnitOptions {
  out?: NodeJS.WritableStream;
  suiteName?: string;
}

export function createJUnitReporter(opts: JUnitOptions): Reporter {
  const out = opts.out ?? process.stdout;
  const suiteName = opts.suiteName ?? 'coax';
  const records: RunRecord[] = [];

  return {
    start() {
      // JUnit XML is buffered to a single suite emission at finish() because
      // the suite header needs total counts that aren't known until all
      // requests have run.
    },
    record(r) {
      records.push(r);
    },
    finish(s) {
      out.write('<?xml version="1.0" encoding="UTF-8"?>\n');
      out.write(
        `<testsuite name="${esc(suiteName)}" tests="${s.totalRequests}" failures="${s.failedRequests + s.failedAssertions}" errors="0" time="${(s.elapsedMs / 1000).toFixed(3)}">\n`,
      );
      for (const r of records) {
        const name = r.name ?? r.title;
        const classname = `${r.method} ${r.url}`;
        const time = (r.result.ms / 1000).toFixed(3);
        const failures: string[] = [];

        if (!r.result.ok) {
          failures.push(
            `    <failure message="${esc(r.result.category)}: ${esc(r.result.message)}"></failure>\n`,
          );
        } else {
          for (const a of r.assertions) {
            if (!a.ok) {
              failures.push(
                `    <failure message="${esc(a.raw)}"><![CDATA[${a.error ?? 'failed'}]]></failure>\n`,
              );
            }
          }
        }

        if (failures.length === 0) {
          out.write(`  <testcase name="${esc(name)}" classname="${esc(classname)}" time="${time}"/>\n`);
        } else {
          out.write(`  <testcase name="${esc(name)}" classname="${esc(classname)}" time="${time}">\n`);
          for (const f of failures) out.write(f);
          out.write('  </testcase>\n');
        }
      }
      out.write('</testsuite>\n');
    },
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
