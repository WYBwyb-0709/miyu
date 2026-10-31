/* ══════════════════════════════════════════════════════════
   auth.js · 账户创建 / 解锁 / 导入 / 退出
   ══════════════════════════════════════════════════════════ */
(function (MY) {
  'use strict';

  const U = MY.util;
  const S = MY.state;
  const ACCOUNT_KEY = 'miyu.account';
  const NAME_KEY = 'miyu.name';
  const PUB_KEY = 'miyu.pub';

  function showView(view) {
    U.$('authCreateView').classList.add('hidden');
    U.$('authUnlockView').classList.add('hidden');
    U.$('authImportView').classList.add('hidden');
    U.$('authOverlay').classList.remove('hidden');
    if (view === 'create') U.$('authCreateView').classList.remove('hidden');
    if (view === 'unlock') U.$('authUnlockView').classList.remove('hidden');
    if (view === 'import') U.$('authImportView').classList.remove('hidden');
  }

  async function clearPreviousAccount(nextPub) {
    const oldPub = localStorage.getItem(PUB_KEY);
    if (!oldPub || oldPub === nextPub) return;
    try {
      await MY.store.init(oldPub);
      await MY.store.clearAccount();
    } catch { /* 忽略 */ }
    try {
      localStorage.removeItem(`miyu.rooms.${oldPub}`);
      localStorage.removeItem(`miyu.contacts.${oldPub}`);
      localStorage.removeItem(`miyu.profile.${oldPub}`);
      localStorage.removeItem(`miyu.last.${oldPub}`);
    } catch { /* 忽略 */ }
  }

  async function enterApp(sk, pub, name) {
    S.sk = sk;
    S.pub = pub;
    S.name = name;
    localStorage.setItem(NAME_KEY, name);
    localStorage.setItem(PUB_KEY, pub);
    await MY.store.init(pub);
    MY.people.loadContacts();
    MY.people.loadProfile();
    await MY.app.start();
    U.$('authOverlay').classList.add('hidden');
  }

  const Auth = {
    showView,

    init() {
      const saved = localStorage.getItem(ACCOUNT_KEY);
      if (saved) {
        showView('unlock');
        const nm = localStorage.getItem(NAME_KEY) || '未知';
        U.$('unlockDesc').textContent = `账户：${nm}。输入密码解锁。`;
        setTimeout(() => U.$('unlockPassword').focus(), 60);
      } else {
        showView('create');
        setTimeout(() => U.$('createUsername').focus(), 60);
      }
    },

    async create(username, password) {
      const oldPub = localStorage.getItem(PUB_KEY);
      const skBytes = MiyuVendor.generateSecretKey();
      const ncryptsec = MiyuVendor.nip49.encrypt(skBytes, password, 16, 0x02);
      const pub = MiyuVendor.getPublicKey(skBytes);
      if (oldPub && oldPub !== pub) await clearPreviousAccount(pub);
      localStorage.setItem(ACCOUNT_KEY, ncryptsec);
      await enterApp(skBytes, pub, username);
    },

    async unlock(password) {
      const ncryptsec = localStorage.getItem(ACCOUNT_KEY);
      if (!ncryptsec) throw new Error('本设备没有账户');
      const skBytes = MiyuVendor.nip49.decrypt(ncryptsec, password);
      const pub = MiyuVendor.getPublicKey(skBytes);
      const name = localStorage.getItem(NAME_KEY) || '用户';
      await enterApp(skBytes, pub, name);
    },

    async import(ncryptsec, username, password) {
      const skBytes = MiyuVendor.nip49.decrypt(ncryptsec, password);
      const pub = MiyuVendor.getPublicKey(skBytes);
      const oldPub = localStorage.getItem(PUB_KEY);
      if (oldPub && oldPub !== pub) await clearPreviousAccount(pub);
      localStorage.setItem(ACCOUNT_KEY, ncryptsec);
      await enterApp(skBytes, pub, username);
    },

    exportNcryptsec() {
      return localStorage.getItem(ACCOUNT_KEY) || '';
    },

    async logout() {
      const pub = S.pub;
      MY.net.shutdown();
      for (const room of S.rooms.values()) {
        try { room.sub && room.sub.close(); } catch { /* 忽略 */ }
        MY.ui.revokeRoomUrls(room);
      }
      if (pub) {
        try {
          await MY.store.init(pub);
          await MY.store.clearAccount();
        } catch { /* 忽略 */ }
      }
      try {
        localStorage.removeItem(ACCOUNT_KEY);
        localStorage.removeItem(NAME_KEY);
        localStorage.removeItem(PUB_KEY);
        if (pub) {
          localStorage.removeItem(`miyu.rooms.${pub}`);
          localStorage.removeItem(`miyu.contacts.${pub}`);
          localStorage.removeItem(`miyu.profile.${pub}`);
          localStorage.removeItem(`miyu.last.${pub}`);
        }
      } catch { /* 忽略 */ }
      location.reload();
    },
  };

  MY.auth = Auth;

  window.addEventListener('DOMContentLoaded', () => {
    const $ = U.$;
    const go = (id, view) => {
      const el = $(id);
      if (el) el.onclick = () => showView(view);
    };
    go('btnGotoImport', 'import');
    go('btnGotoCreate', 'create');
    go('btnGotoImportFromUnlock', 'import');

    $('btnCreateSubmit').onclick = async () => {
      const username = $('createUsername').value.trim();
      const p1 = $('createPassword').value;
      const p2 = $('createPasswordConfirm').value;
      const err = $('createError');
      err.textContent = '';
      if (!username) { err.textContent = '请填写用户名'; return; }
      if (username.length > 24) { err.textContent = '用户名不能超过 24 个字符'; return; }
      if (!p1 || p1.length < 6) { err.textContent = '密码至少 6 位'; return; }
      if (p1 !== p2) { err.textContent = '两次输入的密码不一致'; return; }
      if (localStorage.getItem(ACCOUNT_KEY) && !confirm('本设备已有账户。继续将覆盖当前账户，且不会自动备份。建议先导出 ncryptsec。确定继续？')) return;
      const btn = $('btnCreateSubmit');
      btn.disabled = true;
      try {
        await Auth.create(username, p1);
      } catch (e) {
        err.textContent = '创建失败：' + (e && e.message ? e.message : '未知错误');
      } finally { btn.disabled = false; }
    };

    $('btnUnlockSubmit').onclick = async () => {
      const pwd = $('unlockPassword').value;
      const err = $('unlockError');
      err.textContent = '';
      if (!pwd) { err.textContent = '请输入密码'; return; }
      const btn = $('btnUnlockSubmit');
      btn.disabled = true;
      try {
        await Auth.unlock(pwd);
      } catch {
        err.textContent = '密码错误或账户数据损坏';
      } finally { btn.disabled = false; }
    };

    $('btnImportSubmit').onclick = async () => {
      const ncryptsec = $('importNcryptsec').value.trim();
      const username = $('importUsername').value.trim();
      const pwd = $('importPassword').value;
      const err = $('importError');
      err.textContent = '';
      if (!ncryptsec.startsWith('ncryptsec1')) { err.textContent = 'ncryptsec 字符串格式不正确'; return; }
      if (!username) { err.textContent = '请填写显示名称'; return; }
      if (!pwd) { err.textContent = '请输入密码'; return; }
      const btn = $('btnImportSubmit');
      btn.disabled = true;
      try {
        await Auth.import(ncryptsec, username, pwd);
      } catch {
        err.textContent = '导入失败：密码错误或 ncryptsec 无效';
      } finally { btn.disabled = false; }
    };

    for (const [id, handler] of [
      ['unlockPassword', () => $('btnUnlockSubmit').click()],
      ['importPassword', () => $('btnImportSubmit').click()],
      ['createPasswordConfirm', () => $('btnCreateSubmit').click()],
    ]) {
      const el = $(id);
      if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handler(); } });
    }
  });
})(window.MY = window.MY || {});
