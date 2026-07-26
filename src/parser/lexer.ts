import type { Line, HttpMethod } from './types.js';

const METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const RX = {
  separator: /^###\s*(.*)$/,
  variable: /^@([A-Za-z_][\w-]*)\s*=\s*(.*)$/,
  name: /^#\s*@name\s+(\S+)\s*$/,
  id: /^#\s*@id\s+(\S+)\s*$/,
  folder: /^#\s*@folder\s+(\S+)\s*$/,
  test: /^#\s*@test\s+(.+?)\s*$/,
  override: /^#\s*@override(:secret)?\s+(\S+)(?:[ \t]+(.*))?\s*$/,
  graphql: /^#\s*@graphql\s*$/,
  fileBody: /^<\s+(\S.*)$/,
  request: /^([A-Z]+)\s+(\S+)(?:\s+(HTTP\/[\d.]+))?\s*$/,
  header: /^([A-Za-z0-9][A-Za-z0-9_-]*)\s*:\s*(.*)$/,
  comment: /^(?:#|\/\/)(.*)$/,
};

export function lex(input: string): Line[] {
  return input.split(/\r\n|\r|\n/).map((raw, i): Line => {
    const lineNo = i + 1;
    if (raw.trim() === '') return { kind: 'blank', lineNo };

    let m: RegExpExecArray | null;
    if ((m = RX.separator.exec(raw))) return { kind: 'separator', title: m[1]!.trim(), lineNo };
    if ((m = RX.name.exec(raw))) return { kind: 'name', name: m[1]!, lineNo };
    if ((m = RX.id.exec(raw))) return { kind: 'id', id: m[1]!, lineNo };
    if ((m = RX.folder.exec(raw))) return { kind: 'folder', folderPath: m[1]!, lineNo };
    if ((m = RX.test.exec(raw))) return { kind: 'test', assertion: m[1]!, lineNo };
    if ((m = RX.override.exec(raw))) {
      return {
        kind: 'override',
        key: m[2]!,
        value: m[3] ?? '',
        isSecret: m[1] === ':secret',
        lineNo,
      };
    }
    if ((m = RX.graphql.exec(raw))) return { kind: 'graphql', lineNo };
    if ((m = RX.variable.exec(raw))) return { kind: 'variable', name: m[1]!, value: m[2]!.trim(), lineNo };
    if ((m = RX.fileBody.exec(raw))) return { kind: 'fileBody', path: m[1]!.trim(), lineNo };
    if ((m = RX.request.exec(raw))) {
      const method = m[1]! as HttpMethod;
      if (METHODS.has(method)) {
        const url = m[2]!;
        const httpVersion = m[3];
        return {
          kind: 'request',
          method,
          url,
          lineNo,
          ...(httpVersion !== undefined ? { httpVersion } : {}),
        };
      }
    }
    if ((m = RX.header.exec(raw))) return { kind: 'header', key: m[1]!, value: m[2]!, lineNo };
    if ((m = RX.comment.exec(raw))) return { kind: 'comment', text: m[1]!, lineNo };
    return { kind: 'text', text: raw, lineNo };
  });
}
