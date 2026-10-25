import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_URL,
  PBKDF2_ITERATIONS,
  isCloudConfigured,
  newVaultId,
  isValidVaultId,
  normalizeVaultId,
  validatePassphrase,
  encryptBackup,
  decryptBackup,
  uploadVault,
  downloadVault,
  vaultUrl,
  createDebouncer
} from '../lib/cloud.js';
import { createInitialState, addCustomer, exportBackupJson, parseBackup, migrate } from '../lib/store.js';
import { activeBook } from '../lib/books.js';
import { handleRequest, isRateLimited, MAX_BODY_BYTES } from '../../worker/src/index.js';

const st = { getItem: () => null, setItem() {} };

/** Minimal fake D1: understands the three statements the worker uses. */
function fakeD1() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.startsWith('SELECT')) {
                const r = rows.get(args[0]);
                return r ? { blob: r.blob, updated_at: r.updated_at, size: r.size } : null;
              }
              throw new Error('first() on non-select');
            },
            async run() {
              if (sql.startsWith('INSERT')) {
                rows.set(args[0], { blob: args[1], updated_at: args[2], size: args[3] });
                return { success: true };
              }
              if (sql.startsWith('DELETE')) {
                rows.delete(args[0]);
                return { success: true };
              }
              throw new Error(`unexpected sql: ${sql}`);
            }
          };
        }
      };
    }
  };
}

test('cloud: not configured by default; vault ids are 32 hex; passphrase rules', () => {
  assert.equal(CLOUD_URL, '');
  assert.equal(isCloudConfigured(), false);
  assert.equal(isCloudConfigured('https://kilat-vault.example.workers.dev'), true);
  assert.equal(PBKDF2_ITERATIONS, 200000);
  const id = newVaultId();
  assert.equal(id.length, 32);
  assert.ok(isValidVaultId(id));
  assert.notEqual(newVaultId(), id);
  assert.equal(normalizeVaultId(' ABCD-EF01 2345 6789 abcd ef01 2345 6789 '), 'abcdef0123456789abcdef0123456789');
  assert.equal(isValidVaultId('zz'), false);
  assert.equal(validatePassphrase('short').ok, false);
  assert.equal(validatePassphrase('        ').ok, false);
  assert.equal(validatePassphrase('warung bu siti 2026').ok, true);
  assert.equal(vaultUrl(id, 'https://x.workers.dev/'), `https://x.workers.dev/v1/vault/${id}`);
});

test('cloud: encrypt -> decrypt round trip restores the full backup; wrong passphrase and tampering fail', async () => {
  let s = addCustomer(createInitialState(), { id: 'c1', name: 'Pak Budi', phone: '0812' }, st);
  const json = exportBackupJson(s);
  const payload = await encryptBackup(json, 'warung bu siti 2026');
  assert.ok(payload.salt && payload.iv && payload.data && payload.updatedAt);
  assert.ok(!payload.data.includes('Pak Budi'));
  assert.ok(!JSON.stringify(payload).includes('Pak Budi'), 'server-side blob holds no plaintext');

  const back = await decryptBackup(payload, 'warung bu siti 2026');
  assert.equal(back, json);
  const restored = parseBackup(back).state;
  assert.equal(activeBook(restored).customers[0].name, 'Pak Budi');
  assert.deepEqual(restored, migrate(s));

  await assert.rejects(() => decryptBackup(payload, 'warung bu siti 2027'), (err) => err.code === 'WRONG_PASSPHRASE');
  const tampered = { ...payload, data: payload.data.slice(0, -4) + 'AAAA' };
  await assert.rejects(() => decryptBackup(tampered, 'warung bu siti 2026'), (err) => err.code === 'WRONG_PASSPHRASE');
  await assert.rejects(() => encryptBackup(json, 'short'), /too_short/);
  // Different salt / iv every time
  const again = await encryptBackup(json, 'warung bu siti 2026');
  assert.notEqual(again.salt, payload.salt);
  assert.notEqual(again.data, payload.data);
});

test('cloud: upload/download refuse when not configured and talk to the vault URL when configured', async () => {
  const id = newVaultId();
  await assert.rejects(() => uploadVault(id, { salt: 'a', iv: 'b', data: 'c' }), (err) => err.code === 'NOT_CONFIGURED');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === 'PUT') return { ok: true, status: 200, json: async () => ({ ok: true, id }) };
    return { ok: true, status: 200, json: async () => JSON.parse(calls[0].body) };
  };
  const payload = { salt: 'c2FsdA==', iv: 'aXY=', data: 'ZGF0YQ==', updatedAt: '2026-10-25T00:00:00.000Z' };
  const up = await uploadVault(id, payload, { fetchImpl, baseUrl: 'https://v.workers.dev' });
  assert.equal(up.ok, true);
  assert.equal(calls[0].url, `https://v.workers.dev/v1/vault/${id}`);
  const down = await downloadVault(id, { fetchImpl, baseUrl: 'https://v.workers.dev' });
  assert.deepEqual(down, payload);
  const notFound = async () => ({ ok: false, status: 404, text: async () => '' });
  await assert.rejects(() => downloadVault(id, { fetchImpl: notFound, baseUrl: 'https://v.workers.dev' }), (err) => err.code === 'NOT_FOUND');
  await assert.rejects(
    () => uploadVault(id, { salt: 'a', iv: 'b', data: 'x'.repeat(1_100_000) }, { fetchImpl, baseUrl: 'https://v.workers.dev' }),
    (err) => err.code === 'TOO_LARGE'
  );
});

test('cloud: debouncer coalesces bursts of changes into one backup after the delay', () => {
  const timers = [];
  const setTimer = (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; };
  const clearTimer = (h) => { h.cleared = true; };
  let runs = 0;
  const d = createDebouncer(() => { runs += 1; }, 30_000, { setTimer, clearTimer });
  d(); d(); d();
  assert.equal(timers.length, 3);
  assert.equal(timers.filter((h) => h.cleared).length, 2);
  assert.equal(d.pending(), true);
  timers[2].fn();
  assert.equal(runs, 1);
  assert.equal(d.pending(), false);
  d(); d.cancel();
  assert.equal(d.pending(), false);
});

test('worker: PUT/GET/DELETE round trip with a fake D1, validation, size cap, CORS and rate limit', async () => {
  const DB = fakeD1();
  const env = { DB, ALLOWED_ORIGIN: 'https://sakredstudio.github.io' };
  const map = new Map();
  let clock = 1_700_000_000_000;
  const opts = { now: () => clock, map };
  const id = newVaultId();
  const base = 'https://kilat-vault.example.workers.dev';
  const req = (method, path, body, headers = {}) =>
    new Request(base + path, {
      method,
      headers: { origin: 'https://sakredstudio.github.io', 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : body
    });

  // preflight + health
  const pre = await handleRequest(req('OPTIONS', `/v1/vault/${id}`), env, opts);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://sakredstudio.github.io');
  assert.ok(pre.headers.get('access-control-allow-methods').includes('PUT'));
  assert.equal((await handleRequest(req('GET', '/'), env, opts)).status, 200);

  // not found before upload, invalid id, invalid payload
  assert.equal((await handleRequest(req('GET', `/v1/vault/${id}`), env, opts)).status, 404);
  assert.equal((await handleRequest(req('GET', '/v1/vault/not-hex'), env, opts)).status, 400);
  assert.equal((await handleRequest(req('PUT', `/v1/vault/${id}`, '{bad json'), env, opts)).status, 400);
  assert.equal((await handleRequest(req('PUT', `/v1/vault/${id}`, JSON.stringify({ salt: 'x' })), env, opts)).status, 400);

  // real encrypted payload round trip
  const payload = await encryptBackup(exportBackupJson(createInitialState()), 'warung bu siti 2026');
  const put = await handleRequest(req('PUT', `/v1/vault/${id}`, JSON.stringify(payload)), env, opts);
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.equal(putBody.ok, true);
  assert.equal(putBody.id, id);
  assert.equal(DB.rows.size, 1);
  assert.ok(!DB.rows.get(id).blob.includes('Warung Bu Siti'), 'D1 holds ciphertext only');

  const get = await handleRequest(req('GET', `/v1/vault/${id}`), env, opts);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('access-control-allow-origin'), 'https://sakredstudio.github.io');
  const stored = await get.json();
  assert.equal(stored.data, payload.data);
  assert.equal(await decryptBackup(stored, 'warung bu siti 2026'), exportBackupJson(createInitialState()));

  // overwrite keeps one row
  clock += 1000;
  await handleRequest(req('PUT', `/v1/vault/${id}`, JSON.stringify(payload)), env, opts);
  assert.equal(DB.rows.size, 1);

  // size cap (declared and actual)
  const big = JSON.stringify({ salt: 'YQ==', iv: 'YQ==', data: 'A'.repeat(MAX_BODY_BYTES + 10) });
  assert.equal((await handleRequest(req('PUT', `/v1/vault/${id}`, big), env, opts)).status, 413);
  assert.equal((await handleRequest(req('PUT', `/v1/vault/${id}`, '{}', { 'content-length': String(MAX_BODY_BYTES + 1) }), env, opts)).status, 413);

  // delete
  assert.equal((await handleRequest(req('DELETE', `/v1/vault/${id}`), env, opts)).status, 200);
  assert.equal((await handleRequest(req('GET', `/v1/vault/${id}`), env, opts)).status, 404);
  assert.equal((await handleRequest(req('POST', `/v1/vault/${id}`, '{}'), env, opts)).status, 405);

  // rate limit: 60 per minute per IP, resets after the window
  const rl = new Map();
  let limited = 0;
  for (let i = 0; i < 70; i++) if (isRateLimited('9.9.9.9', clock, rl)) limited += 1;
  assert.equal(limited, 10);
  assert.equal(isRateLimited('9.9.9.9', clock + 61_000, rl), false);
  assert.equal(isRateLimited('8.8.8.8', clock, rl), false, 'other IPs unaffected');
  const freshMap = new Map();
  for (let i = 0; i < 60; i++) await handleRequest(req('GET', `/v1/vault/${id}`), env, { now: () => clock, map: freshMap });
  const over = await handleRequest(req('GET', `/v1/vault/${id}`), env, { now: () => clock, map: freshMap });
  assert.equal(over.status, 429);
  assert.equal(over.headers.get('retry-after'), '60');
});
