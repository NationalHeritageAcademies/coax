import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, type MockServer } from './fixtures/server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_PATH = join(__dirname, '..', 'out', 'main', 'index.js');

test('import → send → export end-to-end', async () => {
  // Sanity: built app must exist
  if (!existsSync(APP_PATH)) {
    throw new Error(`Electron entry not found at ${APP_PATH} — run \`npm run build\` first.`);
  }

  const mock: MockServer = await startMock();
  const tmp = mkdtempSync(join(tmpdir(), 'httpui-e2e-'));

  // Write a tiny .http fixture pointed at the mock
  const fixturePath = join(tmp, 'fixture.http');
  writeFileSync(
    fixturePath,
    [
      `@baseUrl = http://127.0.0.1:${mock.port}`,
      `@token = T123`,
      ``,
      `### get users`,
      `GET {{baseUrl}}/users`,
      `Authorization: Bearer {{token}}`,
      ``,
    ].join('\n'),
  );

  // Use a per-test userData dir so the workspace doesn't collide with the user's real one
  const userDataDir = join(tmp, 'userData');
  const app = await electron.launch({
    args: [APP_PATH, `--user-data-dir=${userDataDir}`],
  });

  // Pipe Electron stdout/stderr so failures surface in test logs
  app.process().stdout?.on('data', (d) => process.stdout.write(`[electron stdout] ${d}`));
  app.process().stderr?.on('data', (d) => process.stderr.write(`[electron stderr] ${d}`));

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    // Let the renderer settle
    await new Promise((r) => setTimeout(r, 200));

    // Wait for the bridge to be exposed
    await window.waitForFunction(
      () => typeof (window as unknown as { httpui?: unknown }).httpui !== 'undefined',
      { timeout: 10_000 },
    );

    // Folder-first model: open a workspace folder before any
    // collection-creating operation. We use the test's tmp dir as the
    // workspace.
    const openResult = await window.evaluate(async (folderPath) => {
      const httpui = (window as unknown as { httpui: { invoke: (m: unknown) => Promise<unknown> } })
        .httpui;
      return httpui.invoke({ kind: 'workspace:open', folderPath });
    }, tmp);
    expect(openResult).toMatchObject({ ok: true });
    const workspaceId = (openResult as { ok: true; data: { id: string } }).data.id;

    // 1) Import the fixture via direct IPC (skip the dialog modal)
    const importResult = await window.evaluate(async (path) => {
      const httpui = (window as unknown as { httpui: { invoke: (m: unknown) => Promise<unknown> } })
        .httpui;
      return httpui.invoke({ kind: 'http:import', path });
    }, fixturePath);

    if (!(importResult as { ok: boolean }).ok) {
      // Surface the IPC error to make diagnosis easier
       
      console.error('http:import failed:', JSON.stringify(importResult));
    }
    expect(importResult).toMatchObject({ ok: true });
    const { data: importData } = importResult as {
      ok: true;
      data: { collectionId: string; stats: { requests: number } };
    };
    expect(importData.collectionId).toBeTruthy();
    expect(importData.stats.requests).toBe(1);

    // 2) Find the request id.
    const reqList = await window.evaluate(async (collectionId) => {
      const httpui = (window as unknown as { httpui: { invoke: (m: unknown) => Promise<unknown> } })
        .httpui;
      return httpui.invoke({ kind: 'request:list', collectionId });
    }, importData.collectionId);

    const requestRow = (reqList as { ok: true; data: { id: string; method: string; url: string }[] })
      .data[0]!;
    expect(requestRow.method).toBe('GET');

    // 3) Import builds a "From file" env from the file's @vars and activates it
    // automatically (see http:import in handlers.ts), so {{baseUrl}} / {{token}}
    // already resolve — no manual setActive needed. Verify it exists the same
    // way the renderer does: collection:list → the collection's rootFolderId →
    // env:list({ folderId }). (Folder-scoped envs key off folderId, not the
    // collection id.)
    const colList = await window.evaluate(async (wsId) => {
      const httpui = (window as unknown as { httpui: { invoke: (m: unknown) => Promise<unknown> } })
        .httpui;
      return httpui.invoke({ kind: 'collection:list', workspaceId: wsId });
    }, workspaceId);
    const collection = (
      colList as { ok: true; data: { id: string; rootFolderId: string }[] }
    ).data.find((c) => c.id === importData.collectionId);
    expect(collection, 'imported collection should be listed').toBeTruthy();

    const envList = await window.evaluate(async (folderId) => {
      const httpui = (window as unknown as { httpui: { invoke: (m: unknown) => Promise<unknown> } })
        .httpui;
      return httpui.invoke({ kind: 'env:list', folderId });
    }, collection!.rootFolderId);
    const envEnvelope = envList as { ok: true; data: { id: string; name: string }[] };
    expect(envEnvelope.ok).toBe(true);
    const fromFile = envEnvelope.data.find((e) => e.name === 'From file');
    expect(fromFile, 'From file env should exist after import').toBeTruthy();

    // 4) Send the request via IPC
    const sendResult = await window.evaluate(async (rid) => {
      const httpui = (window as unknown as { httpui: { invoke: (m: unknown) => Promise<unknown> } })
        .httpui;
      return httpui.invoke({ kind: 'request:send', tabId: 'e2e-tab', requestId: rid });
    }, requestRow.id);

    const sendEnvelope = sendResult as {
      ok: true;
      data: {
        result:
          | { ok: true; status: number; bodyBytes: { byteLength: number } }
          | { ok: false; category: string; message: string };
      };
    };
    expect(sendEnvelope.ok).toBe(true);
    if (!sendEnvelope.data.result.ok) {
       
      console.error('request:send returned non-ok result:', JSON.stringify(sendEnvelope));
    }
    expect(sendEnvelope.data.result.ok).toBe(true);
    if (sendEnvelope.data.result.ok) {
      expect(sendEnvelope.data.result.status).toBe(200);
    }

    // 5) Export the collection
    const exportPath = join(tmp, 'export.http');
    const exportResult = await window.evaluate(
      async ({ collectionId, targetPath }) => {
        const httpui = (
          window as unknown as { httpui: { invoke: (m: unknown) => Promise<unknown> } }
        ).httpui;
        return httpui.invoke({ kind: 'collection:export', collectionId, targetPath });
      },
      { collectionId: importData.collectionId, targetPath: exportPath },
    );

    expect(exportResult).toMatchObject({ ok: true });
    expect(existsSync(exportPath)).toBe(true);
    const exportedText = readFileSync(exportPath, 'utf8');
    expect(exportedText).toContain('GET ');
    expect(exportedText).toContain('/users');
    expect(exportedText).toContain('Authorization');
  } finally {
    await app.close();
    await mock.stop();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
