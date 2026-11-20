'use strict';
/*
 * OpenLeaf desktop app: runs the OpenLeaf server inside Electron and shows it in a native window.
 */
const { app, BrowserWindow, Menu, shell, dialog, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const PREFERRED_PORT = 51730; // fixed so editor preferences (stored per origin) survive restarts
const isMac = process.platform === 'darwin';
const configFile = () => path.join(app.getPath('userData'), 'config.json');
const windowFile = () => path.join(app.getPath('userData'), 'window.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch { /* not fatal */ }
}

/**
 * Apps started from the Start menu don't always see a PATH that includes TeX, so add the usual
 * MiKTeX / TeX Live / MacTeX / Strawberry Perl locations if they exist.
 */
function extendPathForTeX() {
  const candidates = [];
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
    for (const r of roots) candidates.push(path.join(r, 'MiKTeX', 'miktex', 'bin', 'x64'), path.join(r, 'MiKTeX', 'miktex', 'bin'));
    for (const tl of ['C:\\texlive', 'D:\\texlive']) {
      let years = [];
      try { years = fs.readdirSync(tl).filter((y) => /^\d{4}$/.test(y)).sort().reverse(); } catch { /* not installed */ }
      for (const y of years) candidates.push(path.join(tl, y, 'bin', 'windows'), path.join(tl, y, 'bin', 'win64'), path.join(tl, y, 'bin', 'win32'));
    }
    candidates.push('C:\\Strawberry\\perl\\bin', 'C:\\Strawberry\\c\\bin');
  } else {
    candidates.push('/Library/TeX/texbin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
    try {
      for (const y of fs.readdirSync('/usr/local/texlive').filter((d) => /^\d{4}$/.test(d)).sort().reverse()) {
        for (const a of fs.readdirSync(path.join('/usr/local/texlive', y, 'bin'))) candidates.push(path.join('/usr/local/texlive', y, 'bin', a));
      }
    } catch { /* not installed */ }
  }
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const current = (env[key] || '').split(path.delimiter).filter(Boolean);
  const lower = new Set(current.map((p) => p.toLowerCase()));
  const extra = candidates.filter((p) => !lower.has(p.toLowerCase()) && fs.existsSync(p));
  env[key] = [...current, ...extra].join(path.delimiter);
}

/** Carry settings and the default projects folder over from when the app was called TeXLocal. */
function migrateFromTeXLocal() {
  const oldConfig = path.join(app.getPath('appData'), 'TeXLocal', 'config.json');
  if (!fs.existsSync(configFile()) && fs.existsSync(oldConfig)) writeJson(configFile(), readJson(oldConfig, {}));
  const docs = app.getPath('documents');
  const oldDir = path.join(docs, 'TeXLocal Projects'), newDir = path.join(docs, 'OpenLeaf Projects');
  if (!readJson(configFile(), {}).projectsDir && fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    try { fs.renameSync(oldDir, newDir); } catch { writeJson(configFile(), { ...readJson(configFile(), {}), projectsDir: oldDir }); }
  }
}

let mainWindow = null;
let baseUrl = null;
let projectsDir = null;

function createWindow() {
  const saved = readJson(windowFile(), { width: 1400, height: 900, maximized: false });
  mainWindow = new BrowserWindow({
    width: saved.width, height: saved.height, x: saved.x, y: saved.y,
    minWidth: 760, minHeight: 480,
    title: 'OpenLeaf',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15191f' : '#f4f5f7',
    show: false,
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  if (saved.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isMinimized()) return;
    writeJson(windowFile(), { ...(mainWindow.isMaximized() ? readJson(windowFile(), {}) : mainWindow.getBounds()), maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('close', saveBounds);
  mainWindow.on('closed', () => { mainWindow = null; });

  // Links to other sites open in the normal browser; OpenLeaf pages stay in the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(baseUrl)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(baseUrl)) { e.preventDefault(); shell.openExternal(url); }
  });

  // The editor asks the page to stay open while a save is in flight; let the user decide.
  mainWindow.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1,
      title: 'Unsaved changes', message: 'Some changes are still being saved.', detail: 'Leave anyway? The last few keystrokes may be lost.',
    });
    if (choice === 0) e.preventDefault();
  });

  // Spell-check suggestions + standard edit actions on right-click.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const items = [];
    for (const s of params.dictionarySuggestions || []) items.push({ label: s, click: () => mainWindow.webContents.replaceMisspelling(s) });
    if (params.misspelledWord) {
      items.push({ label: 'Add to dictionary', click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  mainWindow.loadURL(baseUrl);
}

async function chooseProjectsFolder() {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the folder that holds your LaTeX projects',
    defaultPath: projectsDir, properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0] || r.filePaths[0] === projectsDir) return;
  writeJson(configFile(), { ...readJson(configFile(), {}), projectsDir: r.filePaths[0] });
  const restart = dialog.showMessageBoxSync(mainWindow, {
    type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0,
    message: 'OpenLeaf will use the new projects folder after a restart.',
  });
  if (restart === 0) { app.relaunch(); app.exit(0); }
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'All projects', accelerator: 'CmdOrCtrl+Shift+H', click: () => mainWindow && mainWindow.loadURL(baseUrl) },
        { type: 'separator' },
        { label: 'Open projects folder', click: () => shell.openPath(projectsDir) },
        { label: 'Change projects folder…', click: chooseProjectsFolder },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Install MiKTeX (LaTeX for Windows)', click: () => shell.openExternal('https://miktex.org/download') },
        { label: 'Install TeX Live', click: () => shell.openExternal('https://tug.org/texlive/') },
        { type: 'separator' },
        {
          label: 'About OpenLeaf',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info', title: 'About OpenLeaf', message: `OpenLeaf ${app.getVersion()}`,
            detail: `A local, Overleaf-style LaTeX editor.\n\nProjects folder:\n${projectsDir}\n\nElectron ${process.versions.electron} · Node ${process.versions.node}`,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    extendPathForTeX();
    migrateFromTeXLocal();
    projectsDir = readJson(configFile(), {}).projectsDir || path.join(app.getPath('documents'), 'OpenLeaf Projects');
    process.env.OPENLEAF_PROJECTS = projectsDir;
    const { startServer } = require('../server.js');
    let port;
    try { port = await startServer({ port: PREFERRED_PORT, host: '127.0.0.1' }); }
    catch (e) {
      if (e.code !== 'EADDRINUSE') { dialog.showErrorBox('OpenLeaf could not start', String(e.stack || e)); app.exit(1); return; }
      port = await startServer({ port: 0, host: '127.0.0.1' });
    }
    baseUrl = `http://127.0.0.1:${port}/`;
    buildMenu();
    createWindow();
    app.on('activate', () => { if (!mainWindow) createWindow(); });
  });

  app.on('window-all-closed', () => { if (!isMac) app.quit(); });

  // Make sure collaborators' latest edits reach the disk before the app exits.
  let flushed = false;
  app.on('before-quit', (e) => {
    if (flushed || !baseUrl) return;
    e.preventDefault();
    flushed = true;
    const done = () => app.quit();
    require('../server.js').shutdown().then(done, done);
    setTimeout(done, 3000);
  });
}
