import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAppSettings, writeAppSettings } from '@app/app-settings.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coax-app-settings-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('app-settings sidecar', () => {
  it('returns defaults when the file does not exist', () => {
    expect(readAppSettings(dir)).toEqual({ allowInsecureTLS: false, hasSeenWelcome: false, autoUpdate: true });
  });

  it('round-trips a write/read', () => {
    const after = writeAppSettings(dir, { allowInsecureTLS: true });
    expect(after).toEqual({ allowInsecureTLS: true, hasSeenWelcome: false, autoUpdate: true });
    expect(readAppSettings(dir)).toEqual({ allowInsecureTLS: true, hasSeenWelcome: false, autoUpdate: true });
  });

  it('writes the file with 0o600 permissions', () => {
    writeAppSettings(dir, { allowInsecureTLS: true });
    const file = join(dir, 'settings.json');
    expect(existsSync(file)).toBe(true);
    // Only the lowest 9 mode bits matter for the permission check; mask off
    // the file-type bits.
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('merges a partial update without losing other fields (forward-compat)', () => {
    writeAppSettings(dir, { allowInsecureTLS: true });
    // Pretend a future version wrote an unknown field; readAppSettings ignores it
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ allowInsecureTLS: true, futureField: 'ignored' }),
    );
    expect(readAppSettings(dir)).toEqual({ allowInsecureTLS: true, hasSeenWelcome: false, autoUpdate: true });
  });

  it('returns defaults on unparseable JSON instead of throwing', () => {
    writeFileSync(join(dir, 'settings.json'), '{ this is not json }');
    expect(readAppSettings(dir)).toEqual({ allowInsecureTLS: false, hasSeenWelcome: false, autoUpdate: true });
  });
});
