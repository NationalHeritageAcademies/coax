import type { IpcRequest, IpcResponse } from './types.js';

export type Handlers = {
  [K in IpcRequest['kind']]?: (
    msg: Extract<IpcRequest, { kind: K }>
  ) => unknown;
};

export function createDispatcher(handlers: Handlers) {
  return async (msg: IpcRequest): Promise<IpcResponse> => {
    const handler = handlers[msg.kind] as
      | ((m: IpcRequest) => unknown)
      | undefined;
    if (!handler) {
      return {
        ok: false,
        error: { code: 'UNKNOWN_KIND', message: `No handler for ${msg.kind}` },
      };
    }
    try {
      const data = await handler(msg);
      return { ok: true, data };
    } catch (e: unknown) {
      return { ok: false, error: toError(e) };
    }
  };
}

function toError(e: unknown): { code: string; message: string } {
  if (e instanceof Error) {
    const m = /^([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(e.message);
    if (m) return { code: m[1]!, message: m[2]! };
    return { code: e.message, message: e.message };
  }
  return { code: 'UNKNOWN', message: String(e) };
}
