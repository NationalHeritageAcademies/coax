import { Command } from 'commander';

import { runFile, type RunOptions } from './run.js';
import { loadEnv } from './env-loader.js';
import { createPrettyReporter } from './reporters/pretty.js';
import { createJUnitReporter } from './reporters/junit.js';
import type { Reporter } from './reporters/types.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';

const VERSION = '1.3.1';

export async function main(argv: string[]): Promise<ExitCodeValue> {
  const program = new Command();
  program
    .name('coax')
    .description('Coax CLI — run .http files headlessly, with assertions, for CI/CD.')
    .version(VERSION);

  let exitCode: ExitCodeValue = ExitCode.Ok;

  program
    .command('run <file...>')
    .description('Run one or more .http files')
    .option('-e, --env <name>', 'load vars from <name>.env.json next to the .http file')
    .option('-r, --request <title>', 'only run requests whose title or @name matches')
    .option('-v, --var <key=value...>', 'override a variable (repeatable)')
    .option('-o, --output <reporter>', 'reporter: pretty | junit', 'pretty')
    .option('-t, --timeout <ms>', 'per-request timeout in milliseconds', '30000')
    .option('-k, --insecure', 'skip TLS cert validation (for self-signed dev servers)')
    .option('--fail-fast', 'stop at first failed request or assertion')
    .option('--no-color', 'disable ANSI color output')
    .action(async (files: string[], rawOpts: Record<string, unknown>) => {
      const reporter = makeReporter(rawOpts);
      if (!reporter) {
        process.stderr.write(
          `coax: unknown --output value "${String(rawOpts.output)}" (expected: pretty | junit)\n`,
        );
        exitCode = ExitCode.UsageOrParseError;
        return;
      }

      const varOverrides = parseVarOverrides(rawOpts.var as string[] | undefined);
      if (varOverrides === null) {
        process.stderr.write('coax: --var must be in key=value form\n');
        exitCode = ExitCode.UsageOrParseError;
        return;
      }

      const envName = typeof rawOpts.env === 'string' && rawOpts.env ? rawOpts.env : null;

      let highest: ExitCodeValue = ExitCode.Ok;
      for (const file of files) {
        let envVars: Record<string, string> | undefined;
        let preRunMessages: string[] | undefined;
        if (envName) {
          const result = await loadEnv(file, envName);
          if (!result.ok) {
            process.stderr.write(`coax: ${result.error}\n`);
            highest = ExitCode.UsageOrParseError;
            if (rawOpts.failFast) break;
            continue;
          }
          envVars = result.env.vars;
          preRunMessages = result.env.warnings;
        }

        const opts: RunOptions = {
          reporter,
          ...(typeof rawOpts.request === 'string' && rawOpts.request
            ? { requestFilter: rawOpts.request }
            : {}),
          timeoutMs: Number(rawOpts.timeout) || 30000,
          failFast: Boolean(rawOpts.failFast),
          varOverrides,
          ...(envVars ? { envVars } : {}),
          ...(preRunMessages && preRunMessages.length > 0 ? { preRunMessages } : {}),
          ...(rawOpts.insecure ? { insecureTLS: true } : {}),
        };

        const code = await runFile(file, opts);
        if (rank(code) > rank(highest)) highest = code;
        if (opts.failFast && highest !== ExitCode.Ok) break;
      }
      exitCode = highest;
    });

  try {
    await program.parseAsync(argv);
  } catch (e) {
    process.stderr.write(`coax: ${(e as Error).message}\n`);
    return ExitCode.UsageOrParseError;
  }

  return exitCode;
}

function makeReporter(opts: Record<string, unknown>): Reporter | null {
  const which = typeof opts.output === 'string' ? opts.output : 'pretty';
  const color = opts.color !== false && process.stdout.isTTY;
  if (which === 'pretty') return createPrettyReporter({ color });
  if (which === 'junit') return createJUnitReporter({});
  return null;
}

function parseVarOverrides(raw: string[] | undefined): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const entry of raw ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0) return null;
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

const EXIT_RANK: Record<ExitCodeValue, number> = {
  [ExitCode.Ok]: 0,
  [ExitCode.AssertionFailed]: 1,
  [ExitCode.RequestFailed]: 2,
  [ExitCode.UsageOrParseError]: 3,
};

function rank(code: ExitCodeValue): number {
  return EXIT_RANK[code];
}

