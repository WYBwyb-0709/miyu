/* ══════════════════════════════════════════════════════════
   files.js · 分片文件传输（加密、校验、补发）
   ══════════════════════════════════════════════════════════ */
(function (MY) {
  'use strict';

  const U = MY.util;
  const S = MY.state;
  const C = MY.const;
  const P = MY.people;
  const V = MiyuVendor;
  const CHUNK = C.CHUNK_BINARY;
  const sentCache = new Map();
  const rxBuffers = new Map();
  const rxTimers = new Map();

  function cacheKey(roomId, mid) { return `${roomId}:${mid}`; }
  function rxKey(roomId, mid) { return `${S.pub}:${roomId}:${mid}`; }

  function isTextLike(file) {
    const mime = String(file.type || '').toLowerCase();
    if (mime.startsWith('text/')) return true;
    if (['application/json', 'application/xml', 'application/javascript', 'application/x-yaml',
      'application/toml', 'application/sql', 'application/x-sh', 'image/svg+xml'].includes(mime)) return true;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const textExts = new Set(['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
      'csv', 'tsv', 'html', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt',
      'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'php', 'lua', 'sh', 'bash', 'zsh', 'bat', 'ps1', 'sql', 'vue',
      'svelte', 'tex', 'svg', 'rst']);
    return textExts.has(ext);
  }

  async function prepare(file, room) {
    let bytes = new Uint8Array(await file.arrayBuffer());
    let compressed = false;
    let engine = 'none';

    if (isTextLike(file) && bytes.length > 512) {
      try {
        const z = V.deflateSync(bytes, { level: 6 });
        if (z.length < bytes.length * 0.92) {
          bytes = new Uint8Array(z);
          compressed = true;
          engine = 'deflate';
        }
      } catch { /* 忽略 */ }
    }

    const hash = await U.sha256Hex(bytes);
    let encrypted = false;
    if (room.key) {
      bytes = await MY.crypto.encryptBytes(room.key, bytes);
      encrypted = true;
    } else if (room.convKey) {
      const aes = await MY.crypto.deriveDmAesKey(room.convKey);
      bytes = await MY.crypto.encryptBytes(aes, bytes);
      encrypted = true;
    }
    return { bytes, compressed, encrypted, engine, hash };
  }

  async function restore(transmitted, room, meta) {
    let bytes = transmitted;
    if (meta.enc) {
      if (room.key) bytes = await MY.crypto.decryptBytes(room.key, bytes);
      else if (room.convKey) {
        const aes = await MY.crypto.deriveDmAesKey(room.convKey);
        bytes = await MY.crypto.decryptBytes(aes, bytes);
      } else throw new Error('missing key');
    }
    if (meta.engine === 'deflate') bytes = new Uint8Array(V.inflateSync(bytes));
    return bytes;
  }

  function buildChunkEvent(room, json, index) {
    const name = S.name || 'anonymous';
    const tags = [['name', name]];
    if (index === 0 && S.settings.shareAvatar && S.profile.avatar) tags.push(['avatar', S.profile.avatar]);
    if (room.type === 'dm') {
      return MY.chat.wrapDM(room.peerPub, {
        kind: 1,
        content: json,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      });
    }
    const content = room.key ? MY.crypto.encryptText(room.key, json) : Promise.resolve(json);
    return content.then((c) => {
      const ev = V.finalizeEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', room.id], ...tags],
        content: c,
      }, S.sk);
      return ev;
    });
  }

  async function send(file) {
    const room = S.activeRoomId ? MY.people.roomById(S.activeRoomId) : null;
    if (!room) return;
    if (room.type === 'group' && room.encrypted && !room.key) {
      MY.ui.toast('请先输入房间密码解锁');
      return;
    }
    if (file.size > C.MAX_FILE) {
      MY.ui.toast(`文件 ${U.formatBytes(file.size)} 超过 ${U.formatBytes(C.MAX_FILE)} 上限`);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      MY.ui.toast(`正在发送 ${U.formatBytes(file.size)} 文件，请保持应用打开`);
    }

    const mid = U.uuid();
    const createdAt = Math.floor(Date.now() / 1000);
    const meta = await prepare(file, room);
    const total = Math.max(1, Math.ceil(meta.bytes.length / CHUNK));
    const name = file.name || 'file';

    const localItem = {
      ev: { id: 'local-' + mid, kind: 1, pubkey: S.pub, created_at: createdAt, content: '', tags: [] },
      text: null,
      failed: false,
      senderName: S.name,
      fileMeta: {
        mid, name, mime: file.type || 'application/octet-stream', size: file.size,
        engine: meta.engine, enc: meta.encrypted, hash: meta.hash, total, chunkIds: [],
      },
      fileProgress: 0,
      transferState: 'sending',
      status: 'pending',
      displayPubkey: S.pub,
      recalled: false,
    };
    room.events.push(localItem);
    room.seen.add(localItem.ev.id);
    room.lastActivity = createdAt;
    room.lastPreview = '[文件] ' + name;
    MY.ui.trackBlobUrl(room, localItem, file);
    MY.ui.scheduleRender();
    MY.ui.scheduleRoomList();
    MY.store.saveEvent(room.id, localItem).catch(() => {});

    const events = new Array(total);
    const missing = new Set();
    let done = 0;

    const jobs = [];
    for (let i = 0; i < total; i++) {
      const slice = meta.bytes.slice(i * CHUNK, (i + 1) * CHUNK);
      const payload = JSON.stringify({
        _miyu_file: 1, mid, i, n: total, name,
        mime: file.type || 'application/octet-stream', size: file.size,
        engine: meta.engine, enc: meta.encrypted, hash: meta.hash,
        data: U.b64encode(slice),
      });
      jobs.push((async (idx, p) => {
        try {
          const ev = await buildChunkEvent(room, p, idx);
          events[idx] = ev;
          room.seen.add(ev.id);
          if (ev.rumorId) room.seen.add(ev.rumorId);
          if (ev.chunkIds) for (const id of ev.chunkIds) room.seen.add(id);
          const ok = await MY.net.publish(ev, 3);
          if (!ok) missing.add(idx);
          done++;
          localItem.fileProgress = done / total;
          if (S.activeRoomId === room.id) MY.ui.updateFileItem(localItem);
        } catch {
          missing.add(idx);
          done++;
          localItem.fileProgress = done / total;
        }
      })(i, payload));
      if (jobs.length >= 3) { await Promise.all(jobs.splice(0)); }
    }
    await Promise.all(jobs);

    localItem.fileMeta.chunkIds = events.filter(Boolean).map((e) => e.rumorId || e.id);
    localItem.ev.created_at = createdAt;

    const firstEvent = events.find(Boolean);
    if (firstEvent) {
      const oldId = localItem.ev.id;
      localItem.ev.id = firstEvent.rumorId || firstEvent.id;
      localItem.ev.pubkey = S.pub;
      if (firstEvent._rumor) localItem.ev.created_at = firstEvent._rumor.created_at;
      localItem.wrapIds = events.filter(Boolean).map((e) => e.id);
      room.seen.delete(oldId);
      room.seen.add(localItem.ev.id);
      await MY.store.removeEvent(room.id, oldId).catch(() => {});
      await MY.store.saveBlob(localItem.ev.id, file).catch(() => {});
    }
    localItem.fileProgress = 1;

    if (missing.size === 0) {
      localItem.status = 'ok';
      localItem.transferState = 'ok';
      localItem.failed = false;
    } else {
      localItem.status = 'fail';
      localItem.transferState = 'fail';
      localItem.fileError = 'send';
      MY.ui.toast(`${missing.size} 个分片未送达，可稍后重试`);
    }

    const cache = { roomId: room.id, mid, total, events, missing, file, createdAt: Date.now() };
    sentCache.set(cacheKey(room.id, mid), cache);
    if (total <= 800) {
      MY.store.outboxSet(`sent:${mid}`, {
        roomId: room.id, mid, total, events,
        createdAt: Date.now(),
      }).catch(() => {});
    }

    MY.ui.scheduleRender();
    MY.store.saveEvent(room.id, localItem).catch(() => {});
  }

  async function retry(mid) {
    const room = S.activeRoomId ? MY.people.roomById(S.activeRoomId) : null;
    if (!room) return;
    const item = room.events.find((e) => e.fileMeta && e.fileMeta.mid === mid);
    let cache = sentCache.get(cacheKey(room.id, mid));
    if (!cache) {
      const saved = await MY.store.outboxGet(`sent:${mid}`);
      if (saved && saved.events) {
        cache = {
          roomId: saved.roomId, mid: saved.mid, total: saved.total,
          events: saved.events, missing: new Set(saved.events.map((_, i) => i).filter((i) => !saved.events[i])),
          createdAt: saved.createdAt,
        };
      }
    }
    if (!item || !cache) {
      MY.ui.toast('重试缓存已过期，请重新发送文件');
      return;
    }
    if (!cache.missing || !cache.missing.size) {
      cache.missing = new Set();
      for (let i = 0; i < cache.total; i++) if (!cache.events[i]) cache.missing.add(i);
    }
    if (!cache.missing.size && item.status !== 'fail') {
      MY.ui.toast('文件已发送');
      return;
    }
    const todo = cache.missing.size ? [...cache.missing] : cache.events.map((_, i) => i);
    item.status = 'pending';
    item.transferState = 'sending';
    item.failed = false;
    let n = 0;
    for (const idx of todo) {
      if (!cache.events[idx]) { n++; continue; }
      const ok = await MY.net.publish(cache.events[idx], 3);
      if (ok) cache.missing.delete(idx);
      n++;
      item.fileProgress = n / todo.length;
      if (S.activeRoomId === room.id) MY.ui.updateFileItem(item);
    }
    item.fileProgress = 1;
    if (cache.missing.size === 0) {
      item.status = 'ok';
      item.transferState = 'ok';
      MY.ui.toast('文件已补发完成');
    } else {
      item.status = 'fail';
      item.transferState = 'fail';
      MY.ui.toast(`仍有 ${cache.missing.size} 个分片未送达`);
    }
    MY.store.saveEvent(room.id, item).catch(() => {});
    MY.ui.scheduleRender();
  }

  function parseFilePayload(text) {
    if (typeof text !== 'string' || !text.startsWith('{"_miyu_file"')) return null;
    try {
      const p = JSON.parse(text);
      if (!p || p._miyu_file !== 1) return null;
      if (typeof p.mid !== 'string' || p.mid.length > 80) return null;
      if (!Number.isInteger(p.i) || !Number.isInteger(p.n) || p.n < 1 || p.n > 8192) return null;
      if (p.i < 0 || p.i >= p.n) return null;
      if (typeof p.data !== 'string') return null;
      if (typeof p.size !== 'number' || p.size < 0 || p.size > C.MAX_FILE) return null;
      return p;
    } catch { return null; }
  }

  function parseNeedPayload(text) {
    if (typeof text !== 'string' || !text.startsWith('{"_miyu_need"')) return null;
    try {
      const p = JSON.parse(text);
      if (!p || p._miyu_need !== 1 || typeof p.mid !== 'string') return null;
      if (!Array.isArray(p.missing) || p.missing.length > 1024) return null;
      p.missing = p.missing.filter((n) => Number.isInteger(n) && n >= 0);
      return p;
    } catch { return null; }
  }

  function armTimeout(room, key) {
    clearTimeout(rxTimers.get(key));
    const buf = rxBuffers.get(key);
    if (!buf) return;
    rxTimers.set(key, setTimeout(() => {
      const b = rxBuffers.get(key);
      if (!b) return;
      if (b.chunks.size >= b.meta.n) return;
      if (b.retries < C.FILE_RX_RETRIES && Date.now() - b.startedAt < C.FILE_RX_MAX_WAIT) {
        b.retries++;
        b.item.transferState = 'waiting';
        b.item.fileProgress = b.chunks.size / b.meta.n;
        MY.ui.updateFileItem(b.item);
        const missing = [];
        for (let i = 0; i < b.meta.n && missing.length < 500; i++) if (!b.chunks.has(i)) missing.push(i);
        MY.chat.sendControl(room, { _miyu_need: 1, mid: b.meta.mid, missing }).catch(() => {});
        armTimeout(room, key);
        return;
      }
      b.item.failed = true;
      b.item.fileError = 'timeout';
      b.item.transferState = 'timeout';
      b.item.fileProgress = b.chunks.size / b.meta.n;
      rxTimers.delete(key);
      rxBuffers.delete(key);
      MY.store.saveEvent(room.id, b.item).catch(() => {});
      MY.ui.scheduleRender();
    }, C.FILE_RX_WAIT));
  }

  async function finish(room, key, buf) {
    clearTimeout(rxTimers.get(key));
    rxTimers.delete(key);
    rxBuffers.delete(key);
    const item = buf.item;
    item.transferState = 'verifying';
    MY.ui.updateFileItem(item);
    try {
      const parts = [];
      let totalLen = 0;
      for (let i = 0; i < buf.meta.n; i++) {
        const part = U.b64decode(buf.chunks.get(i));
        parts.push(part);
        totalLen += part.length;
      }
      const transmitted = new Uint8Array(totalLen);
      let off = 0;
      for (const p of parts) { transmitted.set(p, off); off += p.length; }
      const hash = await U.sha256Hex(transmitted);
      if (buf.meta.hash && hash !== buf.meta.hash) throw new Error('hash mismatch');
      const raw = await restore(transmitted, room, buf.meta);
      const blob = new Blob([raw], { type: buf.meta.mime || 'application/octet-stream' });
      MY.ui.trackBlobUrl(room, item, blob);
      await MY.store.saveBlob(item.ev.id, blob);
      item.fileProgress = 1;
      item.transferState = 'ok';
      item.failed = false;
      item.fileError = null;
      item.status = 'ok';
      item.fileMeta.chunkIds = [...buf.seen];
      room.lastPreview = '[文件] ' + buf.meta.name;
      if (S.activeRoomId === room.id) {
        MY.ui.scheduleRender();
      } else {
        room.unread = (room.unread || 0) + 1;
        MY.ui.scheduleRoomList();
        const sender = item.senderName || P.displayName(item.displayPubkey);
        const title = room.type === 'group' ? `${sender} · ${room.label}` : sender;
        MY.ui.alertMessage(room, title, '[文件] ' + buf.meta.name);
      }
      MY.store.saveEvent(room.id, item).catch(() => {});
    } catch {
      item.failed = true;
      item.fileError = 'corrupt';
      item.fileProgress = 1;
      item.transferState = 'fail';
      item.status = undefined;
      MY.store.saveEvent(room.id, item).catch(() => {});
      MY.ui.scheduleRender();
    }
  }

  function ingest(room, payload, ev) {
    if (room.hiddenFiles && room.hiddenFiles.has(payload.mid)) return;
    if (room.recalledFiles && room.recalledFiles.has(payload.mid)) return;
    const key = rxKey(room.id, payload.mid);
    const existing = room.events.find((x) => x.fileMeta && x.fileMeta.mid === payload.mid);
    const already = existing && existing.fileProgress === 1 && !existing.failed;
    if (already && !rxBuffers.has(key)) return;

    if (!rxBuffers.has(key)) {
      let item = existing;
      if (!item) {
        item = {
          ev: { id: ev.id, kind: 1, pubkey: ev.pubkey, created_at: ev.created_at, content: '', tags: ev.tags || [] },
          text: null, failed: false,
          senderName: (ev.tags || []).find((t) => t[0] === 'name')?.[1] || P.displayName(ev.pubkey),
          fileMeta: {
            mid: payload.mid, name: payload.name || 'file', mime: payload.mime || 'application/octet-stream',
            size: payload.size, engine: payload.engine || 'none', enc: !!payload.enc,
            hash: payload.hash || '', total: payload.n, chunkIds: [],
          },
          fileProgress: 0,
          transferState: 'receiving',
          status: undefined,
          displayPubkey: ev.pubkey,
          recalled: false,
        };
        room.events.push(item);
      } else {
        item.failed = false;
        item.fileError = null;
        item.fileProgress = 0;
        item.transferState = 'receiving';
        item.status = undefined;
        item.recalled = false;
        if (item.fileMeta) {
          item.fileMeta.total = payload.n;
          item.fileMeta.name = payload.name || item.fileMeta.name;
          item.fileMeta.mime = payload.mime || item.fileMeta.mime;
          item.fileMeta.engine = payload.engine || item.fileMeta.engine;
          item.fileMeta.enc = !!payload.enc;
          item.fileMeta.hash = payload.hash || item.fileMeta.hash;
          item.fileMeta.chunkIds = [];
        }
      }
      room.lastActivity = Math.max(room.lastActivity || 0, ev.created_at);
      room.lastPreview = '[文件] ' + (item.fileMeta ? item.fileMeta.name : '');
      rxBuffers.set(key, {
        meta: { ...payload, mid: payload.mid },
        chunks: new Map(),
        seen: new Set(),
        item,
        startedAt: Date.now(),
        retries: 0,
      });
      MY.ui.scheduleRender();
      MY.ui.scheduleRoomList();
    }

    const buf = rxBuffers.get(key);
    if (!buf || buf.chunks.has(payload.i)) return;
    buf.seen.add(ev.id);
    if (ev.rumorId) buf.seen.add(ev.rumorId);
    buf.chunks.set(payload.i, payload.data);
    buf.item.fileProgress = buf.chunks.size / buf.meta.n;
    buf.item.transferState = 'receiving';
    buf.item.failed = false;
    buf.item.fileError = null;
    buf.item.fileMeta.chunkIds = [...buf.seen];
    MY.ui.updateFileItem(buf.item);
    armTimeout(room, key);

    if (buf.chunks.size === buf.meta.n) finish(room, key, buf).catch(() => {});
  }

  /* 房间被清空/删除/退出时，丢弃该房间的发送缓存与接收缓冲 */
  function forgetRoom(roomId) {
    if (!roomId) return;
    for (const key of [...sentCache.keys()]) {
      if (key.startsWith(`${roomId}:`)) sentCache.delete(key);
    }
    for (const key of [...rxBuffers.keys()]) {
      const a = key.indexOf(':');
      const b = key.lastIndexOf(':');
      if (a >= 0 && b > a && key.slice(a + 1, b) === roomId) {
        clearTimeout(rxTimers.get(key));
        rxTimers.delete(key);
        rxBuffers.delete(key);
      }
    }
  }

  async function handleNeed(room, payload) {
    let cache = sentCache.get(cacheKey(room.id, payload.mid));
    if (!cache) {
      const saved = await MY.store.outboxGet(`sent:${payload.mid}`);
      if (saved) cache = { ...saved, missing: new Set() };
    }
    if (!cache || !Array.isArray(cache.events)) return;
    const todo = payload.missing.filter((i) => i >= 0 && i < cache.events.length && cache.events[i]).slice(0, 200);
    for (const idx of todo) {
      await MY.net.publish(cache.events[idx], 2);
    }
  }

  MY.files = {
    send, retry, ingest, handleNeed, parseFilePayload, parseNeedPayload, restore, forgetRoom,
  };
})(window.MY = window.MY || {});
