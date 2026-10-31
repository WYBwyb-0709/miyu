/* ══════════════════════════════════════════════════════════
   ui.js · 渲染与交互
   ══════════════════════════════════════════════════════════ */
(function (MY) {
  'use strict';

  const U = MY.util;
  const S = MY.state;
  const $ = U.$;
  const $$ = U.$$;
  const P = MY.people;

  const roomListEl = () => $('roomList');
  const contactListEl = () => $('contactList');
  const messagesEl = () => $('messages');
  const msgMenuEl = () => $('msgMenu');

  let toastTimer = null;
  let renderScheduled = false;
  let listScheduled = false;
  let renderedSignature = '';
  let menuTargetItem = null;
  let roomMenuEl = null;
  let confirmResolver = null;

  function toast(text, ms) {
    const el = $('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2600);
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      const overlay = $('confirmOverlay');
      $('confirmTitle').textContent = title || '确认';
      $('confirmText').textContent = text || '';
      $('confirmOk').textContent = okLabel || '确认';
      overlay.classList.remove('hidden');
      confirmResolver = resolve;
    });
  }

  function initConfirm() {
    $('confirmOk').onclick = () => {
      $('confirmOverlay').classList.add('hidden');
      if (confirmResolver) confirmResolver(true);
      confirmResolver = null;
    };
    $('confirmCancel').onclick = () => {
      $('confirmOverlay').classList.add('hidden');
      if (confirmResolver) confirmResolver(false);
      confirmResolver = null;
    };
  }

  function closeTopOverlays() {
    for (const id of ['settingsOverlay', 'roomOverlay', 'contactOverlay', 'infoOverlay']) {
      const el = $(id);
      if (el && !el.classList.contains('hidden')) {
        el.classList.add('hidden');
        return true;
      }
    }
    const c = $('confirmOverlay');
    if (c && !c.classList.contains('hidden')) {
      c.classList.add('hidden');
      if (confirmResolver) confirmResolver(false);
      confirmResolver = null;
      return true;
    }
    const img = $('imageOverlay');
    if (img && !img.classList.contains('hidden')) { img.classList.add('hidden'); return true; }
    return false;
  }

  /* ── 房间列表 ── */
  function scheduleRoomList() {
    if (listScheduled) return;
    listScheduled = true;
    requestAnimationFrame(() => {
      listScheduled = false;
      renderRoomList();
    });
  }

  function roomMatches(room, q) {
    if (!q) return true;
    const s = q.toLowerCase();
    if (String(room.label || '').toLowerCase().includes(s)) return true;
    if (String(room.lastPreview || '').toLowerCase().includes(s)) return true;
    if (room.peerPub && P.displayName(room.peerPub).toLowerCase().includes(s)) return true;
    return false;
  }

  function renderRoomList() {
    const el = roomListEl();
    if (!el) return;
    if (S.tab !== 'chats') { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const q = (S.roomSearch || '').trim();
    const rooms = [...S.rooms.values()]
      .filter((r) => roomMatches(r, q))
      .sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return (b.lastActivity || 0) - (a.lastActivity || 0);
      });

    el.textContent = '';
    for (const room of rooms) {
      const item = document.createElement('div');
      item.className = 'room-item' + (S.activeRoomId === room.id ? ' active' : '');
      item.dataset.roomId = room.id;

      const av = document.createElement('div');
      av.className = 'room-avatar';
      if (room.type === 'dm' && room.peerPub) {
        P.paintAvatar(av, room.peerPub, room.peerName || '私');
      } else {
        av.textContent = room.label === '大厅' ? '大' : String(room.label || '群').slice(0, 1).toUpperCase();
        const hue = P.avatarHue(room.id);
        av.style.background = `linear-gradient(135deg,hsl(${hue} 32% 82%),hsl(${hue} 30% 70%))`;
        av.style.color = '#555';
      }

      const meta = document.createElement('div');
      meta.className = 'room-meta';
      const name = document.createElement('div');
      name.className = 'name';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = room.label || '未命名';
      name.appendChild(nm);
      if (room.pinned) {
        const t = document.createElement('span'); t.className = 'tag-pin'; t.textContent = '置顶'; name.appendChild(t);
      }
      if (room.muted) {
        const t = document.createElement('span'); t.className = 'tag-mute'; t.textContent = '静音'; name.appendChild(t);
      }

      const sub = document.createElement('div');
      sub.className = 'sub';
      let preview = room.lastPreview ? String(room.lastPreview).replace(/\s+/g, ' ').slice(0, 46) : '';
      if (room.type === 'dm' && !preview) preview = '私聊 · 端到端加密';
      if (room.type === 'group' && !preview) preview = room.encrypted ? '加密群聊' : '公开群聊';
      sub.textContent = preview;

      meta.append(name, sub);

      const side = document.createElement('div');
      side.className = 'room-side';
      const time = document.createElement('div');
      time.className = 'room-time';
      time.textContent = U.fmtRoomTime(room.lastActivity);
      side.appendChild(time);
      if (room.unread > 0) {
        const badge = document.createElement('div');
        badge.className = 'room-badge unread';
        badge.textContent = room.unread > 99 ? '99+' : String(room.unread);
        side.appendChild(badge);
      }

      item.append(av, meta, side);
      item.onclick = () => MY.chat.switchRoom(room.id);
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openRoomMenu(room, e.clientX, e.clientY);
      });
      el.appendChild(item);
    }

    if (!rooms.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-list';
      empty.textContent = q ? '没有匹配的会话' : '还没有会话。加入群聊、发起私聊，或添加联系人。';
      el.appendChild(empty);
    }
  }

  function openRoomMenu(room, x, y) {
    closeRoomMenu();
    roomMenuEl = document.createElement('div');
    roomMenuEl.className = 'ctx-menu';
    const add = (label, fn, danger) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (danger) b.className = 'danger';
      b.onclick = () => { closeRoomMenu(); fn(); };
      roomMenuEl.appendChild(b);
    };
    add(room.pinned ? '取消置顶' : '置顶会话', () => {
      room.pinned = !room.pinned;
      P.saveRooms();
      scheduleRoomList();
    });
    add(room.muted ? '取消静音' : '消息免打扰', () => {
      room.muted = !room.muted;
      P.saveRooms();
      scheduleRoomList();
    });
    add('标记为已读', () => {
      room.unread = 0;
      scheduleRoomList();
    });
    add('清空聊天记录', () => MY.chat.clearRoom(room.id));
    add(room.type === 'group' ? '退出群聊' : '删除会话', () => MY.chat.leaveRoom(room.id), true);
    document.body.appendChild(roomMenuEl);
    const r = roomMenuEl.getBoundingClientRect();
    roomMenuEl.style.left = Math.min(Math.max(8, x), window.innerWidth - r.width - 8) + 'px';
    roomMenuEl.style.top = Math.min(Math.max(8, y), window.innerHeight - r.height - 8) + 'px';
    setTimeout(() => document.addEventListener('click', closeRoomMenu, { once: true }), 0);
  }

  function closeRoomMenu() {
    if (roomMenuEl) { roomMenuEl.remove(); roomMenuEl = null; }
  }

  /* ── 通讯录 ── */
  function renderContacts() {
    const el = contactListEl();
    if (!el) return;
    if (S.tab !== 'contacts') { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const q = (S.roomSearch || '').trim().toLowerCase();
    el.textContent = '';

    const meCard = document.createElement('div');
    meCard.className = 'contact-item';
    const meAv = document.createElement('div');
    meAv.className = 'contact-avatar';
    P.paintAvatar(meAv, S.pub, S.name);
    const meMeta = document.createElement('div');
    meMeta.className = 'contact-meta';
    const meN = document.createElement('div'); meN.className = 'n'; meN.textContent = S.name || '我';
    const meP = document.createElement('div'); meP.className = 'p'; meP.textContent = '我的公钥 · ' + (S.pub || '').slice(0, 16) + '…';
    meMeta.append(meN, meP);
    meCard.append(meAv, meMeta);
    meCard.onclick = async () => {
      const ok = await U.copyText(S.pub || '');
      toast(ok ? '公钥已复制' : '复制失败');
    };
    el.appendChild(meCard);

    const contacts = [...S.contacts.entries()]
      .filter(([pub, c]) => {
        if (!/^[0-9a-f]{64}$/i.test(pub)) return false;
        if (!q) return true;
        return (c.name || '').toLowerCase().includes(q) || pub.includes(q);
      })
      .sort((a, b) => {
        if (!!a[1].saved !== !!b[1].saved) return a[1].saved ? -1 : 1;
        return (b[1].lastAt || 0) - (a[1].lastAt || 0);
      });

    const caption = document.createElement('div');
    caption.className = 'section-caption';
    caption.textContent = contacts.length ? `联系人 · ${contacts.length}` : '联系人';
    el.appendChild(caption);

    for (const [pub, c] of contacts) {
      const row = document.createElement('div');
      row.className = 'contact-item';
      const av = document.createElement('div');
      av.className = 'contact-avatar';
      P.paintAvatar(av, pub, c.name || pub.slice(0, 8));
      const meta = document.createElement('div');
      meta.className = 'contact-meta';
      const n = document.createElement('div');
      n.className = 'n';
      const nm = document.createElement('span');
      nm.textContent = c.name || P.displayName(pub);
      n.appendChild(nm);
      if (c.saved) {
        const star = document.createElement('span');
        star.className = 'contact-star';
        star.textContent = '★';
        n.appendChild(star);
      }
      const p = document.createElement('div');
      p.className = 'p';
      p.textContent = pub.slice(0, 24) + '…';
      meta.append(n, p);
      row.append(av, meta);
      row.onclick = () => MY.chat.openDM(pub);
      el.appendChild(row);
    }

    if (!contacts.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-list';
      empty.textContent = q ? '没有匹配的联系人' : '聊天后对方会自动出现在这里，也可以点“添加联系人”输入公钥。';
      el.appendChild(empty);
    }
  }

  function switchTab(tab) {
    S.tab = tab;
    for (const b of $$('#sideTabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    scheduleRoomList();
    renderContacts();
  }

  /* ── 消息渲染 ── */
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      renderMessages();
    });
  }

  function shouldShowAvatar(room) {
    if (!room) return false;
    if (room.type === 'dm') return !!S.settings.dmAvatars;
    if (room.label === '大厅') return false;
    return !!S.settings.groupAvatars;
  }

  function highlightInto(el, text, query) {
    el.textContent = '';
    if (!query) { el.textContent = text; return; }
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    let i = 0;
    while (i < text.length) {
      const at = lower.indexOf(q, i);
      if (at < 0 || !q) {
        el.appendChild(document.createTextNode(text.slice(i)));
        break;
      }
      if (at > i) el.appendChild(document.createTextNode(text.slice(i, at)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(at, at + q.length);
      el.appendChild(mark);
      i = at + q.length;
    }
  }

  function fileLine(item) {
    const pct = Math.round(Math.max(0, Math.min(1, item.fileProgress || 0)) * 100);
    if (item.failed) {
      if (item.fileError === 'timeout') return { text: `传输超时 · ${pct}% · 可重试`, cls: 'fail' };
      if (item.fileError === 'corrupt') return { text: '文件校验失败，内容可能不完整', cls: 'fail' };
      return { text: '文件传输失败', cls: 'fail' };
    }
    if (item.status === 'fail') return { text: `发送未完成 · ${pct}% · 可重试`, cls: 'fail' };
    if (item.downloadUrl) return { text: '已完成 · 点击右侧保存', cls: 'ok' };
    if (item.transferState === 'waiting') return { text: `等待补发 · ${pct}%`, cls: 'wait' };
    if (item.transferState === 'verifying') return { text: '校验中…', cls: '' };
    if (item.transferState === 'sending') return { text: `发送中 · ${pct}%`, cls: '' };
    if (item.transferState === 'expired') return { text: '文件未保存到本机', cls: '' };
    if ((item.fileProgress || 0) < 1) return { text: `接收中 · ${pct}%`, cls: '' };
    return { text: '文件已发送', cls: 'ok' };
  }

  function buildQuote(item, room) {
    if (!item.replyTo) return null;
    const q = document.createElement('div');
    q.className = 'quote';
    const b = document.createElement('b');
    b.textContent = item.replyTo.name || '引用';
    const s = document.createElement('span');
    s.textContent = item.replyTo.preview || '';
    q.append(b, s);
    q.onclick = (e) => {
      e.stopPropagation();
      scrollToMessage(item.replyTo.id);
    };
    return q;
  }

  function buildFileBubble(item, meta, room) {
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    if (item.downloadUrl && String(meta.mime || '').startsWith('image/')) {
      const prev = document.createElement('div');
      prev.className = 'file-preview';
      const img = document.createElement('img');
      img.src = item.downloadUrl;
      img.alt = meta.name || '';
      img.loading = 'lazy';
      prev.appendChild(img);
      prev.onclick = () => openImage(item.downloadUrl);
      bubble.appendChild(prev);
    }
    const card = document.createElement('div');
    card.className = 'file-card';
    card.dataset.fileMid = meta.mid;
    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.textContent = String(meta.mime || '').startsWith('image/') ? '▧' : '▤';
    const info = document.createElement('div');
    info.className = 'file-info';
    const fn = document.createElement('div');
    fn.className = 'file-name';
    fn.textContent = meta.name || '未知文件';
    const fs = document.createElement('div');
    fs.className = 'file-size';
    fs.textContent = `${U.formatBytes(meta.size)} · ${meta.total || 1} 片`;
    info.append(fn, fs);

    const line = fileLine(item);
    const status = document.createElement('div');
    status.className = 'file-transfer ' + line.cls;
    status.dataset.fileStatus = '1';
    status.textContent = line.text;
    if (!item.downloadUrl && !item.failed) {
      const prog = document.createElement('div');
      prog.className = 'file-progress';
      const bar = document.createElement('div');
      bar.className = 'file-progress-bar';
      bar.dataset.fileBar = '1';
      bar.style.width = `${Math.round((item.fileProgress || 0) * 100)}%`;
      prog.appendChild(bar);
      status.appendChild(prog);
    }
    info.appendChild(status);
    card.append(icon, info);

    if (item.downloadUrl) {
      const dl = document.createElement('button');
      dl.className = 'file-dl';
      dl.type = 'button';
      dl.textContent = '↓';
      dl.title = '保存文件';
      dl.onclick = async (e) => {
        e.stopPropagation();
        const blob = await MY.store.loadBlob(item.ev.id);
        if (blob) await U.saveBlob(blob, meta.name);
        else U.saveBlob(new Blob([], { type: meta.mime }), meta.name);
      };
      card.appendChild(dl);
    }

    if ((item.displayPubkey || item.ev.pubkey) === S.pub && item.status === 'fail') {
      const retry = document.createElement('button');
      retry.className = 'file-retry';
      retry.type = 'button';
      retry.textContent = '重试';
      retry.onclick = (e) => { e.stopPropagation(); MY.files.retry(meta.mid); };
      card.appendChild(retry);
    }

    bubble.appendChild(card);
    return bubble;
  }

  function buildMessageEl(item) {
    const room = P.roomById(S.activeRoomId);
    const ev = item.ev;
    const mine = (item.displayPubkey || ev.pubkey) === S.pub;

    if (item.recalled) {
      const r = document.createElement('div');
      r.className = 'msg-system recall';
      r.dataset.evid = ev.id;
      r.textContent = mine ? '你撤回了一条消息' : '对方撤回了一条消息';
      return r;
    }

    const group = document.createElement('div');
    group.className = 'msg-group ' + (mine ? 'mine' : 'theirs');
    group.dataset.evid = ev.id;

    const showAvatar = shouldShowAvatar(room);
    if (showAvatar) {
      const av = document.createElement('div');
      av.className = 'msg-avatar';
      P.paintAvatar(av, item.displayPubkey || ev.pubkey, item.senderName);
      group.appendChild(av);
    } else {
      group.classList.add('no-avatar');
    }

    const body = document.createElement('div');
    body.className = 'msg-body';

    if (!mine && room && room.type === 'group') {
      const s = document.createElement('div');
      s.className = 'msg-sender';
      s.textContent = item.senderName || P.displayName(item.displayPubkey || ev.pubkey);
      body.appendChild(s);
    }

    let bubble;
    if (item.fileMeta) {
      bubble = buildFileBubble(item, item.fileMeta, room);
    } else {
      bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      if (item.failed) {
        bubble.textContent = '无法解密 · 密钥不匹配';
        bubble.style.color = 'var(--text-3)';
      } else if (item.text == null) {
        bubble.textContent = '解密中…';
        bubble.style.color = 'var(--text-3)';
      } else {
        highlightInto(bubble, item.text, S.searchOpen ? S.msgSearch : '');
      }
    }

    const quote = buildQuote(item, room);
    if (quote) bubble.insertBefore(quote, bubble.firstChild);
    body.appendChild(bubble);

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = U.fmtTime(ev.created_at);
    body.appendChild(time);

    if (!item.fileMeta && (item.status === 'pending' || item.status === 'fail')) {
      const st = document.createElement('div');
      st.className = 'msg-status ' + (item.status === 'fail' ? 'fail' : 'pending');
      st.textContent = item.status === 'fail' ? '发送失败' : '发送中…';
      body.appendChild(st);
    }

    group.appendChild(body);

    const menuBtn = document.createElement('button');
    menuBtn.className = 'msg-menu-btn';
    menuBtn.type = 'button';
    menuBtn.title = '消息操作';
    menuBtn.textContent = '⋯';
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const r = menuBtn.getBoundingClientRect();
      openMsgMenu(item, r.left, r.bottom + 4);
    };
    group.appendChild(menuBtn);
    group.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMsgMenu(item, e.clientX, e.clientY);
    });

    let pressTimer = null;
    group.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      pressTimer = setTimeout(() => {
        openMsgMenu(item, e.touches[0].clientX, e.touches[0].clientY);
      }, 520);
    }, { passive: true });
    const cancel = () => clearTimeout(pressTimer);
    group.addEventListener('touchend', cancel, { passive: true });
    group.addEventListener('touchmove', cancel, { passive: true });

    return group;
  }

  function renderMessages() {
    const el = messagesEl();
    const room = P.roomById(S.activeRoomId);
    if (!el) return;
    if (!room) {
      el.textContent = '';
      renderedSignature = '';
      return;
    }
    const q = S.searchOpen ? S.msgSearch.trim().toLowerCase() : '';
    let items = room.events
      .filter((i) => !i.deleted)
      .sort((a, b) => a.ev.created_at - b.ev.created_at);
    if (q) {
      items = items.filter((i) => {
        if (i.recalled) return false;
        if (i.text && i.text.toLowerCase().includes(q)) return true;
        if (i.fileMeta && String(i.fileMeta.name || '').toLowerCase().includes(q)) return true;
        if (i.senderName && i.senderName.toLowerCase().includes(q)) return true;
        return false;
      });
    }

    const sig = `${room.id}|${q}|` + items.map((i) => [
      i.ev.id, i.recalled ? 'r' : '', i.status || '', i.failed ? 'f' : '',
      i.downloadUrl ? 'd' : '', i.fileProgress || 0, i.text == null ? 'n' : 't',
      i.deleted ? 'x' : '', i.replyTo ? 'q' : '',
    ].join(':')).join('|');
    if (sig === renderedSignature) return;

    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    el.textContent = '';

    if (room.type === 'group' && room.encrypted && !room.key) {
      const warn = document.createElement('div');
      warn.className = 'msg-system warn';
      warn.textContent = '此群聊已加密。输入房间密码后才能查看和发送消息。';
      el.appendChild(warn);
    }

    let prevAt = 0;
    for (const item of items) {
      const at = item.ev.created_at;
      if (!prevAt || at - prevAt > 5 * 60 || new Date(at * 1000).toDateString() !== new Date(prevAt * 1000).toDateString()) {
        const sep = document.createElement('div');
        sep.className = 'msg-date';
        sep.textContent = U.fmtMsgDate(at);
        el.appendChild(sep);
      }
      prevAt = at;
      el.appendChild(buildMessageEl(item));
    }

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'msg-system';
      if (q) empty.textContent = '没有匹配的消息';
      else if (room.type === 'dm') empty.textContent = '私聊消息端到端加密，只有你和对方能读。';
      else empty.textContent = '还没有消息，发一条打个招呼吧';
      el.appendChild(empty);
    }

    const countEl = $('searchCount');
    if (countEl) countEl.textContent = q ? `${items.length} 条` : '';
    if (!q && (atBottom || !items.length)) el.scrollTop = el.scrollHeight;
    renderedSignature = sig;
  }

  function scrollToMessage(id) {
    const el = messagesEl();
    if (!el || !id) return;
    const node = el.querySelector(`[data-evid="${CSS.escape(id)}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const bubble = node.querySelector('.msg-bubble');
    if (bubble) {
      bubble.style.transition = 'box-shadow .25s';
      bubble.style.boxShadow = '0 0 0 2px var(--accent)';
      setTimeout(() => { bubble.style.boxShadow = ''; }, 900);
    }
  }

  function invalidateRender() { renderedSignature = ''; }

  function updateFileItem(item) {
    if (!item || !item.fileMeta) return;
    const el = messagesEl();
    if (!el) return;
    const card = el.querySelector(`[data-file-mid="${CSS.escape(item.fileMeta.mid)}"]`);
    if (!card) return;
    const line = fileLine(item);
    const status = card.querySelector('[data-file-status]');
    const bar = card.querySelector('[data-file-bar]');
    if (bar) bar.style.width = `${Math.round((item.fileProgress || 0) * 100)}%`;
    if (status) {
      status.className = 'file-transfer ' + line.cls;
      status.textContent = line.text;
      if (!item.downloadUrl && !item.failed) {
        const prog = document.createElement('div');
        prog.className = 'file-progress';
        const inner = document.createElement('div');
        inner.className = 'file-progress-bar';
        inner.dataset.fileBar = '1';
        inner.style.width = `${Math.round((item.fileProgress || 0) * 100)}%`;
        prog.appendChild(inner);
        status.appendChild(prog);
      }
    }
  }

  /* ── 头部与连接状态 ── */
  function updateHeader(room) {
    const title = $('roomTitle');
    const sub = $('roomSub');
    if (!title || !sub) return;
    if (!room) {
      title.textContent = '选择一个会话';
      sub.textContent = '在左侧开始聊天';
      return;
    }
    title.textContent = room.label || '未命名';
    const st = MY.net.status();
    const conn = st.connected > 0 ? `已连接 ${st.connected}/${st.total} 个中继` : '未连接中继';
    if (room.type === 'dm') {
      sub.textContent = `私聊 · 端到端加密 · ${conn}`;
    } else {
      const count = room.members ? room.members.size : 0;
      const mode = room.encrypted ? '加密群聊' : '公开群聊';
      sub.textContent = `${mode}${count ? ` · ${count} 位成员` : ''} · ${conn}`;
    }
  }

  function updateConnUI() {
    const st = MY.net.status();
    const dot = $('connDot');
    if (dot) dot.classList.toggle('offline', st.connected === 0);
    const room = P.roomById(S.activeRoomId);
    if (room) updateHeader(room);
    const backend = $('storageBackend');
    if (backend) backend.textContent = MY.store.backendName;
    const st2 = $('storageBackend');
    if (st2) st2.textContent = MY.store.backendName;
  }

  function refreshProfileUI() {
    $('sideMeName').textContent = S.name || '未登录';
    $('sideMePub').textContent = S.pub ? S.pub.slice(0, 12) + '…' : '—';
    P.paintAvatar($('sideMeAvatar'), S.pub, S.name || '—');
    P.paintAvatar($('settingsAvatar'), S.pub, S.name || '密');
    if ($('settingsName')) $('settingsName').textContent = S.name || '—';
    if ($('settingsPub')) $('settingsPub').textContent = S.pub ? S.pub.slice(0, 34) + '…' : '—';
    if ($('nameInput')) $('nameInput').value = S.name || '';
    if ($('appVersion')) $('appVersion').textContent = MY.const.VERSION;
    scheduleRoomList();
    renderContacts();
  }

  /* ── 消息菜单 ── */
  function openMsgMenu(item, x, y) {
    if (!item) return;
    menuTargetItem = item;
    const menu = msgMenuEl();
    const copy = menu.querySelector('[data-action="copy"]');
    const reply = menu.querySelector('[data-action="reply"]');
    const del = menu.querySelector('[data-action="delete"]');
    const recall = menu.querySelector('[data-action="recall"]');
    if (copy) copy.disabled = !(item.text || item.fileMeta);
    if (reply) reply.disabled = !!item.recalled;
    if (del) del.disabled = false;
    if (recall) recall.disabled = !MY.chat.canRecall(item);
    menu.classList.remove('hidden');
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(Math.max(8, x), window.innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(Math.max(8, y), window.innerHeight - r.height - 8) + 'px';
  }

  function closeMsgMenu() {
    msgMenuEl().classList.add('hidden');
    menuTargetItem = null;
  }

  function bindMessageMenu() {
    const menu = msgMenuEl();
    menu.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      const item = menuTargetItem;
      closeMsgMenu();
      if (!item) return;
      if (action === 'copy') {
        const text = item.text || (item.fileMeta ? item.fileMeta.name : '');
        const ok = await U.copyText(text || '');
        toast(ok ? '已复制' : '复制失败');
      } else if (action === 'reply') {
        MY.chat.setReply(item);
      } else if (action === 'delete') {
        MY.chat.deleteForMe(item);
      } else if (action === 'recall') {
        MY.chat.recall(item);
      }
    });
    document.addEventListener('click', (e) => {
      if (!menu.classList.contains('hidden') && !menu.contains(e.target)) closeMsgMenu();
    });
    messagesEl().addEventListener('scroll', () => {
      if (!menu.classList.contains('hidden')) closeMsgMenu();
    }, { passive: true });
    document.addEventListener('scroll', closeRoomMenu, { passive: true });
  }

  /* ── Blob URL ── */
  function trackBlobUrl(room, item, blob) {
    if (item.downloadUrl) {
      try { URL.revokeObjectURL(item.downloadUrl); } catch { /* 忽略 */ }
      room.blobUrls && room.blobUrls.delete(item.downloadUrl);
    }
    const url = URL.createObjectURL(blob);
    item.downloadUrl = url;
    if (!room.blobUrls) room.blobUrls = new Set();
    room.blobUrls.add(url);
    return url;
  }

  function revokeRoomUrls(room) {
    if (!room) return;
    for (const url of room.blobUrls || []) {
      try { URL.revokeObjectURL(url); } catch { /* 忽略 */ }
    }
    if (room.blobUrls) room.blobUrls.clear();
    for (const item of room.events) item.downloadUrl = null;
  }

  async function hydrateBlobs(room) {
    const pending = room.events.filter((i) => i.fileMeta && !i.downloadUrl && !i.failed && !i.recalled);
    await Promise.all(pending.map(async (item) => {
      const blob = await MY.store.loadBlob(item.ev.id);
      if (blob && !item.downloadUrl) {
        trackBlobUrl(room, item, blob);
        item.transferState = 'ok';
      }
    }));
  }

  /* ── 表情 ── */
  function initEmoji() {
    const panel = $('emojiPanel');
    if (!panel) return;
    for (const e of MY.emoji) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.onclick = () => {
        const input = $('msgInput');
        const at = input.selectionStart == null ? input.value.length : input.selectionStart;
        input.value = input.value.slice(0, at) + e + input.value.slice(at);
        input.selectionStart = input.selectionEnd = at + e.length;
        input.focus();
        MY.chat.syncComposerHeight();
      };
      panel.appendChild(b);
    }
    $('emojiBtn').onclick = (e) => {
      e.stopPropagation();
      panel.classList.toggle('hidden');
    };
    document.addEventListener('click', (e) => {
      if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target.id !== 'emojiBtn') {
        panel.classList.add('hidden');
      }
    });
  }

  function openImage(url) {
    if (!url) return;
    $('imageViewer').src = url;
    $('imageOverlay').classList.remove('hidden');
  }

  function closeImage() {
    $('imageOverlay').classList.add('hidden');
    $('imageViewer').src = '';
  }

  function alertMessage(room, title, body) {
    if (!S.settings.notify) return;
    if (document.hidden || S.activeRoomId !== room.id) {
      U.notify(title || room.label, body || '', room.id);
      if (S.settings.sound) U.beep();
    }
  }

  function setReplyBar(item) {
    const bar = $('replyBar');
    if (!bar) return;
    if (!item) {
      bar.classList.add('hidden');
      S.replyTo = null;
      return;
    }
    S.replyTo = {
      id: item.ev.id,
      pub: item.displayPubkey || item.ev.pubkey,
      name: (item.displayPubkey || item.ev.pubkey) === S.pub ? '我' : (item.senderName || P.displayName(item.displayPubkey)),
      preview: item.text ? item.text.slice(0, 80) : ('[文件] ' + (item.fileMeta ? item.fileMeta.name : '')),
    };
    $('replyName').textContent = '回复 ' + S.replyTo.name;
    $('replyText').textContent = S.replyTo.preview;
    bar.classList.remove('hidden');
    $('msgInput').focus();
  }

  MY.ui = {
    toast,
    confirm: confirmDialog,
    initConfirm,
    closeTopOverlays,
    scheduleRoomList,
    scheduleRender,
    invalidateRender,
    openRoomMenu,
    renderRoomList,
    renderContacts,
    switchTab,
    renderMessages,
    updateFileItem,
    updateHeader,
    updateConnUI,
    refreshProfileUI,
    openMsgMenu,
    closeMsgMenu,
    bindMessageMenu,
    trackBlobUrl,
    revokeRoomUrls,
    hydrateBlobs,
    initEmoji,
    openImage,
    closeImage,
    alertMessage,
    setReplyBar,
    fileLine,
    scrollToMessage,
    shouldShowAvatar,
  };
})(window.MY = window.MY || {});
