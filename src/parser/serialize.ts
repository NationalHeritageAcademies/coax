import type { ParsedFile, ParsedRequest } from './types.js';

/**
 * Two modes:
 *  - serializeHttpFile(file, originalText): preserves original byte-for-byte
 *    for any line range that hasn't been edited (which, for an unedited parse,
 *    is every line in the file). Lines outside any request range — top-of-file
 *    variables, ############ comment dividers, blank gap lines, trailing
 *    newline — are emitted from the original verbatim.
 *  - serializeHttpFile(file): canonical emit (used for brand-new collections
 *    that have no original text).
 */
export function serializeHttpFile(file: ParsedFile, original?: string): string {
  if (original === undefined) return canonical(file);
  return preserve(file, original);
}

function preserve(file: ParsedFile, original: string): string {
  // Split with /\r?\n/ so a trailing "\n" yields an empty final element.
  // Joining with "\n" reconstructs the trailing newline correctly.
  const lines = original.split(/\r?\n/);

  // Sort requests by startLine so we walk in document order.
  const sortedReqs = [...file.requests].sort(
    (a, b) => a.range.startLine - b.range.startLine,
  );

  let cursor = 0; // 0-based line index of next line to emit
  const out: string[] = [];

  for (const req of sortedReqs) {
    const startIdx = req.range.startLine - 1; // 0-based
    const endIdx = req.range.endLine - 1; // 0-based, inclusive

    // Skip overlapping/nested ranges (shouldn't happen with the current
    // parser, but be defensive).
    if (startIdx < cursor) {
      // Already past this request's start; if it extends further, advance
      // cursor through any new lines it covers.
      if (endIdx >= cursor) {
        while (cursor <= endIdx) {
          out.push(lines[cursor] ?? '');
          cursor++;
        }
      }
      continue;
    }

    // Emit gap lines (anything between previous cursor and this request's
    // start) verbatim from the original.
    while (cursor < startIdx) {
      out.push(lines[cursor] ?? '');
      cursor++;
    }

    // Emit the request range from the original. Future enhancement: compare
    // the slice against emitRequest(req) and prefer the canonical emit when
    // they differ (i.e. the request was edited). For now — and for v1 — the
    // round-trip path always uses the original slice.
    while (cursor <= endIdx) {
      out.push(lines[cursor] ?? '');
      cursor++;
    }
  }

  // Emit any trailing lines past the last request (e.g. trailing newline,
  // post-script comments, etc.) verbatim.
  while (cursor < lines.length) {
    out.push(lines[cursor] ?? '');
    cursor++;
  }

  return out.join('\n');
}

function canonical(file: ParsedFile): string {
  const out: string[] = [];
  for (const v of file.variables) out.push(`@${v.name} = ${v.value}`);
  if (file.variables.length) out.push('');
  for (const r of file.requests) {
    out.push(emitRequest(r));
    out.push('');
  }
  return out.join('\n');
}

function emitRequest(r: ParsedRequest): string {
  const parts: string[] = [];
  parts.push(`### ${r.title}`.trimEnd());
  // `@id` first: a stable per-request identifier that lets future sync
  // logic match the "same" request across machines after renames. Older
  // exports won't have it; that's tolerated (the importer mints one).
  if (r.id !== undefined) parts.push(`# @id ${r.id}`);
  // Note: `# @folder` is intentionally NOT emitted. Under the directories
  // model, the on-disk folder is the only "folder" concept — anything that
  // wants to be in its own group becomes its own .http file in its own
  // subdirectory. Legacy @folder lines are tolerated on read (the parser
  // still recognises them) and silently dropped on the next flush.
  if (r.name !== undefined) parts.push(`# @name ${r.name}`);
  for (const o of r.overrides ?? []) {
    if (o.isSecret) parts.push(`# @override:secret ${o.key}`);
    else parts.push(`# @override ${o.key} ${o.value ?? ''}`.trimEnd());
  }
  for (const t of r.tests ?? []) parts.push(`# @test ${t}`);
  if (r.hints.graphql) parts.push('# @graphql');
  parts.push(`${r.method} ${r.url}${r.httpVersion ? ` ${r.httpVersion}` : ''}`);
  for (const h of r.headers) parts.push(`${h.key}: ${h.value}`);
  if (r.body && (r.body.raw !== '' || r.hints.file)) {
    parts.push('');
    if (r.hints.file) parts.push(`< ${r.hints.file}`);
    else parts.push(r.body.raw);
  }
  return parts.join('\n');
}
