#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════
   server.js · 命令行启动器
   ══════════════════════════════════════════════════════════ */
import { startRelay } from './core.js';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultData = resolve(here, '..', 'data', 'events.jsonl');

const port = Number(process.env.RELAY_PORT || process.env.PORT || 7777);
const lan = process.env.RELAY_LAN === '1' || process.env.HOST === '0.0.0.0';
const host = process.env.HOST || (lan ? '0.0.0.0' : '127.0.0.1');
const dataFile = process.env.RELAY_DATA ? resolve(process.env.RELAY_DATA) : defaultData;

try { mkdirSync(dirname(dataFile), { recursive: true }); } catch { /* 忽略 */ }

const relay = await startRelay({
  host,
  port,
  dataFile,
  name: process.env.RELAY_NAME || '密语本机中继',
});

console.log(`密语中继已启动`);
console.log(`  WebSocket : ${relay.url}`);
console.log(`  局域网    : ${lan ? relay.lanUrl : '未开启（设置 HOST=0.0.0.0 开启）'}`);
console.log(`  健康检查  : http://127.0.0.1:${relay.port}/health`);
console.log(`  数据文件  : ${dataFile}`);
if (lan) console.log('  提示      : 局域网模式会监听所有网卡，请只在可信网络使用。');

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n收到 ${signal}，正在关闭…`);
  try { await relay.stop(); } catch { /* 忽略 */ }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
