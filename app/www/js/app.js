/* ══════════════════════════════════════════════════════════
   app.js · 启动、界面绑定与设置
   ══════════════════════════════════════════════════════════ */
(function (MY) {
  'use strict';

  const U = MY.util;
  const S = MY.state;
  const P = MY.people;
  const $ = U.$;

  let bound = false;
  let statusTimer = null;
  let roomModalMode = 'new';
  let contactModalMode = 'contact';
  let nativeReady = false;

  function toast(text, ms) { MY.ui.toast(text, ms); }

  function desktop() { return window.miyuDesktop || null; }

  /* ── 桌面端配置 ── */

  async function loadDesktopConfig() {
    const api = desktop();
    if (!api) return null;
    try {
      const cfg = await api.getConfig();
      if (cfg && typeof cfg === 'object') {
        S.desktop = cfg;
        if (cfg.relayUrl) MY.net.setLocalRelay(cfg.relayUrl);
        return cfg;
      }
    } catch { /* 忽略 */ }
    return null;
  }

  function updateDesktopUI() {
    const cfg = S.desktop;
    const row = $('lanRow');
    const openDir = $('btnOpenDataDir');
    if (!desktop()) {
      if (row) row.style.display = 'none';
      if (openDir) openDir.style.display = 'none';
      return;
    }
    if (row) row.style.display = 'flex';
    if (openDir) openDir.style.display = '';
    if ($('lanToggle')) $('lanToggle').checked = !!(cfg && cfg.lanEnabled);
    const info = $('lanInfo');
    if (info) {
      if (cfg && cfg.relayError) {
        info.textContent = '本机中继启动失败：' + cfg.relayError + '\n公共中继仍可使用，请尝试重启应用。';
      } else if (cfg && cfg.lanEnabled && Array.isArray(cfg.lanUrls) && cfg.lanUrls.length) {
        info.textContent = '局域网地址：' + cfg.lanUrls.join('  ');
      } else if (cfg && cfg.lanEnabled) {
        info.textContent = '已开启，但未检测到局域网 IPv4 地址。请确认电脑已连接 Wi-Fi 或网线。';
      } else {
        info.textContent = '开启后，同一 Wi-Fi 下的 Android 设备可连接本机中继。';
      }
    }
  }

  function wireDesktop() {
    const api = desktop();
    if (!api) return;
    if (api.onNotificationClick) {
      api.onNotificationClick((roomId) => {
        if (roomId && S.rooms.has(roomId)) openRoom(roomId).catch(() => {});
      });
    }
    if (api.onConfigChanged) {
      api.onConfigChanged((cfg) => {
        if (!cfg || typeof cfg !== 'object') return;
        const oldRelay = MY.net.localRelay;
        S.desktop = { ...(S.desktop || {}), ...cfg };
        if (cfg.relayUrl && cfg.relayUrl !== oldRelay) {
          const urls = MY.net.relays.map((u) => (u === oldRelay ? cfg.relayUrl : u));
          MY.net.setLocalRelay(cfg.relayUrl);
          if (oldRelay) {
            MY.net.reconfigure(urls);
            MY.chat.refreshSubscriptions();
          }
        }
        updateDesktopUI();
        const toggle = $('lanToggle');
        if (toggle) toggle.checked = !!cfg.lanEnabled;
        MY.ui.updateConnUI();
      });
    }
  }

  async function toggleLan(enabled) {
    const api = desktop();
    if (!api || !api.setLan) return;
    const toggle = $('lanToggle');
    if (toggle) toggle.disabled = true;
    try {
      const cfg = await api.setLan(!!enabled);
      if (cfg && typeof cfg === 'object') {
        S.desktop = { ...(S.desktop || {}), ...cfg };
      } else if (S.desktop) {
        S.desktop.lanEnabled = !!enabled;
      }
      updateDesktopUI();
      toast(enabled ? '局域网中继已开启' : '局域网中继已关闭');
    } catch (e) {
      if (toggle) toggle.checked = !enabled;
      toast('切换失败：' + (e && e.message ? e.message : '未知错误'));
    } finally {
      if (toggle) toggle.disabled = false;
    }
  }

  /* ── 聊天输入 ── */

  function sendComposer() {
    const input = $('msgInput');
    if (!input || input.disabled) return;
    const text = input.value;
    if (!text.trim()) return;
    MY.chat.sendText(text).then((ok) => {
      if (!ok) return;
      input.value = '';
      MY.chat.syncComposerHeight();
      input.focus();
    }).catch(() => toast('发送失败'));
  }

  function onComposerKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    const mode = S.settings.sendKey;
    const ctrl = e.ctrlKey || e.metaKey;
    let shouldSend = false;
    if (mode === 'enter') shouldSend = !ctrl;
    else if (mode === 'ctrl') shouldSend = ctrl;
    else shouldSend = true;
    if (!shouldSend) return;
    e.preventDefault();
    sendComposer();
  }

  /* ── 新建 / 加入群聊 ── */

  function openRoomModal(mode) {
    roomModalMode = mode === 'join' ? 'join' : 'new';
    const title = $('roomModalTitle');
    const desc = $('roomModalDesc');
    const label = $('roomNameLabel');
    const input = $('roomNameInput');
    const pwd = $('roomPasswordInput');
    const btn = $('btnCreateRoom');
    const err = $('roomError');
    if (roomModalMode === 'new') {
      if (title) title.textContent = '新建群聊';
      if (desc) desc.textContent = '创建后会生成邀请码。把邀请码（加密群聊还要密码）发给朋友即可加入。';
      if (label) label.textContent = '群聊名称';
      if (input) { input.value = ''; input.placeholder = '例如：项目讨论组'; }
      if (btn) btn.textContent = '创建';
    } else {
      if (title) title.textContent = '加入群聊';
      if (desc) desc.textContent = '粘贴邀请码，或输入 miyu- 开头的群聊 ID。加密群聊请同时填写房间密码。';
      if (label) label.textContent = '邀请码 / 群聊 ID';
      if (input) { input.value = ''; input.placeholder = 'miyu-join:... 或 miyu-...'; }
      if (btn) btn.textContent = '加入';
    }
    if (pwd) pwd.value = '';
    if (err) err.textContent = '';
    if ($('roomOverlay')) $('roomOverlay').classList.remove('hidden');
    setTimeout(() => { try { input.focus(); } catch { /* 忽略 */ } }, 50);
  }

  async function submitRoomModal() {
    const input = $('roomNameInput');
    const pwd = $('roomPasswordInput');
    const err = $('roomError');
    const btn = $('btnCreateRoom');
    if (!input || !err || !btn) return;
    err.textContent = '';
    btn.disabled = true;
    try {
      if (roomModalMode === 'new') {
        await MY.chat.createRoom({ label: input.value, password: pwd.value });
        $('roomOverlay').classList.add('hidden');
        toast('群聊已创建');
      } else {
        const code = input.value.trim();
        if (!code) throw new Error('请粘贴邀请码或群聊 ID');
        await MY.chat.joinRoom({ code, password: pwd.value });
        $('roomOverlay').classList.add('hidden');
        toast('已加入群聊');
      }
    } catch (e) {
      err.textContent = e && e.message ? e.message : '操作失败';
    } finally { btn.disabled = false; }
  }

  /* ── 联系人 / 私聊 ── */

  function openContactModal(mode) {
    contactModalMode = mode === 'dm' ? 'dm' : 'contact';
    const title = $('contactModalTitle');
    const desc = $('contactModalDesc');
    const btn = $('btnSaveContact');
    const pub = $('contactPubkey');
    const alias = $('contactAlias');
    const err = $('contactError');
    if (title) title.textContent = contactModalMode === 'dm' ? '发起私聊' : '添加联系人';
    if (desc) desc.textContent = '粘贴对方的 64 位 Nostr 公钥。对方不需要在线，公钥即地址。';
    if (btn) btn.textContent = contactModalMode === 'dm' ? '开始私聊' : '保存联系人';
    if (pub) pub.value = '';
    if (alias) alias.value = '';
    if (err) err.textContent = '';
    if ($('contactOverlay')) $('contactOverlay').classList.remove('hidden');
    setTimeout(() => { try { pub.focus(); } catch { /* 忽略 */ } }, 50);
  }

  async function submitContactModal() {
    const pubEl = $('contactPubkey');
    const aliasEl = $('contactAlias');
    const err = $('contactError');
    const btn = $('btnSaveContact');
    if (!pubEl || !err || !btn) return;
    const pub = pubEl.value.trim().toLowerCase();
    const alias = aliasEl ? aliasEl.value.trim().slice(0, 24) : '';
    err.textContent = '';
    if (!/^[0-9a-f]{64}$/.test(pub)) { err.textContent = '公钥应为 64 位十六进制字符串'; return; }
    if (pub === S.pub) { err.textContent = '不能添加自己为联系人'; return; }
    btn.disabled = true;
    try {
      P.upsertContact(pub, { name: alias, saved: true, lastAt: Math.floor(Date.now() / 1000) });
      $('contactOverlay').classList.add('hidden');
      if (contactModalMode === 'dm') {
        await MY.chat.openDM(pub, alias);
      } else {
        MY.ui.switchTab('contacts');
        toast('联系人已保存');
      }
    } catch (e) {
      err.textContent = e && e.message ? e.message : '操作失败';
    } finally { btn.disabled = false; }
  }

  /* ── 设置 ── */

  function fillRelayList() {
    const el = $('relayList');
    if (el) el.value = MY.net.relays.join('\n');
  }

  function updateRelayStatus(text) {
    const el = $('relayStatus');
    if (el) el.textContent = text;
  }

  function openSettings() {
    const s = S.settings;
    if ($('nameInput')) $('nameInput').value = S.name || '';
    if ($('exportNcryptsec')) $('exportNcryptsec').value = '';
    fillRelayList();
    const cfg = S.desktop;
    updateDesktopUI();
    if ($('lanToggle') && cfg) $('lanToggle').checked = !!cfg.lanEnabled;
    if ($('storageBackend')) $('storageBackend').textContent = MY.store.backendName;
    if ($('appVersion')) $('appVersion').textContent = MY.const.VERSION;
    const uploadShare = $('shareAvatarToggle');
    if (uploadShare) uploadShare.checked = !!s.shareAvatar;
    MY.ui.refreshProfileUI();
    MY.settings.applySettings();
    updateRelayStatus('保存后会自动重连。本机中继优先，公共中继作为兜底。');
    if ($('settingsOverlay')) $('settingsOverlay').classList.remove('hidden');
  }

  function closeSettings() {
    const overlay = $('settingsOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  async function changeAvatar(file) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { toast('头像图片不能超过 12 MB'); return; }
    try {
      const avatar = await MY.crypto.fileToAvatar(file);
      S.profile.avatar = avatar;
      S.profile.updatedAt = Date.now();
      P.saveProfile();
      MY.ui.refreshProfileUI();
      toast('头像已更新，将随新消息发送');
    } catch {
      toast('头像处理失败，请换一张图片');
    }
  }

  async function testRelays() {
    const el = $('relayList');
    if (!el) return;
    const urls = U.parseRelayUrls(el.value);
    if (!urls.length) { updateRelayStatus('没有可测试的 WebSocket 地址。'); return; }
    const btn = $('btnTestRelay');
    if (btn) btn.disabled = true;
    updateRelayStatus('正在测试 ' + urls.length + ' 个中继…');
    const results = await Promise.all(urls.map(async (u) => {
      const r = await MY.net.test(u);
      return { url: u, ...r };
    }));
    const ok = results.filter((r) => r.ok).length;
    const lines = results.map((r) => `${r.ok ? '✓' : '✗'} ${r.url}${r.ok ? '' : ' — ' + (r.error || '失败')}`);
    updateRelayStatus(`${ok}/${urls.length} 个中继可用\n` + lines.join('\n'));
    if (btn) btn.disabled = false;
    toast(ok > 0 ? `连接成功 ${ok}/${urls.length}` : '所有中继均不可用');
  }

  async function saveRelays() {
    const el = $('relayList');
    if (!el) return;
    const urls = U.parseRelayUrls(el.value);
    if (!urls.length) { updateRelayStatus('请至少填写一个 ws:// 或 wss:// 地址。'); toast('没有有效的中继地址'); return; }
    MY.net.reconfigure(urls);
    fillRelayList();
    MY.chat.refreshSubscriptions();
    MY.ui.updateConnUI();
    updateRelayStatus('已保存并重连。');
    toast('中继设置已保存');
    setTimeout(() => {
      const st = MY.net.status();
      updateRelayStatus(`已连接 ${st.connected}/${st.total} 个中继。保存后会自动重连。`);
    }, 2500);
  }

  function resetRelays() {
    const urls = MY.net.reset();
    MY.net.reconfigure(urls);
    fillRelayList();
    MY.chat.refreshSubscriptions();
    MY.ui.updateConnUI();
    updateRelayStatus('已恢复默认中继。');
    toast('已恢复默认中继');
  }

  async function exportAccount() {
    const value = MY.auth.exportNcryptsec();
    if (!value) { toast('没有可导出的账户'); return; }
    const box = $('exportNcryptsec');
    if (box) box.value = value;
    const ok = await U.copyText(value);
    toast(ok ? '账户凭证已复制，请妥善保管' : '账户凭证已生成，请手动复制');
  }

  async function toggleNotify(enabled) {
    if (!enabled) {
      S.settings.notify = false;
      MY.settings.saveSettings();
      return;
    }
    const ok = await U.requestNotifyPermission();
    S.settings.notify = ok;
    MY.settings.saveSettings();
    MY.settings.applySettings();
    if (!ok) toast('系统未授予通知权限，可在系统设置中开启');
  }

  /* ── 搜索 ── */

  function openChatSearch() {
    const bar = $('searchBar');
    if (!bar) return;
    bar.classList.remove('hidden');
    S.searchOpen = true;
    setTimeout(() => { try { $('msgSearchInput').focus(); } catch { /* 忽略 */ } }, 40);
  }

  function closeChatSearch() {
    const bar = $('searchBar');
    if (bar) bar.classList.add('hidden');
    S.searchOpen = false;
    S.msgSearch = '';
    const input = $('msgSearchInput');
    if (input) input.value = '';
    const count = $('searchCount');
    if (count) count.textContent = '';
    MY.ui.invalidateRender();
    MY.ui.scheduleRender();
  }

  /* ── 移动端侧栏 ── */

  function openSidebar() {
    const s = $('sidebar');
    const b = $('sidebarBackdrop');
    if (s) s.classList.add('mobile-open');
    if (b) b.classList.add('show');
  }

  function closeSidebar() {
    const s = $('sidebar');
    const b = $('sidebarBackdrop');
    if (s) s.classList.remove('mobile-open');
    if (b) b.classList.remove('show');
  }

  /* ── 原生通知 ── */

  async function initNative() {
    if (nativeReady || !U.isNative()) return;
    nativeReady = true;
    const plugins = window.Capacitor && window.Capacitor.Plugins;
    const ln = plugins && plugins.LocalNotifications;
    const appPlugin = plugins && plugins.App;

    if (appPlugin && appPlugin.addListener) {
      try {
        appPlugin.addListener('backButton', () => {
          const unlock = $('unlockOverlay');
          if (unlock && !unlock.classList.contains('hidden')) {
            const cancel = $('btnCancelUnlockRoom');
            if (cancel) cancel.click();
            return;
          }
          const sidebar = $('sidebar');
          if (sidebar && sidebar.classList.contains('mobile-open')) { closeSidebar(); return; }
          if ($('imageOverlay') && !$('imageOverlay').classList.contains('hidden')) { MY.ui.closeImage(); return; }
          MY.ui.closeMsgMenu();
          if (MY.ui.closeTopOverlays()) return;
          if (appPlugin.minimizeApp) {
            try { appPlugin.minimizeApp(); return; } catch { /* 忽略 */ }
          }
        });
      } catch { /* 忽略 */ }
      try {
        appPlugin.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) return;
          setTimeout(() => {
            if (!S.ready) return;
            try { MY.chat.refreshSubscriptions(); } catch { /* 忽略 */ }
            MY.chat.backfillDMs(true).catch(() => {});
            const room = MY.chat.activeRoom();
            if (room) MY.chat.backfillRoom(room, true).catch(() => {});
          }, 700);
        });
      } catch { /* 忽略 */ }
    }

    if (!ln) return;
    try {
      await ln.createChannel({
        id: 'miyu-default',
        name: '新消息',
        description: '密语的新消息提醒',
        importance: 4,
        visibility: 1,
        vibration: true,
        lights: true,
      });
    } catch { /* 忽略 */ }
    try {
      await ln.requestPermissions();
    } catch { /* 用户可稍后在系统设置中授权 */ }
    try {
      ln.addListener('localNotificationActionPerformed', (event) => {
        const roomId = event && event.notification && event.notification.extra && event.notification.extra.roomId;
        if (roomId) MY.app.openRoom(roomId);
      });
    } catch { /* 忽略 */ }
  }

  /* ── 状态轮询 ── */

  function startStatusPolling() {
    clearInterval(statusTimer);
    const tick = () => {
      try { MY.ui.updateConnUI(); } catch { /* 忽略 */ }
    };
    tick();
    statusTimer = setInterval(tick, 5000);
    setTimeout(tick, 1200);
  }

  /* ── 绑定 ── */

  function bindUI() {
    if (bound) return;
    bound = true;

    if ($('btnNew')) $('btnNew').onclick = () => openRoomModal('new');
    if ($('btnJoinGroup')) $('btnJoinGroup').onclick = () => openRoomModal('join');
    if ($('btnNewDM')) $('btnNewDM').onclick = () => openContactModal('dm');
    if ($('btnAddContact')) $('btnAddContact').onclick = () => openContactModal('contact');

    if ($('btnEmptyNew')) $('btnEmptyNew').onclick = () => openRoomModal('new');
    if ($('btnEmptyJoin')) $('btnEmptyJoin').onclick = () => openRoomModal('join');
    if ($('btnEmptyDM')) $('btnEmptyDM').onclick = () => openContactModal('dm');
    if ($('btnEmptyContact')) $('btnEmptyContact').onclick = () => openContactModal('contact');
    if ($('scrollDownBtn')) $('scrollDownBtn').onclick = () => MY.ui.scrollToBottom();

    const tabs = $('sideTabs');
    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-tab]');
        if (!btn) return;
        MY.ui.switchTab(btn.dataset.tab);
      });
    }

    if ($('roomSearch')) {
      $('roomSearch').addEventListener('input', (e) => {
        S.roomSearch = e.target.value;
        MY.ui.scheduleRoomList();
        MY.ui.renderContacts();
      });
    }

    if ($('mobileToggle')) $('mobileToggle').onclick = openSidebar;
    if ($('sidebarBackdrop')) $('sidebarBackdrop').onclick = closeSidebar;

    if ($('btnRoomInfo')) $('btnRoomInfo').onclick = () => { MY.chat.showInfo().catch(() => {}); };
    if ($('btnRoomMore')) {
      $('btnRoomMore').onclick = (e) => {
        const room = MY.chat.activeRoom();
        if (!room) return;
        const r = e.currentTarget.getBoundingClientRect();
        MY.ui.openRoomMenu(room, r.left, r.bottom + 6);
      };
    }

    if ($('btnChatSearch')) $('btnChatSearch').onclick = openChatSearch;
    if ($('btnSearchClose')) $('btnSearchClose').onclick = closeChatSearch;
    if ($('msgSearchInput')) {
      $('msgSearchInput').addEventListener('input', (e) => {
        S.searchOpen = true;
        S.msgSearch = e.target.value;
        MY.ui.invalidateRender();
        MY.ui.scheduleRender();
      });
    }
    if ($('btnCancelReply')) $('btnCancelReply').onclick = () => MY.ui.setReplyBar(null);

    if ($('msgInput')) {
      $('msgInput').addEventListener('input', () => MY.chat.syncComposerHeight());
      $('msgInput').addEventListener('keydown', onComposerKey);
      $('msgInput').addEventListener('focus', () => { if (U.isMobileWidth()) closeSidebar(); });
    }
    if ($('sendBtn')) $('sendBtn').onclick = sendComposer;

    if ($('fileBtn')) $('fileBtn').onclick = () => { const f = $('fileInput'); if (f) f.click(); };
    if ($('fileInput')) {
      $('fileInput').addEventListener('change', (e) => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        if (!files.length) return;
        if (files.length > 9) toast('一次最多发送 9 个文件');
        files.slice(0, 9).forEach((file, i) => {
          setTimeout(() => { MY.files.send(file).catch(() => toast('文件发送失败')); }, i * 180);
        });
      });
    }

    if ($('btnCancelRoom')) $('btnCancelRoom').onclick = () => $('roomOverlay').classList.add('hidden');
    if ($('btnCreateRoom')) $('btnCreateRoom').onclick = () => submitRoomModal().catch(() => {});
    if ($('roomNameInput')) {
      $('roomNameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitRoomModal().catch(() => {}); }
      });
    }

    if ($('btnCancelContact')) $('btnCancelContact').onclick = () => $('contactOverlay').classList.add('hidden');
    if ($('btnSaveContact')) $('btnSaveContact').onclick = () => submitContactModal().catch(() => {});
    if ($('contactPubkey')) {
      $('contactPubkey').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitContactModal().catch(() => {}); }
      });
    }

    if ($('btnCloseInfo')) $('btnCloseInfo').onclick = () => $('infoOverlay').classList.add('hidden');
    if ($('btnCloseImage')) $('btnCloseImage').onclick = () => MY.ui.closeImage();

    if ($('btnSettingsBottom')) $('btnSettingsBottom').onclick = openSettings;
    if ($('btnCloseSettings')) $('btnCloseSettings').onclick = closeSettings;
    if ($('btnLogout')) {
      $('btnLogout').onclick = async () => {
        const ok = await MY.ui.confirm('退出登录', '退出后会清除本设备上的账户与消息缓存。请确认已导出 ncryptsec 并记住密码。', '退出');
        if (!ok) return;
        MY.chat.shutdown();
        await MY.auth.logout();
      };
    }

    if ($('themeSelect')) {
      $('themeSelect').addEventListener('change', (e) => {
        S.settings.theme = e.target.value;
        MY.settings.saveSettings();
        MY.settings.applySettings();
      });
    }
    if ($('fontSizeSelect')) {
      $('fontSizeSelect').addEventListener('change', (e) => {
        S.settings.font = e.target.value;
        MY.settings.saveSettings();
        MY.settings.applySettings();
      });
    }
    if ($('sendKeySelect')) {
      $('sendKeySelect').addEventListener('change', (e) => {
        S.settings.sendKey = e.target.value;
        MY.settings.saveSettings();
      });
    }
    const accents = $('accentSwatches');
    if (accents) {
      accents.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-accent]');
        if (!btn) return;
        S.settings.accent = btn.dataset.accent;
        MY.settings.saveSettings();
        MY.settings.applySettings();
      });
    }

    const bindToggle = (id, key, after) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => {
        S.settings[key] = el.checked;
        MY.settings.saveSettings();
        if (after) after(el.checked);
        if (S.activeRoomId) MY.ui.scheduleRender();
        MY.ui.scheduleRoomList();
      });
    };
    bindToggle('groupAvatarToggle', 'groupAvatars');
    bindToggle('dmAvatarToggle', 'dmAvatars');
    bindToggle('shareAvatarToggle', 'shareAvatar');
    bindToggle('soundToggle', 'sound');
    if ($('notifyToggle')) {
      $('notifyToggle').addEventListener('change', (e) => { toggleNotify(e.target.checked).catch(() => {}); });
    }

    if ($('btnAvatarUpload') && $('avatarInput')) {
      $('btnAvatarUpload').onclick = () => $('avatarInput').click();
      $('avatarInput').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        changeAvatar(file).catch(() => {});
      });
    }
    if ($('btnAvatarRemove')) {
      $('btnAvatarRemove').onclick = () => {
        S.profile.avatar = null;
        S.profile.updatedAt = Date.now();
        P.saveProfile();
        MY.ui.refreshProfileUI();
        toast('头像已移除');
      };
    }
    if ($('btnCopyMyPubkey')) {
      $('btnCopyMyPubkey').onclick = async () => {
        const ok = await U.copyText(S.pub || '');
        toast(ok ? '公钥已复制' : '复制失败');
      };
    }
    if ($('btnSaveName')) {
      $('btnSaveName').onclick = () => {
        const name = ($('nameInput').value || '').trim().slice(0, 24);
        if (!name) { toast('名称不能为空'); return; }
        S.name = name;
        try { localStorage.setItem('miyu.name', name); } catch { /* 忽略 */ }
        MY.ui.refreshProfileUI();
        toast('名称已保存，对新消息生效');
      };
    }

    if ($('btnTestRelay')) $('btnTestRelay').onclick = () => testRelays().catch(() => {});
    if ($('btnSaveRelay')) $('btnSaveRelay').onclick = () => saveRelays().catch(() => {});
    if ($('btnResetRelay')) $('btnResetRelay').onclick = resetRelays;
    if ($('lanToggle')) {
      $('lanToggle').addEventListener('change', (e) => { toggleLan(e.target.checked).catch(() => {}); });
    }
    if ($('btnClearMessages')) {
      $('btnClearMessages').onclick = () => { MY.chat.clearAllMessages().catch(() => {}); };
    }
    if ($('btnExportAccount')) $('btnExportAccount').onclick = () => exportAccount().catch(() => {});
    if ($('btnOpenDataDir')) {
      $('btnOpenDataDir').onclick = () => {
        const api = desktop();
        if (api && api.openDataDir) api.openDataDir();
      };
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('imageOverlay') && !$('imageOverlay').classList.contains('hidden')) { MY.ui.closeImage(); return; }
      if ($('unlockOverlay') && !$('unlockOverlay').classList.contains('hidden')) {
        const btn = $('btnCancelUnlockRoom');
        if (btn) btn.click();
        return;
      }
      MY.ui.closeMsgMenu();
      MY.ui.closeTopOverlays();
    });

    window.addEventListener('resize', U.debounce(() => {
      MY.chat.syncComposerHeight();
      if (!U.isMobileWidth()) closeSidebar();
    }, 120));

    window.addEventListener('beforeunload', () => {
      clearInterval(statusTimer);
      try { MY.chat.shutdown(); } catch { /* 忽略 */ }
      try { MY.net.shutdown(); } catch { /* 忽略 */ }
    });
  }

  /* ── 启动 ── */

  async function start() {
    S.ready = true;
    MY.settings.loadSettings();
    MY.settings.applySettings();
    MY.ui.showSkeleton();
    MY.ui.refreshProfileUI();
    try {
      await MY.chat.loadRooms();
    } finally {
      MY.ui.hideSkeleton();
    }
    MY.chat.refreshSubscriptions();
    MY.ui.renderRoomList();
    MY.ui.renderContacts();
    MY.ui.updateConnUI();
    MY.chat.updateComposer();

    let target = null;
    try {
      const last = localStorage.getItem(P.lastRoomKey());
      if (last && S.rooms.has(last)) target = last;
    } catch { /* 忽略 */ }
    if (!target) {
      const rooms = [...S.rooms.values()].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
      if (rooms.length) target = rooms[0].id;
    }
    if (target) await MY.chat.switchRoom(target);
    else {
      MY.ui.updateHeader(null);
      MY.chat.updateComposer();
      MY.ui.scheduleRender();
    }

    MY.chat.backfillDMs(true).catch(() => {});
    initNative().catch(() => {});
    startStatusPolling();
    updateDesktopUI();
  }

  async function openRoom(roomId) {
    if (!roomId || !S.rooms.has(roomId)) return;
    closeSidebar();
    await MY.chat.switchRoom(roomId);
  }

  MY.app = {
    start,
    openRoom,
    openSettings,
    openRoomModal,
    openContactModal,
  };

  window.addEventListener('DOMContentLoaded', async () => {
    MY.settings.loadSettings();
    MY.settings.applySettings();
    MY.settings.watchTheme();
    MY.chat.init();
    MY.ui.initConfirm();
    MY.ui.bindMessageMenu();
    MY.ui.initEmoji();
    MY.ui.bindFocusTrap();
    bindUI();

    await loadDesktopConfig();
    wireDesktop();
    MY.net.init();
    fillRelayList();
    updateDesktopUI();
    MY.ui.updateConnUI();

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !U.isNative() && !U.isDesktop()) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    MY.auth.init();
  });
})(window.MY = window.MY || {});
