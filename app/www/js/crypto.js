/* ══════════════════════════════════════════════════════════
   crypto.js · AES-GCM / PBKDF2 / 房间密钥包装
   ══════════════════════════════════════════════════════════ */
(function (MY) {
  'use strict';

  const U = MY.util;
  const enc = U.enc;
  const dec = U.dec;
  const VERIFIER = 'miyu-room-verifier-v1';
  const PBKDF2_ITERATIONS = 210000;

  async function deriveBits(password, salt, iterations) {
    const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: iterations || PBKDF2_ITERATIONS, hash: 'SHA-256' },
      km,
      256
    );
    return new Uint8Array(bits);
  }

  async function importAes(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function deriveRoomKey(password, roomId) {
    const raw = await deriveBits(password, roomId, PBKDF2_ITERATIONS);
    const key = await importAes(raw);
    return { key, raw };
  }

  async function encryptBytes(key, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    return out;
  }

  async function decryptBytes(key, combined) {
    if (!combined || combined.length < 13) throw new Error('bad ciphertext');
    const iv = combined.slice(0, 12);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined.slice(12)));
  }

  async function encryptText(key, text) {
    return U.b64encode(await encryptBytes(key, enc.encode(text)));
  }

  async function decryptText(key, b64) {
    return dec.decode(await decryptBytes(key, U.b64decode(b64)));
  }

  async function makeVerifier(key) {
    return encryptText(key, VERIFIER);
  }

  async function checkVerifier(key, verifier) {
    try {
      return (await decryptText(key, verifier)) === VERIFIER;
    } catch { return false; }
  }

  async function deriveWrapKey(sk) {
    const km = await crypto.subtle.importKey('raw', sk, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('miyu-key-wrap'), info: enc.encode('room-key-v1') },
      km,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function wrapRoomKey(raw, sk) {
    const key = await deriveWrapKey(sk);
    const out = await encryptBytes(key, raw);
    return U.b64encode(out);
  }

  async function unwrapRoomKey(b64, sk) {
    const key = await deriveWrapKey(sk);
    const raw = await decryptBytes(key, U.b64decode(b64));
    return raw;
  }

  async function deriveDmAesKey(convKey) {
    const km = await crypto.subtle.importKey('raw', convKey, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('miyu-dm'), info: enc.encode('file-aes-v1') },
      km,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
      img.src = url;
    });
  }

  async function fileToAvatar(file) {
    const img = await loadImage(file);
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, side, side, 0, 0, 128, 128);
    let q = 0.86;
    let url = canvas.toDataURL('image/jpeg', q);
    while (url.length > 24000 && q > 0.42) {
      q -= 0.1;
      url = canvas.toDataURL('image/jpeg', q);
    }
    return url;
  }

  async function dataUrlToBlob(dataUrl) {
    try {
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return null;
      const head = dataUrl.slice(0, comma);
      const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
      const bin = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    } catch { return null; }
  }

  MY.crypto = {
    VERIFIER,
    deriveRoomKey,
    importAes,
    encryptBytes,
    decryptBytes,
    encryptText,
    decryptText,
    makeVerifier,
    checkVerifier,
    wrapRoomKey,
    unwrapRoomKey,
    deriveDmAesKey,
    fileToAvatar,
    dataUrlToBlob,
  };
})(window.MY = window.MY || {});
