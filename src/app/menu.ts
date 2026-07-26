// =============================================================================
// Application menu
// =============================================================================
//
// Builds and installs the native macOS / Windows / Linux menu bar. Menu
// actions are mostly one-way: they tell the renderer "user clicked X via
// the menu" by sending an event over webContents, and the renderer
// dispatches whatever in-app flow that corresponds to.
//
// We intentionally don't duplicate handler logic in the main process —
// the renderer is the single source of truth for "what to do when the
// user wants to import an .http." This keeps menu items in sync with the
// in-app affordances without two paths to maintain.

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * Emit a "menu pressed X" event to the currently-focused renderer
 * window. The renderer registers handlers for these via
 * window.httpui.onMainEvent.
 */
function send(event: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send(event);
}

export function buildAppMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'Open Workspace Folder…',
        accelerator: 'CmdOrCtrl+O',
        click: () => { send('hu:menu-open-workspace'); },
      },
      {
        label: 'Close Workspace',
        accelerator: 'CmdOrCtrl+W',
        click: () => { send('hu:menu-close-workspace'); },
      },
      { type: 'separator' },
      {
        label: 'Import .http…',
        click: () => { send('hu:menu-import-http'); },
      },
      {
        label: 'Import Swagger from URL…',
        click: () => { send('hu:menu-import-swagger-url'); },
      },
      {
        label: 'Import Swagger from file…',
        click: () => { send('hu:menu-import-swagger-file'); },
      },
      { type: 'separator' },
      {
        label: 'Export Collection…',
        click: () => { send('hu:menu-export-collection'); },
      },
      // On Mac, Preferences lives in the app menu (standard HIG). On
      // Windows/Linux it goes under File between Export and Quit.
      ...(isMac
        ? []
        : ([
            { type: 'separator' },
            {
              label: 'Preferences…',
              accelerator: 'Ctrl+,',
              click: () => { send('hu:menu-preferences'); },
            },
            { type: 'separator' },
            { role: 'quit' },
          ] satisfies MenuItemConstructorOptions[])),
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
            { type: 'separator' },
            {
              label: 'Speech',
              submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
            },
          ] satisfies MenuItemConstructorOptions[])
        : ([
            { role: 'delete' },
            { type: 'separator' },
            { role: 'selectAll' },
          ] satisfies MenuItemConstructorOptions[])),
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? ([
            { type: 'separator' },
            { role: 'front' },
            { type: 'separator' },
            { role: 'window' },
          ] satisfies MenuItemConstructorOptions[])
        : ([{ role: 'close' }] satisfies MenuItemConstructorOptions[])),
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: 'Quick Reference',
        accelerator: 'CmdOrCtrl+/',
        click: () => { send('hu:menu-help'); },
      },
      { type: 'separator' },
      {
        label: 'Install CLI…',
        click: () => { send('hu:menu-install-cli'); },
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Preferences…',
                accelerator: 'Cmd+,',
                click: () => { send('hu:menu-preferences'); },
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ];

  return Menu.buildFromTemplate(template);
}

export function installAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu());
}
