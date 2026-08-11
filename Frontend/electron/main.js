const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const path = require('path');

const APP_URL = process.env.DUBFLOW_APP_URL || 'http://127.0.0.1:3000';
const DESKTOP_TOKEN = process.env.DUBFLOW_DESKTOP_TOKEN || '';
const USER_DATA_DIR = process.env.DUBFLOW_USER_DATA_DIR
  || (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'DubFlow', 'electron-profile')
    : path.join(app.getPath('home'), '.config', 'DubFlow', 'electron-profile'));
const PRELOAD_PATH = path.join(__dirname, 'preload.js');

app.setName('DubFlow Local Studio');
app.setPath('userData', USER_DATA_DIR);

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
  return;
}

function installDesktopOnlyHeaders() {
  if (!DESKTOP_TOKEN) return;
  const origin = new URL(APP_URL).origin;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          'x-dubflow-desktop-token': DESKTOP_TOKEN,
        },
      });
    }
  );
}

async function waitForStyledPage(window) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          const appRoot = document.querySelector('.h-screen');
          const mainShell = document.querySelector('main.flex');
          const hasStylesheet = Array.from(document.styleSheets || []).some((sheet) => {
            try {
              return sheet.href && sheet.href.includes('/_next/static/css/') && sheet.cssRules.length > 20;
            } catch {
              return false;
            }
          });
          const shellDisplay = mainShell ? getComputedStyle(mainShell).display : '';
          const textColor = appRoot ? getComputedStyle(appRoot).color : '';
          resolve(Boolean(appRoot && hasStylesheet && shellDisplay === 'flex' && textColor !== 'rgb(0, 0, 0)'));
        });
      });
    `).catch(() => false);

    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

function focusMainWindow() {
  const [mainWindow] = BrowserWindow.getAllWindows();
  if (!mainWindow) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return true;
}

function fileResult(filePath, keyName = 'filePath') {
  const extension = path.extname(filePath || '').toLowerCase();
  return {
    success: true,
    [keyName]: filePath,
    filePath,
    fileName: path.basename(filePath || ''),
    extension,
  };
}

async function pickFileWithElectron(window, options, keyName = 'filePath') {
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();

  const result = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    ...options,
  });

  const selectedPath = result.filePaths?.[0] || '';
  if (result.canceled || !selectedPath) {
    return { success: false, cancelled: true, message: 'No file selected' };
  }

  return fileResult(selectedPath, keyName);
}

async function pickFolderWithElectron(window) {
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();

  const result = await dialog.showOpenDialog(window, {
    title: 'Choose Output Folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: app.getPath('downloads'),
  });

  const folderPath = result.filePaths?.[0] || '';
  if (result.canceled || !folderPath) {
    return { success: false, cancelled: true, message: 'No folder selected' };
  }

  return {
    success: true,
    folderPath,
    folderName: path.basename(folderPath),
  };
}

function installDesktopPickerHandlers() {
  ipcMain.handle('dubflow:pick-video', (event) => pickFileWithElectron(
    BrowserWindow.fromWebContents(event.sender),
    {
      title: 'Choose Video File',
      defaultPath: app.getPath('downloads'),
      filters: [
        { name: 'Video files', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'] },
        { name: 'All files', extensions: ['*'] },
      ],
    },
    'videoPath'
  ));

  ipcMain.handle('dubflow:pick-audio', (event) => pickFileWithElectron(
    BrowserWindow.fromWebContents(event.sender),
    {
      title: 'Choose Background Music',
      defaultPath: app.getPath('music'),
      filters: [
        { name: 'Audio files', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'] },
        { name: 'All files', extensions: ['*'] },
      ],
    },
    'filePath'
  ));

  ipcMain.handle('dubflow:pick-logo', (event) => pickFileWithElectron(
    BrowserWindow.fromWebContents(event.sender),
    {
      title: 'Choose Logo Image',
      defaultPath: app.getPath('pictures'),
      filters: [
        { name: 'Image files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
        { name: 'All files', extensions: ['*'] },
      ],
    },
    'filePath'
  ));

  ipcMain.handle('dubflow:pick-google-credentials', (event) => pickFileWithElectron(
    BrowserWindow.fromWebContents(event.sender),
    {
      title: 'Choose Google service account JSON',
      defaultPath: app.getPath('downloads'),
      filters: [
        { name: 'Google credentials JSON', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    },
    'filePath'
  ));

  ipcMain.handle('dubflow:pick-output-folder', (event) => pickFolderWithElectron(
    BrowserWindow.fromWebContents(event.sender)
  ));
}

function createWindow() {
  let reloadedForStyles = false;
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#071020',
    show: false,
    title: 'DubFlow Local Studio',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD_PATH,
    },
  });

  mainWindow.webContents.on('did-finish-load', async () => {
    if (mainWindow.isVisible()) return;
    mainWindow.webContents.setZoomFactor(1);
    const styled = await waitForStyledPage(mainWindow);
    if (!styled) {
      if (!reloadedForStyles) {
        reloadedForStyles = true;
        mainWindow.webContents.reloadIgnoringCache();
        return;
      }
      mainWindow.show();
      return;
    }

    mainWindow.show();
  });

  mainWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.loadURL(APP_URL);
      }
    }, 1000);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(APP_URL, DESKTOP_TOKEN ? {
    extraHeaders: `x-dubflow-desktop-token: ${DESKTOP_TOKEN}`,
  } : undefined);
}

app.on('second-instance', () => {
  if (!focusMainWindow()) {
    createWindow();
  }
});

app.whenReady().then(() => {
  installDesktopOnlyHeaders();
  installDesktopPickerHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
