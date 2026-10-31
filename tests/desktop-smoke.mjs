/* ══════════════════════════════════════════════════════════
   desktop-smoke.mjs · Electron 桌面端启动与 IPC 冒烟测试
   运行：node tests/desktop-smoke.mjs
   ══════════════════════════════════════════════════════════ */
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = mkdtempSync(join(tmpdir(), 'miyu-desktop-smoke-'));
const shotsDir = resolve(root, 'dist/screenshots');
mkdirSync(shotsDir, { recursive: true });

let passed = 0;
let failed = 0;
const errors = [];

function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.error('  ✗', label, extra == null ? '' : extra); }
}

const executablePath = resolve(root, 'desktop/node_modules/electron/dist/electron.exe');
let electronApp = null;

try {
  if (!existsSync(executablePath)) throw new Error('Electron 未安装：' + executablePath);
  console.log('1. 启动 Electron 主进程');
  electronApp = await electron.launch({
    executablePath,
    args: ['.'],
    cwd: join(root, 'desktop'),
    env: { ...process.env, MIYU_USER_DATA: tempDir, MIYU_TEST: '1' },
    timeout: 60000,
  });
  const page = await electronApp.firstWindow({ timeout: 30000 });
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/favicon|WebSocket is already in CLOSING or CLOSED/i.test(text)) return;
    errors.push('console: ' + text);
  });

  await page.waitForFunction(() => window.MY && MY.state && document.getElementById('btnCreateSubmit'), null, { timeout: 30000 });
  ok(true, '桌面窗口加载应用');

  const cfg = await page.evaluate(() => window.miyuDesktop.getConfig());
  ok(!!cfg && cfg.relayRunning === true, '内置中继已启动', cfg);
  ok(/^ws:\/\/127\.0\.0\.1:\d+$/.test(cfg.relayUrl || ''), '中继地址正确', cfg.relayUrl);
  ok(cfg.platform === 'win32', '识别 Windows 平台');

  console.log('2. 创建账户与发送消息');
  await page.fill('#createUsername', '桌面测试');
  await page.fill('#createPassword', 'desk-pass-1');
  await page.fill('#createPasswordConfirm', 'desk-pass-1');
  await page.click('#btnCreateSubmit');
  await page.waitForFunction(() => MY.state.ready && MY.state.pub && document.getElementById('authOverlay').classList.contains('hidden'), null, { timeout: 30000 });
  ok(true, '账户创建并进入主界面');

  await page.waitForFunction(() => MY.net.status().connected >= 1, null, { timeout: 20000 });
  ok(true, '客户端连接到本机中继');

  const groupId = await page.evaluate(async () => {
    const room = await MY.chat.createRoom({ label: '桌面冒烟群', password: '' });
    return room.id;
  });
  await page.fill('#msgInput', '来自 Electron 桌面端的消息');
  await page.click('#sendBtn');
  await page.waitForFunction(({ id, text }) => {
    const room = MY.state.rooms.get(id);
    const item = room && room.events.find((e) => e.text === text);
    return !!item && item.status === 'ok';
  }, { id: groupId, text: '来自 Electron 桌面端的消息' }, { timeout: 20000 });
  ok(true, '消息发布并确认成功');

  console.log('3. 局域网中继开关');
  const lanOn = await page.evaluate(() => window.miyuDesktop.setLan(true));
  ok(lanOn && lanOn.lanEnabled === true && lanOn.relayRunning === true, '开启局域网中继', lanOn && lanOn.lanUrls);
  await page.waitForFunction(() => MY.state.desktop && MY.state.desktop.lanEnabled === true, null, { timeout: 10000 });
  ok(true, '渲染层收到配置变化事件');
  const lanOff = await page.evaluate(() => window.miyuDesktop.setLan(false));
  ok(lanOff && lanOff.lanEnabled === false && lanOff.relayRunning === true, '关闭局域网中继并保持可用');

  console.log('4. 原生通知与界面');
  const notify = await page.evaluate(() => window.miyuDesktop.notify('密语冒烟测试', '桌面通知调用正常', ''));
  ok(notify && notify.ok === true, '原生通知 IPC 正常');
  await page.screenshot({ path: join(shotsDir, 'desktop.png') });
  const title = await page.title();
  ok(/密语/.test(title), '窗口标题正确');

  await page.waitForTimeout(600);
  ok(errors.length === 0, '无未捕获的页面错误', errors.slice(0, 5));
} catch (err) {
  failed++;
  console.error('测试异常：', err && err.stack ? err.stack : err);
} finally {
  try { if (electronApp) await electronApp.close(); } catch { /* 忽略 */ }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
