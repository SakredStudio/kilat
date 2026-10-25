// Kilat encrypted cloud backup (v3, Pro+, opt-in, OFF by default). Client side only:
//   passphrase + random salt --PBKDF2(200k, SHA-256)--> AES-GCM-256 key --> encrypt backup JSON.
// The server (projects/kilat/worker) only ever sees { salt, iv, data (ciphertext), updatedAt }
// under an unguessable random vaultId. CLOUD_URL '' means "not configured": the UI then says
// "Belum tersedia". Works in browsers and Node 20+ (globalThis.crypto.subtle).

export const CLOUD_URL = ''; // e.g. 'https://kilat-vault.<account>.workers.dev' once deployed
export const PBKDF2_ITERATIONS = 200_000;
export const MIN_PASSPHRASE_LENGTH = 8;
export const MAX_BLOB_BYTES = 1_000_000;

function subtleOf(cryptoImpl) {
  const c = cryptoImpl || globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto is not available');
  return c;
}

export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  return Buffer.from(u8).toString('base64');
}

export function base64ToBytes(b64) {
  const s = String(b64 || '');
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isCloudConfigured(baseUrl = CLOUD_URL) {
  return typeof baseUrl === 'string' && /^https?:\/\//.test(baseUrl);
}

/** 16 random bytes as 32 hex chars: the only identifier the server ever sees. */
export function newVaultId(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  subtleOf(cryptoImpl).getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function isValidVaultId(id) {
  return /^[0-9a-f]{32}$/.test(String(id || '').trim().toLowerCase());
}

export function normalizeVaultId(id) {
  return String(id || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
}

/** Passphrase rules: at least 8 characters; we recommend 3+ words. Never stored anywhere. */
export function validatePassphrase(passphrase) {
  const p = String(passphrase || '');
  if (p.length < MIN_PASSPHRASE_LENGTH) return { ok: false, reason: 'too_short' };
  if (!/\S/.test(p)) return { ok: false, reason: 'too_short' };
  return { ok: true, reason: '' };
}

export async function deriveKey(passphrase, saltBytes, cryptoImpl = globalThis.crypto) {
  const { subtle } = subtleOf(cryptoImpl);
  const enc = new TextEncoder();
  const baseKey = await subtle.importKey('raw', enc.encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a backup JSON string. Returns the wire payload { salt, iv, data, updatedAt } (base64).
 */
export async function encryptBackup(json, passphrase, { cryptoImpl = globalThis.crypto, now = new Date() } = {}) {
  const check = validatePassphrase(passphrase);
  if (!check.ok) throw new Error(`Passphrase ${check.reason}`);
  const c = subtleOf(cryptoImpl);
  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  c.getRandomValues(salt);
  c.getRandomValues(iv);
  const key = await deriveKey(passphrase, salt, c);
  const plain = new TextEncoder().encode(String(json));
  const cipher = await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return {
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(cipher)),
    updatedAt: (now instanceof Date ? now : new Date(now)).toISOString()
  };
}

/** Decrypt a wire payload back to the JSON string. Throws on a wrong passphrase or tampering. */
export async function decryptBackup(payload, passphrase, { cryptoImpl = globalThis.crypto } = {}) {
  if (!payload || typeof payload !== 'object' || !payload.salt || !payload.iv || !payload.data) {
    throw new Error('Invalid vault payload');
  }
  const c = subtleOf(cryptoImpl);
  const key = await deriveKey(passphrase, base64ToBytes(payload.salt), c);
  let plain;
  try {
    plain = await c.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(payload.iv) }, key, base64ToBytes(payload.data));
  } catch {
    const err = new Error('Wrong passphrase or corrupted vault');
    err.code = 'WRONG_PASSPHRASE';
    throw err;
  }
  return new TextDecoder().decode(plain);
}

export function vaultUrl(vaultId, baseUrl = CLOUD_URL) {
  const id = normalizeVaultId(vaultId);
  if (!isValidVaultId(id)) throw new Error('Invalid vault id');
  return `${String(baseUrl).replace(/\/+$/, '')}/v1/vault/${id}`;
}

async function readError(res) {
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  const err = new Error(`Cloud ${res.status}: ${text.slice(0, 120)}`);
  err.status = res.status;
  return err;
}

export async function uploadVault(vaultId, payload, { fetchImpl = globalThis.fetch, baseUrl = CLOUD_URL } = {}) {
  if (!isCloudConfigured(baseUrl)) {
    const err = new Error('Cloud backup not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const body = JSON.stringify(payload);
  if (body.length > MAX_BLOB_BYTES) {
    const err = new Error('Backup too large for cloud vault (1 MB)');
    err.code = 'TOO_LARGE';
    throw err;
  }
  const res = await fetchImpl(vaultUrl(vaultId, baseUrl), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function downloadVault(vaultId, { fetchImpl = globalThis.fetch, baseUrl = CLOUD_URL } = {}) {
  if (!isCloudConfigured(baseUrl)) {
    const err = new Error('Cloud backup not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const res = await fetchImpl(vaultUrl(vaultId, baseUrl), { method: 'GET' });
  if (res.status === 404) {
    const err = new Error('Vault not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function deleteVault(vaultId, { fetchImpl = globalThis.fetch, baseUrl = CLOUD_URL } = {}) {
  if (!isCloudConfigured(baseUrl)) return { ok: false, code: 'NOT_CONFIGURED' };
  const res = await fetchImpl(vaultUrl(vaultId, baseUrl), { method: 'DELETE' });
  return { ok: res.ok, status: res.status };
}

/** Debounce helper for auto-backup-after-changes (30 s by default). */
export function createDebouncer(fn, delayMs = 30_000, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let handle = null;
  const debounced = (...args) => {
    if (handle) clearTimer(handle);
    handle = setTimer(() => {
      handle = null;
      fn(...args);
    }, delayMs);
  };
  debounced.cancel = () => {
    if (handle) clearTimer(handle);
    handle = null;
  };
  debounced.pending = () => handle !== null;
  return debounced;
}
