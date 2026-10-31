# Android 构建、安装与签名

## 已构建的安装包

```text
dist/Miyu-1.0.0-android-debug.apk
```

- 包名：`com.miyu.app`
- 版本：1.0.0（versionCode 1）
- minSdk：33（Android 13）
- targetSdk / compileSdk：36（Android 16）
- 签名：Android debug key，APK Signature Scheme v2
- SHA-256：`0D280A3DAD8EB80DC3397763EA9C5CE228BAA494649122D0A7763855C0C6E70C`

### 直接安装

1. 把 APK 传到手机（USB、网盘、聊天工具均可）。
2. 在系统设置中允许文件管理器/浏览器“安装未知应用”。
3. 打开 APK，确认安装。
4. 首次启动按提示允许通知权限（Android 13+ 需要 `POST_NOTIFICATIONS`）。

或用 adb：

```powershell
adb install -r dist\Miyu-1.0.0-android-debug.apk
```

> debug APK 使用公共 debug 密钥签名，不能上架应用商店，也不适合作为正式分发版本。需要长期使用时请生成自己的 release 密钥。

## 环境要求

- Windows 10/11 或 macOS/Linux
- JDK 21
- Android SDK Platform 36
- Android SDK Build-Tools 36.0.0
- Android SDK Platform-Tools（adb，可选）
- Node.js 22+

本机验证过的路径：

```text
JDK:            D:\AndroidBuild\jdk-21.0.2
Android SDK:    D:\AndroidBuild\sdk
Gradle cache:   D:\AndroidBuild\gradle
```

## 构建 debug APK

在仓库根目录：

```powershell
npm ci
npx cap sync android
```

设置环境变量（按自己的路径修改）：

```powershell
$env:JAVA_HOME = 'D:\AndroidBuild\jdk-21.0.2'
$env:ANDROID_HOME = 'D:\AndroidBuild\sdk'
$env:ANDROID_SDK_ROOT = 'D:\AndroidBuild\sdk'
$env:GRADLE_USER_HOME = 'D:\AndroidBuild\gradle'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
```

构建：

```powershell
cd android
.\gradlew.bat assembleDebug --no-daemon
```

产物：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

验证签名和包信息：

```powershell
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --verbose `
  app\build\outputs\apk\debug\app-debug.apk

& "$env:ANDROID_HOME\build-tools\36.0.0\aapt.exe" dump badging `
  app\build\outputs\apk\debug\app-debug.apk
```

## 构建 release APK

### 1. 生成密钥库

在 `android/` 目录执行：

```powershell
keytool -genkeypair -v `
  -keystore release.keystore `
  -alias miyu `
  -keyalg RSA -keysize 2048 -validity 10000 `
  -storetype PKCS12
```

按提示设置密钥库密码、密钥密码和证书信息。密钥库和密码丢失后无法升级已安装应用，请离线备份。

### 2. 配置签名

复制示例文件：

```powershell
Copy-Item keystore.properties.example keystore.properties
```

编辑 `android/keystore.properties`：

```properties
storeFile=release.keystore
storePassword=你的密钥库密码
keyAlias=miyu
keyPassword=你的密钥密码
```

`storeFile` 相对于 `android/` 目录。`keystore.properties`、`*.keystore`、`*.jks` 已在 `.gitignore` 中排除。

`android/app/build.gradle` 会检测该文件：存在时自动给 release 构建签名，不存在时 release 构建保持未签名，debug 构建不受影响。

### 3. 构建并验证

```powershell
cd android
.\gradlew.bat assembleRelease --no-daemon
```

产物：

```text
android/app/build/outputs/apk/release/app-release.apk
```

验证：

```powershell
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --verbose --print-certs `
  app\build\outputs\apk\release\app-release.apk
```

### 4. 升级注意事项

- 新 APK 必须使用同一签名密钥、相同 `applicationId`，否则系统拒绝覆盖安装。
- 修改 `versionCode` / `versionName` 只需编辑 `android/app/build.gradle` 的 `defaultConfig`。
- 从 debug 版切换到 release 版时签名不同，需要先卸载；卸载会清除应用私有数据，请先导出 `ncryptsec`。

## 连接电脑的局域网中继

Android 端不自带中继，默认使用公共中继。若电脑上运行密语桌面端：

1. Windows 打开“设置 → 中继服务器”，开启“允许局域网设备连接本机中继”。
2. 记下设置页显示的地址，例如 `ws://192.168.1.23:7777`。
3. Android 与电脑连接同一个 Wi-Fi。
4. Android 打开“设置 → 中继服务器”，把该地址加到列表第一行，保存并重连。
5. Windows 防火墙提示时允许“专用网络”。

验证：桌面端和 Android 端分别进入同一个群聊，互发消息。若只有一端能收到，检查：

- 两台设备是否在同一网段（避免访客 Wi-Fi / AP 隔离）
- Windows 防火墙是否放行 7777 端口
- 设置页显示的实际端口是否仍是 7777（端口冲突时会自动更换）
- 地址是否以 `ws://` 开头，且没有多余路径

## 通知与后台

- Android 13+ 首次启动会请求通知权限。拒绝后可在“系统设置 → 应用 → 密语 → 通知”重新开启。
- 应用使用本地通知，不依赖 FCM，因此不需要 Google 服务。
- 应用被系统杀死或深度休眠后不会保持 WebSocket，重新打开后才补拉消息。这是无推送服务架构的限制。
- 部分厂商系统会限制后台网络。需要及时接收时，可在系统设置中允许后台活动/关闭省电限制。

## 数据位置

Android 应用数据位于应用私有目录，普通文件管理器不可见：

```text
/data/data/com.miyu.app/
```

包含 WebView 的 IndexedDB、localStorage、缓存。卸载应用或“清除数据”会删除账户、消息和加密群密钥。请在卸载前导出 `ncryptsec`。

## 常见问题

### Gradle 下载超时

`android/gradle/wrapper/gradle-wrapper.properties` 默认从 `services.gradle.org` 下载。国内网络可临时改成腾讯镜像：

```properties
distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-all.zip
networkTimeout=60000
```

下载完成后 Gradle 会缓存到 `GRADLE_USER_HOME`，后续构建不再联网。

### Java 堆内存不足

仓库默认配置已针对小内存机器调低：

```properties
org.gradle.jvmargs=-Xmx1024m -Dfile.encoding=UTF-8
org.gradle.workers.max=2
```

如果仍然 OOM：

- 关闭浏览器、Electron 等占内存程序
- 不要同时跑多个 Gradle 构建
- 把 `-Xmx1024m` 再降到 `-Xmx768m`
- 使用 `--no-daemon`，构建结束后不会留下守护进程

### `JAVA_HOME is not set`

`apksigner`、`aapt` 和 Gradle 都需要 Java。先设置：

```powershell
$env:JAVA_HOME = 'D:\AndroidBuild\jdk-21.0.2'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
java -version
```

### `INSTALL_FAILED_UPDATE_INCOMPATIBLE`

手机上已安装不同签名的同包名应用。先卸载旧版，再安装新 APK。卸载会删除本地数据。

### 应用显示“明文 HTTP 被阻止”

Android 工程已配置 `network_security_config.xml` 允许明文 WebSocket（`ws://`），用于连接局域网中继。若自行修改了 manifest 或网络安全配置，请确认：

```xml
<base-config cleartextTrafficPermitted="true">
```

以及 `AndroidManifest.xml` 中 `android:usesCleartextTraffic="true"`。

## CI 签名说明

GitHub Actions 的 Android 工作流会构建 debug APK。配置以下仓库 Secrets 后，还会额外构建签名 release APK：

| Secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `release.keystore` 的 Base64 |
| `ANDROID_KEYSTORE_PASSWORD` | 密钥库密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名，例如 `miyu` |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

生成 Base64（PowerShell）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('android\release.keystore')) |
  Set-Clipboard
```

工作流会把密钥库解码到临时路径，写入 `android/keystore.properties`，构建后删除。不要把密钥库或密码提交到仓库。
