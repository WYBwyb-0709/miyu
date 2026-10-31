/* ══════════════════════════════════════════════════════════
   preload.js · 受控的桌面能力桥
   ══════════════════════════════════════════════════════════ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const handler = (_event, payload) => {
    try { callback(payload); } catch { /* 忽略渲染层异常 */ }
  };
  ipcRenderer.on(channel, handler);
  return () => {
    try { ipcRenderer.removeListener(channel, handler); } catch { /* 忽略 */ }
  };
}

contextBridge.exposeInMainWorld('miyuDesktop', {
  getConfig: () => ipcRenderer.invoke('miyu:get-config'),
  setLan: (enabled) => ipcRenderer.invoke('miyu:set-lan', !!enabled),
  notify: (title, body, roomId) => ipcRenderer.invoke('miyu:notify', {
    title: String(title == null ? '' : title),
    body: String(body == null ? '' : body),
    roomId: String(roomId == null ? '' : roomId),
  }),
  openDataDir: () => ipcRenderer.invoke('miyu:open-data'),
  openExternal: (url) => ipcRenderer.invoke('miyu:open-external', String(url == null ? '' : url)),
  quit: () => ipcRenderer.invoke('miyu:quit'),
  onNotificationClick: (callback) => on('miyu:notification-click', callback),
  onConfigChanged: (callback) => on('miyu:config-changed', callback),
});
