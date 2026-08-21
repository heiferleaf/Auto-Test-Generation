// 最小 Electron 靶机应用（M1.5 端到端冒烟用），仅供测试，不要求完美。
// 启动：electron . --remote-debugging-port=9222

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

function createWindow() {
  const win = new BrowserWindow({
    width: 600,
    height: 400,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
