# 密语 · Miyu

免费、去中心化的私密聊天应用。界面和交互接近微信，核心消息走 [Nostr](https://nostr.com/) 协议，不依赖手机号、邮箱或中心化账户服务器。

支持 **Windows 10/11**、**Android 13–16**，同时提供可安装的 **PWA**。

![密语桌面端](dist/screenshots/desktop.png)

## 直接使用

仓库的 `dist/` 目录内有已构建好的安装包：

| 平台 | 文件 | 大小 | 说明 |
|---|---|---|---|
| Windows 10/11 x64 | `dist/Miyu-1.0.0-portable.exe` | 105.2 MiB | 便携版，无需安装 |
| Android 13–16 | `dist/Miyu-1.0.0-android-debug.apk` | 9.5 MiB | debug 签名，可直接安装 |

SHA-256：

```text
Miyu-1.0.0-portable.exe       C22C5A0F714D3C1E4BCE54FCE3899FB15706899822B326E022F09DB83364D8BE
Miyu-1.0.0-android-debug.apk  0D280A3DAD8EB80DC3397763EA9C5CE228BAA494649122D0A7763855C0C6E70C
```

> Windows SmartScreen 可能提示“未知发布者”，因为安装包没有商业代码签名证书。选择“更多信息 → 仍要运行”即可。
>
> Android 安装时需要允许“安装未知应用”。本 APK 使用 Android debug 密钥签名，适合自用和测试；正式分发建议按 [Android 文档](docs/ANDROID.md) 生成自己的 release 签名。

## 功能

### 账户与身份

- 首次启动在本机生成 Nostr 密钥，不注册、不绑定手机号或邮箱
- 用户名 + 密码；密码只用于在本机加密身份密钥（NIP-49 / `ncryptsec`）
- 导出 `ncryptsec` 凭证，在另一台设备导入恢复账户、房间和联系人
- 修改显示名称、头像；可选择是否随消息共享头像
- 退出登录会清除本机账户与聊天数据，请先导出凭证

### 聊天

- **群聊**：创建、通过邀请码加入、群聊信息、成员列表、邀请码复制、群名修改
- **私聊**：使用 64 位 Nostr 公钥添加联系人并开始私聊
- **端到端加密私聊**：NIP-59 礼物包装 + NIP-44 v2；中继只看到密文和收件人公钥
- **可选加密群聊**：设置房间密码后，消息与文件使用 PBKDF2 + AES-256-GCM 加密
- 文本消息（最长 4000 字）、表情选择、引用回复、复制文字
- 会话内搜索、会话列表搜索、联系人搜索
- 未读数、置顶、免打扰、删除会话、退出群聊
- 消息撤回（2 分钟内，双方客户端生效，NIP-09）与“仅在本机删除”
- 文件与图片发送，单文件最大 15 MiB，分片传输、断片重试、SHA-256 校验
- 图片预览、文件下载/系统分享
- 新消息通知、提示音、窗口隐藏时继续接收
- 浅色 / 深色 / 跟随系统，7 种主题色，4 档字号
- 发送键可选 Enter、Ctrl+Enter 或两者皆可
- 中文界面，桌面与移动端自适应

### 桌面端

- 内置本机 Nostr 中继（默认 `ws://127.0.0.1:7777`），断网也能在同一台电脑内聊天
- 局域网中继开关，Android 设备可连接电脑的中继
- 系统托盘、关闭到托盘、托盘菜单、单实例运行
- Windows 原生通知，点击通知跳转到对应会话
- 窗口大小/位置记忆、崩溃自动重载
- 便携版数据保存在 EXE 同级的 `MiyuData/`

### Android

- Capacitor 原生壳，支持 Android 13–16（minSdk 33，targetSdk 36）
- 系统返回键、生命周期、软键盘适配
- Android 通知渠道与通知权限
- 文件保存/分享走系统分享面板
- 可连接电脑的局域网中继，也可直接使用公共中继

### PWA

- 可添加到主屏幕，应用外壳离线缓存
- 与桌面/Android 共用同一套 HTML/CSS/JS
- 安装方式和 HTTPS 要求见 [PWA 文档](docs/PWA.md)

## 不包含的功能

按照需求，本版本不包含：小程序、二维码扫描、音视频通话、位置共享、语音/视频消息、支付、红包、拍一拍、公众号/服务号。

本版本聚焦聊天核心，也不包含朋友圈、视频号、看一看、搜一搜等社交广场模块。

## 快速开始

1. 启动应用，输入用户名和密码创建账户。
2. 点“发起私聊”，粘贴对方的 64 位公钥；或点“新建群聊”创建群聊。
3. 在群聊信息里复制邀请码，发给朋友；对方点“加入群聊”粘贴邀请码。
4. 加密群聊需要把房间密码通过另一条安全渠道告诉成员，邀请码本身不含密码。
5. 桌面端可在“设置 → 中继服务器”开启局域网中继，Android 在同一个 Wi-Fi 下添加 `ws://电脑IP:7777`。

> 首次使用请立即在“设置 → 账户导出凭证”生成并妥善保存 `ncryptsec`。忘记密码无法找回账户。

## 联网方式

### 桌面端本机中继

Windows 版启动时自动运行本机中继，数据写入：

```text
<EXE 所在目录>/MiyuData/relay-data/events.jsonl
```

同一台电脑上的客户端通过 `ws://127.0.0.1:7777` 连接。端口被占用时会自动换一个空闲端口，设置页会显示实际地址。

### 局域网中继

在桌面端“设置 → 中继服务器”打开“允许局域网设备连接本机中继”，或在托盘菜单勾选“局域网中继”。设置页会显示类似：

```text
ws://192.168.1.23:7777
```

Android 与电脑连同一个 Wi-Fi，在 Android 的“设置 → 中继服务器”添加这个地址并保存。Windows 防火墙首次询问时需允许专用网络访问。

> 局域网模式监听所有网卡，同一网络中的其他人也能连接该中继。只建议在可信 Wi-Fi 使用。

### 公共中继

默认还配置了：

```text
wss://relay.damus.io
wss://nos.lol
wss://relay.nostr.band
```

公共中继用于无法直连本机中继时兜底。它们可能限流、丢事件或保留时间有限；重要聊天建议使用自己的本机/局域网中继。可在设置中增删中继地址。

## 项目结构

```text
app/www/                 前端应用（HTML/CSS/JS，Electron 与 Capacitor 共用）
  index.html             主界面
  css/app.css            全部样式
  js/core.js             工具、常量、通知、下载
  js/store.js            IndexedDB 存储
  js/net.js              中继连接与发布
  js/state.js            账户/联系人/设置状态
  js/crypto.js           AES-GCM、PBKDF2、房间密钥包装
  js/auth.js             创建/解锁/导入/导出账户
  js/chat.js             群聊、私聊、撤回、删除、邀请
  js/files.js            分片加密文件传输
  js/ui.js               渲染、菜单、弹层
  js/app.js              启动、设置、桌面/原生桥接
  vendor/miyu-vendor.js  打包后的 nostr-tools + fflate
  sw.js / manifest.webmanifest

relay/src/core.js        单文件 Nostr 中继（NIP-01/09/11/40/45）
relay/src/server.js      中继命令行入口
desktop/                 Electron 主进程、预加载桥、打包配置
android/                 Capacitor Android 工程
scripts/                 构建、图标、静态服务器、中继测试
tests/                   浏览器双账户 E2E、Electron 冒烟测试
docs/                    构建、PWA、架构与安全文档
dist/                    已构建产物与测试截图
```

## 从源码构建

### 环境要求

- Node.js 22 或更高（当前验证版本 26.12.0）
- Windows 10/11 x64（构建 Windows 便携版）
- Android 构建：JDK 21、Android SDK Platform 36、Build-Tools 36.0.0
- 首次构建需要网络下载 Electron / Gradle 依赖

### 安装依赖

```powershell
npm ci
npm ci --prefix desktop
npm ci --prefix relay
```

### 重新生成前端 vendor 包

修改 `scripts/vendor-entry.js` 或升级 `nostr-tools` 后：

```powershell
npm run vendor
```

### Windows 便携版

```powershell
cd desktop
npm run dist
```

产物：`dist/Miyu-1.0.0-portable.exe`。

只解包、不生成安装包：

```powershell
cd desktop
npm run pack
```

### Android APK

先同步前端资源，再构建：

```powershell
npx cap sync android
cd android
.\gradlew.bat assembleDebug --no-daemon
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`。

Gradle 内存占用默认已调低（`-Xmx1024m`、2 个 worker），适合 4 GB 内存机器。完整步骤、签名与常见问题见 [docs/ANDROID.md](docs/ANDROID.md)。

### PWA

```powershell
npm run serve
```

浏览器打开 `http://127.0.0.1:8080`。局域网安装需要 HTTPS，详见 [docs/PWA.md](docs/PWA.md)。

## 测试

```powershell
npm run test:relay      # 中继协议测试，23 项
npm run test:browser    # 双账户浏览器 E2E，23 项
npm run test:desktop    # Electron 桌面端冒烟，13 项
```

浏览器测试使用系统 Edge/Chrome。测试会启动随机端口的中继与静态服务器，生成截图到 `dist/screenshots/`。

## 数据与恢复

| 数据 | 位置 |
|---|---|
| Windows 账户、消息、文件缓存 | `MiyuData/`（便携版 EXE 同级） |
| Windows 本机中继事件 | `MiyuData/relay-data/events.jsonl` |
| Android 账户与消息 | 应用私有存储（WebView IndexedDB / localStorage） |
| 账户恢复凭证 | 设置页导出的 `ncryptsec` 字符串 |

- 换设备：在旧设备导出 `ncryptsec`，在新设备“导入账户”，输入同一密码和显示名称。房间列表、联系人、加密群密钥会随账户恢复；历史消息不会自动从旧设备迁移，需中继仍保留事件。
- 忘记密码：无法解密本机账户，只能重新创建账户。没有中心化客服可以重置。
- 清理本机消息：只删除本设备缓存，不影响中继和其他设备。
- 卸载 Android 应用会删除应用私有数据，请先导出凭证。

## 安全模型与限制

密语不是“匿名 Guaranteed”工具，使用前请理解以下边界。完整说明见 [docs/SECURITY.md](docs/SECURITY.md)。

- 私聊使用 NIP-59 + NIP-44 端到端加密；中继能看到发送时间、收件人公钥和事件大小，但看不到正文。
- 未设置密码的群聊是公开群聊，任何知道群聊 ID 的人都能订阅和阅读。
- 加密群聊正文和文件加密，但群聊 ID、`t` 标签、发送者公钥、时间等元数据仍可能被中继观察。
- 群成员列表来自成员自己发送的加入/消息信息，没有中心化成员认证；没有群主、管理员、踢人功能。
- 撤回和“删除所有人”依赖各客户端处理删除事件；离线客户端重新同步时若中继已删除事件则看不到，恶意客户端仍可能保留已收到的内容。
- 本机中继没有 NIP-42 身份认证；开启局域网时，同网段设备可连接。请只在可信网络使用。
- 公共中继由第三方运营，可能记录元数据、限流或删除事件。敏感聊天请使用自己控制的中继。
- 单文件上限 15 MiB；消息上限 4000 字；撤回窗口 2 分钟。
- 没有离线推送服务。Android 应用被系统杀死后不会收到消息，重新打开会从已连接中继补拉。
- 本版本未实现朋友圈、音视频通话、位置、支付、红包、小程序、二维码、公众号等模块。

## 文档

- [Android 构建、安装与签名](docs/ANDROID.md)
- [PWA 部署与安装](docs/PWA.md)
- [协议与实现架构](docs/ARCHITECTURE.md)
- [安全模型](docs/SECURITY.md)

## 许可

MIT，见 [LICENSE](LICENSE)。第三方依赖保留各自许可证。
