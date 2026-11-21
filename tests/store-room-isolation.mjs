/* ══════════════════════════════════════════════════════════
   store-room-isolation.mjs · 会话删除的数据隔离回归测试
   运行：node tests/store-room-isolation.mjs
   覆盖：IndexedDB 与 localStorage 降级两种存储后端
   另含：outbox 按房间清理与账户隔离、文件重载语义（已收文件不重复拉取）
   ══════════════════════════════════════════════════════════ */
import { chromium } from 'playwright-core';
import { startRelay } from '../relay/src/core.js';
import { startStaticServer } from '../scripts/static-server.mjs';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = 'room-isolation-test';
const ACCOUNT2 = 'other-account-test';
const ROOM_A = 'room-a';
const ROOM_B = 'room-b';
const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);

let passed = 0;
let failed = 0;

function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.error('  ✗', label, extra == null ? '' : extra); }
}

function browserPath() {
  const paths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return paths.find((p) => existsSync(p)) || '';
}

async function waitStore(page) {
  await page.waitForFunction(() => window.MY && MY.store && typeof MY.store.init === 'function', null, { timeout: 20000 });
}

async function setupRoomData(page) {
  return page.evaluate(async ({ account, roomA, roomB, idA, idB }) => {
    await MY.store.init(account);
    await MY.store.saveEvent(roomA, { ev: { id: idA, created_at: 1, pubkey: 'p' }, text: 'A 房间消息' });
    await MY.store.saveEvent(roomB, { ev: { id: idB, created_at: 2, pubkey: 'p' }, text: 'B 房间消息' });
    await MY.store.saveBlob(idA, new Blob(['A'], { type: 'text/plain' }));
    await MY.store.saveBlob(idB, new Blob(['B'], { type: 'text/plain' }));
    await MY.store.outboxSet('sent:mA', { roomId: roomA, mid: 'mA', total: 1, events: [], createdAt: 1 });
    await MY.store.outboxSet('sent:mB', { roomId: roomB, mid: 'mB', total: 1, events: [], createdAt: 2 });
    await MY.store.deleteRoom(roomA);
    await MY.store.outboxDeleteRoom(roomA);
    return { mode: MY.store.mode };
  }, { account: ACCOUNT, roomA: ROOM_A, roomB: ROOM_B, idA: ID_A, idB: ID_B });
}

async function readAfterReload(page) {
  return page.evaluate(async ({ account, roomA, roomB, idA, idB }) => {
    await MY.store.init(account);
    const aBlob = await MY.store.loadBlob(idA);
    const bBlob = await MY.store.loadBlob(idB);
    const aEvents = await MY.store.loadEvents(roomA);
    const bEvents = await MY.store.loadEvents(roomB);
    const bFallbackKey = `miyu.bl.${account}.${idB}`;
    const aFallbackKey = `miyu.bl.${account}.${idA}`;
    return {
      mode: MY.store.mode,
      aBlobText: aBlob ? await aBlob.text() : null,
      bBlobText: bBlob ? await bBlob.text() : null,
      aEvents: aEvents.length,
      bEvents: bEvents.length,
      aFallback: localStorage.getItem(aFallbackKey),
      bFallback: localStorage.getItem(bFallbackKey),
      aOutbox: await MY.store.outboxGet('sent:mA'),
      bOutbox: await MY.store.outboxGet('sent:mB'),
      aHasBlob: await MY.store.hasBlob(idA),
      bHasBlob: await MY.store.hasBlob(idB),
    };
  }, { account: ACCOUNT, roomA: ROOM_A, roomB: ROOM_B, idA: ID_A, idB: ID_B });
}

async function runCase(browser, site, label, disableIdb) {
  console.log(`${label}`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  if (disableIdb) {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        value: { open() { throw new Error('IndexedDB disabled for fallback test'); } },
      });
    });
  }
  const page = await context.newPage();
  await page.goto(site.url + '/', { waitUntil: 'domcontentloaded' });
  await waitStore(page);
  const setup = await setupRoomData(page);
  ok(setup.mode === (disableIdb ? 'fallback' : 'idb'), `存储后端为 ${disableIdb ? 'fallback' : 'idb'}`, setup.mode);

  // 新开页面，清空模块内的 memBlobs 缓存，确保读到的是真实持久层
  await page.close();
  const verify = await context.newPage();
  await verify.goto(site.url + '/', { waitUntil: 'domcontentloaded' });
  await waitStore(verify);
  const data = await readAfterReload(verify);
  ok(data.aEvents === 0, '被清空房间的事件已删除', data.aEvents);
  ok(data.aBlobText === null, '被清空房间的文件缓存已删除', data.aBlobText);
  ok(data.bEvents === 1, '其他房间的事件完整保留', data.bEvents);
  ok(data.bBlobText === 'B', '其他房间的文件缓存完整保留', data.bBlobText);
  ok(!data.aOutbox, '被清空房间的 outbox 记录已删除');
  ok(!!data.bOutbox && data.bOutbox.roomId === ROOM_B, '其他房间的 outbox 记录完整保留');
  ok(data.aHasBlob === false, 'hasBlob：被清空房间的文件返回不存在', data.aHasBlob);
  ok(data.bHasBlob === true, 'hasBlob：其他房间的文件返回存在', data.bHasBlob);
  if (disableIdb) {
    ok(data.aFallback === null, 'fallback：被清空房间的 blob 键已删除');
    ok(!!data.bFallback, 'fallback：其他房间的 blob 键仍存在');
  }
  await context.close();
}

/* outbox 账户隔离：清理只作用于当前账户，绝不跨账户误删 */
async function runAccountCase(browser, site, label, disableIdb) {
  console.log(`${label}`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  if (disableIdb) {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        value: { open() { throw new Error('IndexedDB disabled for fallback test'); } },
      });
    });
  }
  const page = await context.newPage();
  await page.goto(site.url + '/', { waitUntil: 'domcontentloaded' });
  await waitStore(page);
  const data = await page.evaluate(async ({ account, account2, roomA }) => {
    await MY.store.init(account);
    await MY.store.outboxSet('sent:mX', { roomId: roomA, mid: 'mX', total: 1, events: [], createdAt: 1 });
    await MY.store.init(account2);
    await MY.store.outboxSet('sent:mY', { roomId: roomA, mid: 'mY', total: 1, events: [], createdAt: 2 });
    await MY.store.outboxDeleteRoom(roomA); // 当前账户为 account2
    const yAfter = await MY.store.outboxGet('sent:mY');
    await MY.store.init(account);
    const xAfter = await MY.store.outboxGet('sent:mX');
    return { xAfter, yAfter, mode: MY.store.mode };
  }, { account: ACCOUNT, account2: ACCOUNT2, roomA: ROOM_A });
  ok(data.mode === (disableIdb ? 'fallback' : 'idb'), `存储后端为 ${disableIdb ? 'fallback' : 'idb'}`, data.mode);
  ok(!data.yAfter, '当前账户该房间的 outbox 已清理', data.yAfter);
  ok(!!data.xAfter && data.xAfter.roomId === ROOM_A, '其他账户同房间 outbox 不被误删', data.xAfter);
  await context.close();
}

/* 文件重载语义：已落盘文件重启后保持完成态、不重复拉取；缺缓存才重新接收 */
async function runFileReloadCase(browser, site, relayUrl) {
  console.log('3. 文件重载语义（真实应用载入路径）');
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  await page.addInitScript((url) => {
    try { localStorage.setItem('miyu.relays.v1', JSON.stringify([url])); } catch { /* 忽略 */ }
  }, relayUrl);
  await page.goto(site.url + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.MY && document.getElementById('btnCreateSubmit'), null, { timeout: 20000 });
  await page.fill('#createUsername', 'file-reload');
  await page.fill('#createPassword', 'pass-1234');
  await page.fill('#createPasswordConfirm', 'pass-1234');
  await page.click('#btnCreateSubmit');
  await page.waitForFunction(() => window.MY && MY.state && MY.state.ready && MY.state.pub, null, { timeout: 30000 });

  // 种入两个"上一会话"的文件消息：一个已落盘，一个只有消息记录没有缓存
  const seeded = await page.evaluate(async () => {
    const room = await MY.chat.createRoom({ label: '文件重载回归', password: '' });
    const sender = 'a'.repeat(64);
    const mkItem = (mid, firstId) => ({
      ev: { id: firstId, kind: 1, pubkey: sender, created_at: 1000, content: '', tags: [] },
      text: null, failed: false, senderName: 'Peer',
      fileMeta: { mid, name: `${mid}.bin`, mime: 'application/octet-stream', size: 4, engine: 'none', enc: false, hash: '', total: 2, chunkIds: [] },
      fileProgress: 1, transferState: 'ok', status: 'ok',
      displayPubkey: sender, recalled: false,
    });
    const done = mkItem('mid-done', 'c'.repeat(64));
    const lost = mkItem('mid-lost', 'd'.repeat(64));
    await MY.store.saveEvent(room.id, done);
    await MY.store.saveBlob(done.ev.id, new Blob(['abcd'], { type: 'application/octet-stream' }));
    await MY.store.saveEvent(room.id, lost);
    return { roomId: room.id, doneId: done.ev.id, lostId: lost.ev.id };
  });

  // 模拟重启：重跑载入路径（loadRooms → loadRoomState，从持久层重建房间状态）
  await page.evaluate(async () => { await MY.chat.loadRooms(); });

  const after = await page.evaluate(async ({ roomId, doneId, lostId }) => {
    const room = MY.state.rooms.get(roomId);
    const done = room.events.find((e) => e.fileMeta && e.ev.id === doneId);
    const lost = room.events.find((e) => e.fileMeta && e.ev.id === lostId);
    await MY.ui.hydrateBlobs(room); // 等同打开房间时的缓存水合
    // 重放前快照：载入后的初始状态
    const pre = {
      doneProgress: done.fileProgress,
      doneState: done.transferState,
      lostProgress: lost.fileProgress,
      lostState: lost.transferState,
      lostSeen: room.seen.has(lostId),
    };
    // 模拟订阅重放：对两项各重放一个缺失分片
    const sender = 'a'.repeat(64);
    const chunk = (mid, i) => ({
      _miyu_file: 1, mid, i, n: 2, name: `${mid}.bin`, mime: 'application/octet-stream',
      size: 4, engine: 'none', enc: false, hash: '', data: btoa('xy'),
    });
    const evFor = (id) => ({ id, kind: 1, pubkey: sender, created_at: 1001, tags: [] });
    MY.files.ingest(room, chunk('mid-done', 1), evFor('e'.repeat(64)));
    MY.files.ingest(room, chunk('mid-lost', 1), evFor('f'.repeat(64)));
    return {
      pre,
      doneProgress: done.fileProgress,
      doneState: done.transferState,
      doneUrl: !!done.downloadUrl,
      doneSeen: room.seen.has(doneId),
      doneDup: room.events.filter((e) => e.fileMeta && e.fileMeta.mid === 'mid-done').length,
      lostState: lost.transferState,
    };
  }, seeded);
  ok(after.pre.lostProgress === 0 && after.pre.lostSeen === false, '重载：缺缓存文件不保留 seen，处于可重拉状态');
  ok(after.pre.lostState === 'expired', '重载：缺缓存文件保持未保存提示态', after.pre.lostState);
  ok(after.doneProgress === 1, '重载：已落盘文件 fileProgress 恢复为 1', after.doneProgress);
  ok(after.doneState === 'ok', '重载：已落盘文件保持完成态', after.doneState);
  ok(after.doneUrl, '重载：已落盘文件水合出可保存的下载地址（文案走“已完成 · 点击右侧保存”）');
  ok(after.doneSeen, '重载：已完成文件保留 seen，首片重放在订阅层被拦截');
  ok(after.doneDup === 1, '重放后不产生重复消息项', after.doneDup);
  ok(after.doneState === 'ok' && after.doneProgress === 1, '重放：已完成文件被 ingest 跳过，状态未被重置');
  ok(after.lostState === 'receiving', '重放：真正缺缓存的文件仍会进入接收流程', after.lostState);

  // 新开页面验证持久层：排除 memBlobs 内存缓存掩盖落盘缺失的可能
  const pub = await page.evaluate(() => MY.state.pub);
  await page.close();
  const verify = await context.newPage();
  await verify.goto(site.url + '/', { waitUntil: 'domcontentloaded' });
  await waitStore(verify);
  const persisted = await verify.evaluate(async ({ pub, doneId }) => {
    await MY.store.init(pub);
    const blob = await MY.store.loadBlob(doneId);
    return { has: await MY.store.hasBlob(doneId), text: blob ? await blob.text() : null };
  }, { pub, doneId: seeded.doneId }).catch((e) => ({ has: false, text: null, err: String(e && e.message || e) }));
  ok(persisted.has && persisted.text === 'abcd', '落盘验证：新页面从持久层读到文件内容', JSON.stringify(persisted));
  await context.close();
}

const site = await startStaticServer({ root: join(root, 'app/www'), port: 0 });
const tempDir = mkdtempSync(join(tmpdir(), 'miyu-store-iso-'));
const relay = await startRelay({ host: '127.0.0.1', port: 0, dataFile: join(tempDir, 'events.jsonl'), logger: false });
let browser = null;
try {
  const executablePath = browserPath();
  if (!executablePath) throw new Error('未找到 Edge / Chrome，可安装 Microsoft Edge 后重试');
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  });
  await runCase(browser, site, '1. IndexedDB 后端', false);
  await runCase(browser, site, '2. localStorage 降级后端', true);
  await runAccountCase(browser, site, '3. outbox 账户隔离（IndexedDB）', false);
  await runAccountCase(browser, site, '4. outbox 账户隔离（fallback）', true);
  await runFileReloadCase(browser, site, relay.url);
} catch (err) {
  failed++;
  console.error('测试异常：', err && err.stack ? err.stack : err);
} finally {
  try { if (browser) await browser.close(); } catch { /* 忽略 */ }
  try { await site.close(); } catch { /* 忽略 */ }
  try { await relay.stop(); } catch { /* 忽略 */ }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
