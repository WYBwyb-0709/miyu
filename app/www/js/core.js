/* ══════════════════════════════════════════════════════════
   core.js · 基础工具
   ══════════════════════════════════════════════════════════ */
(function (MY) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function hexToBytes(hex) {
    const clean = String(hex || '').trim();
    if (clean.length % 2) throw new Error('invalid hex');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      const b = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(b)) throw new Error('invalid hex');
      out[i] = b;
    }
    return out;
  }

  function b64encode(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function b64decode(str) {
    const bin = atob(String(str || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function b64urlEncode(str) {
    return b64encode(enc.encode(str)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(str) {
    let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return dec.decode(b64decode(s));
  }

  async function sha256Hex(bytes) {
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(h));
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = bytesToHex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function fmtTime(ts) {
    const d = new Date(ts * 1000);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function fmtRoomTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtTime(ts);
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  function fmtMsgDate(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    const hm = fmtTime(ts);
    if (d.toDateString() === now.toDateString()) return hm;
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(1) + ' MB';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('read failed'));
      r.readAsDataURL(blob);
    });
  }

  function safeFileName(name) {
    return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
  }

  async function saveBlob(blob, filename) {
    const clean = safeFileName(filename);
    if (isNative()) {
      const plugins = window.Capacitor && window.Capacitor.Plugins;
      const fs = plugins && plugins.Filesystem;
      const share = plugins && plugins.Share;
      if (fs) {
        try {
          const dataUrl = await readAsDataUrl(blob);
          const comma = dataUrl.indexOf(',');
          const data = comma >= 0 ? dataUrl.slice(comma + 1) : '';
          const res = await fs.writeFile({
            path: `Miyu/${Date.now()}-${clean}`,
            data,
            directory: 'DOCUMENTS',
            recursive: true,
          });
          if (share && res && res.uri) {
            try {
              await share.share({ title: clean, url: res.uri, dialogTitle: '保存或分享文件' });
            } catch { /* 已保存到文档目录 */ }
          }
          return true;
        } catch { /* 回退到分享/下载 */ }
      }
      if (navigator.canShare) {
        try {
          const file = new File([blob], clean, { type: blob.type || 'application/octet-stream' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: clean });
            return true;
          }
        } catch { /* 忽略 */ }
      }
    }
    downloadBlob(blob, clean);
    return true;
  }

  function slugId(name) {
    const ascii = String(name || '').trim().toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '');
    const base = ascii.replace(/[\u4e00-\u9fff]/g, '').slice(0, 16) || 'room';
    let hash = 0;
    for (let i = 0; i < ascii.length; i++) hash = ((hash << 5) - hash + ascii.charCodeAt(i)) | 0;
    return `miyu-${base}-${Math.abs(hash).toString(36).slice(0, 4)}-${uuid().slice(0, 4)}`;
  }

  function parseRelayUrls(text) {
    const out = [];
    for (const raw of String(text || '').split(/[\s,;]+/)) {
      const u = raw.trim();
      if (!u) continue;
      if (!/^wss?:\/\//i.test(u)) continue;
      if (!out.includes(u)) out.push(u.replace(/\/+$/, ''));
    }
    return out;
  }

  function isDesktop() {
    return !!window.miyuDesktop;
  }

  function isNative() {
    return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  }

  function isMobileWidth() {
    return window.innerWidth <= 900;
  }

  let audioCtx = null;
  function beep() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(660, t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.18);
    } catch { /* 忽略 */ }
  }

  let nativeNotifySeq = Math.floor(Date.now() / 1000) % 100000;

  async function notify(title, body, roomId) {
    if (isDesktop() && window.miyuDesktop.notify) {
      try { await window.miyuDesktop.notify(title, body, roomId); return; } catch { /* 忽略 */ }
    }
    if (isNative()) {
      const ln = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
      if (ln) {
        try {
          nativeNotifySeq = (nativeNotifySeq + 1) % 2100000000;
          await ln.schedule({
            notifications: [{
              id: nativeNotifySeq,
              title: String(title || '密语'),
              body: String(body || ''),
              schedule: { at: new Date(Date.now() + 250) },
              channelId: 'miyu-default',
              extra: { roomId: roomId || '' },
              smallIcon: 'ic_stat_miyu',
              iconColor: '#07c160',
            }],
          });
          return;
        } catch { /* 回退到 Web 通知 */ }
      }
    }
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') return;
      if (Notification.permission !== 'granted') return;
      const n = new Notification(title, { body, silent: true, tag: roomId || 'miyu' });
      n.onclick = () => {
        try { window.focus(); } catch { /* 忽略 */ }
        if (roomId && MY.app && MY.app.openRoom) MY.app.openRoom(roomId);
        n.close();
      };
    } catch { /* 忽略 */ }
  }

  async function requestNotifyPermission() {
    if (isNative()) {
      const ln = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
      if (ln) {
        try {
          const res = await ln.requestPermissions();
          return res && res.display === 'granted';
        } catch { /* 继续 Web 权限 */ }
      }
    }
    try {
      if (!('Notification' in window)) return false;
      if (Notification.permission === 'granted') return true;
      if (Notification.permission === 'denied') return false;
      return (await Notification.requestPermission()) === 'granted';
    } catch { return false; }
  }

  function storageGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch { return fallback; }
  }

  function storageSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }

  MY.util = {
    $, $$, enc, dec, sleep, debounce, clamp, esc,
    bytesToHex, hexToBytes, b64encode, b64decode, b64urlEncode, b64urlDecode,
    sha256Hex, uuid, fmtTime, fmtRoomTime, fmtMsgDate, formatBytes,
    copyText, downloadBlob, saveBlob, slugId, parseRelayUrls,
    isDesktop, isNative, isMobileWidth, beep, notify, requestNotifyPermission,
    storageGet, storageSet,
  };

  MY.const = {
    APP_NAME: '密语',
    VERSION: '1.0.0',
    MAX_TEXT: 4000,
    MAX_FILE: 15 * 1024 * 1024,
    CHUNK_BINARY: 24 * 1024,
    RECALL_WINDOW: 2 * 60 * 1000,
    FILE_RX_WAIT: 25 * 1000,
    FILE_RX_MAX_WAIT: 20 * 60 * 1000,
    FILE_RX_RETRIES: 10,
    LOBBY_ID: 'miyu-lobby',
  };
})(window.MY = window.MY || {});
