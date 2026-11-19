// Tiroir desktop shell: runs server.js in-process and shows the web UI in a frameless window
// whose title bar (move, minimise, maximise, close) is drawn by the page itself.
const { app, BrowserWindow, ipcMain, Menu, shell, nativeImage, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.TIROIR_NO_OPEN = '1'; // the shell opens the window, not the browser
app.setAppUserModelId('Tiroir');
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();

// ---------- leave nothing behind ----------
// Chromium's caches (images, scripts, GPU shaders, page storage) only live while Tiroir runs. They are cleared on quit,
// and swept again here at start-up, before Chromium opens them, in case the last run crashed or was killed.
// Kept: config.json (settings, sealed sign-ins), Local Storage (display preferences), Network (the local session cookie).
const CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'GraphiteDawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache',
  'GPUPersistentCache', 'blob_storage', 'Shared Dictionary', 'VideoDecodeStats', 'IndexedDB', 'Service Worker', 'Session Storage', 'shared_proto_db',
  'WebStorage', 'DIPS', 'DIPS-wal', 'declarative_performance_observer.db', 'declarative_performance_observer.db-journal', 'thumbs', 'Extension State'];
// Chromium keeps its cache files open until the very end, so the folders themselves are removed by a tiny hidden helper
// that waits for Tiroir to have fully exited. Files a new Tiroir already reopened are locked and skipped (start-up sweeps them).
function sweepAfterExit() {
  if (process.platform !== 'win32') return;
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const list = CACHE_DIRS.map((d) => q(path.join(app.getPath('userData'), d))).join(',');
  const cmd = `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800; Remove-Item -LiteralPath ${list} -Recurse -Force -ErrorAction SilentlyContinue`;
  // Electron's children die with it (Windows job object), so the helper is created by Windows itself (WMI), hidden.
  const inner = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(cmd, 'utf16le').toString('base64')}`;
  const launcher = `$si = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${inner}'; ProcessStartupInformation = $si } | Out-Null`;
  try { require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher], { windowsHide: true, stdio: 'ignore', timeout: 6000 }); } catch {}
}
if (firstInstance) for (const d of CACHE_DIRS) { try { fs.rmSync(path.join(app.getPath('userData'), d), { recursive: true, force: true }); } catch {} }
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache'); // shaders are cheap to rebuild: never written to disk
let cleaned = false;
app.on('will-quit', (e) => {
  if (cleaned || !firstInstance) return;
  e.preventDefault(); cleaned = true;
  const s = session.defaultSession;
  Promise.allSettled([
    s.clearCache(), s.clearCodeCaches({}),
    s.clearStorageData({ storages: ['indexdb', 'cachestorage', 'serviceworkers', 'shadercache', 'websql', 'filesystem'] }),
  ]).then(() => { try { require('../server.js').purgeTemp(); } catch {} sweepAfterExit(); app.quit(); });
  setTimeout(() => { sweepAfterExit(); app.exit(0); }, 4000); // never hang on quit
});

let win;
async function createWindow() {
  const { cfg, server } = require('../server.js');
  const port = process.env.TIROIR_PORT || 4170;
  // Never hand the session key to whatever else might be squatting on our port: only load once OUR server listens.
  if (!server.listening) {
    const err = await new Promise((r) => { server.once('listening', () => r(null)); server.once('error', r); });
    if (err) {
      dialog.showErrorBox('Tiroir', `Le port ${port} est déjà utilisé par une autre application, Tiroir ne peut pas démarrer.\n\n(${err.code || err.message})`);
      return app.quit();
    }
  }
  // Tiroir never needs the camera, microphone, location, notifications… only video full screen and "copy link".
  const ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ALLOWED.has(perm));
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    frame: false, backgroundColor: '#0b0b0c', show: false, title: 'Tiroir',
    icon: nativeImage.createFromPath(path.join(__dirname, '../web/icon.ico')),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  const send = () => win.webContents.send('win', { max: win.isMaximized(), focus: win.isFocused() });
  for (const ev of ['maximize', 'unmaximize', 'focus', 'blur']) win.on(ev, send);
  win.webContents.on('did-finish-load', send);

  // Feel like an app, not a browser: no zoom, no reload/devtools shortcuts, links open in the real browser.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on('before-input-event', (e, i) => {
    const k = i.key.toLowerCase();
    if (i.control && ['+', '-', '=', '0', 'r', 'p'].includes(k)) e.preventDefault();
    if (k === 'f12' || (i.control && i.shift && k === 'i')) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://localhost:${port}/`)) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });

  const load = () => win.loadURL(`http://localhost:${port}/?k=${cfg.key}`).catch(() => setTimeout(load, 300));
  load();
}

ipcMain.on('win', (e, action) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (action === 'min') w.minimize();
  else if (action === 'max') w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (action === 'close') w.close();
});

// Google pages (console, Drive web, sign-in) open in the user's default browser. Only https links are accepted.
ipcMain.on('open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url).catch(() => {}); });

Menu.setApplicationMenu(null);
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
