import type { IpcRequest, IpcResponse } from './types.js';

declare global {
  interface Window {
    httpui: {
      invoke: <R>(msg: IpcRequest) => Promise<IpcResponse<R>>;
      onMainEvent: (event: string, handler: () => void) => () => void;
      platform: NodeJS.Platform;
    };
  }
}

// Dev-only RPC logging. Vite replaces import.meta.env.DEV at build time, so
// the branch is tree-shaken from production. Each call gets a sequence id so
// overlapping request/response pairs stay correlated in the console.
const isDev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? false;
let _rpcSeq = 0;

export async function rpc<R>(msg: IpcRequest): Promise<R> {
  const id = isDev ? ++_rpcSeq : 0;
  if (isDev) {
    console.debug(`[rpc #${id}] →`, msg.kind, msg);
  }
  const start = isDev ? performance.now() : 0;
  const r = await window.httpui.invoke<R>(msg);
  if (!r.ok) {
    if (isDev) {
      console.debug(
        `[rpc #${id}] ✗`,
        msg.kind,
        `${(performance.now() - start).toFixed(0)}ms`,
        r.error,
      );
    }
    const err = new Error(`${r.error.code}: ${r.error.message}`);
    (err as Error & { code?: string }).code = r.error.code;
    throw err;
  }
  if (isDev) {
    console.debug(
      `[rpc #${id}] ✓`,
      msg.kind,
      `${(performance.now() - start).toFixed(0)}ms`,
      r.data,
    );
  }
  return r.data;
}
