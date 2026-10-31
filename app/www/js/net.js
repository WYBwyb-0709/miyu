/* ══════════════════════════════════════════════════════════
   net.js · 中继连接与发布
   ══════════════════════════════════════════════════════════ */
(function (MY) {
  'use strict';

  const U = MY.util;
  const RELAY_KEY = 'miyu.relays.v1';
  const PUBLIC_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
  ];

  let localRelay = null;
  let list = [];
  let pool = null;

  function normalize(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function defaults() {
    const out = [];
    if (localRelay) out.push(localRelay);
    for (const r of PUBLIC_RELAYS) if (!out.includes(r)) out.push(r);
    return out;
  }

  function load() {
    const saved = U.storageGet(RELAY_KEY, null);
    if (Array.isArray(saved)) {
      const clean = saved.map(normalize).filter((u) => /^wss?:\/\//i.test(u));
      if (clean.length) return clean;
    }
    return defaults();
  }

  function save(urls) {
    U.storageSet(RELAY_KEY, urls);
  }

  function reset() {
    try { localStorage.removeItem(RELAY_KEY); } catch { /* 忽略 */ }
    list = defaults();
    return list;
  }

  function createPool() {
    return new MiyuVendor.SimplePool({ enablePing: true, enableReconnect: true });
  }

  function isPublishOk(result) {
    if (!result || result.status !== 'fulfilled') return false;
    const val = result.value;
    if (typeof val !== 'string') return true;
    const low = val.toLowerCase();
    if (low.startsWith('connection failure')) return false;
    if (low.startsWith('blocked:')) return false;
    if (low.startsWith('invalid:')) return false;
    if (low.startsWith('rate-limited:')) return false;
    if (low.startsWith('error:')) return false;
    if (low.startsWith('pow:')) return false;
    if (low.startsWith('auth-required:')) return false;
    return true;
  }

  async function publishOnce(ev, timeout) {
    return new Promise((resolve) => {
      const results = [];
      let pending = 0;
      let settled = false;
      let timer = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(results);
      };

      let promises;
      try { promises = pool.publish(list, ev); }
      catch { return resolve(results); }
      if (!promises || !promises.length) return resolve(results);

      pending = promises.length;
      timer = setTimeout(finish, timeout);

      promises.forEach((p, i) => {
        Promise.resolve(p).then((value) => {
          results[i] = { status: 'fulfilled', value };
          if (isPublishOk(results[i])) finish();
        }, (reason) => {
          results[i] = { status: 'rejected', reason };
        }).finally(() => {
          pending--;
          if (pending === 0) finish();
        });
      });
    });
  }

  const Net = {
    get relays() { return list.slice(); },
    get localRelay() { return localRelay; },

    setLocalRelay(url) {
      localRelay = url ? normalize(url) : null;
      if (!U.storageGet(RELAY_KEY, null)) list = defaults();
    },

    availableDefaults: defaults,

    init() {
      list = load();
      pool = createPool();
      return list;
    },

    reconfigure(urls) {
      list = (urls || []).map(normalize).filter((u) => /^wss?:\/\//i.test(u));
      if (!list.length) list = defaults();
      save(list);
      if (pool) {
        try { pool.destroy(); } catch { /* 忽略 */ }
      }
      pool = createPool();
      return list;
    },

    saveAndReconfigure(urls) {
      return this.reconfigure(urls);
    },

    reset,

    async publish(ev, attempts = 3, timeout = 9000) {
      for (let i = 0; i < attempts; i++) {
        const results = await publishOnce(ev, timeout);
        if (results.some(isPublishOk)) return true;
        if (i < attempts - 1) await U.sleep(400 * (i + 1) + Math.random() * 250);
      }
      return false;
    },

    subscribe(filter, handlers) {
      if (!pool) return { close() {} };
      try {
        return pool.subscribeMany(list, filter, {
          onevent: handlers.onevent || (() => {}),
          oneose: handlers.oneose || (() => {}),
          onclose: handlers.onclose || (() => {}),
          maxWait: 6000,
        });
      } catch {
        return { close() {} };
      }
    },

    async query(filter, maxWait = 4500) {
      if (!pool) return [];
      try {
        return await pool.querySync(list, filter, { maxWait });
      } catch { return []; }
    },

    status() {
      const map = new Map();
      let connected = 0;
      try {
        if (pool) {
          const st = pool.listConnectionStatus();
          for (const [url, ok] of st.entries()) {
            map.set(url, !!ok);
            if (ok) connected++;
          }
        }
      } catch { /* 忽略 */ }
      for (const url of list) if (!map.has(url)) map.set(url, false);
      return { connected, total: list.length, map };
    },

    async test(url) {
      const u = normalize(url);
      if (!/^wss?:\/\//i.test(u)) return { ok: false, error: '地址必须以 ws:// 或 wss:// 开头' };
      const p = createPool();
      try {
        const relay = await Promise.race([
          p.ensureRelay(u, { connectionTimeout: 7000 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), 8000)),
        ]);
        try { relay.close(); } catch { /* 忽略 */ }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : '连接失败' };
      } finally {
        try { p.destroy(); } catch { /* 忽略 */ }
      }
    },

    shutdown() {
      if (pool) {
        try { pool.destroy(); } catch { /* 忽略 */ }
        pool = null;
      }
    },
  };

  MY.net = Net;
})(window.MY = window.MY || {});
