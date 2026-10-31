/* ══════════════════════════════════════════════════════════
   core.js · 单文件 Nostr 中继（NIP-01/09/11/40/45）
   ══════════════════════════════════════════════════════════ */
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyEvent } from 'nostr-tools/pure';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const SOFTWARE = 'miyu-relay/1.0.0';
const MAX_MESSAGE = 700 * 1024;
const MAX_CONTENT = 500 * 1024;
const MAX_TAGS = 5000;
const MAX_FILTERS = 8;
const MAX_SUBS = 24;
const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 500;

function nowSec() { return Math.floor(Date.now() / 1000); }

function tagValues(ev, name) {
  const out = [];
  for (const t of ev.tags || []) {
    if (Array.isArray(t) && t[0] === name && typeof t[1] === 'string') out.push(t[1]);
  }
  return out;
}

function isExpired(ev, at) {
  for (const t of ev.tags || []) {
    if (Array.isArray(t) && t[0] === 'expiration' && t[1]) {
      const n = Number(t[1]);
      if (Number.isFinite(n) && n > 0 && n <= (at || nowSec())) return true;
    }
  }
  return false;
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function matchesFilter(ev, filter, at) {
  if (!filter || typeof filter !== 'object') return false;
  if (isExpired(ev, at)) return false;
  if (Array.isArray(filter.ids) && !filter.ids.includes(ev.id)) return false;
  if (Array.isArray(filter.authors) && !filter.authors.includes(ev.pubkey)) return false;
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(ev.kind)) return false;
  if (Number.isFinite(filter.since) && ev.created_at < filter.since) return false;
  if (Number.isFinite(filter.until) && ev.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || key.length < 2) continue;
    if (!Array.isArray(values) || !values.length) return false;
    const name = key.slice(1);
    const found = (ev.tags || []).some((t) => Array.isArray(t) && t[0] === name && values.includes(t[1]));
    if (!found) return false;
  }
  return true;
}

export async function startRelay(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number.isFinite(options.port) ? options.port : 7777;
  const dataFile = options.dataFile ? String(options.dataFile) : null;
  const relayName = options.name || '密语本机中继';
  const logger = options.logger === false ? null : (options.logger || console);
  const relayPubkey = typeof options.pubkey === 'string' ? options.pubkey : '';
  const startedAt = Date.now();

  const events = new Map();
  const tombstones = new Map();
  const connections = new Set();
  const kindIndex = new Map();
  const authorIndex = new Map();
  const tagIndex = new Map();

  function log(...args) {
    if (logger && typeof logger.log === 'function') logger.log(...args);
  }

  if (dataFile) {
    try { mkdirSync(dirname(dataFile), { recursive: true }); } catch { /* 忽略 */ }
  }

  function addToIndex(map, key, id) {
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(id);
  }

  function removeFromIndex(map, key, id) {
    const set = map.get(key);
    if (!set) return;
    set.delete(id);
    if (!set.size) map.delete(key);
  }

  function addIndexes(ev) {
    addToIndex(kindIndex, ev.kind, ev.id);
    addToIndex(authorIndex, ev.pubkey, ev.id);
    for (const t of ev.tags || []) {
      if (!Array.isArray(t) || t.length < 2 || typeof t[1] !== 'string') continue;
      addToIndex(tagIndex, `${t[0]}:${t[1]}`, ev.id);
    }
  }

  function removeIndexes(ev) {
    removeFromIndex(kindIndex, ev.kind, ev.id);
    removeFromIndex(authorIndex, ev.pubkey, ev.id);
    for (const t of ev.tags || []) {
      if (!Array.isArray(t) || t.length < 2 || typeof t[1] !== 'string') continue;
      removeFromIndex(tagIndex, `${t[0]}:${t[1]}`, ev.id);
    }
  }

  function persistEvent(ev) {
    if (!dataFile) return;
    try {
      appendFileSync(dataFile, JSON.stringify({ type: 'event', event: ev }) + '\n');
    } catch (e) { log('[relay] persist event failed:', e.message); }
  }

  function persistDelete(ids, by) {
    if (!dataFile || !ids.length) return;
    try {
      appendFileSync(dataFile, JSON.stringify({ type: 'delete', ids, by }) + '\n');
    } catch (e) { log('[relay] persist delete failed:', e.message); }
  }

  function loadData() {
    if (!dataFile || !existsSync(dataFile)) return 0;
    let raw = '';
    try { raw = readFileSync(dataFile, 'utf8'); } catch (e) {
      log('[relay] read data failed:', e.message);
      return 0;
    }
    let lines = 0;
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      lines++;
      let obj;
      try { obj = JSON.parse(text); } catch { continue; }
      if (obj && obj.type === 'delete' && Array.isArray(obj.ids) && typeof obj.by === 'string') {
        for (const id of obj.ids) {
          if (typeof id !== 'string') continue;
          tombstones.set(id, obj.by);
          const target = events.get(id);
          if (target && target.pubkey === obj.by) {
            removeIndexes(target);
            events.delete(id);
          }
        }
        continue;
      }
      const ev = obj && obj.type === 'event' ? obj.event : obj;
      if (!ev || !ev.id) continue;
      try {
        if (!verifyEvent(ev)) continue;
        if (isExpired(ev)) continue;
        if (tombstones.get(ev.id) === ev.pubkey) continue;
        if (!events.has(ev.id)) {
          events.set(ev.id, ev);
          addIndexes(ev);
        }
      } catch { /* 跳过损坏行 */ }
    }
    if (lines > events.size + tombstones.size + 800) compact();
    return lines;
  }

  function compact() {
    if (!dataFile) return;
    try {
      const lines = [];
      for (const ev of events.values()) lines.push(JSON.stringify({ type: 'event', event: ev }));
      for (const [id, by] of tombstones) lines.push(JSON.stringify({ type: 'delete', ids: [id], by }));
      const tmp = dataFile + '.tmp';
      writeFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
      try { unlinkSync(dataFile); } catch { /* 忽略 */ }
      try { copyFileSync(tmp, dataFile); } catch { /* 忽略 */ }
      try { unlinkSync(tmp); } catch { /* 忽略 */ }
    } catch (e) { log('[relay] compact failed:', e.message); }
  }

  function collectCandidates(filter) {
    if (!filter || typeof filter !== 'object') return [];
    if (Array.isArray(filter.ids)) {
      const out = [];
      for (const id of filter.ids) {
        const ev = events.get(id);
        if (ev) out.push(ev);
      }
      return out;
    }
    let best = null;
    const consider = (set) => {
      if (!set || !set.size) return;
      if (!best || set.size < best.size) best = set;
    };
    if (Array.isArray(filter.authors)) {
      const union = new Set();
      for (const pub of filter.authors) {
        const set = authorIndex.get(pub);
        if (set) for (const id of set) union.add(id);
      }
      consider(union);
    }
    if (Array.isArray(filter.kinds)) {
      const union = new Set();
      for (const kind of filter.kinds) {
        const set = kindIndex.get(kind);
        if (set) for (const id of set) union.add(id);
      }
      consider(union);
    }
    for (const [key, values] of Object.entries(filter)) {
      if (!key.startsWith('#') || key.length < 2 || !Array.isArray(values)) continue;
      const union = new Set();
      const tagName = key.slice(1);
      for (const value of values) {
        const set = tagIndex.get(`${tagName}:${value}`);
        if (set) for (const id of set) union.add(id);
      }
      consider(union);
    }
    const source = best ? [...best] : [...events.keys()];
    const out = [];
    for (const id of source) {
      const ev = events.get(id);
      if (ev) out.push(ev);
    }
    return out;
  }

  function queryEvents(filters) {
    const at = nowSec();
    const seen = new Set();
    const out = [];
    for (const filter of filters) {
      if (!filter || typeof filter !== 'object') continue;
      const limit = clampLimit(filter.limit);
      const matched = [];
      for (const ev of collectCandidates(filter)) {
        if (seen.has(ev.id)) continue;
        if (!matchesFilter(ev, filter, at)) continue;
        matched.push(ev);
      }
      matched.sort((a, b) => (b.created_at - a.created_at) || String(a.id).localeCompare(String(b.id)));
      for (const ev of matched.slice(0, limit)) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        out.push(ev);
      }
    }
    return out;
  }

  function countEvents(filters) {
    const at = nowSec();
    const seen = new Set();
    for (const filter of filters) {
      for (const ev of collectCandidates(filter)) {
        if (seen.has(ev.id)) continue;
        if (matchesFilter(ev, filter, at)) seen.add(ev.id);
      }
    }
    return seen.size;
  }

  function send(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return true;
    } catch { return false; }
  }

  function sendOk(conn, id, ok, message) {
    send(conn.ws, ['OK', id, !!ok, String(message || '')]);
  }

  function broadcast(ev) {
    for (const conn of connections) {
      for (const sub of conn.subs.values()) {
        let matches = false;
        for (const filter of sub.filters) {
          if (matchesFilter(ev, filter)) { matches = true; break; }
        }
        if (!matches) continue;
        if (sub.sent.has(ev.id)) continue;
        sub.sent.add(ev.id);
        if (sub.sent.size > 6000) sub.sent = new Set([...sub.sent].slice(-3000));
        send(conn.ws, ['EVENT', sub.id, ev]);
        break;
      }
    }
  }

  function storeEvent(ev) {
    if (events.has(ev.id)) return false;
    if (tombstones.get(ev.id) === ev.pubkey) return false;
    events.set(ev.id, ev);
    addIndexes(ev);
    persistEvent(ev);
    return true;
  }

  function removeEvent(id) {
    const target = events.get(id);
    if (!target) return false;
    removeIndexes(target);
    events.delete(id);
    return true;
  }

  function processDeletion(ev) {
    const targets = [];
    for (const t of ev.tags || []) {
      if (Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string') targets.push(t[1]);
    }
    const removed = [];
    for (const id of targets) {
      const target = events.get(id);
      if (target && target.pubkey === ev.pubkey) {
        removeEvent(id);
        tombstones.set(id, ev.pubkey);
        removed.push(id);
      } else if (!target && !tombstones.has(id)) {
        tombstones.set(id, ev.pubkey);
        removed.push(id);
      }
    }
    if (removed.length) persistDelete(removed, ev.pubkey);
  }

  function validateEvent(ev) {
    if (!ev || typeof ev !== 'object') return 'invalid: not an event';
    if (typeof ev.id !== 'string' || ev.id.length !== 64) return 'invalid: bad id';
    if (typeof ev.pubkey !== 'string' || ev.pubkey.length !== 64) return 'invalid: bad pubkey';
    if (typeof ev.sig !== 'string' || ev.sig.length !== 128) return 'invalid: bad signature';
    if (!Number.isInteger(ev.kind) || ev.kind < 0 || ev.kind > 65535) return 'invalid: bad kind';
    if (!Number.isFinite(ev.created_at) || ev.created_at < 0) return 'invalid: bad created_at';
    if (typeof ev.content !== 'string') return 'invalid: bad content';
    if (ev.content.length > MAX_CONTENT) return 'invalid: content too large';
    if (!Array.isArray(ev.tags) || ev.tags.length > MAX_TAGS) return 'invalid: bad tags';
    try {
      if (!verifyEvent(ev)) return 'invalid: bad signature';
    } catch { return 'invalid: bad signature'; }
    return '';
  }

  function handleClientMessage(conn, raw, isBinary) {
    if (isBinary) { send(conn.ws, ['NOTICE', 'binary messages are not supported']); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch {
      send(conn.ws, ['NOTICE', 'invalid: malformed JSON']);
      return;
    }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') {
      send(conn.ws, ['NOTICE', 'invalid: message must be an array']);
      return;
    }
    const type = msg[0];
    if (type === 'EVENT') {
      if (!allowEvent(conn)) {
        const id = msg[1] && typeof msg[1].id === 'string' ? msg[1].id : '';
        sendOk(conn, id, false, 'rate-limited: slow down');
        return;
      }
      const ev = msg[1];
      const problem = validateEvent(ev);
      if (problem) {
        sendOk(conn, ev && ev.id ? ev.id : '', false, problem);
        return;
      }
      if (isExpired(ev)) {
        sendOk(conn, ev.id, true, 'expired: not stored');
        return;
      }
      if (events.has(ev.id)) {
        sendOk(conn, ev.id, true, 'duplicate: already have this event');
        return;
      }
      if (tombstones.get(ev.id) === ev.pubkey) {
        sendOk(conn, ev.id, true, 'deleted: event was deleted');
        return;
      }
      storeEvent(ev);
      if (ev.kind === 5) processDeletion(ev);
      sendOk(conn, ev.id, true, '');
      broadcast(ev);
      return;
    }

    if (type === 'REQ') {
      const subId = msg[1];
      if (typeof subId !== 'string' || !subId || subId.length > 80) {
        send(conn.ws, ['NOTICE', 'invalid: bad subscription id']);
        return;
      }
      let filters = msg.slice(2);
      if (!filters.length) filters = [{}];
      if (filters.length > MAX_FILTERS) {
        send(conn.ws, ['CLOSED', subId, 'invalid: too many filters']);
        return;
      }
      for (const f of filters) {
        if (!f || typeof f !== 'object' || Array.isArray(f)) {
          send(conn.ws, ['CLOSED', subId, 'invalid: bad filter']);
          return;
        }
      }
      if (conn.subs.size >= MAX_SUBS && !conn.subs.has(subId)) {
        send(conn.ws, ['CLOSED', subId, 'invalid: too many subscriptions']);
        return;
      }
      const old = conn.subs.get(subId);
      if (old && old.timer) clearTimeout(old.timer);
      const sub = { id: subId, filters, sent: new Set(), timer: null };
      conn.subs.set(subId, sub);

      const existing = queryEvents(filters);
      let i = 0;
      const pump = () => {
        if (!conn.subs.has(subId) || conn.subs.get(subId) !== sub) return;
        const start = Date.now();
        while (i < existing.length && Date.now() - start < 24) {
          const ev = existing[i++];
          if (sub.sent.has(ev.id)) continue;
          sub.sent.add(ev.id);
          send(conn.ws, ['EVENT', subId, ev]);
        }
        if (i < existing.length) {
          sub.timer = setTimeout(pump, 0);
        } else {
          send(conn.ws, ['EOSE', subId]);
        }
      };
      pump();
      return;
    }

    if (type === 'CLOSE') {
      const subId = msg[1];
      const sub = conn.subs.get(subId);
      if (sub && sub.timer) clearTimeout(sub.timer);
      conn.subs.delete(subId);
      return;
    }

    if (type === 'COUNT') {
      const subId = msg[1];
      if (typeof subId !== 'string' || !subId) {
        send(conn.ws, ['NOTICE', 'invalid: bad count id']);
        return;
      }
      let filters = msg.slice(2);
      if (!filters.length) filters = [{}];
      if (filters.length > MAX_FILTERS) {
        send(conn.ws, ['COUNT', subId, { count: 0 }]);
        return;
      }
      const count = countEvents(filters);
      send(conn.ws, ['COUNT', subId, { count }]);
      return;
    }

    send(conn.ws, ['NOTICE', `unsupported: ${type}`]);
  }

  function allowEvent(conn) {
    const now = Date.now();
    const elapsed = Math.max(0, now - conn.bucketAt) / 1000;
    conn.bucketAt = now;
    conn.tokens = Math.min(1200, conn.tokens + elapsed * 160);
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  loadData();

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const accept = String(req.headers.accept || '');
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (url.pathname === '/health') {
      const body = JSON.stringify({
        ok: true,
        name: relayName,
        software: SOFTWARE,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        events: events.size,
        tombstones: tombstones.size,
        connections: connections.size,
        time: nowSec(),
      });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    if (url.pathname === '/' && (accept.includes('application/nostr+json') || url.searchParams.get('format') === 'json')) {
      const body = JSON.stringify({
        name: relayName,
        description: '密语的本机 / 局域网 Nostr 中继。支持群聊、私聊礼物包装与 NIP-09 撤回。',
        supported_nips: [1, 9, 11, 40, 45],
        software: 'miyu-relay',
        version: '1.0.0',
        limitation: {
          max_message_length: MAX_MESSAGE,
          max_subscriptions: MAX_SUBS,
          max_filters: MAX_FILTERS,
          max_limit: MAX_LIMIT,
          max_event_tags: MAX_TAGS,
          max_content_length: MAX_CONTENT,
          min_pow_difficulty: 0,
          auth_required: false,
          payment_required: false,
          restricted_writes: false,
        },
        pubkey: relayPubkey,
      });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/nostr+json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${relayName}</title>
<body style="font-family:system-ui;max-width:720px;margin:8vh auto;padding:0 20px;line-height:1.7;color:#222">
<h1>${relayName}</h1>
<p>这是密语客户端的本机 Nostr 中继。WebSocket 地址：<code>ws://${req.headers.host || `${host}:${port}`}</code></p>
<p>事件数：${events.size} · 运行 ${Math.floor((Date.now() - startedAt) / 1000)} 秒</p>
<p><a href="/health">/health</a></p>
</body>`);
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE, perMessageDeflate: false });

  wss.on('connection', (ws, req) => {
    const conn = {
      ws,
      subs: new Map(),
      tokens: 1200,
      bucketAt: Date.now(),
      address: req.socket.remoteAddress || '',
    };
    connections.add(conn);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      try {
        handleClientMessage(conn, isBinary ? '' : data.toString('utf8'), isBinary);
      } catch (e) {
        log('[relay] message error:', e && e.message);
        send(ws, ['NOTICE', 'internal: ' + (e && e.message ? e.message : 'error')]);
      }
    });
    ws.on('close', () => {
      for (const sub of conn.subs.values()) if (sub.timer) clearTimeout(sub.timer);
      conn.subs.clear();
      connections.delete(conn);
    });
    ws.on('error', () => {
      connections.delete(conn);
    });
  });

  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch { /* 忽略 */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* 忽略 */ }
    }
  }, 30000);
  if (pingTimer.unref) pingTimer.unref();

  const purgeTimer = setInterval(() => {
    const at = nowSec();
    for (const [id, ev] of [...events]) {
      if (isExpired(ev, at)) removeEvent(id);
    }
  }, 60000);
  if (purgeTimer.unref) purgeTimer.unref();

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;

  return {
    server: httpServer,
    wss,
    port: actualPort,
    host,
    url: `ws://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    lanUrl: `ws://${host}:${actualPort}`,
    stats: () => ({ events: events.size, tombstones: tombstones.size, connections: connections.size }),
    async stop() {
      clearInterval(pingTimer);
      clearInterval(purgeTimer);
      for (const conn of connections) {
        try { conn.ws.close(1001, 'server stopping'); } catch { /* 忽略 */ }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
