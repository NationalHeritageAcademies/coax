import { signal } from '@melodicdev/core/signals';
import type { Workspace, Directory, Collection, Folder, RequestRow, Environment, OpenTab, ThemeMode } from './model.js';

// Source-of-truth signals for the renderer. Components subscribe to these.
// Use s() to read, s.set(x) to write, s.subscribe(fn) to observe.

export const workspaces = signal<Workspace[]>([]);
export const activeWorkspace = signal<Workspace | null>(null);

export const directories = signal<Directory[]>([]);
export const collections = signal<Collection[]>([]);
export const folders = signal<Folder[]>([]);
export const requests = signal<RequestRow[]>([]);

export const environments = signal<Environment[]>([]);

export const tabs = signal<OpenTab[]>([]);
export const activeTabId = signal<string | null>(null);

// Theme persists to localStorage so the user's last choice survives reloads.
// We read the stored value on module load and write back on every change.
const THEME_STORAGE_KEY = 'hu-theme';
function readStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* localStorage unavailable */
  }
  return 'system';
}

// Set by the auto-update flow (src/ui/main.ts) when a new version has
// been downloaded and is staged for install. Consumers in the app
// header render a persistent "Restart to update" indicator while true.
export const updateReady = signal<{ version: string } | null>(null);

export const theme = signal<ThemeMode>(readStoredTheme());
theme.subscribe((value) => {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    /* localStorage unavailable */
  }
});
