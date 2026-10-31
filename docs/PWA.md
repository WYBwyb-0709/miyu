# PWA 部署与安装

密语前端是一个标准 PWA：`app/www/manifest.webmanifest` 提供安装信息，`app/www/sw.js` 只缓存应用外壳，不缓存聊天数据。

## 本机预览

在仓库根目录：

```powershell
npm run serve
```

默认监听 `http://127.0.0.1:8080`，并托管 `app/www`。

打开浏览器访问 `http://127.0.0.1:8080`。在 Edge/Chrome 中：

- 地址栏右侧出现安装图标，或
- 菜单 → “应用” → “安装此站点”

端口可改：

```powershell
$env:PORT = 8090
npm run serve
```

### 局域网访问

```powershell
$env:LAN = '1'
$env:PORT = 8080
npm run serve
```

终端会打印类似 `http://192.168.1.23:8080` 的地址。

注意：局域网 HTTP 不是安全上下文（secure context），Service Worker 不会注册；Chrome 也不会提供标准 PWA 安装。局域网手机访问可以临时聊天，但要“安装 PWA / 离线启动”需要 HTTPS 或 `localhost`。

## 正式部署

PWA 是纯静态站点，把 `app/www/` 整个目录部署到任意支持 HTTPS 的静态托管即可，例如：

- Nginx / Caddy
- GitHub Pages
- Cloudflare Pages
- Netlify / Vercel

要求：

1. 必须使用 HTTPS（`localhost` 除外）。
2. 站点根路径应指向 `app/www/`，`manifest.webmanifest`、`sw.js`、`js/`、`css/`、`icons/` 保持相对路径。
3. 不要给 `sw.js` 设置长期强缓存，建议 `Cache-Control: no-cache`，方便版本升级。
4. 如果部署在子路径（如 `/miyu/`），当前相对路径写法可直接工作；不需要改 `start_url` 和 `scope`。

### Nginx 示例

```nginx
server {
    listen 443 ssl http2;
    server_name chat.example.com;

    root /var/www/miyu;
    index index.html;

    location = /sw.js {
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

将 `app/www/` 的内容放到 `/var/www/miyu/`。

### 缓存更新

`sw.js` 使用 `miyu-shell-v1.0.0` 作为缓存名。发布新版本时修改：

```js
const CACHE = 'miyu-shell-v1.1.0';
```

并同步修改 `ASSETS` 中新增/删除的文件。用户再次打开页面后，新 Service Worker 会 `skipWaiting` 并接管，旧缓存会在 `activate` 时删除。

## 安装后的行为

- 应用外壳可离线打开；账户、消息、设置仍保存在浏览器 IndexedDB / localStorage。
- 没有服务器推送。页面关闭后不会收到新消息；重新打开并连接中继后会补拉。
- 浏览器通知需要用户授权，且只在页面打开时由前端触发。
- 清除站点数据/浏览器数据会删除账户和聊天记录。请先在设置中导出 `ncryptsec`。
- PWA 与 Android APK 使用同一套前端，但数据互不相通：它们是两个不同的存储容器。

## 中继配置

PWA 默认使用公共中继：

```text
wss://relay.damus.io
wss://nos.lol
wss://relay.nostr.band
```

如果电脑上运行密语桌面端并开启局域网中继，可以在 PWA 设置中添加：

```text
ws://192.168.1.23:7777
```

但 HTTPS 页面连接明文 `ws://` 会被浏览器按混合内容拦截。正式部署的 HTTPS PWA 需要使用 `wss://` 中继，或在本地以 `http://localhost` 运行。

## 常见问题

### 没有安装按钮

- 确认使用 HTTPS 或 `http://localhost`
- 确认 `manifest.webmanifest` 返回 200，且 MIME 类型为 `application/manifest+json`
- 确认 `sw.js` 返回 200，且未被浏览器禁用
- Edge 可在 `edge://apps` 查看已安装应用

### 修改代码后页面没更新

1. 开发者工具 → Application → Service Workers → Update
2. 勾选 “Bypass for network” 临时绕过缓存
3. 或修改 `sw.js` 的 `CACHE` 版本号后刷新两次

### 通知不出现

- 浏览器设置中允许该站点通知
- 页面必须处于打开状态
- 系统“勿扰模式”可能拦截通知
