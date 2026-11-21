/* ══════════════════════════════════════════════════════════
   store.js · IndexedDB（带 localStorage 降级）
   ══════════════════════════════════════════════════════════ */
(function (MY) {
  'use strict';

  const U = MY.util;
  const DB_NAME = 'miyu-db';
  const DB_VERSION = 1;
  const OPEN_TIMEOUT = 2500;
  const FALLBACK_EVENTS_MAX = 500;
  const FALLBACK_BLOB_MAX = 1.2 * 1024 * 1024;
  const FALLBACK_BLOB_TOTAL = 4 * 1024 * 1024;
  const memBlobs = new Map();

  let dbPromise = null;
  let mode = 'idb';
  let account = 'anon';

  function openDB() {
    if (dbPromise) return dbPromise;
    if (mode === 'fallback') return Promise.reject(new Error('fallback'));
    dbPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        mode = 'fallback';
        reject(new Error('IndexedDB timeout'));
      }, OPEN_TIMEOUT);

      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { clearTimeout(timer); mode = 'fallback'; reject(e); return; }

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('events')) {
          const s = db.createObjectStore('events', { keyPath: 'k' });
          s.createIndex('room', ['account', 'roomId', 'created_at']);
        }
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'k' });
      };
      req.onsuccess = () => {
        if (settled) { try { req.result.close(); } catch { /* 忽略 */ } return; }
        settled = true;
        clearTimeout(timer);
        resolve(req.result);
      };
      req.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        mode = 'fallback';
        reject(req.error || new Error('IndexedDB error'));
      };
      req.onblocked = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        mode = 'fallback';
        reject(new Error('IndexedDB blocked'));
      };
    });
    return dbPromise;
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('tx error'));
      tx.onabort = () => reject(tx.error || new Error('tx abort'));
    });
  }

  function eventKey(roomId, id) {
    return `${account}:${roomId}:${id}`;
  }

  function fallbackEventsKey(roomId) {
    return `miyu.ev.${account}.${roomId}`;
  }

  function fallbackBlobKey(id) {
    return `miyu.bl.${account}.${id}`;
  }

  function fallbackKvKey(key) {
    return `miyu.kv.${account}.${key}`;
  }

  function fallbackOutboxKey(key) {
    return `miyu.ob.${account}.${key}`;
  }

  function readFallbackEvents(roomId) {
    return U.storageGet(fallbackEventsKey(roomId), []);
  }

  function writeFallbackEvents(roomId, list) {
    const trimmed = list.slice().sort((a, b) => a.created_at - b.created_at).slice(-FALLBACK_EVENTS_MAX);
    try { localStorage.setItem(fallbackEventsKey(roomId), JSON.stringify(trimmed)); } catch {
      try { localStorage.setItem(fallbackEventsKey(roomId), JSON.stringify(trimmed.slice(-200))); } catch { /* 忽略 */ }
    }
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('read failed'));
      r.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(url) {
    try {
      const comma = url.indexOf(',');
      if (comma < 0) return null;
      const head = url.slice(0, comma);
      const mime = (head.match(/^data:([^;,]+)/) || [])[1] || 'application/octet-stream';
      const bin = atob(url.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    } catch { return null; }
  }

  function pruneFallbackBlobs(incoming) {
    const prefix = `miyu.bl.${account}.`;
    const entries = [];
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const len = (localStorage.getItem(k) || '').length;
      entries.push({ k, len });
      total += len;
    }
    for (const e of entries) {
      if (total + incoming <= FALLBACK_BLOB_TOTAL) break;
      try { localStorage.removeItem(e.k); } catch { /* 忽略 */ }
      total -= e.len;
    }
  }

  function makeRecord(roomId, item) {
    const ev = item.ev || {};
    return {
      k: eventKey(roomId, ev.id),
      account,
      roomId,
      id: ev.id,
      created_at: ev.created_at || Math.floor(Date.now() / 1000),
      pubkey: item.displayPubkey || ev.pubkey || '',
      senderName: item.senderName || '',
      text: item.text == null ? null : String(item.text),
      fileMeta: item.fileMeta || null,
      status: item.status || null,
      recalled: !!item.recalled,
      deleted: !!item.deleted,
      failed: !!item.failed,
      fileError: item.fileError || null,
      replyTo: item.replyTo || null,
      wrapIds: Array.isArray(item.wrapIds) ? item.wrapIds : null,
    };
  }

  const Store = {
    get mode() { return mode; },
    get backendName() { return mode === 'fallback' ? '本地兼容存储' : 'IndexedDB'; },

    async init(pub) {
      account = pub || 'anon';
      try { await openDB(); } catch { mode = 'fallback'; }
      return mode;
    },

    async saveEvent(roomId, item) {
      const rec = makeRecord(roomId, item);
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('events', 'readwrite');
          tx.objectStore('events').put(rec);
          await txDone(tx);
          return rec;
        } catch { mode = 'fallback'; }
      }
      const list = readFallbackEvents(roomId);
      const i = list.findIndex((r) => r.id === rec.id);
      if (i >= 0) list[i] = rec; else list.push(rec);
      writeFallbackEvents(roomId, list);
      return rec;
    },

    async loadEvents(roomId) {
      let rows = [];
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('events', 'readonly');
          const idx = tx.objectStore('events').index('room');
          const range = IDBKeyRange.bound([account, roomId, 0], [account, roomId, Infinity]);
          rows = await new Promise((resolve) => {
            const req = idx.getAll(range);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
          });
        } catch { mode = 'fallback'; }
      }
      const fb = readFallbackEvents(roomId);
      if (!fb.length) return rows.sort((a, b) => a.created_at - b.created_at);
      const map = new Map();
      for (const r of fb) map.set(r.id, r);
      for (const r of rows) map.set(r.id, r);
      return [...map.values()].sort((a, b) => a.created_at - b.created_at);
    },

    async removeEvent(roomId, id) {
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('events', 'readwrite');
          tx.objectStore('events').delete(eventKey(roomId, id));
          await txDone(tx);
        } catch { mode = 'fallback'; }
      }
      writeFallbackEvents(roomId, readFallbackEvents(roomId).filter((r) => r.id !== id));
    },

    async deleteRoom(roomId) {
      const ids = new Set();
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction(['events', 'blobs'], 'readwrite');
          const evStore = tx.objectStore('events');
          const idx = evStore.index('room');
          const range = IDBKeyRange.bound([account, roomId, 0], [account, roomId, Infinity]);
          const rows = await new Promise((resolve, reject) => {
            const req = idx.getAll(range);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error || new Error('read failed'));
          });
          const blobStore = tx.objectStore('blobs');
          for (const rec of rows) {
            ids.add(rec.id);
            evStore.delete(rec.k);
            blobStore.delete(`${account}:${rec.id}`);
          }
          await txDone(tx);
        } catch { mode = 'fallback'; }
      }
      const fb = readFallbackEvents(roomId);
      for (const rec of fb) ids.add(rec.id);
      try { localStorage.removeItem(fallbackEventsKey(roomId)); } catch { /* 忽略 */ }
      for (const id of ids) {
        memBlobs.delete(`${account}:${id}`);
        try { localStorage.removeItem(fallbackBlobKey(id)); } catch { /* 忽略 */ }
      }
    },

    async saveBlob(id, blob) {
      if (!blob) return;
      memBlobs.set(`${account}:${id}`, blob);
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').put({ k: `${account}:${id}`, blob });
          await txDone(tx);
          return;
        } catch { mode = 'fallback'; }
      }
      if (blob.size > FALLBACK_BLOB_MAX) return;
      try {
        const dataUrl = await blobToDataURL(blob);
        pruneFallbackBlobs(dataUrl.length);
        localStorage.setItem(fallbackBlobKey(id), dataUrl);
      } catch { /* 仅内存 */ }
    },

    async loadBlob(id) {
      const mem = memBlobs.get(`${account}:${id}`);
      if (mem) return mem;
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('blobs', 'readonly');
          const rec = await new Promise((resolve) => {
            const req = tx.objectStore('blobs').get(`${account}:${id}`);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
          });
          if (rec && rec.blob) { memBlobs.set(`${account}:${id}`, rec.blob); return rec.blob; }
        } catch { mode = 'fallback'; }
      }
      const dataUrl = (() => { try { return localStorage.getItem(fallbackBlobKey(id)); } catch { return null; } })();
      if (!dataUrl) return null;
      const blob = dataURLToBlob(dataUrl);
      if (blob) memBlobs.set(`${account}:${id}`, blob);
      return blob;
    },

    async deleteBlob(id) {
      memBlobs.delete(`${account}:${id}`);
      try { localStorage.removeItem(fallbackBlobKey(id)); } catch { /* 忽略 */ }
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').delete(`${account}:${id}`);
          await txDone(tx);
        } catch { mode = 'fallback'; }
      }
    },

    async kvSet(key, value) {
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ k: `${account}:${key}`, v: value });
          await txDone(tx);
          return;
        } catch { mode = 'fallback'; }
      }
      U.storageSet(fallbackKvKey(key), value);
    },

    async kvGet(key, fallback) {
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('kv', 'readonly');
          const rec = await new Promise((resolve) => {
            const req = tx.objectStore('kv').get(`${account}:${key}`);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
          });
          if (rec) return rec.v;
        } catch { mode = 'fallback'; }
      }
      return U.storageGet(fallbackKvKey(key), fallback);
    },

    async outboxSet(key, value) {
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('outbox', 'readwrite');
          tx.objectStore('outbox').put({ k: `${account}:${key}`, v: value });
          await txDone(tx);
          return;
        } catch { mode = 'fallback'; }
      }
      try {
        const raw = JSON.stringify(value);
        if (raw.length < 2.5 * 1024 * 1024) U.storageSet(fallbackOutboxKey(key), value);
      } catch { /* 忽略 */ }
    },

    async outboxGet(key) {
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('outbox', 'readonly');
          const rec = await new Promise((resolve) => {
            const req = tx.objectStore('outbox').get(`${account}:${key}`);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
          });
          if (rec) return rec.v;
        } catch { mode = 'fallback'; }
      }
      return U.storageGet(fallbackOutboxKey(key), null);
    },

    async outboxDelete(key) {
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('outbox', 'readwrite');
          tx.objectStore('outbox').delete(`${account}:${key}`);
          await txDone(tx);
        } catch { mode = 'fallback'; }
      }
      try { localStorage.removeItem(fallbackOutboxKey(key)); } catch { /* 忽略 */ }
    },

    /* 仅清理当前账户下属于指定房间的 outbox 记录，绝不触碰其他房间/其他账户 */
    async outboxDeleteRoom(roomId) {
      if (!roomId) return;
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('outbox', 'readwrite');
          const prefix = `${account}:`;
          const req = tx.objectStore('outbox').openCursor();
          req.onsuccess = () => {
            const c = req.result;
            if (!c) return;
            const rec = c.value;
            if (rec && typeof rec.k === 'string' && rec.k.startsWith(prefix)
              && rec.v && rec.v.roomId === roomId) c.delete();
            c.continue();
          };
          await txDone(tx);
          return;
        } catch { mode = 'fallback'; }
      }
      try {
        const lsPrefix = `miyu.ob.${account}.`;
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (!k || !k.startsWith(lsPrefix)) continue;
          let v = null;
          try { v = JSON.parse(localStorage.getItem(k)); } catch { v = null; }
          if (v && v.roomId === roomId) localStorage.removeItem(k);
        }
      } catch { /* 忽略 */ }
    },

    /* 只判断 blob 是否存在，不把文件内容读进内存 */
    async hasBlob(id) {
      if (!id) return false;
      if (memBlobs.has(`${account}:${id}`)) return true;
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction('blobs', 'readonly');
          const found = await new Promise((resolve) => {
            const req = tx.objectStore('blobs').getKey(`${account}:${id}`);
            req.onsuccess = () => resolve(req.result != null);
            req.onerror = () => resolve(false);
          });
          if (found) return true;
        } catch { mode = 'fallback'; }
      }
      try { return localStorage.getItem(fallbackBlobKey(id)) != null; } catch { return false; }
    },

    async clearAccount() {
      memBlobs.clear();
      if (mode !== 'fallback') {
        try {
          const db = await openDB();
          const tx = db.transaction(['events', 'blobs', 'kv', 'outbox'], 'readwrite');
          for (const name of ['events', 'blobs', 'kv', 'outbox']) {
            const store = tx.objectStore(name);
            const req = store.openCursor();
            req.onsuccess = () => {
              const c = req.result;
              if (c) {
                if (String(c.value.k).startsWith(`${account}:`)) c.delete();
                c.continue();
              }
            };
          }
          await txDone(tx);
        } catch { mode = 'fallback'; }
      }
      try {
        const prefixes = [`miyu.ev.${account}.`, `miyu.bl.${account}.`, `miyu.kv.${account}.`, `miyu.ob.${account}.`];
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && prefixes.some((p) => k.startsWith(p))) localStorage.removeItem(k);
        }
      } catch { /* 忽略 */ }
    },
  };

  MY.store = Store;
})(window.MY = window.MY || {});
