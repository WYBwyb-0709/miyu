/* ══════════════════════════════════════════════════════════
   chat.js · 房间、私聊、协议与消息生命周期
   ══════════════════════════════════════════════════════════ */
(function (MY) {
  'use strict';

  const U = MY.util;
  const S = MY.state;
  const P = MY.people;
  const C = MY.const;
  const V = MiyuVendor;
  const $ = U.$;

  const MAX_ROOM_EVENTS = 3000;
  const MAX_HIDDEN = 3000;
  const MAX_RECALLS = 4000;
  const DM_BACKFILL_LIMIT = 600;
  const GROUP_BACKFILL_LIMIT = 800;
  const BACKFILL_COOLDOWN = 90 * 1000;

  let groupSub = null;
  let dmSub = null;
  let subTimer = null;
  let saveTimer = null;
  let unlockResolve = null;
  let unlockTarget = null;
  let lastDmBackfillAt = 0;
  let dmBackfilling = false;
  let dmWrapSeen = new Set();
  let loadingPromise = null;

  /* ── 小工具 ── */

  function nowSec() { return Math.floor(Date.now() / 1000); }

  function isHexPub(s) { return /^[0-9a-f]{64}$/i.test(String(s || '')); }

  function activeRoom() { return P.roomById(S.activeRoomId); }

  function makeRoom(raw) {
    const room = {
      id: raw.id,
      type: raw.type === 'dm' ? 'dm' : 'group',
      label: String(raw.label || '未命名').slice(0, 64),
      encrypted: !!raw.encrypted,
      key: null,
      rawKey: null,
      wrappedKey: raw.wrappedKey || null,
      verifier: raw.verifier || null,
      peerPub: raw.peerPub || null,
      peerName: raw.peerName || null,
      convKey: null,
      events: [],
      seen: new Set(),
      members: new Map(),
      pendingRecalls: new Map(),
      hidden: new Set(),
      hiddenFiles: new Set(),
      recalledFiles: new Set(),
      blobUrls: new Set(),
      lastActivity: Number(raw.lastActivity) || 0,
      lastPreview: String(raw.lastPreview || ''),
      unread: Number(raw.unread) || 0,
      pinned: !!raw.pinned,
      muted: !!raw.muted,
      joinedAt: Number(raw.joinedAt) || Date.now(),
      backfilledAt: 0,
      backfilling: false,
      sub: null,
    };
    if (Array.isArray(raw.members)) {
      for (const row of raw.members) {
        if (!Array.isArray(row) || !isHexPub(row[0])) continue;
        room.members.set(row[0], {
          name: String((row[1] && row[1].name) || '').slice(0, 40),
          lastAt: Number(row[1] && row[1].lastAt) || 0,
        });
      }
    }
    return room;
  }

  function ensureSelfMember(room) {
    if (!room || room.type !== 'group' || !S.pub) return;
    const prev = room.members.get(S.pub) || {};
    room.members.set(S.pub, { name: S.name || prev.name || '', lastAt: Math.max(prev.lastAt || 0, nowSec()) });
  }

  function saveRoomsSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { P.saveRooms(); } catch { /* 忽略 */ }
    }, 250);
  }

  function trimEvents(room) {
    if (room.events.length <= MAX_ROOM_EVENTS) return;
    const drop = room.events.splice(0, room.events.length - MAX_ROOM_EVENTS);
    for (const item of drop) {
      if (item.downloadUrl) {
        try { URL.revokeObjectURL(item.downloadUrl); } catch { /* 忽略 */ }
        room.blobUrls.delete(item.downloadUrl);
      }
    }
  }

  function setHidden(room, id) {
    room.hidden.add(id);
    if (room.hidden.size > MAX_HIDDEN) {
      const arr = [...room.hidden];
      room.hidden = new Set(arr.slice(-MAX_HIDDEN));
    }
    MY.store.kvSet(`hidden:${room.id}`, [...room.hidden]).catch(() => {});
  }

  function saveRecallIndex(room) {
    const out = [...room.pendingRecalls.entries()].slice(-MAX_RECALLS);
    MY.store.kvSet(`recalls:${room.id}`, out).catch(() => {});
  }

  function markRecalled(room, item) {
    if (!item || item.recalled) return false;
    item.recalled = true;
    item.failed = false;
    if (item.status === 'pending' || item.status === 'fail') item.status = null;
    if (item.fileMeta && item.fileMeta.mid) room.recalledFiles.add(item.fileMeta.mid);
    MY.store.saveEvent(room.id, item).catch(() => {});
    return true;
  }

  function replyFromTags(tags) {
    if (!Array.isArray(tags)) return null;
    const mine = tags.find((t) => Array.isArray(t) && t[0] === 'miyu-reply');
    if (mine && mine[1]) {
      return {
        id: String(mine[1]),
        name: String(mine[2] || '').slice(0, 40),
        preview: String(mine[3] || '').slice(0, 100),
      };
    }
    const e = tags.find((t) => Array.isArray(t) && t[0] === 'e' && t[1] && (!t[3] || t[3] === 'reply'));
    if (e) return { id: String(e[1]), name: '', preview: '' };
    return null;
  }

  function tagValue(tags, name, max) {
    if (!Array.isArray(tags)) return '';
    const t = tags.find((row) => Array.isArray(row) && row[0] === name);
    if (!t || typeof t[1] !== 'string') return '';
    return t[1].slice(0, max || 80);
  }

  function updateMember(room, pub, name, at) {
    if (!room || room.type !== 'group' || !isHexPub(pub)) return;
    const prev = room.members.get(pub) || { name: '', lastAt: 0 };
    const nextName = (name || prev.name || '').slice(0, 40);
    const nextAt = Math.max(prev.lastAt || 0, Number(at) || 0);
    if (nextName !== prev.name || nextAt !== prev.lastAt) {
      room.members.set(pub, { name: nextName, lastAt: nextAt });
      saveRoomsSoon();
    }
  }

  function previewFor(item) {
    if (!item) return '';
    if (item.recalled) return '撤回了一条消息';
    if (item.fileMeta) return '[文件] ' + (item.fileMeta.name || '');
    if (item.text == null) return '[无法解密的消息]';
    return String(item.text).replace(/\s+/g, ' ').slice(0, 80);
  }

  function sortedForLoad(rows) {
    return rows.slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  }

  /* ── DM 包装 / 解包 ── */

  async function wrapDM(peerPub, inner) {
    if (!S.sk || !S.pub) throw new Error('账户未就绪');
    if (!isHexPub(peerPub)) throw new Error('收件人公钥无效');
    const rumor = {
      pubkey: S.pub,
      created_at: Number(inner && inner.created_at) || nowSec(),
      kind: Number(inner && inner.kind) || 1,
      tags: Array.isArray(inner && inner.tags) ? inner.tags : [],
      content: String((inner && inner.content) != null ? inner.content : ''),
    };
    rumor.id = V.getEventHash(rumor);

    const sealKey = V.nip44.getConversationKey(S.sk, peerPub);
    const seal = V.finalizeEvent({
      kind: 13,
      created_at: nowSec() - Math.floor(Math.random() * 900),
      tags: [],
      content: V.nip44.encrypt(JSON.stringify(rumor), sealKey),
    }, S.sk);

    const ephemeral = V.generateSecretKey();
    const wrapKey = V.nip44.getConversationKey(ephemeral, peerPub);
    const wrap = V.finalizeEvent({
      kind: 1059,
      created_at: nowSec() - Math.floor(Math.random() * 1800),
      tags: [['p', peerPub]],
      content: V.nip44.encrypt(JSON.stringify(seal), wrapKey),
    }, ephemeral);

    Object.defineProperty(wrap, 'rumorId', { value: rumor.id, enumerable: false, configurable: true });
    Object.defineProperty(wrap, '_rumor', { value: rumor, enumerable: false, configurable: true });
    return wrap;
  }

  async function unwrapDM(wrap) {
    if (!S.sk) throw new Error('账户未就绪');
    if (!wrap || wrap.kind !== 1059 || typeof wrap.content !== 'string') throw new Error('不是私聊包装');
    const key1 = V.nip44.getConversationKey(S.sk, wrap.pubkey);
    const seal = JSON.parse(V.nip44.decrypt(wrap.content, key1));
    if (!seal || seal.kind !== 13 || !V.verifyEvent(seal)) throw new Error('密封事件无效');
    const key2 = V.nip44.getConversationKey(S.sk, seal.pubkey);
    const rumor = JSON.parse(V.nip44.decrypt(seal.content, key2));
    if (!rumor || typeof rumor !== 'object') throw new Error('私聊内容无效');
    if (rumor.pubkey !== seal.pubkey || !isHexPub(rumor.pubkey)) throw new Error('发送者签名不一致');
    if (!Number.isFinite(rumor.created_at) || rumor.created_at < 0) throw new Error('时间戳无效');
    if (!Array.isArray(rumor.tags)) rumor.tags = [];
    if (typeof rumor.content !== 'string') rumor.content = '';
    if (rumor.content.length > 700000) throw new Error('私聊内容过大');
    const clean = {
      kind: Number(rumor.kind) || 1,
      pubkey: rumor.pubkey,
      created_at: Math.floor(rumor.created_at),
      tags: rumor.tags,
      content: rumor.content,
    };
    clean.id = V.getEventHash(clean);
    return clean;
  }

  function dmConvKey(peerPub) {
    if (!S.sk || !isHexPub(peerPub)) return null;
    try { return V.nip44.getConversationKey(S.sk, peerPub); } catch { return null; }
  }

  /* ── 房间加载 ── */

  async function loadRooms() {
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      const raws = P.loadRoomsRaw();
      for (const raw of raws) {
        if (!raw || typeof raw !== 'object') continue;
        if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 100) continue;
        if (!/^[a-z0-9._:-]+$/i.test(raw.id)) continue;
        if (raw.type === 'dm' && !isHexPub(raw.peerPub)) continue;
        let room = makeRoom(raw);
        S.rooms.set(room.id, room);
        if (room.type === 'dm') room.convKey = dmConvKey(room.peerPub);
        if (room.encrypted && room.wrappedKey && S.sk) {
          try {
            const rawKey = await MY.crypto.unwrapRoomKey(room.wrappedKey, S.sk);
            room.rawKey = rawKey;
            room.key = await MY.crypto.importAes(rawKey);
          } catch { room.key = null; }
        }
        ensureSelfMember(room);
        await loadRoomState(room);
      }
    })().finally(() => { loadingPromise = null; });
    return loadingPromise;
  }

  async function loadRoomState(room) {
    const [hidden, hiddenFiles, recallRows, rows] = await Promise.all([
      MY.store.kvGet(`hidden:${room.id}`, []).catch(() => []),
      MY.store.kvGet(`hiddenFiles:${room.id}`, []).catch(() => []),
      MY.store.kvGet(`recalls:${room.id}`, []).catch(() => []),
      MY.store.loadEvents(room.id).catch(() => []),
    ]);
    if (Array.isArray(hidden)) for (const id of hidden) if (typeof id === 'string') room.hidden.add(id);
    if (Array.isArray(hiddenFiles)) for (const mid of hiddenFiles) if (typeof mid === 'string') room.hiddenFiles.add(mid);
    if (Array.isArray(recallRows)) {
      for (const row of recallRows) {
        if (Array.isArray(row) && typeof row[0] === 'string' && isHexPub(row[1])) {
          room.pendingRecalls.set(row[0], row[1]);
        }
      }
    }

    const items = [];
    for (const row of sortedForLoad(rows)) {
      if (!row || typeof row.id !== 'string' || room.hidden.has(row.id)) continue;
      const isFile = !!row.fileMeta;
      const recalled = !!row.recalled || room.pendingRecalls.get(row.id) === row.pubkey;
      const item = {
        ev: {
          id: row.id,
          pubkey: row.pubkey || '',
          kind: 1,
          created_at: Number(row.created_at) || 0,
          tags: [],
          content: '',
        },
        displayPubkey: row.pubkey || '',
        senderName: row.senderName || '',
        text: row.text == null ? null : String(row.text),
        fileMeta: row.fileMeta || null,
        status: row.status || null,
        recalled,
        deleted: !!row.deleted,
        failed: !!row.failed,
        fileError: row.fileError || null,
        replyTo: row.replyTo || null,
        wrapIds: Array.isArray(row.wrapIds) ? row.wrapIds : null,
        fileProgress: 0,
        transferState: isFile ? 'expired' : 'ok',
        downloadUrl: null,
      };
      room.events.push(item);
      room.seen.add(item.ev.id);
      if (item.fileMeta && item.fileMeta.mid && recalled) room.recalledFiles.add(item.fileMeta.mid);
      if (isFile) room.seen.delete(item.ev.id);
    }

    if (!room.lastActivity) {
      const last = room.events.reduce((m, i) => Math.max(m, i.ev.created_at || 0), 0);
      room.lastActivity = last;
    }
    if (!room.lastPreview) {
      const visible = room.events.filter((i) => !i.deleted);
      const last = visible[visible.length - 1];
      if (last) room.lastPreview = previewFor(last);
    }
  }

  /* ── 订阅 ── */

  function scheduleSubscriptions() {
    clearTimeout(subTimer);
    subTimer = setTimeout(() => { refreshSubscriptions(); }, 220);
  }

  function refreshSubscriptions() {
    try { groupSub && groupSub.close(); } catch { /* 忽略 */ }
    try { dmSub && dmSub.close(); } catch { /* 忽略 */ }
    groupSub = null;
    dmSub = null;
    if (!S.ready || !S.pub || !S.sk) return;

    const groupIds = [...S.rooms.values()]
      .filter((r) => r.type === 'group')
      .map((r) => r.id)
      .slice(0, 200);

    if (groupIds.length) {
      groupSub = MY.net.subscribe({
        kinds: [1, 5],
        '#t': groupIds,
        limit: 300,
      }, {
        onevent: (ev) => { handleGroupEvent(ev).catch(() => {}); },
      });
    }

    dmSub = MY.net.subscribe({
      kinds: [1059],
      '#p': [S.pub],
      limit: 300,
    }, {
      onevent: (wrap) => { handleDM(wrap).catch(() => {}); },
    });
  }

  /* ── 群聊事件 ── */

  async function handleGroupEvent(ev, opts) {
    if (!ev || ev.kind !== 1 && ev.kind !== 5) return;
    const tags = Array.isArray(ev.tags) ? ev.tags : [];
    let room = null;
    for (const t of tags) {
      if (Array.isArray(t) && t[0] === 't' && S.rooms.has(t[1])) { room = S.rooms.get(t[1]); break; }
    }
    if (!room) {
      if (ev.kind === 5) {
        for (const t of tags) {
          if (Array.isArray(t) && t[0] === 't' && S.rooms.has(t[1])) { room = S.rooms.get(t[1]); break; }
        }
        if (!room) return;
      } else return;
    }
    if (room.seen.has(ev.id)) return;
    if (ev.kind === 5) {
      if (!V.verifyEvent(ev)) return;
      room.seen.add(ev.id);
      applyDeletion(room, { pubkey: ev.pubkey, tags });
      return;
    }
    if (room.encrypted && !room.key) return;
    if (room.hidden.has(ev.id)) return;

    if (!V.verifyEvent(ev)) return;
    room.seen.add(ev.id);

    const nameTag = tagValue(tags, 'name', 40);
    const avatarTag = tagValue(tags, 'avatar', 40000);
    if (nameTag || avatarTag) P.updateContactFromTags(ev.pubkey, tags);
    updateMember(room, ev.pubkey, nameTag, ev.created_at);

    let content = ev.content;
    let decryptFailed = false;
    if (room.encrypted) {
      try {
        content = await MY.crypto.decryptText(room.key, ev.content);
      } catch {
        content = '';
        decryptFailed = true;
      }
    }

    if (!decryptFailed) {
      const handled = await handleContent(room, ev, content, {
        senderName: nameTag || P.displayName(ev.pubkey),
        displayPubkey: ev.pubkey,
        wrapIds: null,
        silent: !!(opts && opts.silent),
      });
      if (handled) return;
    }

    addTextItem(room, ev, {
      text: decryptFailed ? null : content,
      failed: decryptFailed,
      senderName: nameTag || P.displayName(ev.pubkey),
      displayPubkey: ev.pubkey,
      wrapIds: null,
      silent: !!(opts && opts.silent),
    });
  }

  async function handleDM(wrap, opts) {
    if (!wrap || wrap.kind !== 1059) return;
    if (!V.verifyEvent(wrap)) return;
    if (dmWrapSeen.has(wrap.id)) return;
    dmWrapSeen.add(wrap.id);
    if (dmWrapSeen.size > 4000) dmWrapSeen = new Set([...dmWrapSeen].slice(-2000));

    let rumor;
    try { rumor = await unwrapDM(wrap); } catch { return; }
    if (!rumor || !isHexPub(rumor.pubkey)) return;
    if (rumor.pubkey === S.pub) return;

    const room = ensureDMRoom(rumor.pubkey);
    if (room.seen.has(rumor.id)) return;
    if (room.hidden.has(rumor.id)) return;
    room.seen.add(rumor.id);

    const nameTag = tagValue(rumor.tags, 'name', 40);
    const avatarTag = tagValue(rumor.tags, 'avatar', 40000);
    if (nameTag || avatarTag) P.updateContactFromTags(room.peerPub, rumor.tags);
    if (nameTag) {
      room.peerName = nameTag;
      const contact = P.contactFor(room.peerPub);
      if (!contact || !contact.name) {
        room.label = nameTag;
        saveRoomsSoon();
        MY.ui.scheduleRoomList();
      }
    }

    if (rumor.kind === 5) {
      applyDeletion(room, { pubkey: rumor.pubkey, tags: rumor.tags });
      return;
    }
    if (rumor.kind !== 1) return;

    const handled = await handleContent(room, rumor, rumor.content, {
      senderName: nameTag || (room.peerName || P.displayName(room.peerPub)),
      displayPubkey: room.peerPub,
      wrapIds: [wrap.id],
      silent: !!(opts && opts.silent),
    });
    if (handled) return;

    addTextItem(room, rumor, {
      text: rumor.content,
      failed: false,
      senderName: nameTag || (room.peerName || P.displayName(room.peerPub)),
      displayPubkey: room.peerPub,
      wrapIds: [wrap.id],
      silent: !!(opts && opts.silent),
    });
  }

  /* ── 内容分派 ── */

  async function handleContent(room, ev, text, meta) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || trimmed.length < 8) return false;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { return false; }
    if (!obj || typeof obj !== 'object') return false;

    if (obj._miyu_file === 1) {
      const payload = MY.files.parseFilePayload(trimmed);
      if (!payload) return true;
      if (room.hiddenFiles.has(payload.mid) || room.recalledFiles.has(payload.mid)) return true;
      if (room.hidden.has(ev.id)) return true;
      if (room.pendingRecalls.get(ev.id) === meta.displayPubkey) {
        room.recalledFiles.add(payload.mid);
        return true;
      }
      try { MY.files.ingest(room, payload, ev); } catch { /* 忽略 */ }
      return true;
    }

    if (obj._miyu_need === 1) {
      const payload = MY.files.parseNeedPayload(trimmed);
      if (payload) MY.files.handleNeed(room, payload).catch(() => {});
      return true;
    }

    if (obj._miyu_join === 1) {
      if (room.type === 'group' && isHexPub(meta.displayPubkey)) {
        updateMember(room, meta.displayPubkey, String(obj.name || meta.senderName || '').slice(0, 40), ev.created_at);
      }
      return true;
    }

    if (obj._miyu_here === 1) {
      if (room.type === 'group' && isHexPub(meta.displayPubkey)) {
        updateMember(room, meta.displayPubkey, String(obj.name || meta.senderName || '').slice(0, 40), ev.created_at);
      }
      return true;
    }

    if (obj._miyu_typing === 1) return true;
    return false;
  }

  function addTextItem(room, ev, info) {
    const replyTo = replyFromTags(ev.tags);
    const recalled = room.pendingRecalls.get(ev.id) === info.displayPubkey;
    const item = {
      ev,
      displayPubkey: info.displayPubkey,
      senderName: info.senderName || P.displayName(info.displayPubkey),
      text: info.text == null ? null : String(info.text),
      fileMeta: null,
      status: 'ok',
      recalled,
      deleted: false,
      failed: !!info.failed,
      fileError: null,
      replyTo,
      wrapIds: info.wrapIds || null,
      downloadUrl: null,
    };
    room.events.push(item);
    trimEvents(room);
    room.lastActivity = Math.max(room.lastActivity || 0, ev.created_at || 0);
    room.lastPreview = previewFor(item);
    if (!info.silent && S.activeRoomId !== room.id) room.unread = (room.unread || 0) + 1;
    if (!info.silent && document.hidden && S.activeRoomId === room.id) room.unread = (room.unread || 0) + 1;
    MY.store.saveEvent(room.id, item).catch(() => {});
    saveRoomsSoon();
    MY.ui.scheduleRoomList();
    if (S.activeRoomId === room.id) MY.ui.scheduleRender();

    if (!info.silent && !recalled && info.displayPubkey !== S.pub && !room.muted) {
      const title = room.type === 'group'
        ? `${info.senderName || P.displayName(info.displayPubkey)} · ${room.label}`
        : (info.senderName || room.label);
      MY.ui.alertMessage(room, title, previewFor(item).slice(0, 120));
    }
  }

  function applyDeletion(room, ev) {
    const tags = Array.isArray(ev.tags) ? ev.tags : [];
    const author = ev.pubkey;
    const targets = [];
    for (const t of tags) {
      if (Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string') targets.push(t[1]);
    }
    if (!targets.length) return;
    let changed = false;
    for (const id of targets) {
      room.pendingRecalls.set(id, author);
      for (const item of room.events) {
        const ids = item.fileMeta && Array.isArray(item.fileMeta.chunkIds) && item.fileMeta.chunkIds.length
          ? item.fileMeta.chunkIds
          : [item.ev.id];
        if (!ids.includes(id)) continue;
        if ((item.displayPubkey || item.ev.pubkey) !== author) continue;
        if (markRecalled(room, item)) changed = true;
      }
    }
    saveRecallIndex(room);
    if (changed) {
      saveRoomsSoon();
      if (S.activeRoomId === room.id) MY.ui.scheduleRender();
      MY.ui.scheduleRoomList();
    }
  }

  function ensureDMRoom(peerPub, name) {
    const existing = [...S.rooms.values()].find((r) => r.type === 'dm' && r.peerPub === peerPub);
    if (existing) {
      if (name && (!existing.peerName || existing.label === `私聊 ${peerPub.slice(0, 6)}`)) {
        existing.peerName = name;
        existing.label = name;
      }
      if (!existing.convKey) existing.convKey = dmConvKey(peerPub);
      return existing;
    }
    const contact = P.contactFor(peerPub);
    const display = (name || (contact && contact.name) || '').slice(0, 40) || `私聊 ${peerPub.slice(0, 6)}`;
    const room = makeRoom({
      id: `dm-${peerPub.slice(0, 24)}`,
      type: 'dm',
      label: display,
      peerPub,
      peerName: display,
      joinedAt: Date.now(),
    });
    room.convKey = dmConvKey(peerPub);
    S.rooms.set(room.id, room);
    P.saveRooms();
    MY.ui.scheduleRoomList();
    scheduleSubscriptions();
    return room;
  }

  /* ── 历史补齐 ── */

  async function backfillRoom(room, force) {
    if (!room || room.type !== 'group') return;
    if (!room.key && room.encrypted) return;
    if (room.backfilling) return;
    if (!force && Date.now() - (room.backfilledAt || 0) < BACKFILL_COOLDOWN) return;
    room.backfilling = true;
    room.backfilledAt = Date.now();
    try {
      const events = await MY.net.query({
        kinds: [1, 5],
        '#t': [room.id],
        limit: GROUP_BACKFILL_LIMIT,
      }, 6500);
      const sorted = sortedForLoad(events.filter(Boolean));
      for (const ev of sorted) await handleGroupEvent(ev, { silent: true });
    } catch { /* 离线时忽略 */ }
    finally {
      room.backfilling = false;
      MY.ui.scheduleRender();
      MY.ui.scheduleRoomList();
    }
  }

  async function backfillDMs(force) {
    if (dmBackfilling || !S.sk) return;
    if (!force && Date.now() - lastDmBackfillAt < BACKFILL_COOLDOWN) return;
    dmBackfilling = true;
    lastDmBackfillAt = Date.now();
    try {
      const wraps = await MY.net.query({
        kinds: [1059],
        '#p': [S.pub],
        limit: DM_BACKFILL_LIMIT,
      }, 7000);
      const sorted = wraps.filter(Boolean).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      for (const wrap of sorted) await handleDM(wrap, { silent: true });
    } catch { /* 离线时忽略 */ }
    finally {
      dmBackfilling = false;
      MY.ui.scheduleRoomList();
      if (S.activeRoomId) MY.ui.scheduleRender();
    }
  }

  /* ── 发送 ── */

  async function sendText(text) {
    const room = activeRoom();
    if (!room) { MY.ui.toast('请先选择一个会话'); return false; }
    if (room.encrypted && !room.key) { MY.ui.toast('请先输入房间密码解锁'); return false; }
    const clean = String(text == null ? '' : text);
    if (!clean.trim()) return false;
    if (clean.length > C.MAX_TEXT) { MY.ui.toast(`消息不能超过 ${C.MAX_TEXT} 个字符`); return false; }

    const reply = S.replyTo && S.replyTo.id ? {
      id: S.replyTo.id,
      name: String(S.replyTo.name || '').slice(0, 40),
      preview: String(S.replyTo.preview || '').slice(0, 100),
    } : null;
    const createdAt = nowSec();
    const tags = [['name', (S.name || 'anonymous').slice(0, 40)]];
    if (S.settings.shareAvatar && S.profile.avatar) tags.push(['avatar', S.profile.avatar]);
    if (reply) {
      tags.push(['e', reply.id, '', 'reply']);
      tags.push(['miyu-reply', reply.id, reply.name, reply.preview]);
    }

    let ev;
    let publishEv;
    let wrapIds = null;
    try {
      if (room.type === 'dm') {
        const wrap = await wrapDM(room.peerPub, { kind: 1, content: clean, tags, created_at: createdAt });
        ev = wrap._rumor;
        publishEv = wrap;
        wrapIds = [wrap.id];
      } else {
        const content = room.key ? await MY.crypto.encryptText(room.key, clean) : clean;
        ev = V.finalizeEvent({
          kind: 1,
          created_at: createdAt,
          tags: [['t', room.id], ...tags],
          content,
        }, S.sk);
        publishEv = ev;
      }
    } catch (e) {
      MY.ui.toast('发送失败：' + (e && e.message ? e.message : '加密错误'));
      return false;
    }

    const item = {
      ev,
      displayPubkey: S.pub,
      senderName: S.name || '',
      text: clean,
      fileMeta: null,
      status: 'pending',
      recalled: false,
      deleted: false,
      failed: false,
      fileError: null,
      replyTo: reply,
      wrapIds,
      downloadUrl: null,
    };
    room.events.push(item);
    trimEvents(room);
    room.seen.add(ev.id);
    room.lastActivity = createdAt;
    room.lastPreview = clean.replace(/\s+/g, ' ').slice(0, 80);
    ensureSelfMember(room);
    S.replyTo = null;
    MY.ui.setReplyBar(null);
    MY.ui.scheduleRender();
    MY.ui.scheduleRoomList();
    saveRoomsSoon();
    MY.store.saveEvent(room.id, item).catch(() => {});

    MY.net.publish(publishEv, 3).then((ok) => {
      item.status = ok ? 'ok' : 'fail';
      MY.store.saveEvent(room.id, item).catch(() => {});
      if (S.activeRoomId === room.id) MY.ui.scheduleRender();
      if (!ok) MY.ui.toast('网络不可用，消息发送失败');
    }).catch(() => {
      item.status = 'fail';
      MY.store.saveEvent(room.id, item).catch(() => {});
      if (S.activeRoomId === room.id) MY.ui.scheduleRender();
    });
    return true;
  }

  async function sendControl(room, obj) {
    if (!room || !S.sk) return false;
    if (room.encrypted && !room.key) return false;
    const json = JSON.stringify(obj);
    const tags = [['name', (S.name || 'anonymous').slice(0, 40)]];
    try {
      if (room.type === 'dm') {
        const wrap = await wrapDM(room.peerPub, { kind: 1, content: json, tags, created_at: nowSec() });
        return await MY.net.publish(wrap, 2);
      }
      const content = room.key ? await MY.crypto.encryptText(room.key, json) : json;
      const ev = V.finalizeEvent({
        kind: 1,
        created_at: nowSec(),
        tags: [['t', room.id], ...tags],
        content,
      }, S.sk);
      room.seen.add(ev.id);
      return await MY.net.publish(ev, 2);
    } catch { return false; }
  }

  /* ── 删除 / 撤回 ── */

  function canRecall(item) {
    if (!item || item.recalled || item.deleted || item.failed) return false;
    if (item.status === 'pending') return false;
    if ((item.displayPubkey || item.ev.pubkey) !== S.pub) return false;
    if (String(item.ev.id).startsWith('local-')) return false;
    const at = Number(item.ev.created_at) * 1000;
    return Number.isFinite(at) && Date.now() - at < C.RECALL_WINDOW;
  }

  async function recall(item) {
    const room = activeRoom();
    if (!room || !canRecall(item)) { MY.ui.toast('这条消息已超过 2 分钟，不能再撤回'); return; }
    const targets = item.fileMeta && Array.isArray(item.fileMeta.chunkIds) && item.fileMeta.chunkIds.length
      ? item.fileMeta.chunkIds.filter(Boolean).slice(0, 200)
      : [item.ev.id];
    if (!targets.length) { MY.ui.toast('没有可撤回的消息'); return; }

    markRecalled(room, item);
    if (S.activeRoomId === room.id) MY.ui.scheduleRender();
    MY.ui.scheduleRoomList();
    saveRoomsSoon();

    try {
      let publishEv;
      const tags = targets.map((id) => ['e', id]);
      if (room.type === 'dm') {
        publishEv = await wrapDM(room.peerPub, {
          kind: 5,
          content: 'recall',
          tags,
          created_at: nowSec(),
        });
      } else {
        tags.push(['t', room.id], ['name', (S.name || '').slice(0, 40)]);
        publishEv = V.finalizeEvent({ kind: 5, created_at: nowSec(), tags, content: 'recall' }, S.sk);
      }
      const ok = await MY.net.publish(publishEv, 3);
      MY.ui.toast(ok ? '已撤回' : '撤回请求未送达，请检查网络');
    } catch {
      MY.ui.toast('撤回失败');
    }
  }

  async function deleteForMe(item) {
    const room = activeRoom();
    if (!room || !item) return;
    if (item.downloadUrl) {
      try { URL.revokeObjectURL(item.downloadUrl); } catch { /* 忽略 */ }
      room.blobUrls.delete(item.downloadUrl);
    }
    room.events = room.events.filter((x) => x !== item);
    setHidden(room, item.ev.id);
    if (item.fileMeta && item.fileMeta.mid) {
      room.hiddenFiles.add(item.fileMeta.mid);
      MY.store.kvSet(`hiddenFiles:${room.id}`, [...room.hiddenFiles]).catch(() => {});
      if (Array.isArray(item.fileMeta.chunkIds)) {
        for (const id of item.fileMeta.chunkIds) if (id) setHidden(room, id);
      }
    }
    await MY.store.removeEvent(room.id, item.ev.id).catch(() => {});
    await MY.store.deleteBlob(item.ev.id).catch(() => {});
    MY.ui.invalidateRender();
    MY.ui.scheduleRender();
    MY.ui.scheduleRoomList();
    MY.ui.toast('已从本机删除');
  }

  /* ── 房间操作 ── */

  function isLocked(room) {
    return !!(room && room.type === 'group' && room.encrypted && !room.key);
  }

  async function switchRoom(id) {
    const room = S.rooms.get(id);
    if (!room) return false;
    if (S.activeRoomId === id) {
      document.getElementById('sidebar') && document.getElementById('sidebar').classList.remove('mobile-open');
      document.getElementById('sidebarBackdrop') && document.getElementById('sidebarBackdrop').classList.remove('show');
      return true;
    }
    S.activeRoomId = id;
    room.unread = 0;
    S.replyTo = null;
    S.searchOpen = false;
    S.msgSearch = '';
    const bar = $('searchBar');
    if (bar) bar.classList.add('hidden');
    const input = $('msgSearchInput');
    if (input) input.value = '';
    MY.ui.setReplyBar(null);
    MY.ui.invalidateRender();
    MY.ui.scheduleRender();
    MY.ui.scheduleRoomList();
    MY.ui.updateHeader(room);
    MY.ui.updateConnUI();
    updateComposer();
    saveRoomsSoon();
    try { localStorage.setItem(P.lastRoomKey(), id); } catch { /* 忽略 */ }
    document.getElementById('sidebar') && document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop') && document.getElementById('sidebarBackdrop').classList.remove('show');

    MY.ui.hydrateBlobs(room).then(() => {
      if (S.activeRoomId === room.id) MY.ui.scheduleRender();
    }).catch(() => {});

    if (isLocked(room)) {
      setTimeout(() => { promptUnlock(room).catch(() => {}); }, 260);
    } else {
      backfillRoom(room).catch(() => {});
      if (room.type === 'dm') backfillDMs().catch(() => {});
    }
    return true;
  }

  async function createRoom(input) {
    const label = String((input && input.label) || '').trim().slice(0, 64);
    const password = String((input && input.password) || '');
    if (!label) throw new Error('请填写群聊名称');
    if (password && password.length < 4) throw new Error('房间密码至少 4 位');
    const id = U.slugId(label);
    const room = makeRoom({
      id,
      type: 'group',
      label,
      encrypted: !!password,
      joinedAt: Date.now(),
    });
    if (password) {
      const derived = await MY.crypto.deriveRoomKey(password, id);
      room.key = derived.key;
      room.rawKey = derived.raw;
      room.verifier = await MY.crypto.makeVerifier(derived.key);
      room.wrappedKey = await MY.crypto.wrapRoomKey(derived.raw, S.sk);
    }
    ensureSelfMember(room);
    S.rooms.set(id, room);
    P.saveRooms();
    scheduleSubscriptions();
    await switchRoom(id);
    sendControl(room, { _miyu_join: 1, name: S.name || '' }).catch(() => {});
    return room;
  }

  function parseInvite(text) {
    let raw = String(text || '').trim();
    if (!raw) return null;
    if (raw.startsWith('miyu://join/')) raw = raw.slice('miyu://join/'.length);
    else if (raw.startsWith('miyu-join:')) raw = raw.slice('miyu-join:'.length);
    raw = raw.replace(/\s+/g, '');
    if (/^miyu-[a-z0-9._:-]{4,90}$/i.test(raw)) {
      return { id: raw, label: '', enc: false, verifier: null };
    }
    try {
      const json = JSON.parse(U.b64urlDecode(raw));
      if (!json || json.v !== 1) return null;
      if (typeof json.id !== 'string' || !/^[a-z0-9._:-]{4,100}$/i.test(json.id)) return null;
      return {
        id: json.id,
        label: typeof json.label === 'string' ? json.label.slice(0, 64) : '',
        enc: !!json.enc,
        verifier: typeof json.verifier === 'string' ? json.verifier : null,
      };
    } catch { return null; }
  }

  function inviteCode(room) {
    if (!room || room.type !== 'group') return '';
    return U.b64urlEncode(JSON.stringify({
      v: 1,
      id: room.id,
      label: room.label,
      enc: room.encrypted ? 1 : 0,
      verifier: room.encrypted ? room.verifier : null,
    }));
  }

  async function joinRoom(input) {
    const code = parseInvite(input && input.code);
    if (!code) throw new Error('邀请码或群聊 ID 格式不正确');
    const password = String((input && input.password) || '');
    const existing = S.rooms.get(code.id);
    if (existing) {
      if (existing.encrypted && !existing.key && password) await unlockWithPassword(existing, password);
      await switchRoom(existing.id);
      return existing;
    }

    const room = makeRoom({
      id: code.id,
      type: 'group',
      label: code.label || `群聊 ${code.id.slice(-6)}`,
      encrypted: code.enc,
      verifier: code.verifier,
      joinedAt: Date.now(),
    });
    ensureSelfMember(room);
    if (room.encrypted) {
      if (password) {
        await unlockWithPassword(room, password);
      }
    }
    S.rooms.set(room.id, room);
    P.saveRooms();
    scheduleSubscriptions();
    await switchRoom(room.id);
    if (room.encrypted && room.key) {
      backfillRoom(room, true).catch(() => {});
      sendControl(room, { _miyu_join: 1, name: S.name || '' }).catch(() => {});
    } else if (!room.encrypted) {
      sendControl(room, { _miyu_join: 1, name: S.name || '' }).catch(() => {});
    }
    return room;
  }

  async function openDM(peerPub, name) {
    const pub = String(peerPub || '').toLowerCase();
    if (!isHexPub(pub)) { MY.ui.toast('公钥格式不正确'); return null; }
    if (pub === S.pub) { MY.ui.toast('不能和自己私聊'); return null; }
    let room = [...S.rooms.values()].find((r) => r.type === 'dm' && r.peerPub === pub);
    if (!room) {
      room = ensureDMRoom(pub, name || '');
    } else if (name) {
      const contact = P.contactFor(pub);
      if (!contact || !contact.name) {
        room.peerName = name;
        room.label = name;
        P.saveRooms();
        MY.ui.scheduleRoomList();
      }
    }
    await switchRoom(room.id);
    backfillDMs().catch(() => {});
    return room;
  }

  async function unlockWithPassword(room, password) {
    if (!room || !room.encrypted) return true;
    const derived = await MY.crypto.deriveRoomKey(password, room.id);
    if (room.verifier) {
      const ok = await MY.crypto.checkVerifier(derived.key, room.verifier);
      if (!ok) throw new Error('房间密码不正确');
    }
    room.key = derived.key;
    room.rawKey = derived.raw;
    room.wrappedKey = await MY.crypto.wrapRoomKey(derived.raw, S.sk);
    P.saveRooms();
    return true;
  }

  function promptUnlock(room) {
    if (!room) return Promise.resolve(false);
    if (!isLocked(room)) return Promise.resolve(true);
    if (unlockResolve) {
      try { unlockResolve(false); } catch { /* 忽略 */ }
      unlockResolve = null;
    }
    unlockTarget = room;
    const overlay = $('unlockOverlay');
    if (!overlay) return Promise.resolve(false);
    $('unlockRoomDesc').textContent = `“${room.label}”已加密。输入房间密码后才能查看和发送消息。`;
    $('unlockRoomInput').value = '';
    $('unlockRoomError').textContent = '';
    overlay.classList.remove('hidden');
    setTimeout(() => { try { $('unlockRoomInput').focus(); } catch { /* 忽略 */ } }, 60);
    return new Promise((resolve) => { unlockResolve = resolve; });
  }

  function closeUnlockPrompt(result) {
    const resolve = unlockResolve;
    unlockResolve = null;
    const overlay = $('unlockOverlay');
    if (overlay) overlay.classList.add('hidden');
    const room = unlockTarget;
    unlockTarget = null;
    if (resolve) resolve(!!result);
    return room;
  }

  async function submitUnlock() {
    const room = unlockTarget;
    if (!room) return;
    const pwd = $('unlockRoomInput').value;
    const err = $('unlockRoomError');
    err.textContent = '';
    if (!pwd) { err.textContent = '请输入房间密码'; return; }
    const btn = $('btnUnlockRoom');
    btn.disabled = true;
    try {
      await unlockWithPassword(room, pwd);
      closeUnlockPrompt(true);
      MY.ui.toast('已解锁');
      updateComposer();
      MY.ui.invalidateRender();
      MY.ui.scheduleRender();
      MY.ui.updateHeader(room);
      backfillRoom(room, true).catch(() => {});
      sendControl(room, { _miyu_join: 1, name: S.name || '' }).catch(() => {});
      if (S.rooms.has(room.id) && S.activeRoomId === room.id) MY.ui.scheduleRender();
    } catch (e) {
      err.textContent = e && e.message ? e.message : '解锁失败';
    } finally { btn.disabled = false; }
  }

  async function clearRoom(id) {
    const room = S.rooms.get(id);
    if (!room) return;
    const ok = await MY.ui.confirm('清空聊天记录', `清空“${room.label}”在本机的全部消息和文件缓存？其他设备和服务器上的记录不会被删除。`, '清空');
    if (!ok) return;
    await MY.store.deleteRoom(room.id).catch(() => {});
    MY.ui.revokeRoomUrls(room);
    room.events = [];
    room.seen.clear();
    room.hidden.clear();
    room.hiddenFiles.clear();
    room.recalledFiles.clear();
    room.pendingRecalls.clear();
    room.lastPreview = '';
    room.lastActivity = 0;
    room.unread = 0;
    await MY.store.kvSet(`hidden:${room.id}`, []).catch(() => {});
    await MY.store.kvSet(`hiddenFiles:${room.id}`, []).catch(() => {});
    await MY.store.kvSet(`recalls:${room.id}`, []).catch(() => {});
    P.saveRooms();
    MY.ui.invalidateRender();
    MY.ui.scheduleRender();
    MY.ui.scheduleRoomList();
    MY.ui.toast('本机记录已清空');
  }

  async function clearAllMessages() {
    const ok = await MY.ui.confirm('清理本机消息', '删除本设备上所有会话的消息与文件缓存。账户、群聊和密钥会保留，服务器上的内容不受影响。', '清理');
    if (!ok) return;
    for (const room of S.rooms.values()) {
      await MY.store.deleteRoom(room.id).catch(() => {});
      MY.ui.revokeRoomUrls(room);
      room.events = [];
      room.seen.clear();
      room.hidden.clear();
      room.hiddenFiles.clear();
      room.recalledFiles.clear();
      room.pendingRecalls.clear();
      room.lastPreview = '';
      room.lastActivity = 0;
      room.unread = 0;
      await MY.store.kvSet(`hidden:${room.id}`, []).catch(() => {});
      await MY.store.kvSet(`hiddenFiles:${room.id}`, []).catch(() => {});
      await MY.store.kvSet(`recalls:${room.id}`, []).catch(() => {});
    }
    P.saveRooms();
    MY.ui.invalidateRender();
    MY.ui.scheduleRender();
    MY.ui.scheduleRoomList();
    MY.ui.toast('本机消息已清理');
  }

  async function leaveRoom(id) {
    const room = S.rooms.get(id);
    if (!room) return;
    const isGroup = room.type === 'group';
    const ok = await MY.ui.confirm(
      isGroup ? '退出群聊' : '删除会话',
      isGroup
        ? `退出“${room.label}”？本机会删除该群聊的本地记录。群聊没有中心服务器，退出后可通过邀请码重新加入。`
        : `删除与“${room.label}”的会话？本机记录会被删除，对方仍保留聊天记录。`,
      isGroup ? '退出' : '删除'
    );
    if (!ok) return;
    await MY.store.deleteRoom(room.id).catch(() => {});
    MY.ui.revokeRoomUrls(room);
    S.rooms.delete(room.id);
    if (S.activeRoomId === room.id) {
      S.activeRoomId = null;
      S.replyTo = null;
      S.searchOpen = false;
      const bar = $('searchBar');
      if (bar) bar.classList.add('hidden');
      const messages = $('messages');
      if (messages) messages.textContent = '';
      MY.ui.invalidateRender();
      MY.ui.updateHeader(null);
      updateComposer();
    }
    try {
      if (localStorage.getItem(P.lastRoomKey()) === room.id) localStorage.removeItem(P.lastRoomKey());
    } catch { /* 忽略 */ }
    P.saveRooms();
    scheduleSubscriptions();
    MY.ui.scheduleRoomList();
    MY.ui.renderContacts();
    MY.ui.scheduleRender();
    MY.ui.toast(isGroup ? '已退出群聊' : '会话已删除');
  }

  /* ── 会话信息 ── */

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function block(label, value, mono) {
    const wrap = el('div', 'info-block');
    wrap.appendChild(el('div', 'k', label));
    wrap.appendChild(el('div', 'v' + (mono ? '' : ' plain'), value));
    return wrap;
  }

  async function showInfo() {
    const room = activeRoom();
    if (!room) return;
    $('infoTitle').textContent = room.type === 'dm' ? '私聊信息' : '群聊信息';
    const body = $('infoBody');
    body.textContent = '';

    const head = el('div', 'info-head');
    const av = el('div', 'info-avatar');
    if (room.type === 'dm' && room.peerPub) P.paintAvatar(av, room.peerPub, room.label);
    else {
      av.textContent = String(room.label || '群').slice(0, 1).toUpperCase();
      const hue = P.avatarHue(room.id);
      av.style.background = `linear-gradient(135deg,hsl(${hue} 32% 82%),hsl(${hue} 30% 70%))`;
      av.style.color = '#555';
    }
    const meta = el('div');
    meta.appendChild(el('div', 'info-name', room.label));
    const sub = room.type === 'dm'
      ? '私聊 · NIP-59 端到端加密'
      : `${room.encrypted ? '加密群聊' : '公开群聊'} · ${room.members.size || 1} 位成员`;
    meta.appendChild(el('div', 'info-sub', sub));
    head.append(av, meta);
    body.appendChild(head);

    if (isLocked(room)) {
      const warn = el('div', 'info-block');
      warn.appendChild(el('div', 'k', 'LOCKED'));
      warn.appendChild(el('div', 'v plain', '此群聊已加密，当前设备尚未解锁。'));
      const btn = el('button', 'mini-btn green', '输入房间密码解锁');
      btn.type = 'button';
      btn.style.marginTop = '8px';
      btn.onclick = async () => {
        const ok = await promptUnlock(room);
        if (ok) showInfo();
      };
      warn.appendChild(btn);
      body.appendChild(warn);
    }

    if (room.type === 'group') {
      const code = inviteCode(room);
      const inv = el('div', 'info-block');
      inv.appendChild(el('div', 'k', '邀请码 · INVITE CODE'));
      inv.appendChild(el('div', 'invite-code', code || '—'));
      const row = el('div');
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
      const copy = el('button', 'mini-btn green', '复制邀请码');
      copy.type = 'button';
      copy.onclick = async () => {
        const ok = await U.copyText(code);
        MY.ui.toast(ok ? '邀请码已复制' : '复制失败');
      };
      row.appendChild(copy);
      inv.appendChild(row);
      body.appendChild(inv);
      if (room.encrypted) body.appendChild(el('div', 'hint', '邀请码不含房间密码。请通过其他安全方式把密码告诉成员。'));

      body.appendChild(block('群聊 ID', room.id, true));

      const rename = el('div', 'info-block');
      rename.appendChild(el('div', 'k', '群聊名称'));
      const input = el('input');
      input.value = room.label;
      input.maxLength = 64;
      input.style.cssText = 'width:100%;padding:8px 10px;border-radius:7px;border:1px solid var(--line);background:var(--bg-side);color:var(--text);font-size:14px;outline:none';
      const row2 = el('div');
      row2.style.cssText = 'display:flex;gap:8px;margin-top:8px';
      const save = el('button', 'mini-btn green', '保存名称');
      save.type = 'button';
      save.onclick = () => {
        const value = input.value.trim().slice(0, 64);
        if (!value) { MY.ui.toast('名称不能为空'); return; }
        room.label = value;
        P.saveRooms();
        MY.ui.scheduleRoomList();
        MY.ui.updateHeader(room);
        MY.ui.toast('名称已更新');
      };
      row2.appendChild(save);
      rename.append(input, row2);
      body.appendChild(rename);

      const members = el('div', 'info-block');
      members.appendChild(el('div', 'k', `成员 · ${room.members.size || 1}`));
      const list = el('div', 'member-list');
      const rows = [...room.members.entries()].sort((a, b) => {
        if (a[0] === S.pub) return -1;
        if (b[0] === S.pub) return 1;
        return (b[1].lastAt || 0) - (a[1].lastAt || 0);
      });
      for (const [pub, info] of rows) {
        const row = el('div', 'member-row');
        const mav = el('div', 'member-avatar');
        P.paintAvatar(mav, pub, info.name || P.displayName(pub));
        const stack = el('div', 'member-name');
        stack.appendChild(document.createTextNode(info.name || P.displayName(pub)));
        if (pub === S.pub) stack.appendChild(el('span', 'me', '我'));
        stack.appendChild(el('div', 'member-pub', pub.slice(0, 12) + '…'));
        row.append(mav, stack);
        list.appendChild(row);
      }
      if (!rows.length) list.appendChild(el('div', 'hint', '还没有成员信息。成员发送消息后会出现在这里。'));
      members.appendChild(list);
      body.appendChild(members);
    } else {
      body.appendChild(block('对方公钥 · PUBKEY', room.peerPub || '', true));
      const tip = el('div', 'info-block');
      tip.appendChild(el('div', 'k', '端到端加密'));
      tip.appendChild(el('div', 'v plain', '消息使用 NIP-59 礼物包装和 NIP-44 加密，中继只能看到密文与收件人公钥。'));
      body.appendChild(tip);
    }

    const actions = el('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:14px';
    const clear = el('button', 'mini-btn', '清空聊天记录');
    clear.type = 'button';
    clear.onclick = async () => {
      $('infoOverlay').classList.add('hidden');
      await clearRoom(room.id);
    };
    const leave = el('button', 'mini-btn danger', room.type === 'group' ? '退出群聊' : '删除会话');
    leave.type = 'button';
    leave.onclick = async () => {
      $('infoOverlay').classList.add('hidden');
      await leaveRoom(room.id);
    };
    actions.append(clear, leave);
    body.appendChild(actions);

    $('infoOverlay').classList.remove('hidden');
  }

  /* ── 输入框 ── */

  function updateComposer() {
    const room = activeRoom();
    const locked = isLocked(room);
    const ready = !!room && S.ready && !locked;
    const input = $('msgInput');
    const send = $('sendBtn');
    const file = $('fileBtn');
    if (input) {
      input.disabled = !ready;
      if (!room) input.placeholder = '选择一个会话开始聊天';
      else if (locked) input.placeholder = '加密群聊 · 请先输入房间密码';
      else input.placeholder = '输入消息…';
    }
    if (send) send.disabled = !ready;
    if (file) file.disabled = !ready;
    if (!ready) {
      const panel = $('emojiPanel');
      if (panel) panel.classList.add('hidden');
    }
  }

  function syncComposerHeight() {
    const input = $('msgInput');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(130, Math.max(26, input.scrollHeight)) + 'px';
  }

  /* ── 生命周期 ── */

  function init() {
    const unlock = $('unlockOverlay');
    if (unlock) {
      $('btnUnlockRoom').onclick = () => { submitUnlock().catch(() => {}); };
      $('btnCancelUnlockRoom').onclick = () => {
        const room = closeUnlockPrompt(false);
        if (room) MY.ui.toast('群聊仍处于锁定状态');
      };
      $('unlockRoomInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitUnlock().catch(() => {}); }
      });
    }
    window.addEventListener('online', () => {
      setTimeout(() => {
        scheduleSubscriptions();
        backfillDMs(true).catch(() => {});
        const room = activeRoom();
        if (room) backfillRoom(room, true).catch(() => {});
      }, 700);
    });
  }

  function shutdown() {
    clearTimeout(subTimer);
    clearTimeout(saveTimer);
    try { groupSub && groupSub.close(); } catch { /* 忽略 */ }
    try { dmSub && dmSub.close(); } catch { /* 忽略 */ }
    groupSub = null;
    dmSub = null;
    closeUnlockPrompt(false);
  }

  MY.chat = {
    init,
    loadRooms,
    refreshSubscriptions,
    scheduleSubscriptions,
    switchRoom,
    createRoom,
    joinRoom,
    openDM,
    sendText,
    sendControl,
    wrapDM,
    recall,
    deleteForMe,
    canRecall,
    setReply: (item) => MY.ui.setReplyBar(item),
    clearRoom,
    clearAllMessages,
    leaveRoom,
    showInfo,
    updateComposer,
    syncComposerHeight,
    promptUnlock,
    isLocked,
    inviteCode,
    parseInvite,
    backfillRoom,
    backfillDMs,
    shutdown,
    activeRoom,
    ensureDMRoom,
  };
})(window.MY = window.MY || {});
