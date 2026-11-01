const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// All user data lives in a visible folder in the home directory, independent of the app.
const root = () => path.join(app.getPath('home'), 'Binder');
const pdfDir = () => path.join(root(), 'pdfs');
const dataDir = () => path.join(root(), 'data');
const libFile = () => path.join(root(), 'library.json');

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v));

// One-time copy of data from earlier versions that used the app-data folder.
function migrate() {
  const old = app.getPath('userData');
  fs.mkdirSync(root(), { recursive: true });
  if (!fs.existsSync(libFile()) && fs.existsSync(path.join(old, 'library.json'))) {
    for (const f of ['library.json', 'pdfs', 'data']) {
      if (fs.existsSync(path.join(old, f))) fs.cpSync(path.join(old, f), path.join(root(), f), { recursive: true });
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1300, height: 850, title: 'Binder',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

ipcMain.handle('lib:list', () => readJson(libFile(), []));

ipcMain.handle('lib:add', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled) return readJson(libFile(), []);
  fs.mkdirSync(pdfDir(), { recursive: true });
  const lib = readJson(libFile(), []);
  for (const p of filePaths) {
    const id = crypto.randomUUID();
    fs.copyFileSync(p, path.join(pdfDir(), id + '.pdf'));
    lib.push({ id, title: path.basename(p, path.extname(p)), added: Date.now() });
  }
  writeJson(libFile(), lib);
  return lib;
});

// Deleting a PDF keeps its notes: only the file goes, the entry stays marked as deleted.
ipcMain.handle('lib:remove', (_e, id) => {
  const lib = readJson(libFile(), []);
  const b = lib.find(x => x.id === id);
  if (b) b.deleted = true;
  writeJson(libFile(), lib);
  fs.rmSync(path.join(pdfDir(), id + '.pdf'), { force: true });
  return lib;
});

// Removes a book's notes for good; the entry goes too only if its PDF is already deleted.
ipcMain.handle('lib:purge', (_e, id) => {
  const lib = readJson(libFile(), []).filter(b => b.id !== id || !b.deleted);
  writeJson(libFile(), lib);
  fs.rmSync(path.join(dataDir(), id + '.json'), { force: true });
  return lib;
});

ipcMain.handle('lib:update', (_e, id, patch) => {
  const lib = readJson(libFile(), []);
  const b = lib.find(x => x.id === id);
  if (b) Object.assign(b, patch);
  writeJson(libFile(), lib);
  return lib;
});

ipcMain.handle('lib:rename', (_e, id, title) => {
  const lib = readJson(libFile(), []);
  const b = lib.find(x => x.id === id);
  if (b) b.title = title;
  writeJson(libFile(), lib);
  return lib;
});

ipcMain.handle('pdf:read', (_e, id) => fs.readFileSync(path.join(pdfDir(), id + '.pdf')));

ipcMain.handle('data:load', (_e, id) => readJson(path.join(dataDir(), id + '.json'), null));

ipcMain.handle('data:save', (_e, id, data) => {
  fs.mkdirSync(dataDir(), { recursive: true });
  writeJson(path.join(dataDir(), id + '.json'), data);
});

if (!app.requestSingleInstanceLock()) app.quit();
app.whenReady().then(() => { migrate(); createWindow(); });
app.on('window-all-closed', () => app.quit());
