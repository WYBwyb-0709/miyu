/* ══════════════════════════════════════════════════════════
   state.js · 全局状态、设置、联系人
   ══════════════════════════════════════════════════════════ */
(function (MY) {
  'use strict';

  const U = MY.util;
  const SETTINGS_KEY = 'miyu.settings.v1';
  const ACCENTS = ['wechat', 'violet', 'ice', 'cyan', 'lime', 'amber', 'rose'];

  const DEFAULT_SETTINGS = {
    theme: 'system',
    accent: 'wechat',
    font: 'normal',
    sendKey: 'enter',
    groupAvatars: true,
    dmAvatars: true,
    shareAvatar: true,
    notify: true,
    sound: true,
    compressImages: true,
  };

  const state = {
    sk: null,
    pub: null,
    name: '',
    ready: false,
    rooms: new Map(),
    activeRoomId: null,
    contacts: new Map(),
    profile: { avatar: null, updatedAt: 0 },
    settings: { ...DEFAULT_SETTINGS },
    desktop: null,
    tab: 'chats',
    roomSearch: '',
    msgSearch: '',
    replyTo: null,
    searchOpen: false,
    bootAt: Date.now(),
  };

  function loadSettings() {
    const raw = U.storageGet(SETTINGS_KEY, {});
    state.settings = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
    if (!['system', 'light', 'dark'].includes(state.settings.theme)) state.settings.theme = 'system';
    if (!ACCENTS.includes(state.settings.accent)) state.settings.accent = 'wechat';
    if (!['small', 'normal', 'large', 'xlarge'].includes(state.settings.font)) state.settings.font = 'normal';
    if (!['enter', 'ctrl', 'both'].includes(state.settings.sendKey)) state.settings.sendKey = 'enter';
  }

  function saveSettings() {
    U.storageSet(SETTINGS_KEY, state.settings);
  }

  function resolvedTheme() {
    if (state.settings.theme === 'system') {
      try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch { return 'light'; }
    }
    return state.settings.theme;
  }

  function applySettings() {
    const html = document.documentElement;
    html.dataset.theme = resolvedTheme();
    html.dataset.accent = state.settings.accent;
    html.dataset.font = state.settings.font;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolvedTheme() === 'dark' ? '#111214' : '#ededed');

    const $ = U.$;
    if ($('themeSelect')) $('themeSelect').value = state.settings.theme;
    if ($('fontSizeSelect')) $('fontSizeSelect').value = state.settings.font;
    if ($('sendKeySelect')) $('sendKeySelect').value = state.settings.sendKey;
    if ($('groupAvatarToggle')) $('groupAvatarToggle').checked = state.settings.groupAvatars;
    if ($('dmAvatarToggle')) $('dmAvatarToggle').checked = state.settings.dmAvatars;
    if ($('shareAvatarToggle')) $('shareAvatarToggle').checked = state.settings.shareAvatar;
    if ($('notifyToggle')) $('notifyToggle').checked = state.settings.notify;
    if ($('soundToggle')) $('soundToggle').checked = state.settings.sound;
    const wrap = $('accentSwatches');
    if (wrap) {
      for (const btn of wrap.querySelectorAll('.swatch')) {
        btn.classList.toggle('active', btn.dataset.accent === state.settings.accent);
      }
    }
    if (state.activeRoomId && MY.ui) MY.ui.scheduleRender();
  }

  function watchTheme() {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const fn = () => { if (state.settings.theme === 'system') applySettings(); };
      if (mq.addEventListener) mq.addEventListener('change', fn);
      else if (mq.addListener) mq.addListener(fn);
    } catch { /* 忽略 */ }
  }

  function roomsKey() { return `miyu.rooms.${state.pub || 'anon'}`; }
  function contactsKey() { return `miyu.contacts.${state.pub || 'anon'}`; }
  function profileKey() { return `miyu.profile.${state.pub || 'anon'}`; }
  function lastRoomKey() { return `miyu.last.${state.pub || 'anon'}`; }

  function saveRooms() {
    if (!state.pub) return;
    const out = [];
    for (const r of state.rooms.values()) {
      out.push({
        id: r.id,
        type: r.type,
        label: r.label,
        encrypted: !!r.encrypted,
        verifier: r.verifier || null,
        peerPub: r.peerPub || null,
        peerName: r.peerName || null,
        pinned: !!r.pinned,
        muted: !!r.muted,
        wrappedKey: r.wrappedKey || null,
        joinedAt: r.joinedAt || Date.now(),
        lastActivity: Number(r.lastActivity) || 0,
        lastPreview: String(r.lastPreview || '').slice(0, 120),
        unread: Number(r.unread) || 0,
        members: r.members instanceof Map
          ? [...r.members.entries()].slice(0, 300).map(([pub, info]) => [pub, {
            name: String((info && info.name) || '').slice(0, 40),
            lastAt: Number(info && info.lastAt) || 0,
          }])
          : [],
      });
    }
    U.storageSet(roomsKey(), out);
  }

  function loadRoomsRaw() {
    const raw = U.storageGet(roomsKey(), []);
    return Array.isArray(raw) ? raw : [];
  }

  function saveContacts() {
    if (!state.pub) return;
    const out = {};
    for (const [pub, c] of state.contacts) out[pub] = c;
    U.storageSet(contactsKey(), out);
  }

  function loadContacts() {
    state.contacts = new Map();
    const raw = U.storageGet(contactsKey(), {});
    if (!raw || typeof raw !== 'object') return;
    for (const [pub, c] of Object.entries(raw)) {
      if (!/^[0-9a-f]{64}$/i.test(pub) || !c || typeof c !== 'object') continue;
      state.contacts.set(pub.toLowerCase(), {
        name: typeof c.name === 'string' ? c.name.slice(0, 40) : '',
        avatar: typeof c.avatar === 'string' && c.avatar.length < 40000 ? c.avatar : null,
        saved: !!c.saved,
        lastAt: Number(c.lastAt) || 0,
      });
    }
  }

  function saveProfile() {
    if (!state.pub) return;
    U.storageSet(profileKey(), { avatar: state.profile.avatar, updatedAt: state.profile.updatedAt });
  }

  function loadProfile() {
    const raw = U.storageGet(profileKey(), null);
    state.profile = { avatar: null, updatedAt: 0 };
    if (!raw || typeof raw !== 'object') return;
    if (typeof raw.avatar === 'string' && /^data:image\//.test(raw.avatar) && raw.avatar.length < 400000) {
      state.profile.avatar = raw.avatar;
    }
    state.profile.updatedAt = Number(raw.updatedAt) || 0;
  }

  function upsertContact(pub, info) {
    if (!pub || !/^[0-9a-f]{64}$/i.test(pub)) return null;
    const key = pub.toLowerCase();
    const prev = state.contacts.get(key) || { name: '', avatar: null, saved: false, lastAt: 0 };
    const next = {
      name: info && typeof info.name === 'string' && info.name.trim() ? info.name.trim().slice(0, 40) : prev.name,
      avatar: info && info.avatar ? info.avatar : prev.avatar,
      saved: info && typeof info.saved === 'boolean' ? info.saved : prev.saved,
      lastAt: Math.max(prev.lastAt || 0, (info && info.lastAt) || 0),
    };
    if (info && info.saved === false) next.saved = false;
    state.contacts.set(key, next);
    saveContacts();
    return next;
  }

  function contactFor(pub) {
    if (!pub) return null;
    return state.contacts.get(String(pub).toLowerCase()) || null;
  }

  function displayName(pub) {
    if (!pub) return '未知';
    if (pub === state.pub && state.name) return state.name;
    const c = contactFor(pub);
    if (c && c.name) return c.name;
    return String(pub).slice(0, 8);
  }

  function avatarFor(pub) {
    if (!pub) return null;
    if (pub === state.pub) return state.profile.avatar;
    const c = contactFor(pub);
    return c && c.avatar ? c.avatar : null;
  }

  function avatarHue(pub) {
    let h = 0;
    const s = String(pub || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  function initialOf(pub, name) {
    const label = name || displayName(pub);
    return String(label || '?').trim().slice(0, 1).toUpperCase() || '?';
  }

  function paintAvatar(el, pub, label) {
    if (!el) return;
    const url = avatarFor(pub);
    el.textContent = '';
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      el.appendChild(img);
      el.style.background = '';
      el.style.color = '';
      return;
    }
    el.textContent = initialOf(pub, label);
    const hue = avatarHue(pub);
    el.style.background = `linear-gradient(135deg,hsl(${hue} 30% 82%),hsl(${hue} 28% 70%))`;
    el.style.color = '#555';
  }

  function roomById(id) {
    return state.rooms.get(id) || null;
  }

  function activeRoom() {
    return roomById(state.activeRoomId);
  }

  function updateContactFromTags(pub, tags) {
    if (!pub || pub === state.pub || !Array.isArray(tags)) return;
    let name = '';
    let avatar = null;
    for (const t of tags) {
      if (!Array.isArray(t)) continue;
      if (t[0] === 'name' && typeof t[1] === 'string') name = t[1].slice(0, 40);
      if (t[0] === 'avatar' && typeof t[1] === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(t[1]) && t[1].length < 40000) avatar = t[1];
    }
    if (!name && !avatar) return;
    upsertContact(pub, { name, avatar });
    if (MY.ui) {
      MY.ui.scheduleRoomList();
      if (state.activeRoomId) MY.ui.scheduleRender();
    }
  }

  const EMOJIS = [
    '😀','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋',
    '😛','😜','🤪','😝','🤗','🤭','🤫','🤔','🤐','😐','😑','😶','😏','😒','🙄','😬','😮','😯','😲','😳',
    '🥺','😢','😭','😤','😠','😡','🤯','😱','😨','😰','😥','😓','🤝','👍','👎','👌','✌️','🤞','🙏','💪',
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❣️','💕','💞','💓','💗','💖','💘','💝','🎉','🎊','🔥',
    '🌹','🌻','🌈','☀️','🌙','⭐','✨','⚡','🍀','🎁','☕','🍺','🍻','🍜','🍚','🍉','🍎','🎂','🏆','💯',
  ];

  MY.state = state;
  MY.settings = {
    DEFAULT_SETTINGS,
    ACCENTS,
    loadSettings,
    saveSettings,
    applySettings,
    watchTheme,
    resolvedTheme,
  };
  MY.people = {
    roomsKey, contactsKey, profileKey, lastRoomKey,
    saveRooms, loadRoomsRaw, saveContacts, loadContacts,
    saveProfile, loadProfile, upsertContact, contactFor, displayName,
    avatarFor, avatarHue, initialOf, paintAvatar,
    roomById, activeRoom, updateContactFromTags,
  };
  MY.emoji = EMOJIS;
})(window.MY = window.MY || {});
