import { parentPort } from 'node:worker_threads';
import { Agent, request } from 'undici';
import type {
  RequestSpec,
  RunnerResult,
  WorkerInbound,
  WorkerOutbound,
  RunnerErrorCategory,
} from './types.js';

export const controllers = new Map<string, AbortController>();

// Track which ids hit their per-request timeout, so we can classify the
// resulting AbortError as 'timeout' rather than 'aborted'. (undici may
// strip the abort reason, so we use a sentinel.)
const timedOut = new Set<string>();

// Single insecure-TLS dispatcher reused for every spec.insecureTLS request.
// Lazily constructed because most users will never need it. `rejectUnauthorized:
// false` disables cert validation entirely — only used when the caller explicitly
// opts in (app setting "Allow insecure TLS" or CLI --insecure).
let insecureDispatcher: Agent | null = null;
function getInsecureDispatcher(): Agent {
  if (insecureDispatcher === null) {
    insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return insecureDispatcher;
}

export async function runOne(spec: RequestSpec): Promise<RunnerResult> {
  // Validate URL up front so we can report 'invalid' without going near undici.
  try {
     
    new URL(spec.url);
  } catch {
    return { id: spec.id, ok: false, category: 'invalid', message: 'Invalid URL' };
  }

  const ac = new AbortController();
  controllers.set(spec.id, ac);
  const t0 = performance.now();
  const timer = spec.timeoutMs
    ? setTimeout(() => {
        timedOut.add(spec.id);
        ac.abort();
      }, spec.timeoutMs)
    : null;
  try {
    const res = await request(spec.url, {
      method: spec.method,
      headers: spec.headers,
      ...(spec.body ? { body: spec.body.raw } : {}),
      signal: ac.signal,
      ...(spec.insecureTLS ? { dispatcher: getInsecureDispatcher() } : {}),
    });
    const buf = Buffer.from(await res.body.arrayBuffer());
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
    }
    return {
      id: spec.id,
      ok: true,
      status: res.statusCode,
      headers,
      bodyBytes: new Uint8Array(buf),
      ms: Math.round(performance.now() - t0),
      sizeBytes: buf.byteLength,
    };
  } catch (e: unknown) {
    const category = timedOut.has(spec.id) ? 'timeout' : classify(e);
    const message = (e as Error)?.message ?? String(e);
    return { id: spec.id, ok: false, category, message };
  } finally {
    if (timer) clearTimeout(timer);
    controllers.delete(spec.id);
    timedOut.delete(spec.id);
  }
}

export function classify(e: unknown): RunnerErrorCategory {
  const m = (e as Error)?.message ?? '';
  const code =
    (e as { code?: string })?.code ??
    (e as { cause?: { code?: string } })?.cause?.code ??
    '';
  if (m.includes('TIMEOUT')) return 'timeout';
  if (m.includes('aborted') || m.includes('AbortError') || code === 'ABORT_ERR') return 'aborted';
  const lc = m.toLowerCase();
  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    code.startsWith('CERT_') ||
    m.includes('CERT_') ||
    m.includes('TLS') ||
    lc.includes('self signed') ||
    lc.includes('self-signed')
  )
    return 'tls';
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN' ||
    code === 'EHOSTUNREACH'
  ) {
    return 'network';
  }
  if (m.includes('Invalid URL') || code === 'ERR_INVALID_URL') return 'invalid';
  return 'unknown';
}

if (parentPort !== null) {
  parentPort.on('message', async (msg: WorkerInbound) => {
    if (msg.kind === 'cancel') {
      controllers.get(msg.id)?.abort();
      return;
    }
    if (msg.kind === 'send') {
      const result = await runOne(msg.spec);
      const out: WorkerOutbound = { kind: 'result', result };
      parentPort!.postMessage(out);
    }
  });
}
