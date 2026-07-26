import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRequest, IpcResponse } from '@ipc/types';

contextBridge.exposeInMainWorld('httpui', {
  invoke: <R = unknown>(msg: IpcRequest): Promise<IpcResponse<R>> =>
    ipcRenderer.invoke('httpui:rpc', msg),
  // One-way main → renderer events. Renderer registers a listener to
  // reload state when the main process tells it to (e.g. on window focus,
  // so external edits to .http files get picked up).
  onMainEvent: (event: string, handler: () => void): (() => void) => {
    const listener = (): void => { handler(); };
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
  // Host platform — used by the renderer to reserve traffic-light padding
  // in the app header on macOS, and to gate other tiny platform-aware
  // UX touches. Kept as a literal string rather than a flag-per-platform
  // so future additions (BSDs?) work without preload changes.
  platform: process.platform,
});
