export type RunnerMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type RunnerBodyKind = 'text' | 'json' | 'form' | 'multipart' | 'graphql';

export interface RequestSpec {
  id: string;
  method: RunnerMethod;
  url: string;
  headers: Record<string, string>;
  body?: { kind: RunnerBodyKind; raw: string };
  timeoutMs?: number;
  /**
   * When true, skip TLS cert validation. Off by default. Used for self-signed
   * dev certs (mkcert, ASP.NET dev-certs, etc.) via the app's "Allow insecure
   * TLS" setting or the CLI's --insecure flag. Affects only THIS request.
   */
  insecureTLS?: boolean;
}

export interface ResponseEnvelope {
  id: string;
  ok: true;
  status: number;
  headers: Record<string, string>;
  bodyBytes: Uint8Array;
  ms: number;
  sizeBytes: number;
}

export type RunnerErrorCategory = 'network' | 'tls' | 'timeout' | 'aborted' | 'invalid' | 'unknown';

export interface ErrorEnvelope {
  id: string;
  ok: false;
  category: RunnerErrorCategory;
  message: string;
}

export type RunnerResult = ResponseEnvelope | ErrorEnvelope;

export type WorkerInbound =
  | { kind: 'send'; spec: RequestSpec }
  | { kind: 'cancel'; id: string };

export interface WorkerOutbound { kind: 'result'; result: RunnerResult }
