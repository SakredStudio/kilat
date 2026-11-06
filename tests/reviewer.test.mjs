import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REVIEWER_CODE_SHA256,
  normalizeReviewerCode,
  sha256Hex,
  matchesCodeHash,
  isReviewerCode
} from '../lib/reviewer.js';
import { isProActive, bookLimit, PRO_BOOK_LIMIT, FREE_BOOK_LIMIT } from '../lib/books.js';
import {
  FREE_CUSTOMER_LIMIT,
  createInitialState,
  migrate,
  loadState,
  saveState,
  updateSettings,
  canAddCustomer,
  addCustomer,
  exportBackupJson,
  parseBackup,
  importBackupJson,
  keepDeviceAccess,
  exportCsv
} from '../lib/store.js';
import { hasProPurchase } from '../lib/billing.js';
import { buildShareCardModel } from '../lib/share-card.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };
}

// A made-up code used ONLY by these tests (same shape as the real one: 14 chars, A-Z 0-9 hyphen).
// The real reviewer code is not in this repo; the tests never try to guess it.
const TEST_CODE = 'TEST-CODE-0001';
const TEST_HASH = createHash('sha256').update(TEST_CODE, 'utf8').digest('hex');

test('reviewer: sha256Hex (Web Crypto) agrees with node:crypto and a known vector', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(TEST_CODE), TEST_HASH);
});

test('reviewer: matchesCodeHash accepts only the code whose hash was given', async () => {
  assert.equal(await matchesCodeHash(TEST_CODE, TEST_HASH), true);
  assert.equal(await matchesCodeHash('TEST-CODE-0002', TEST_HASH), false);
  assert.equal(await matchesCodeHash('TESTCODE0001', TEST_HASH), false);
  assert.equal(await matchesCodeHash(TEST_HASH, TEST_HASH), false, 'typing the hash itself is not the code');
  assert.equal(await matchesCodeHash('', TEST_HASH), false);
  assert.equal(await matchesCodeHash('   ', TEST_HASH), false);
  assert.equal(await matchesCodeHash(null, TEST_HASH), false);
  assert.equal(await matchesCodeHash(undefined, TEST_HASH), false);
  // a malformed / missing expected hash never matches anything
  assert.equal(await matchesCodeHash(TEST_CODE, ''), false);
  assert.equal(await matchesCodeHash(TEST_CODE, undefined), false);
  assert.equal(await matchesCodeHash(TEST_CODE, TEST_HASH.slice(0, 63)), false);
});

test('reviewer: input is trimmed and upper-cased before hashing (inner characters untouched)', async () => {
  assert.equal(normalizeReviewerCode('  test-code-0001 \n'), TEST_CODE);
  assert.equal(normalizeReviewerCode(null), '');
  assert.equal(await matchesCodeHash('  test-code-0001  ', TEST_HASH), true);
  assert.equal(await matchesCodeHash('\tTest-Code-0001\n', TEST_HASH), true);
  assert.equal(await matchesCodeHash('TEST CODE 0001', TEST_HASH), false);
  assert.equal(await matchesCodeHash('TEST- CODE-0001', TEST_HASH), false);
  // the expected hash may be given in upper case
  assert.equal(await matchesCodeHash(TEST_CODE, TEST_HASH.toUpperCase()), true);
});

test('reviewer: isReviewerCode checks against the shipped hash and rejects everything else here', async () => {
  assert.match(REVIEWER_CODE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(REVIEWER_CODE_SHA256, '401e21fe4158f5714e94867b948de36c075774c2f7ceed6b1200a719593f90b2');
  assert.equal(await isReviewerCode(TEST_CODE), false);
  assert.equal(await isReviewerCode(''), false);
  assert.equal(await isReviewerCode(REVIEWER_CODE_SHA256), false);
});

test('reviewer: only the hash ships; reviewer.js holds no other code-shaped literal', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/reviewer.js'), 'utf8');
  const literals = [...src.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2]);
  const codeShaped = literals.filter((s) => /^[A-Z0-9-]{14}$/.test(s));
  assert.deepEqual(codeShaped, []);
  assert.ok(literals.includes(REVIEWER_CODE_SHA256));
});

test('reviewer: isProActive is true for a purchase OR reviewer access, false otherwise', () => {
  const base = createInitialState();
  assert.equal(base.settings.reviewerAccess, false);
  assert.equal(isProActive(base), false);
  assert.equal(isProActive(null), false);
  assert.equal(isProActive({}), false);
  assert.equal(isProActive({ settings: { isPro: true } }), true);
  assert.equal(isProActive({ settings: { reviewerAccess: true } }), true);
  assert.equal(isProActive({ settings: { isPro: false, reviewerAccess: false } }), false);
});

test('reviewer: reviewer access opens every Pro gate in lib/ and survives a reload', () => {
  const mem = createMemoryStorage();
  let state = createInitialState();
  for (let i = 1; i <= FREE_CUSTOMER_LIMIT; i++) {
    state = addCustomer(state, { name: `Pelanggan ${i}`, phone: `0812000000${String(i).padStart(2, '0')}` }, mem);
  }
  assert.equal(canAddCustomer(state), false);
  assert.equal(bookLimit(state), FREE_BOOK_LIMIT);
  assert.throws(() => exportCsv(state), (err) => err.code === 'PRO_REQUIRED');
  assert.equal(buildShareCardModel(state, '2026-11-05').showWatermark, true);

  state = updateSettings(state, { reviewerAccess: true }, mem);
  assert.equal(state.settings.isPro, false, 'the purchase flag is not touched');
  assert.equal(state.settings.reviewerAccess, true);

  const reloaded = loadState(mem);
  assert.equal(reloaded.settings.reviewerAccess, true);
  assert.equal(reloaded.settings.isPro, false);
  assert.equal(isProActive(reloaded), true);
  assert.equal(canAddCustomer(reloaded), true);
  assert.equal(bookLimit(reloaded), PRO_BOOK_LIMIT);
  assert.ok(exportCsv(reloaded).includes('Pelanggan 1'));
  assert.equal(buildShareCardModel(reloaded, '2026-11-05').showWatermark, false);
  const after = addCustomer(reloaded, { name: 'Pelanggan 26', phone: '081299999999' }, mem);
  assert.equal(after.books[0].customers.length, FREE_CUSTOMER_LIMIT + 1);
});

test('reviewer: a billing sync that finds no purchase does not clear reviewer access', async () => {
  const mem = createMemoryStorage();
  let state = updateSettings(createInitialState(), { reviewerAccess: true }, mem);

  // Play TWA with the billing bridge, but this Google account owns nothing.
  const win = {
    PaymentRequest: class {},
    getDigitalGoodsService: async () => ({ getDetails: async () => [], listPurchases: async () => [] })
  };
  const owned = await hasProPurchase(win);
  assert.equal(owned, false);

  // Same rule as initApp()/restore in app.js: billing only ever writes the purchase flag.
  if (owned && !state.settings.isPro) state = updateSettings(state, { isPro: true }, mem);
  assert.equal(state.settings.isPro, false);
  assert.equal(state.settings.reviewerAccess, true);
  assert.equal(isProActive(state), true);

  // Even a sync that actively writes "no purchase" leaves the reviewer flag alone.
  state = updateSettings(state, { isPro: owned }, mem);
  assert.equal(state.settings.isPro, false);
  assert.equal(state.settings.reviewerAccess, true);
  assert.equal(isProActive(loadState(mem)), true);

  // And a real purchase later simply adds the purchase flag.
  state = updateSettings(state, { isPro: true }, mem);
  assert.deepEqual([state.settings.isPro, state.settings.reviewerAccess], [true, true]);
});

test('reviewer: states and backups without the field still load (reviewerAccess defaults to false)', () => {
  const old = createInitialState();
  delete old.settings.reviewerAccess;
  assert.equal(migrate(old).settings.reviewerAccess, false);

  const mem = createMemoryStorage();
  mem.setItem('kilat.v1', JSON.stringify(old));
  assert.equal(loadState(mem).settings.reviewerAccess, false);

  const { state } = parseBackup(JSON.stringify({ ...old, settings: { ...old.settings, isPro: true } }));
  assert.equal(state.settings.reviewerAccess, false);
  assert.equal(state.settings.isPro, true, 'the purchase flag in old backups behaves as before');

  // v1 flat backup (no books[], no reviewerAccess)
  const v1 = parseBackup(JSON.stringify({ schemaVersion: 1, customers: [], debts: [], payments: [], settings: { tone: 'sopan' } }));
  assert.equal(v1.state.settings.reviewerAccess, false);
});

test('reviewer: the flag is not exported, a backup cannot grant it, and an import keeps the device flag', () => {
  const memA = createMemoryStorage();
  const reviewerDevice = updateSettings(createInitialState(), { reviewerAccess: true }, memA);

  // Export: the key is absent from the JSON, everything else is unchanged.
  const exported = JSON.parse(exportBackupJson(reviewerDevice));
  assert.equal('reviewerAccess' in exported.settings, false);
  assert.equal(exported.settings.isPro, false);
  assert.deepEqual({ ...exported.settings, reviewerAccess: true }, reviewerDevice.settings);
  assert.equal(reviewerDevice.settings.reviewerAccess, true, 'exporting does not mutate the live state');

  // Import on another phone: no reviewer access arrives with the file.
  const memB = createMemoryStorage();
  const onOtherPhone = importBackupJson(exportBackupJson(reviewerDevice), memB);
  assert.equal(onOtherPhone.settings.reviewerAccess, false);
  assert.equal(isProActive(loadState(memB)), false);

  // A hand-edited backup that sets the flag is ignored.
  const forged = JSON.stringify({ ...exported, settings: { ...exported.settings, reviewerAccess: true } });
  assert.equal(parseBackup(forged).state.settings.reviewerAccess, false);
  assert.equal(importBackupJson(forged, createMemoryStorage()).settings.reviewerAccess, false);

  // Importing a plain backup on the reviewer's own device keeps that device's access.
  const plain = exportBackupJson(createInitialState());
  const afterImport = importBackupJson(plain, memA);
  assert.equal(afterImport.settings.reviewerAccess, true);
  assert.equal(isProActive(loadState(memA)), true);
  assert.equal(keepDeviceAccess(parseBackup(plain).state, reviewerDevice).settings.reviewerAccess, true);
  assert.equal(keepDeviceAccess(parseBackup(forged).state, createInitialState()).settings.reviewerAccess, false);

  // saveState round-trip keeps the field shape stable.
  assert.deepEqual(loadState(memA), saveState(afterImport, memA));
});
