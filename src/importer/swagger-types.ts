// Normalized in-memory representation of an OpenAPI 3.x or Swagger 2.0 doc.
// Both parser branches translate into this shape so the mapper that creates
// Coax's collection/folder/request rows only has to know one schema.

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';

export interface NormalizedParam {
  in: 'path' | 'query' | 'header' | 'cookie';
  name: string;
  required: boolean;
}

export type NormalizedSecurityScheme =
  | { kind: 'httpBearer' }
  | { kind: 'httpBasic' }
  | { kind: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string }
  | { kind: 'oauth2' }
  | { kind: 'unknown'; raw: unknown };

export interface SecurityRequirement {
  schemeName: string;
}

export interface NormalizedOperation {
  method: HttpMethod;
  /** Raw path with `{name}` placeholders. */
  path: string;
  /** First tag on the operation, or null when untagged. */
  tag: string | null;
  operationId: string | null;
  summary: string | null;
  parameters: NormalizedParam[];
  /**
   * Set when the operation declares a requestBody with an inline `example`.
   * Schema-only bodies don't materialize a placeholder in v1.
   */
  bodyExample: { contentType: string; raw: string } | null;
  /**
   * Operation-level security override. `null` means "inherit globalSecurity".
   */
  security: SecurityRequirement[] | null;
}

export interface NormalizedSpec {
  title: string;
  /** All `servers[].url` (or 2.0 host/basePath/schemes) entries the doc declares. */
  baseUrlCandidates: string[];
  operations: NormalizedOperation[];
  securitySchemes: Record<string, NormalizedSecurityScheme>;
  globalSecurity: SecurityRequirement[];
}

export interface ImportSource {
  kind: 'file' | 'url';
  /** Filename (file imports) or full URL (url imports). */
  origin: string;
  /** Raw document text (JSON or YAML). */
  text: string;
}
