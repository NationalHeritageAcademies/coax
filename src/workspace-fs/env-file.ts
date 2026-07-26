// =============================================================================
// .env.json file format
// =============================================================================
//
// Reads and writes one `.env.json` file. Under the directories model the
// file lives next to one or more `.http` files in a workspace directory
// and applies to everything in that directory and below — no internal
// `scopes` array needed.
//
//   {
//     "$schema": "https://coax.melodic.dev/schema/env.json",
//     "name": "dev",
//     "vars": [
//       { "key": "baseUrl", "valuePlain": "https://dev.example.com" },
//       { "key": "token", "isSecret": true, "secretId": "..." }
//     ]
//   }
//
// The old shape (`scopes: [{ folder, vars }]`) is still accepted on read
// for backward compatibility; vars from every scope are merged. Flush
// always writes the new flat shape.
//
// Defensive validation: anything we don't recognise becomes a structured
// `parseEnvFile` error rather than crashing the workspace open. Callers
// surface the error to the UI so the user can fix or remove the bad file
// without losing the rest of the workspace.

const SCHEMA_URL = 'https://coax.melodic.dev/schema/env.json';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface EnvVarPlain {
  key: string;
  isSecret?: false;
  valuePlain: string;
}

export interface EnvVarSecret {
  key: string;
  isSecret: true;
  /**
   * Stable identifier for the keychain entry that holds the actual value.
   * Cross-machine portable: a teammate cloning the repo gets the JSON with
   * this id but has to add the secret to their own keychain on first use.
   */
  secretId: string;
}

export type EnvVar = EnvVarPlain | EnvVarSecret;

export interface EnvFile {
  name: string;
  vars: EnvVar[];
}

export type ParseResult =
  | { ok: true; value: EnvFile }
  | { ok: false; reason: 'invalid-json' | 'invalid-shape'; message: string };

// -----------------------------------------------------------------------------
// Parse
// -----------------------------------------------------------------------------

export function parseEnvFile(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      reason: 'invalid-json',
      message: e instanceof Error ? e.message : 'Could not parse JSON.',
    };
  }
  if (!isObject(parsed)) {
    return { ok: false, reason: 'invalid-shape', message: 'Top-level value is not an object.' };
  }
  if (typeof parsed.name !== 'string' || parsed.name === '') {
    return { ok: false, reason: 'invalid-shape', message: 'Missing or empty "name".' };
  }

  // New shape: top-level `vars`.
  if (Array.isArray(parsed.vars)) {
    const vars: EnvVar[] = [];
    for (let i = 0; i < parsed.vars.length; i++) {
      const v = parseVar(parsed.vars[i], `vars[${i}]`);
      if (!v.ok) return v;
      vars.push(v.value);
    }
    return { ok: true, value: { name: parsed.name, vars } };
  }

  // Legacy shape: `scopes[].vars`. Merge every scope's vars into one flat
  // array — under the directories model a single .env.json maps to a
  // single directory-scoped env, so scope folder paths are discarded.
  if (Array.isArray(parsed.scopes)) {
    const merged: EnvVar[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < parsed.scopes.length; i++) {
      const raw: unknown = parsed.scopes[i];
      if (!isObject(raw) || !Array.isArray(raw.vars)) continue;
      for (let j = 0; j < raw.vars.length; j++) {
        const v = parseVar(raw.vars[j], `scopes[${i}].vars[${j}]`);
        if (!v.ok) return v;
        if (seen.has(v.value.key)) continue;
        seen.add(v.value.key);
        merged.push(v.value);
      }
    }
    return { ok: true, value: { name: parsed.name, vars: merged } };
  }

  return {
    ok: false,
    reason: 'invalid-shape',
    message: '"vars" (or legacy "scopes") array required.',
  };
}

type ParseVarResult =
  | { ok: true; value: EnvVar }
  | { ok: false; reason: 'invalid-shape'; message: string };

function parseVar(raw: unknown, where: string): ParseVarResult {
  if (!isObject(raw)) {
    return { ok: false, reason: 'invalid-shape', message: `${where} is not an object.` };
  }
  if (typeof raw.key !== 'string' || raw.key === '') {
    return { ok: false, reason: 'invalid-shape', message: `${where}.key is missing or empty.` };
  }
  if (raw.isSecret === true) {
    if (typeof raw.secretId !== 'string' || raw.secretId === '') {
      return {
        ok: false,
        reason: 'invalid-shape',
        message: `${where}.secretId is required when isSecret is true.`,
      };
    }
    return { ok: true, value: { key: raw.key, isSecret: true, secretId: raw.secretId } };
  }
  if (typeof raw.valuePlain !== 'string') {
    return {
      ok: false,
      reason: 'invalid-shape',
      message: `${where}.valuePlain is required for non-secret vars.`,
    };
  }
  return { ok: true, value: { key: raw.key, valuePlain: raw.valuePlain } };
}

// -----------------------------------------------------------------------------
// Serialize
// -----------------------------------------------------------------------------

/**
 * Pretty-print the env file. Field order is fixed so identical content
 * round-trips to byte-identical JSON (useful for git diffs).
 */
export function serializeEnvFile(env: EnvFile): string {
  const out = {
    $schema: SCHEMA_URL,
    name: env.name,
    vars: env.vars.map((v) =>
      v.isSecret === true
        ? { key: v.key, isSecret: true as const, secretId: v.secretId }
        : { key: v.key, valuePlain: v.valuePlain },
    ),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
