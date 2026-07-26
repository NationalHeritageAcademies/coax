import { lex } from './lexer.js';
import { boundaryFromContentType, splitMultipart } from './multipart.js';
import type { ParsedFile, ParsedRequest, VarDef, Header, BodyKind, Line } from './types.js';

function inferBodyKind(headers: Header[], graphqlHint: boolean): BodyKind {
  if (graphqlHint) return 'graphql';
  const ct = headers.find(h => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
  if (ct.startsWith('multipart/')) return 'multipart';
  if (ct.includes('json')) return 'json';
  if (ct.includes('x-www-form-urlencoded')) return 'form';
  if (ct.startsWith('text/') || ct.includes('xml')) return 'text';
  return 'text';
}

export function parseHttpFile(input: string): ParsedFile {
  const lines = lex(input);
  const variables: VarDef[] = [];
  const requests: ParsedRequest[] = [];

  // Top-level variables: any `@var =` lines that appear before the first separator/request line
  let firstReqIdx = lines.findIndex(l => l.kind === 'separator' || l.kind === 'request');
  if (firstReqIdx === -1) firstReqIdx = lines.length;
  for (const l of lines.slice(0, firstReqIdx)) {
    if (l.kind === 'variable') variables.push({ name: l.name, value: l.value, line: l.lineNo });
  }

  // Group remaining lines into request blocks bounded by separators / start of file
  interface Block { startLine: number; endLine: number; title: string; lines: Line[] }
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (let i = firstReqIdx; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.kind === 'separator') {
      if (current) blocks.push(current);
      current = { startLine: l.lineNo, endLine: l.lineNo, title: l.title, lines: [] };
      continue;
    }
    if (!current) current = { startLine: l.lineNo, endLine: l.lineNo, title: '', lines: [] };
    current.lines.push(l);
    current.endLine = l.lineNo;
  }
  if (current) blocks.push(current);

  for (const b of blocks) {
    const req = blockToRequest(b);
    if (req) requests.push(req);
  }
  return { variables, requests };
}

function blockToRequest(b: { startLine: number; endLine: number; title: string; lines: Line[] }): ParsedRequest | null {
  let name: string | undefined;
  let id: string | undefined;
  let folderPath: string | undefined;
  let graphqlHint = false;
  let fileHint: string | undefined;
  let methodIdx = -1;
  const overrides: { key: string; value?: string; isSecret: boolean }[] = [];
  const tests: string[] = [];
  for (let i = 0; i < b.lines.length; i++) {
    const l = b.lines[i]!;
    if (l.kind === 'name') name = l.name;
    else if (l.kind === 'id') id = l.id;
    else if (l.kind === 'folder') folderPath = l.folderPath;
    else if (l.kind === 'test') tests.push(l.assertion);
    else if (l.kind === 'override') {
      overrides.push({
        key: l.key,
        isSecret: l.isSecret,
        ...(l.isSecret ? {} : { value: l.value }),
      });
    }
    else if (l.kind === 'graphql') graphqlHint = true;
    else if (l.kind === 'request') { methodIdx = i; break; }
  }
  if (methodIdx === -1) return null;
  const reqLine = b.lines[methodIdx] as Extract<Line, { kind: 'request' }>;

  const headers: Header[] = [];
  let bodyStart = -1;
  for (let i = methodIdx + 1; i < b.lines.length; i++) {
    const l = b.lines[i]!;
    if (l.kind === 'header') headers.push({ key: l.key, value: l.value });
    else if (l.kind === 'blank') { bodyStart = i + 1; break; }
    else if (l.kind === 'request' || l.kind === 'separator') break;
    // ignore comments inside header block
  }

  const bodyParts: string[] = [];
  if (bodyStart >= 0) {
    for (let i = bodyStart; i < b.lines.length; i++) {
      const l = b.lines[i]!;
      if (l.kind === 'fileBody') { fileHint = l.path; continue; }
      if (l.kind === 'blank') { bodyParts.push(''); continue; }
      if (l.kind === 'text') bodyParts.push(l.text);
      else if (l.kind === 'header') bodyParts.push(`${l.key}: ${l.value}`);
      else if (l.kind === 'comment') continue;
      else if (l.kind === 'request') bodyParts.push(`${l.method} ${l.url}`);
      else if (l.kind === 'variable') bodyParts.push(`@${l.name} = ${l.value}`);
    }
  }
  const raw = bodyParts.join('\n').replace(/\n+$/, '');
  const kind = raw === '' && !fileHint ? 'none' : inferBodyKind(headers, graphqlHint);

  const ct = headers.find(h => h.key.toLowerCase() === 'content-type')?.value;

  const multipartParts =
    kind === 'multipart'
      ? splitMultipart(raw, boundaryFromContentType(ct) ?? '')
      : undefined;

  return {
    ...(id !== undefined ? { id } : {}),
    ...(folderPath !== undefined ? { folderPath } : {}),
    ...(name !== undefined ? { name } : {}),
    title: b.title,
    method: reqLine.method,
    url: reqLine.url,
    ...(reqLine.httpVersion !== undefined ? { httpVersion: reqLine.httpVersion } : {}),
    headers,
    ...(raw !== '' || fileHint
      ? {
          body: {
            kind,
            raw,
            ...(multipartParts !== undefined ? { parts: multipartParts } : {}),
          },
        }
      : {}),
    ...(overrides.length > 0 ? { overrides } : {}),
    ...(tests.length > 0 ? { tests } : {}),
    hints: {
      ...(graphqlHint ? { graphql: true as const } : {}),
      ...(fileHint !== undefined ? { file: fileHint } : {}),
      ...(ct !== undefined ? { contentType: ct } : {}),
    },
    range: { startLine: b.startLine, endLine: b.endLine },
  };
}
