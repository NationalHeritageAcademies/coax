export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type BodyKind = 'none' | 'text' | 'json' | 'form' | 'multipart' | 'graphql';

export interface VarDef {
  name: string;
  value: string;
  line: number;
}
export interface Header {
  key: string;
  value: string;
}
export interface MultipartPart {
  headers: Header[];
  body: string;
  filename?: string;
}
export interface OverrideDirective {
  key: string;
  /** Absent for `# @override:secret <key>` (no value in source). */
  value?: string;
  isSecret: boolean;
}

export interface ParsedRequest {
  /**
   * Stable identifier sourced from a `# @id <token>` directive in the .http
   * file. Optional because older exports and hand-written files won't have
   * it; when missing, callers (the importer especially) mint a fresh id.
   * Used by sync to match the "same" request across machines even after
   * renames — see `docs/plans/future/storage-model-folder-first.md`.
   */
  id?: string;
  /**
   * Folder path within the collection, sourced from a `# @folder /a/b`
   * directive. Forward-slash separated, leading slash required, root is
   * just `/`. Optional: absent means the request lives at the collection
   * root (equivalent to `/`).
   *
   * The folder-first storage model uses this to round-trip folder
   * hierarchy through a single .http file. Other .http parsers ignore
   * the comment, so the file stays portable.
   */
  folderPath?: string;
  name?: string;
  title: string;
  method: HttpMethod;
  url: string;
  httpVersion?: string;
  headers: Header[];
  body?: { kind: BodyKind; raw: string; parts?: MultipartPart[] };
  /**
   * Per-request variable overrides from `# @override` / `# @override:secret`
   * directives on the request block. Absent when the source had no such
   * directives.
   */
  overrides?: OverrideDirective[];
  /**
   * Inline `# @test <expr>` assertions attached to the request. Each entry
   * is the raw assertion text (e.g. `status == 200`). Consumers (the CLI
   * runner) parse + evaluate; the parser only collects them.
   */
  tests?: string[];
  hints: { graphql?: boolean; file?: string; contentType?: string };
  range: { startLine: number; endLine: number };
}
export interface ParsedFile {
  variables: VarDef[];
  requests: ParsedRequest[];
}

export type Line =
  | { kind: 'separator'; title: string; lineNo: number }
  | { kind: 'variable'; name: string; value: string; lineNo: number }
  | { kind: 'name'; name: string; lineNo: number }
  | { kind: 'id'; id: string; lineNo: number }
  | { kind: 'folder'; folderPath: string; lineNo: number }
  | { kind: 'test'; assertion: string; lineNo: number }
  | { kind: 'override'; key: string; value: string; isSecret: boolean; lineNo: number }
  | { kind: 'graphql'; lineNo: number }
  | { kind: 'fileBody'; path: string; lineNo: number }
  | { kind: 'request'; method: HttpMethod; url: string; httpVersion?: string; lineNo: number }
  | { kind: 'header'; key: string; value: string; lineNo: number }
  | { kind: 'comment'; text: string; lineNo: number }
  | { kind: 'blank'; lineNo: number }
  | { kind: 'text'; text: string; lineNo: number };
