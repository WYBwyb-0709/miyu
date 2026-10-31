import { startRelay } from '../relay/src/core.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'miyu-relay-test-'));
const dataFile = join(dir, 'events.jsonl');
let relay = null;
let passed = 0;
let failed = 0;

function assert(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.error('  ✗', label, extra == null ? '' : extra); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function connect(url) {
  const ws = new WebSocket(url);
  const client = {
    ws,
    inbox: [],
    waiters: [],
    closed: false,
    close() { try { ws.close(); } catch { /* 忽略 */ } },
  };
  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    client.inbox.push(msg);
    const pending = client.waiters.splice(0);
    for (const w of pending) w();
  });
  ws.addEventListener('close', () => { client.closed = true; });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
  return client;
}

function send(client, msg) {
  client.ws.send(JSON.stringify(msg));
}

async function waitFor(client, predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const i = client.inbox.findIndex(predicate);
    if (i >= 0) return client.inbox.splice(i, 1)[0];
    await new Promise((resolve) => {
      client.waiters.push(resolve);
      setTimeout(resolve, 150);
    });
  }
  throw new Error('waitFor timeout');
}

async function subscribe(client, id, filter) {
  send(client, ['REQ', id, filter]);
  const events = [];
  while (true) {
    const msg = await waitFor(client, (m) => (m[0] === 'EVENT' || m[0] === 'EOSE' || m[0] === 'CLOSED') && m[1] === id, 7000);
    if (msg[0] === 'EOSE') return events;
    if (msg[0] === 'CLOSED') throw new Error('subscription closed: ' + msg[2]);
    events.push(msg[2]);
  }
}

function makeEvent(sk, kind, content, tags, created_at) {
  return finalizeEvent({ kind, content, tags: tags || [], created_at: created_at || Math.floor(Date.now() / 1000) }, sk);
}

try {
  console.log('1. 启动与 NIP-11');
  relay = await startRelay({ host: '127.0.0.1', port: 0, dataFile, logger: false, name: 'Test Relay' });
  const httpBase = `http://127.0.0.1:${relay.port}`;
  const res = await fetch(httpBase + '/', { headers: { Accept: 'application/nostr+json' } });
  const info = await res.json();
  assert(res.status === 200, 'NIP-11 返回 200');
  assert(info.software === 'miyu-relay' && info.supported_nips.includes(9), 'NIP-11 内容包含 NIP-09', info);
  const health = await (await fetch(httpBase + '/health')).json();
  assert(health.ok === true, 'health 端点正常');

  const aliceSk = generateSecretKey();
  const alicePub = getPublicKey(aliceSk);
  const bobSk = generateSecretKey();
  const bobPub = getPublicKey(bobSk);
  const room = 'miyu-test-room';

  console.log('2. 发布与订阅');
  const a = await connect(`ws://127.0.0.1:${relay.port}`);
  const b = await connect(`ws://127.0.0.1:${relay.port}`);
  send(a, ['REQ', 'sub-a', { kinds: [1], '#t': [room] }]);
  await waitFor(a, (m) => m[0] === 'EOSE' && m[1] === 'sub-a');

  const ev1 = makeEvent(aliceSk, 1, 'hello relay', [['t', room], ['name', 'Alice']]);
  send(a, ['EVENT', ev1]);
  const ok1 = await waitFor(a, (m) => m[0] === 'OK' && m[1] === ev1.id);
  assert(ok1[2] === true, '事件发布获得 OK true', ok1);
  const live = await waitFor(a, (m) => m[0] === 'EVENT' && m[2] && m[2].id === ev1.id);
  assert(live[2].content === 'hello relay', '订阅实时收到事件');

  const got = await subscribe(b, 'sub-b', { kinds: [1], '#t': [room] });
  assert(got.some((e) => e.id === ev1.id), '新连接查询到历史事件');

  console.log('3. 过滤与限制');
  const filtered = await subscribe(b, 'sub-c', { kinds: [1], authors: [alicePub], '#t': [room] });
  assert(filtered.length === 1 && filtered[0].id === ev1.id, 'authors + #t 过滤正确');
  const limited = await subscribe(b, 'sub-limit', { kinds: [1], '#t': [room], limit: 0 });
  assert(limited.length === 0, 'limit=0 不返回事件');
  const notMine = await subscribe(b, 'sub-none', { kinds: [1], authors: [bobPub], '#t': [room] });
  assert(notMine.length === 0, '其他作者过滤为空');

  console.log('4. NIP-09 撤回');
  const badDelete = makeEvent(bobSk, 5, 'recall', [['e', ev1.id], ['t', room]]);
  send(b, ['EVENT', badDelete]);
  const okBad = await waitFor(b, (m) => m[0] === 'OK' && m[1] === badDelete.id);
  assert(okBad[2] === true, '非作者删除请求本身可入库');
  await sleep(120);
  const stillThere = await subscribe(b, 'sub-still', { kinds: [1], '#t': [room] });
  assert(stillThere.some((e) => e.id === ev1.id), '非作者不能删除他人事件');

  const goodDelete = makeEvent(aliceSk, 5, 'recall', [['e', ev1.id], ['t', room]]);
  send(a, ['EVENT', goodDelete]);
  const okGood = await waitFor(a, (m) => m[0] === 'OK' && m[1] === goodDelete.id);
  assert(okGood[2] === true, '作者删除请求获得 OK');
  await sleep(150);
  const afterDelete = await subscribe(b, 'sub-after', { kinds: [1], '#t': [room] });
  assert(!afterDelete.some((e) => e.id === ev1.id), '删除后不再返回原事件');
  const deleteEvents = await subscribe(b, 'sub-del', { kinds: [5], '#t': [room] });
  assert(deleteEvents.some((e) => e.id === goodDelete.id), '删除请求本身仍可订阅到');

  send(a, ['EVENT', ev1]);
  const reOk = await waitFor(a, (m) => m[0] === 'OK' && m[1] === ev1.id);
  assert(reOk[2] === true, '已删除事件重发返回 OK');
  await sleep(100);
  const noResurrect = await subscribe(b, 'sub-res', { kinds: [1], '#t': [room] });
  assert(!noResurrect.some((e) => e.id === ev1.id), '已删除事件不会复活');

  const countId = 'count-1';
  send(b, ['COUNT', countId, { kinds: [1], '#t': [room] }]);
  const countMsg = await waitFor(b, (m) => m[0] === 'COUNT' && m[1] === countId);
  assert(countMsg[2].count === 0, 'NIP-45 COUNT 正确');

  console.log('5. 重启持久化');
  a.close();
  b.close();
  await sleep(150);
  await relay.stop();

  relay = await startRelay({ host: '127.0.0.1', port: 0, dataFile, logger: false });
  const c = await connect(`ws://127.0.0.1:${relay.port}`);
  const persisted = await subscribe(c, 'sub-p', { kinds: [1], '#t': [room] });
  assert(persisted.length === 0, '重启后已删除事件仍不存在');
  const deletes = await subscribe(c, 'sub-pd', { kinds: [5], '#t': [room] });
  assert(deletes.some((e) => e.id === goodDelete.id), '重启后删除事件仍在');
  send(c, ['EVENT', ev1]);
  const tombOk = await waitFor(c, (m) => m[0] === 'OK' && m[1] === ev1.id);
  assert(tombOk[2] === true, '重启后墓碑仍阻止事件复活');
  const check = await subscribe(c, 'sub-p2', { kinds: [1], '#t': [room] });
  assert(check.length === 0, '重启后墓碑生效');
  c.close();

  console.log('6. 错误处理');
  const d = await connect(`ws://127.0.0.1:${relay.port}`);
  const bad = { ...ev1, content: 'tampered' };
  send(d, ['EVENT', bad]);
  const badOk = await waitFor(d, (m) => m[0] === 'OK' && m[1] === bad.id);
  assert(badOk[2] === false && String(badOk[3]).startsWith('invalid:'), '篡改事件被拒绝', badOk);
  send(d, ['REQ', 'x', { kinds: 'not-array' }]);
  const eoseX = await waitFor(d, (m) => (m[0] === 'EOSE' || m[0] === 'CLOSED') && m[1] === 'x');
  assert(eoseX[0] === 'EOSE', '非法 kinds 被视为空过滤而非崩溃');
  d.close();
} catch (err) {
  failed++;
  console.error('测试异常：', err);
} finally {
  try { if (relay) await relay.stop(); } catch { /* 忽略 */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
