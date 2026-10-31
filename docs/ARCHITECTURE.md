# 协议与实现架构

## 总览

```text
┌──────────────────────────────┐
│ app/www  (HTML/CSS/JS)       │
│                              │
│  auth / state / store        │
│  chat / files / ui / net     │
│  vendor: nostr-tools+fflate  │
└──────────────┬───────────────┘
               │ WebSocket (Nostr NIP-01)
      ┌────────┴─────────┐
      │                  │
┌─────▼─────┐      ┌─────▼──────────────┐
│ 本机中继   │      │ 公共 / 自建中继      │
│ relay/    │      │ wss://...           │
│ JSONL     │      └────────────────────┘
└───────────┘
      ▲
      │ ws://127.0.0.1:7777
┌─────┴──────────────────────────────┐
│ Electron 主进程                      │
│ 窗口 / 托盘 / 通知 / 中继生命周期     │
└─────────────────────────────────────┘

Android: Capacitor 壳加载同一份 app/www，无内置中继
PWA:     浏览器直接加载 app/www
```

前端不依赖任何运行时 CDN。`nostr-tools` 与 `fflate` 由 esbuild 打包进 `app/www/vendor/miyu-vendor.js`。

## 身份与账户

- 密钥：`nostr-tools/pure.generateSecretKey()` 生成 32 字节 secp256k1 私钥。
- 公钥：`getPublicKey()`，64 位十六进制，作为联系人地址。
- 本机存储：私钥以 NIP-49 `ncryptsec` 形式保存在 `localStorage`，密码经 scrypt 派生（`nip49.encrypt(sk, password, 16, 0x02)`）。
- 解锁：输入密码解密 `ncryptsec`，私钥只存在于内存。
- 导出：直接导出 `ncryptsec`；对方仍需密码才能使用。
- 换账户：旧账户的 IndexedDB 与 localStorage 房间/联系人数据会被清理。

这是“本地账户”模型，没有服务器登录、密码重置或设备管理。密码丢失等于账户丢失。

## 群聊

### 房间 ID 与邀请

创建群聊时生成：

```text
miyu-<名称摘要>-<hash>-<uuid片段>
```

群聊事件使用 NIP-01 kind `1`，并带标签：

```json
["t", "miyu-xxx"]
```

订阅使用 `{"#t": ["miyu-xxx"]}`。邀请码是 Base64URL 编码的 JSON：

```json
{
  "v": 1,
  "id": "miyu-xxx",
  "label": "群聊名称",
  "enc": 1,
  "verifier": "AES-GCM 密文"
}
```

`verifier` 用于在本地验证输入的密码是否正确，不包含密码本身。邀请码可以公开传递，但加密群仍需另一条安全渠道告知密码。

### 公开群聊

没有设置密码时：

- 消息正文、文件名、发送者名称都是明文事件。
- 任何知道 `t` 标签/群聊 ID 的人都能订阅。
- 适合公开讨论，不适合敏感内容。

### 加密群聊

设置密码时：

1. `PBKDF2-SHA256(password, roomId, 210000)` 派生 256 位房间密钥。
2. 消息正文使用 `AES-256-GCM`，随机 12 字节 IV，密文为 `base64(IV || ciphertext || tag)`。
3. 房间密钥在本机使用账户私钥经 HKDF-SHA256 派生的包装密钥加密后保存（`wrappedKey`），解锁账户后自动恢复。
4. 文件先压缩（仅文本类）、再用同一房间密钥加密，然后分片。
5. 邀请码携带 `verifier`，加入者输入密码后本地验证。

边界：

- 群聊 ID、`t` 标签、发送者公钥、时间戳、事件大小仍是公开元数据。
- 房间密钥在成员之间共享，修改密码不会自动轮换历史消息密钥；没有成员移除/重新加密机制。
- 密码强度决定离线暴力破解难度。请使用足够长的随机密码。

### 成员

成员信息来自各客户端发送的 kind `1` 事件标签和 `_miyu_join` 控制消息：

```json
{"_miyu_join":1,"name":"显示名"}
```

客户端按最近活动时间维护成员列表。没有中心化成员表、群主/管理员、踢人或入群审批。

## 私聊

私聊使用 NIP-59 gift wrap：

1. 构造 rumor（未签名事件，kind `1` 或 `5`）。
2. 用发送者私钥与收件人公钥的 NIP-44 会话密钥加密 rumor，生成 kind `13` seal，并由发送者签名。
3. 生成一次性随机私钥，用其与收件人公钥的 NIP-44 会话密钥加密 seal，生成 kind `1059` gift wrap。
4. 发布 gift wrap，标签 `["p", 收件人公钥]`。
5. 收件人用自己私钥解包两层，校验 seal 签名与 rumor 发送者一致。

中继只能看到：

- gift wrap 的随机公钥、收件人 `p` 标签、时间、密文长度。

看不到正文、发送者真实公钥（除非通过其他元数据关联）或消息类型。私聊删除/撤回同样以 gift wrap 包裹 kind `5`。

## 消息删除与撤回

### 仅在本机删除

- 从 IndexedDB 删除事件与文件 Blob。
- 在房间 `hidden` 集合记录事件 ID，后续同步时跳过。
- 不向中继发布任何内容。

### 撤回 / 删除所有人

- 仅允许发送者、2 分钟内、未删除的消息。
- 群聊：发布 kind `5`，`e` 标签指向目标事件，附带 `t` 房间标签。
- 私聊：kind `5` 放入 NIP-59 gift wrap。
- 本机立即标记为“已撤回”，并记录 `pendingRecalls`。
- 中继收到 kind `5` 后，仅当目标事件作者与删除事件作者一致时才删除目标；同时写入 tombstone，防止旧事件重新上传。
- 其他客户端收到 kind `5` 后把对应消息标记为“撤回了一条消息”，文件分片也会被隐藏。
- 文件消息的撤回会带上所有分片事件 ID（最多 200 个）。

限制：

- 撤回依赖客户端处理删除事件。恶意客户端可以在收到后保留副本。
- 中继删除后，离线很久的客户端重新同步可能看不到原消息，只能看到删除事件（如果它还保留）。
- 删除事件本身仍保留在中继，用于证明删除操作。

## 文件传输

- 单文件上限 15 MiB。
- 分片大小 24 KiB。
- 文本类文件（按 MIME/扩展名判断）大于 512 字节时先 deflate 压缩，压缩率不足 92% 则放弃压缩。
- 加密顺序：压缩 → SHA-256 → AES-GCM（群聊房间密钥或私聊派生密钥）→ Base64 → 分片。
- 每个分片是一个 kind `1` 事件，内容为 JSON：

```json
{
  "_miyu_file": 1,
  "mid": "传输 ID",
  "i": 0,
  "n": 12,
  "name": "报告.pdf",
  "mime": "application/pdf",
  "size": 123456,
  "engine": "none",
  "enc": true,
  "hash": "原始传输字节的 SHA-256",
  "data": "base64..."
}
```

- 接收端按 `mid` 聚合分片，缺片时发送控制消息：

```json
{"_miyu_need":1,"mid":"...","missing":[3,7]}
```

- 发送端保留分片事件，收到补发请求后重发缺失分片。
- 接收端最多等待 20 分钟、重试 10 次；完成后校验 SHA-256，再解密、解压。
- 图片在聊天中直接预览；其他文件通过 Blob 下载或 Android 系统分享。

## 中继实现

`relay/src/core.js` 是单文件 WebSocket 中继，可被 Electron 进程内加载，也可由 `relay/src/server.js` 独立运行。

- NIP-01：`EVENT`、`REQ`、`CLOSE`、`EOSE`、`OK`、`NOTICE`、`CLOSED`
- NIP-09：kind `5` 删除，作者校验 + tombstone
- NIP-11：`Accept: application/nostr+json` 返回 relay 信息
- NIP-40：`expiration` 标签过期清理
- NIP-45：`COUNT` 订阅计数
- 未实现 NIP-42 身份认证，写操作不要求登录
- 存储：追加写入 JSONL，启动时重放；行数明显多于有效事件时压缩重写
- 索引：kind、作者、标签；查询按过滤器候选集合并按 `created_at` 排序
- 限制：单条消息 700 KiB、内容 500 KiB、最多 5000 标签、最多 8 个过滤器、24 个订阅、查询上限 2000
- 限流：每连接令牌桶，初始 1200，恢复 160/秒
- 心跳：30 秒 ping/pong；每分钟清理过期事件
- HTTP：`/health` 健康检查，`/` 简单状态页

桌面端通过 esbuild 把 `core.js` 打成 `desktop/relay-bundle.cjs`，在 Electron 主进程启动，默认只监听 `127.0.0.1`；开启局域网后监听 `0.0.0.0`。

## 前端模块

| 文件 | 职责 |
|---|---|
| `core.js` | DOM/编码/时间工具、常量、通知、文件下载 |
| `store.js` | IndexedDB：事件、Blob、KV；按账户隔离 |
| `net.js` | SimplePool 封装、发布重试、订阅、连接状态 |
| `state.js` | 当前账户、房间、联系人、资料、设置 |
| `crypto.js` | PBKDF2、AES-GCM、房间密钥包装、私聊文件密钥 |
| `auth.js` | 创建/解锁/导入/导出/退出 |
| `chat.js` | 群聊/私聊协议、撤回、删除、邀请、补拉 |
| `files.js` | 文件压缩/加密/分片/重组/补发 |
| `ui.js` | 会话列表、消息渲染、菜单、弹层、文件气泡 |
| `app.js` | 启动、设置、桌面 IPC、Android 生命周期 |

## 存储

- IndexedDB 数据库按账户公钥隔离。
- 事件表保存消息元数据；Blob 表保存接收/发送的文件；KV 表保存 hidden、recall、设置等。
- `localStorage` 保存账户 `ncryptsec`、用户名、公钥、房间列表、联系人、界面设置。
- Windows 便携版把整个 WebView 数据目录放在 `MiyuData/`；中继事件在 `MiyuData/relay-data/events.jsonl`。
- Android 数据在应用私有目录，卸载即删除。
- PWA 数据在浏览器站点存储中，清除站点数据即删除。

## 构建链

- 前端：原生 ES5+/ES2020 浏览器代码，无框架、无构建步骤（vendor 除外）。
- vendor：`scripts/build-vendor.mjs` → esbuild IIFE → `app/www/vendor/miyu-vendor.js`。
- Windows：Electron 45 + electron-builder 26 → portable NSIS EXE。
- Android：Capacitor 8.6 → Gradle 8.14.3 → debug/release APK。
- PWA：静态文件 + `manifest.webmanifest` + `sw.js`。

## 兼容性

- Windows 10/11 x64
- Android 13–16（API 33–36）
- 现代 Chromium 内核浏览器（Edge/Chrome）
- 需要 WebCrypto、IndexedDB、WebSocket；PWA 安装另需安全上下文
