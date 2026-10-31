/* ══════════════════════════════════════════════════════════
   main.js · Electron 主进程
   内置本机 / 局域网 Nostr 中继、托盘、原生通知与窗口管理
   ══════════════════════════════════════════════════════════ */
'use strict';

const {
  app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

app.setName('Miyu');

/* 便携版把数据放在可执行文件旁的 MiyuData；测试可覆盖此路径 */
try {
  let userData = '';
  if (process.env.MIYU_USER_DATA) userData = path.resolve(process.env.MIYU_USER_DATA);
  else if (process.env.PORTABLE_EXECUTABLE_DIR) userData = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'MiyuData');
  if (userData) {
    fs.mkdirSync(userData, { recursive: true });
    app.setPath('userData', userData);
  }
} catch { /* 使用默认用户目录 */ }

const devWebIndex = path.join(__dirname, '..', 'app', 'www', 'index.html');
const isDev = !app.isPackaged || fs.existsSync(devWebIndex);
const DEFAULT_PORT = 7777;
const MAX_TITLE = 90;
const MAX_BODY = 260;

let mainWindow = null;
let tray = null;
let relay = null;
let relayError = '';
let lastPort = DEFAULT_PORT;
let quitting = false;
let trayHintShown = false;
let crashCount = 0;
let lanChain = Promise.resolve();

let configPath = '';
let relayDataDir = '';
let relayDataFile = '';
let config = {
  lanEnabled: false,
  window: { width: 1160, height: 780, x: null, y: null, maximized: false },
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (relay) {
      try { relay.stop().catch(() => {}); } catch { /* 忽略 */ }
      relay = null;
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      quitting = true;
      app.quit();
    }
  });

  app.on('activate', () => {
    if (!mainWindow) createWindow();
    else showWindow();
  });

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('[miyu] 启动失败:', err);
    try {
      require('electron').dialog.showErrorBox('密语启动失败', String(err && err.stack ? err.stack : err));
    } catch { /* 忽略 */ }
    app.quit();
  });
}

/* ── 路径与配置 ── */

function initPaths() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  relayDataDir = path.join(app.getPath('userData'), 'relay-data');
  relayDataFile = path.join(relayDataDir, 'events.jsonl');
  try { fs.mkdirSync(relayDataDir, { recursive: true }); } catch { /* 忽略 */ }
}

function sanitizeWindow(raw) {
  const base = { width: 1160, height: 780, x: null, y: null, maximized: false };
  if (!raw || typeof raw !== 'object') return base;
  const width = Number(raw.width);
  const height = Number(raw.height);
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (Number.isFinite(width)) base.width = Math.max(860, Math.min(4096, Math.round(width)));
  if (Number.isFinite(height)) base.height = Math.max(560, Math.min(2600, Math.round(height)));
  if (Number.isFinite(x)) base.x = Math.round(x);
  if (Number.isFinite(y)) base.y = Math.round(y);
  base.maximized = !!raw.maximized;
  return base;
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (raw && typeof raw === 'object') {
      config.lanEnabled = !!raw.lanEnabled;
      config.window = sanitizeWindow(raw.window);
    }
  } catch { /* 首次运行或文件损坏，使用默认值 */ }
}

function writeConfig() {
  try {
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, configPath);
    } catch {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    }
  } catch (e) {
    console.error('[miyu] 保存配置失败:', e && e.message);
  }
}

/* ── 图标与资源 ── */

function iconPath() {
  return path.join(__dirname, 'build', 'icon.png');
}

function webIndexPath() {
  const packagedIndex = path.join(process.resourcesPath, 'www', 'index.html');
  if (fs.existsSync(packagedIndex)) return packagedIndex;
  return devWebIndex;
}

function relayBundlePath() {
  return path.join(__dirname, 'relay-bundle.cjs');
}

/* ── 中继 ── */

async function loadStartRelay() {
  try {
    const mod = require(relayBundlePath());
    if (mod && typeof mod.startRelay === 'function') return mod.startRelay;
  } catch (e) {
    if (!isDev) throw e;
  }
  if (!isDev) throw new Error('relay-bundle.cjs 缺失');
  const entry = path.join(__dirname, '..', 'relay', 'src', 'core.js');
  const mod = await import(pathToFileURL(entry).href);
  if (!mod || typeof mod.startRelay !== 'function') throw new Error('中继模块加载失败');
  return mod.startRelay;
}

function lanUrls(port) {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const rows of Object.values(interfaces)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || row.internal) continue;
      const family = row.family;
      if (family !== 'IPv4' && family !== 4) continue;
      if (!row.address || row.address.startsWith('169.254.')) continue;
      const url = `ws://${row.address}:${port}`;
      if (!out.includes(url)) out.push(url);
    }
  }
  return out;
}

async function startRelayServer() {
  const start = await loadStartRelay();
  const host = config.lanEnabled ? '0.0.0.0' : '127.0.0.1';
  const options = {
    host,
    dataFile: relayDataFile,
    name: '密语本机中继',
    logger: false,
  };
  let instance = null;
  let error = null;
  try {
    instance = await start({ ...options, port: lastPort });
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      try {
        instance = await start({ ...options, port: 0 });
      } catch (e2) {
        error = e2;
      }
    } else {
      error = e;
    }
  }
  if (!instance) {
    relay = null;
    relayError = error && error.message ? error.message : '本机中继启动失败';
    console.error('[miyu] 中继启动失败:', relayError);
    return false;
  }
  relay = instance;
  lastPort = instance.port;
  relayError = '';
  console.log(`[miyu] 中继已启动 ws://127.0.0.1:${instance.port}${config.lanEnabled ? '（局域网）' : ''}`);
  return true;
}

async function restartRelay() {
  if (relay) {
    const old = relay;
    relay = null;
    try {
      await Promise.race([
        old.stop(),
        new Promise((resolve) => setTimeout(resolve, 2200)),
      ]);
    } catch { /* 忽略 */ }
  }
  return startRelayServer();
}

function buildConfig() {
  return {
    relayUrl: relay ? `ws://127.0.0.1:${relay.port}` : '',
    relayPort: relay ? relay.port : 0,
    relayRunning: !!relay,
    relayError,
    version: app.getVersion(),
    platform: process.platform,
    lanEnabled: !!config.lanEnabled,
    lanUrls: relay && config.lanEnabled ? lanUrls(relay.port) : [],
    dataDir: relayDataDir,
    isPackaged: app.isPackaged,
  };
}

function broadcastConfig() {
  const cfg = buildConfig();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('miyu:config-changed', cfg);
  }
  updateTrayMenu();
  return cfg;
}

function doSetLan(enabled) {
  return (async () => {
    const next = !!enabled;
    if (config.lanEnabled === next && relay) return buildConfig();
    config.lanEnabled = next;
    writeConfig();
    await restartRelay();
    return broadcastConfig();
  })();
}

function setLanEnabled(enabled) {
  lanChain = lanChain.then(() => doSetLan(enabled), () => doSetLan(enabled));
  return lanChain;
}

/* ── 窗口 ── */

function clampToDisplays(bounds) {
  try {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    if (!displays.length) return bounds;
    const visible = displays.some((d) => {
      const a = d.workArea;
      const overlapX = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
      const overlapY = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
      return overlapX > 80 && overlapY > 60;
    });
    if (visible) return bounds;
  } catch { /* 忽略 */ }
  return { width: bounds.width, height: bounds.height, x: undefined, y: undefined };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const normal = mainWindow.getNormalBounds();
    config.window = {
      width: normal.width,
      height: normal.height,
      x: normal.x,
      y: normal.y,
      maximized: mainWindow.isMaximized(),
    };
    writeConfig();
  } catch { /* 忽略 */ }
}

let saveTimer = null;
function saveWindowStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWindowState, 500);
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showWindow();
    return;
  }
  const bounds = clampToDisplays(config.window);
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: '密语',
    backgroundColor: '#ededed',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(webIndexPath()).catch((err) => {
    console.error('[miyu] 页面加载失败:', err);
  });

  mainWindow.once('ready-to-show', () => {
    if (config.window.maximized) {
      try { mainWindow.maximize(); } catch { /* 忽略 */ }
    }
    showWindow();
  });

  mainWindow.on('close', (event) => {
    if (quitting) {
      saveWindowState();
      return;
    }
    event.preventDefault();
    saveWindowState();
    mainWindow.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      showNotification('密语仍在运行', '关闭窗口后消息仍会接收。双击托盘图标可以重新打开。', '');
    }
  });

  mainWindow.on('resize', saveWindowStateSoon);
  mainWindow.on('move', saveWindowStateSoon);
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '';
    if (current && url !== current) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (quitting) return;
    if (details && details.reason === 'clean-exit') return;
    console.error('[miyu] 渲染进程退出:', details);
    if (crashCount >= 3) return;
    crashCount++;
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      setTimeout(() => { crashCount = 0; }, 12000);
    }, 800);
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[miyu] 加载错误:', code, desc);
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showWindow();
}

/* ── 托盘与菜单 ── */

function createTray() {
  try {
    const image = nativeImage.createFromPath(iconPath());
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
    tray.setToolTip('密语 · 私密聊天');
    tray.on('click', toggleWindow);
    tray.on('double-click', showWindow);
    updateTrayMenu();
  } catch (e) {
    console.error('[miyu] 托盘创建失败:', e && e.message);
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const relayLabel = relay
    ? `本机中继 · 端口 ${relay.port}`
    : (relayError ? '本机中继启动失败' : '本机中继未运行');
  const menu = Menu.buildFromTemplate([
    { label: '显示密语', click: showWindow },
    { label: '隐藏到托盘', click: hideWindow },
    { type: 'separator' },
    {
      label: '局域网中继',
      type: 'checkbox',
      checked: !!config.lanEnabled,
      click: (item) => {
        setLanEnabled(!!item.checked).catch((err) => {
          console.error('[miyu] 切换局域网失败:', err);
          updateTrayMenu();
        });
      },
    },
    { label: relayLabel, enabled: false },
    config.lanEnabled && relay
      ? { label: `  ${lanUrls(relay.port)[0] || '未检测到局域网地址'}`, enabled: false }
      : { label: '  仅本机可连接', enabled: false },
    { type: 'separator' },
    { label: '打开数据目录', click: openDataDir },
    { label: '关于密语', click: showAbout },
    { type: 'separator' },
    {
      label: '退出密语',
      click: () => { quitting = true; app.quit(); },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(relay ? `密语 · 中继端口 ${relay.port}` : '密语 · 中继未运行');
}

function openDataDir() {
  fs.mkdirSync(relayDataDir, { recursive: true });
  shell.openPath(relayDataDir).catch(() => {});
}

function showAbout() {
  const cfg = buildConfig();
  const { dialog } = require('electron');
  dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    type: 'info',
    title: '关于密语',
    message: '密语 · 私密聊天',
    detail: [
      `版本：${cfg.version}`,
      '去中心化聊天客户端，基于 Nostr 协议。',
      '群聊、私聊、消息撤回与本机删除。',
      '',
      `本机中继：${cfg.relayRunning ? cfg.relayUrl : '未运行'}`,
      `局域网中继：${cfg.lanEnabled ? '已开启' : '已关闭'}`,
      `数据目录：${cfg.dataDir}`,
      '',
      '本软件免费使用，不收集任何账户或聊天数据。',
    ].join('\n'),
    buttons: ['确定'],
    noLink: true,
  }).catch(() => {});
}

function runInPage(code) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(code, true).catch(() => {});
}

function buildAppMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建群聊', accelerator: 'CmdOrCtrl+N', click: () => runInPage('MY.app.openRoomModal("new")') },
        { label: '加入群聊', accelerator: 'CmdOrCtrl+J', click: () => runInPage('MY.app.openRoomModal("join")') },
        { label: '发起私聊', click: () => runInPage('MY.app.openContactModal("dm")') },
        { type: 'separator' },
        { label: '设置', accelerator: 'CmdOrCtrl+,', click: () => runInPage('MY.app.openSettings()') },
        { type: 'separator' },
        { label: '隐藏到托盘', click: hideWindow },
        { label: '退出密语', accelerator: 'Alt+F4', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具', visible: isDev },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于密语', click: showAbout },
        { label: '打开数据目录', click: openDataDir },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ── 通知 ── */

function clip(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function showNotification(title, body, roomId) {
  if (!Notification.isSupported()) return false;
  try {
    const n = new Notification({
      title: clip(title, MAX_TITLE) || '密语',
      body: clip(body, MAX_BODY),
      icon: iconPath(),
      silent: true,
      timeoutType: 'default',
    });
    n.on('click', () => {
      showWindow();
      const id = clip(roomId, 100);
      if (id && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('miyu:notification-click', id);
      }
    });
    n.show();
    return true;
  } catch (e) {
    console.error('[miyu] 通知失败:', e && e.message);
    return false;
  }
}

/* ── IPC ── */

function registerIpc() {
  ipcMain.handle('miyu:get-config', () => buildConfig());

  ipcMain.handle('miyu:set-lan', async (_event, enabled) => {
    return setLanEnabled(!!enabled);
  });

  ipcMain.handle('miyu:notify', (_event, payload) => {
    const title = payload && typeof payload.title === 'string' ? payload.title : '';
    const body = payload && typeof payload.body === 'string' ? payload.body : '';
    const roomId = payload && typeof payload.roomId === 'string' ? payload.roomId : '';
    return { ok: showNotification(title, body, roomId) };
  });

  ipcMain.handle('miyu:open-data', () => {
    openDataDir();
    return true;
  });

  ipcMain.handle('miyu:open-external', async (_event, url) => {
    const value = String(url || '');
    if (!/^https?:\/\//i.test(value)) return false;
    await shell.openExternal(value).catch(() => {});
    return true;
  });

  ipcMain.handle('miyu:quit', () => {
    quitting = true;
    app.quit();
    return true;
  });
}

/* ── 启动 ── */

async function bootstrap() {
  initPaths();
  loadConfig();

  try {
    const { session } = require('electron');
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'notifications');
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'notifications');
  } catch { /* 忽略 */ }

  registerIpc();
  await startRelayServer();
  createWindow();
  createTray();
  buildAppMenu();
  broadcastConfig();

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
