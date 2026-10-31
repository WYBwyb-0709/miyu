/* ══════════════════════════════════════════════════════════
   smoke.mjs · 两个账户 / 一个中继的端到端冒烟测试
   运行：node tests/smoke.mjs
   ══════════════════════════════════════════════════════════ */
import { chromium } from 'playwright-core';
import { startRelay } from '../relay/src/core.js';
import { startStaticServer } from '../scripts/static-server.mjs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = mkdtempSync(join(tmpdir(), 'miyu-smoke-'));
const shotsDir = resolve(root, 'dist/screenshots');
mkdirSync(shotsDir, { recursive: true });

const errors = [];
let passed = 0;
let failed = 0;

function ok(cond, label, extra) {
  if (cond) {
    passed++;
    console.log('  ✓', label);
  } else {
    failed++;
    console.error('  ✗', label, extra == null ? '' : extra);
  }
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

function attach(page, name) {
  page.on('pageerror', (err) => {
    errors.push(`${name} pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/favicon|ERR_CONNECTION_REFUSED|net::ERR|WebSocket is already in CLOSING or CLOSED/i.test(text)) return;
      errors.push(`${name} console: ${text}`);
    }
  });
}

async function makeAccount(page, name, password) {
  await page.goto(page.appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.MY && MY.state && document.getElementById('btnCreateSubmit'), null, { timeout: 20000 });
  await page.fill('#createUsername', name);
  await page.fill('#createPassword', password);
  await page.fill('#createPasswordConfirm', password);
  await page.click('#btnCreateSubmit');
  await page.waitForFunction(() => {
    const overlay = document.getElementById('authOverlay');
    return window.MY && MY.state.ready && MY.state.pub && overlay && overlay.classList.contains('hidden');
  }, null, { timeout: 30000 });
}

async function waitText(page, roomId, text, timeout = 20000) {
  await page.waitForFunction(({ roomId, text }) => {
    const room = MY.state.rooms.get(roomId);
    return !!room && room.events.some((e) => e.text === text && !e.deleted);
  }, { roomId, text }, { timeout });
}

async function send(page, text) {
  await page.waitForFunction(() => {
    const input = document.getElementById('msgInput');
    return input && !input.disabled;
  }, null, { timeout: 15000 });
  await page.fill('#msgInput', text);
  await page.click('#sendBtn');
}

async function itemId(page, roomId, text) {
  return page.evaluate(({ roomId, text }) => {
    const room = MY.state.rooms.get(roomId);
    const item = room && room.events.find((e) => e.text === text);
    return item ? item.ev.id : '';
  }, { roomId, text });
}

let relay = null;
let site = null;
let browser = null;

try {
  console.log('1. 启动测试中继与静态服务器');
  relay = await startRelay({
    host: '127.0.0.1',
    port: 0,
    dataFile: join(tempDir, 'events.jsonl'),
    logger: false,
  });
  site = await startStaticServer({ root: join(root, 'app/www'), port: 0 });
  ok(!!relay.url && !!site.url, '中继与站点已启动');

  const executablePath = browserPath();
  if (!executablePath) throw new Error('未找到 Edge / Chrome，可安装 Microsoft Edge 后重试');
  console.log('  使用浏览器：' + executablePath);
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  });

  const relayUrl = relay.url;
  const contextA = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const contextB = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  pageA.appUrl = site.url + '/';
  pageB.appUrl = site.url + '/';
  for (const page of [pageA, pageB]) {
    await page.addInitScript((url) => {
      try { localStorage.setItem('miyu.relays.v1', JSON.stringify([url])); } catch { /* 忽略 */ }
    }, relayUrl);
    attach(page, page === pageA ? 'A' : 'B');
  }

  console.log('2. 创建两个账户');
  await makeAccount(pageA, 'Alice', 'pass-1234');
  await makeAccount(pageB, 'Bob', 'pass-5678');
  const pubA = await pageA.evaluate(() => MY.state.pub);
  const pubB = await pageB.evaluate(() => MY.state.pub);
  ok(/^[0-9a-f]{64}$/.test(pubA) && /^[0-9a-f]{64}$/.test(pubB) && pubA !== pubB, '两个独立身份已生成');

  console.log('3. 群聊创建、加入与消息');
  const group = await pageA.evaluate(async () => {
    const room = await MY.chat.createRoom({ label: '冒烟测试群', password: '' });
    return { id: room.id, code: MY.chat.inviteCode(room) };
  });
  ok(!!group.id && !!group.code, '群聊已创建并生成邀请码');
  await pageB.evaluate(async (code) => {
    await MY.chat.joinRoom({ code, password: '' });
  }, group.code);
  const joined = await pageB.evaluate((id) => MY.state.rooms.has(id), group.id);
  ok(joined, '第二个账户通过邀请码加入群聊');

  await pageA.waitForFunction((pub) => {
    const room = [...MY.state.rooms.values()].find((r) => r.type === 'group');
    return !!room && room.members.has(pub);
  }, pubB, { timeout: 15000 });
  ok(true, '群成员列表同步到创建者');

  await send(pageA, '你好，这是来自 Alice 的群消息');
  await waitText(pageB, group.id, '你好，这是来自 Alice 的群消息');
  ok(true, '群聊文本从 A 送达 B');

  await pageB.evaluate((id) => MY.chat.switchRoom(id), group.id);
  await send(pageB, '收到了，我是 Bob');
  await waitText(pageA, group.id, '收到了，我是 Bob');
  ok(true, '群聊文本从 B 送达 A');

  console.log('4. 引用回复、撤回与本机删除');
  const bobMsgId = await itemId(pageA, group.id, '收到了，我是 Bob');
  await pageA.evaluate(({ roomId, text }) => {
    const room = MY.state.rooms.get(roomId);
    const item = room.events.find((e) => e.text === text);
    MY.chat.setReply(item);
  }, { roomId: group.id, text: '收到了，我是 Bob' });
  await send(pageA, '这是一条引用回复');
  await pageB.waitForFunction(({ roomId, id }) => {
    const room = MY.state.rooms.get(roomId);
    return !!room && room.events.some((e) => e.text === '这是一条引用回复' && e.replyTo && e.replyTo.id === id);
  }, { roomId: group.id, id: bobMsgId }, { timeout: 20000 });
  ok(true, '引用回复带上了原消息信息');

  await send(pageA, '两分钟内可以撤回');
  await waitText(pageB, group.id, '两分钟内可以撤回');
  await pageA.waitForFunction(({ roomId, text }) => {
    const room = MY.state.rooms.get(roomId);
    const item = room && room.events.find((e) => e.text === text);
    return !!item && item.status === 'ok';
  }, { roomId: group.id, text: '两分钟内可以撤回' }, { timeout: 15000 });
  await pageA.evaluate(({ roomId, text }) => {
    const room = MY.state.rooms.get(roomId);
    const item = room.events.find((e) => e.text === text);
    return MY.chat.recall(item);
  }, { roomId: group.id, text: '两分钟内可以撤回' });
  await pageB.waitForFunction(({ roomId, text }) => {
    const room = MY.state.rooms.get(roomId);
    const item = room && room.events.find((e) => e.text === text);
    return !!item && item.recalled;
  }, { roomId: group.id, text: '两分钟内可以撤回' }, { timeout: 20000 });
  ok(true, '撤回同步到对方并显示为已撤回');

  await send(pageB, '这条只在我本机删除');
  await waitText(pageA, group.id, '这条只在我本机删除');
  await pageB.evaluate(({ roomId, text }) => {
    const room = MY.state.rooms.get(roomId);
    const item = room.events.find((e) => e.text === text);
    return MY.chat.deleteForMe(item);
  }, { roomId: group.id, text: '这条只在我本机删除' });
  const deletedLocally = await pageB.evaluate(({ roomId, text }) => {
    const room = MY.state.rooms.get(roomId);
    return !!room && !room.events.some((e) => e.text === text);
  }, { roomId: group.id, text: '这条只在我本机删除' });
  const stillOnA = await pageA.evaluate(({ roomId, text }) => {
    const room = MY.state.rooms.get(roomId);
    return !!room && room.events.some((e) => e.text === text);
  }, { roomId: group.id, text: '这条只在我本机删除' });
  ok(deletedLocally && stillOnA, '“仅删除本机”只影响删除方');

  console.log('5. 私聊（NIP-59 礼物包装）');
  await pageA.evaluate(async (pub) => {
    await MY.chat.openDM(pub, 'Bob');
  }, pubB);
  await send(pageA, 'Bob，这是私聊消息');
  await pageB.waitForFunction(({ pub, text }) => {
    const room = [...MY.state.rooms.values()].find((r) => r.type === 'dm' && r.peerPub === pub);
    return !!room && room.events.some((e) => e.text === text);
  }, { pub: pubA, text: 'Bob，这是私聊消息' }, { timeout: 25000 });
  ok(true, '私聊消息解密并送达');

  await pageB.evaluate(async (pub) => {
    await MY.chat.openDM(pub, 'Alice');
  }, pubA);
  await send(pageB, 'Alice，私聊回复');
  await pageA.waitForFunction(({ pub, text }) => {
    const room = [...MY.state.rooms.values()].find((r) => r.type === 'dm' && r.peerPub === pub);
    return !!room && room.events.some((e) => e.text === text);
  }, { pub: pubB, text: 'Alice，私聊回复' }, { timeout: 25000 });
  ok(true, '私聊双向通信正常');

  await pageB.waitForFunction(({ pub, text }) => {
    const room = [...MY.state.rooms.values()].find((r) => r.type === 'dm' && r.peerPub === pub);
    const item = room && room.events.find((e) => e.text === text);
    return !!item && item.status === 'ok';
  }, { pub: pubA, text: 'Alice，私聊回复' }, { timeout: 15000 });
  await pageB.evaluate(({ pub, text }) => {
    const room = [...MY.state.rooms.values()].find((r) => r.type === 'dm' && r.peerPub === pub);
    const item = room.events.find((e) => e.text === text);
    return MY.chat.recall(item);
  }, { pub: pubA, text: 'Alice，私聊回复' });
  await pageA.waitForFunction(({ pub, text }) => {
    const room = [...MY.state.rooms.values()].find((r) => r.type === 'dm' && r.peerPub === pub);
    const item = room && room.events.find((e) => e.text === text);
    return !!item && item.recalled;
  }, { pub: pubB, text: 'Alice，私聊回复' }, { timeout: 25000 });
  ok(true, '私聊撤回正常');

  console.log('6. 文件传输');
  const filePath = join(tempDir, 'smoke.bin');
  const fileBytes = Buffer.alloc(150 * 1024);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 37 + 11) % 256;
  writeFileSync(filePath, fileBytes);
  await pageA.evaluate((id) => MY.chat.switchRoom(id), group.id);
  await pageB.evaluate((id) => MY.chat.switchRoom(id), group.id);
  await pageA.setInputFiles('#fileInput', filePath);
  await pageB.waitForFunction(({ roomId, name }) => {
    const room = MY.state.rooms.get(roomId);
    const item = room && room.events.find((e) => e.fileMeta && e.fileMeta.name === name);
    return !!item && item.fileProgress === 1 && item.transferState === 'ok';
  }, { roomId: group.id, name: 'smoke.bin' }, { timeout: 60000 });
  const received = await pageB.evaluate(async ({ roomId, name }) => {
    const room = MY.state.rooms.get(roomId);
    const item = room.events.find((e) => e.fileMeta && e.fileMeta.name === name && e.downloadUrl);
    if (!item) return null;
    const buf = await (await fetch(item.downloadUrl)).arrayBuffer();
    return { size: buf.byteLength, head: Array.from(new Uint8Array(buf).slice(0, 24)) };
  }, { roomId: group.id, name: 'smoke.bin' });
  ok(received && received.size === fileBytes.length, '文件完整送达（大小一致）', received && received.size);
  ok(received && Buffer.from(received.head).equals(fileBytes.subarray(0, 24)), '文件内容哈希前缀一致');

  console.log('7. 加密群聊');
  const locked = await pageA.evaluate(async () => {
    const room = await MY.chat.createRoom({ label: '加密冒烟群', password: 'room-pass-9' });
    return { id: room.id, code: MY.chat.inviteCode(room) };
  });
  await pageB.evaluate(async ({ code }) => {
    await MY.chat.joinRoom({ code, password: 'room-pass-9' });
  }, locked);
  const unlocked = await pageB.evaluate((id) => {
    const room = MY.state.rooms.get(id);
    return !!(room && room.key);
  }, locked.id);
  ok(unlocked, '加密群聊使用密码解锁');
  await send(pageA, '加密群里的明文');
  await waitText(pageB, locked.id, '加密群里的明文');
  ok(true, '加密群聊消息可读');
  await pageB.evaluate((id) => MY.chat.switchRoom(id), locked.id);
  await send(pageB, '加密群回复');
  await waitText(pageA, locked.id, '加密群回复');
  ok(true, '加密群聊双向通信正常');

  await pageA.evaluate((id) => MY.chat.switchRoom(id), group.id);
  await pageA.screenshot({ path: join(shotsDir, 'smoke-group.png') });
  await pageB.evaluate((id) => MY.chat.switchRoom(id), group.id);
  await pageB.screenshot({ path: join(shotsDir, 'smoke-group-b.png') });

  console.log('8. 重新加载与持久化');
  await pageB.reload({ waitUntil: 'domcontentloaded' });
  await pageB.waitForFunction(() => {
    const view = document.getElementById('authUnlockView');
    return view && !view.classList.contains('hidden') && document.getElementById('unlockPassword');
  }, null, { timeout: 20000 });
  await pageB.fill('#unlockPassword', 'pass-5678');
  await pageB.click('#btnUnlockSubmit');
  await pageB.waitForFunction(() => MY.state.ready && MY.state.pub, null, { timeout: 30000 });
  await pageB.evaluate((id) => MY.chat.switchRoom(id), group.id);
  const persisted = await pageB.evaluate(({ id, text }) => {
    const room = MY.state.rooms.get(id);
    const has = room && room.events.some((e) => e.text === text);
    const hasDeleted = room && room.events.some((e) => e.text === '这条只在我本机删除');
    return { has, hasDeleted };
  }, { id: group.id, text: '你好，这是来自 Alice 的群消息' });
  ok(persisted.has, '重新登录后消息仍在');
  ok(!persisted.hasDeleted, '“仅删除本机”在重载后仍保持删除');
  const keyRestored = await pageB.evaluate((id) => {
    const room = MY.state.rooms.get(id);
    return !!(room && room.key);
  }, locked.id);
  ok(keyRestored, '加密群密钥随账户恢复');
  await pageB.evaluate((id) => MY.chat.switchRoom(id), locked.id);
  await send(pageB, '重载后的加密消息');
  await waitText(pageA, locked.id, '重载后的加密消息');
  ok(true, '重载后仍可发送加密消息');

  console.log('9. 运行时错误检查');
  const runtimeErrors = errors.filter((e) => !/pageerror:.*ResizeObserver/i.test(e));
  ok(runtimeErrors.length === 0, '无未捕获的页面错误', runtimeErrors.slice(0, 6));
  if (runtimeErrors.length) console.error(runtimeErrors.join('\n'));
} catch (err) {
  failed++;
  console.error('测试异常：', err && err.stack ? err.stack : err);
  errors.push(String(err && err.message ? err.message : err));
} finally {
  try { if (browser) await browser.close(); } catch { /* 忽略 */ }
  try { if (site) await site.close(); } catch { /* 忽略 */ }
  try { if (relay) await relay.stop(); } catch { /* 忽略 */ }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (errors.length) {
  console.log('错误记录：');
  for (const e of errors.slice(0, 20)) console.log('  -', e);
}
process.exit(failed ? 1 : 0);
