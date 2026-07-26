import type { MultipartPart, Header } from './types.js';

export function boundaryFromContentType(ct: string | undefined): string | undefined {
  if (!ct) return undefined;
  const m = /boundary=("?)([^";]+)\1/i.exec(ct);
  return m?.[2];
}

export function splitMultipart(body: string, boundary: string): MultipartPart[] {
  if (!boundary) return [];
  const sep = `--${boundary}`;
  const sections = body.split(sep).slice(1);
  const parts: MultipartPart[] = [];
  for (const raw of sections) {
    if (raw.startsWith('--')) break;
    const cleaned = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const idx = cleaned.search(/\r?\n\r?\n/);
    if (idx === -1) continue;
    const headerBlock = cleaned.slice(0, idx);
    const bodyBlock = cleaned.slice(idx).replace(/^\r?\n\r?\n/, '');
    const headers: Header[] = [];
    let filename: string | undefined;
    for (const hl of headerBlock.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9-]+)\s*:\s*(.*)$/.exec(hl);
      if (!m) continue;
      const key = m[1]!;
      const value = m[2]!;
      headers.push({ key, value });
      if (key.toLowerCase() === 'content-disposition') {
        const fn = /filename="?([^";]+)"?/i.exec(value);
        if (fn) filename = fn[1];
      }
    }
    parts.push({ headers, body: bodyBlock, ...(filename !== undefined ? { filename } : {}) });
  }
  return parts;
}
