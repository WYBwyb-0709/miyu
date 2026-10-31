/* ══════════════════════════════════════════════════════════
   store-room-isolation.mjs · 会话删除的数据隔离回归测试
   运行：node tests/store-room-isolation.mjs
   覆盖：IndexedDB 与 localStorage 降级两种存储后端
   ══════════════════════════════════════════════════════════ */
import { chromium } from 'playwright-core';
import { startStaticServer } from '../scripts/static-server.mjs';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = 'room-isolation-test';
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
    await MY.store.deleteRoom(roomA);
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
  if (disableIdb) {
    ok(data.aFallback === null, 'fallback：被清空房间的 blob 键已删除');
    ok(!!data.bFallback, 'fallback：其他房间的 blob 键仍存在');
  }
  await context.close();
}

const site = await startStaticServer({ root: join(root, 'app/www'), port: 0 });
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
} catch (err) {
  failed++;
  console.error('测试异常：', err && err.stack ? err.stack : err);
} finally {
  try { if (browser) await browser.close(); } catch { /* 忽略 */ }
  try { await site.close(); } catch { /* 忽略 */ }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
