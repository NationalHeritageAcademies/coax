import { app, BrowserWindow, ipcMain, shell } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handlers, init as initHandlers, shutdown as shutdownHandlers } from './handlers.js';
import { installAppMenu } from './menu.js';
import { createDispatcher } from '@ipc/main-bridge';
import type { IpcRequest } from '@ipc/types';
import { stopRunner } from '@runner/host';
import { initMainTelemetry } from '@telemetry/init';
import { readTelemetrySettings } from '@telemetry/storage';
import { readAppSettings } from './app-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconPath = join(__dirname, 'icon.png');

const dispatch = createDispatcher(handlers);
ipcMain.handle('httpui:rpc', (_evt, msg: IpcRequest) => dispatch(msg));

// macOS "About Coax" dialog. Win/Linux fall back to Electron's auto-
// generated default — rarely-clicked menu item on those platforms.
app.setAboutPanelOptions({
  applicationName: 'Coax',
  applicationVersion: app.getVersion(),
  copyright: '© 2026 Rick Hopkins (Melodic Development)',
  website: 'https://github.com/NationalHeritageAcademies/coax',
  credits: 'Your API workspace is just a .http file.',
});

// Initialize Sentry BEFORE `app.whenReady()` fires — the Electron SDK installs
// Crashpad and unhandled-exception listeners during the boot window, and
// throws "Sentry SDK should be initialized before the Electron app 'ready'
// event is fired" if we do it any later. Consent comes from a sidecar JSON
// rather than the workspace SQLite so it's readable synchronously here.
// `app.getPath('userData')` works pre-ready (returns the default path based
// on the app name), and `initMainTelemetry` no-ops when DSN or consent is
// missing — so this is a safe unconditional call.
const initialUserData = app.getPath('userData');
const initialTelemetry = readTelemetrySettings(initialUserData);
initMainTelemetry({
  consent: initialTelemetry.consent === true,
  workspaceRoot: initialUserData,
  appVersion: app.getVersion(),
});

async function createWindow(): Promise<void> {
  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Coax',
    icon: iconPath,
    // Match the in-app dark bg so there's no white flash before the
    // renderer mounts. Also fills the title-bar overlay area on Win/Linux
    // and the empty space behind macOS's hidden title bar.
    backgroundColor: '#0a1020',
    // Blend the OS chrome into the app: hide the title bar entirely and
    // let the app's own header double as the drag region. On macOS the
    // traffic-light buttons stay (slightly inset). On Win/Linux Electron
    // draws the min/max/close controls into a colored strip.
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          // Center the traffic-light buttons vertically within our 48px-tall
          // app header. The hiddenInset default sits them too high for a header
          // this tall; y = (48 − ~14px button) / 2 ≈ 17 lines them up with the
          // brand mark and tab strip.
          trafficLightPosition: { x: 19, y: 17 },
        }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#0a1020',
            symbolColor: '#9ca3af',
            height: 48,
          },
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Route any `target="_blank"` link or `window.open` call to the OS browser
  // instead of opening it inside the Electron app (which would replace the
  // shell with the external page).
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
    // Auto-open devtools in dev so renderer errors are visible without a
    // keyboard shortcut hunt; production builds keep them closed.
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady()
  .then(async () => {
    // Dev macOS dock icon — packaged apps use the bundled .icns instead.
    if (process.platform === 'darwin' && process.env.ELECTRON_RENDERER_URL) {
      app.dock?.setIcon(iconPath);
    }
    await initHandlers();
    installAppMenu();
    await createWindow();
    // Kick off the auto-update check ~5s after window creation so it
    // doesn't compete with first-frame work. Dev builds skip (no publish
    // manifest); production builds also skip when the user has turned
    // auto-update off in Settings. electron-updater downloads the new
    // artifact in the background; when ready we tell the renderer via
    // hu:update-downloaded so it can prompt the user to restart.
    if (!process.env.ELECTRON_RENDERER_URL) {
      const appSettings = readAppSettings(app.getPath('userData'));
      if (appSettings.autoUpdate) {
        autoUpdater.autoDownload = true;
        autoUpdater.on('update-downloaded', (info) => {
          const win = BrowserWindow.getAllWindows()[0];
          win?.webContents.send('hu:update-downloaded', { version: info.version });
        });
        autoUpdater.on('error', (err) => {
          console.warn('autoUpdater error:', err.message);
        });
        setTimeout(() => {
          void autoUpdater.checkForUpdates().catch((err: unknown) => {
            console.warn('autoUpdater check failed:', err instanceof Error ? err.message : err);
          });
        }, 5000);
      }
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
    // Refresh-on-focus: when any Coax window regains focus, tell the
    // renderer to re-read the workspace from disk in case files were
    // edited externally (vim, VS Code, `git pull`, etc.). The renderer
    // listens for this and re-runs loadWorkspaceData on the active
    // workspace.
    app.on('browser-window-focus', (_event, win) => {
      win.webContents.send('hu:focus-refresh');
    });
  })
  .catch((err: unknown) => {
    console.error('Failed to start app:', err);
    app.quit();
  });

app.on('before-quit', async () => {
  shutdownHandlers();
  await stopRunner();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
