import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';

import { parseEnvFile } from '@workspace-fs/env-file.js';

export interface LoadedEnv {
  /** The env's declared `name` field. */
  name: string;
  /** Plain vars + any secrets resolved via COAX_SECRET_<KEY>. */
  vars: Record<string, string>;
  /** Non-fatal messages: skipped secrets, malformed sibling files. */
  warnings: string[];
}

export type LoadEnvResult = { ok: true; env: LoadedEnv } | { ok: false; error: string };

/**
 * Discovers `*.env.json` files in the same directory as the .http file and
 * returns the one whose declared `name` matches `envName`.
 *
 * Secrets in the env file are not bundled — they're declared by name, and the
 * CLI looks for `COAX_SECRET_<UPPERCASED_KEY>` in the process environment.
 * Missing secrets become warnings, not errors, so a partial env still runs.
 *
 * Scope: same directory only. Walking ancestor directories like the desktop
 * does is deferred until someone asks — without a defined workspace root
 * the walk would have to bottom out arbitrarily.
 */
export async function loadEnv(
  httpFilePath: string,
  envName: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<LoadEnvResult> {
  const dir = dirname(resolve(httpFilePath));

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    return { ok: false, error: `cannot read directory ${dir}: ${(e as Error).message}` };
  }

  const candidateFiles = entries.filter((e) => e.endsWith('.env.json'));
  if (candidateFiles.length === 0) {
    return { ok: false, error: `no *.env.json files found in ${dir}` };
  }

  const warnings: string[] = [];
  const available: string[] = [];

  for (const file of candidateFiles) {
    const filePath = join(dir, file);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (e) {
      warnings.push(`skipped ${file}: ${(e as Error).message}`);
      continue;
    }
    const result = parseEnvFile(text);
    if (!result.ok) {
      warnings.push(`skipped ${file}: ${result.message}`);
      continue;
    }
    available.push(result.value.name);
    // Case-insensitive — filename slug is lowercase by convention but
    // the JSON's `name` field can be any case ("CI", "ci", "Ci").
    if (result.value.name.toLowerCase() !== envName.toLowerCase()) continue;

    const vars: Record<string, string> = {};
    for (const v of result.value.vars) {
      if (v.isSecret === true) {
        const secretEnv = `COAX_SECRET_${v.key.toUpperCase()}`;
        const value = processEnv[secretEnv];
        if (value !== undefined && value !== '') {
          vars[v.key] = value;
        } else {
          warnings.push(`secret "${v.key}" skipped — set ${secretEnv} to provide it`);
        }
      } else {
        vars[v.key] = v.valuePlain;
      }
    }
    return { ok: true, env: { name: result.value.name, vars, warnings } };
  }

  return {
    ok: false,
    error: `no environment named "${envName}" found in ${dir}${
      available.length > 0 ? ` (available: ${available.join(', ')})` : ''
    }`,
  };
}
