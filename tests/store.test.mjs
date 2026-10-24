import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  FREE_CUSTOMER_LIMIT,
  createInitialState,
  migrate,
  loadState,
  saveState,
  updateWarung,
  updateSettings,
  canAddCustomer,
  addCustomer,
  addDebt,
  addPayment,
  undoLastAction,
  getUndoMeta,
  seedDemoData,
  exportBackupJson,
  importBackupJson,
  exportCsv
} from '../lib/store.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };
}

test('store: createInitialState and save/load round-trip on kilat.v1', () => {
  const mem = createMemoryStorage();
  const s0 = createInitialState();
  assert.equal(STORAGE_KEY, 'kilat.v1');
  assert.equal(s0.schemaVersion, 1);
  assert.equal(s0.warung.currency, 'IDR');
  saveState(s0, mem);
  const loaded = loadState(mem);
  assert.deepEqual(loaded, s0);
});

test('store: enforces 25-customer free tier limit and unlocks with isPro', () => {
  const mem = createMemoryStorage();
  let state = createInitialState();
  for (let i = 1; i <= FREE_CUSTOMER_LIMIT; i++) {
    state = addCustomer(state, { name: `Pelanggan ${i}`, phone: `0812000000${String(i).padStart(2, '0')}` }, mem);
  }
  assert.equal(state.customers.length, 25);
  assert.equal(canAddCustomer(state), false);
  assert.throws(
    () => addCustomer(state, { name: 'Pelanggan 26', phone: '081299999999' }, mem),
    (err) => err.code === 'PRO_LIMIT_REACHED'
  );

  // Unlock Pro
  state = updateSettings(state, { isPro: true }, mem);
  assert.equal(canAddCustomer(state), true);
  state = addCustomer(state, { name: 'Pelanggan 26', phone: '081299999999' }, mem);
  assert.equal(state.customers.length, 26);
});

test('store: addDebt and addPayment support 5-second undo', () => {
  const mem = createMemoryStorage();
  let state = createInitialState();
  state = addCustomer(state, { id: 'c1', name: 'Pak Budi', phone: '081234567890' }, mem);
  state = addDebt(state, { customerId: 'c1', amountIdr: 350000, note: 'Sembako', date: '2026-10-01' }, mem);
  assert.equal(state.debts.length, 1);
  assert.equal(getUndoMeta().type, 'debt');

  // Undo debt
  state = undoLastAction(mem);
  assert.equal(state.debts.length, 0);

  // Add debt again + payment, then undo payment
  state = addDebt(state, { customerId: 'c1', amountIdr: 350000, note: 'Sembako', date: '2026-10-01' }, mem);
  state = addPayment(state, { customerId: 'c1', amountIdr: 150000, note: 'Cicilan', date: '2026-10-10' }, mem);
  assert.equal(state.payments.length, 1);
  assert.equal(getUndoMeta().type, 'payment');

  state = undoLastAction(mem);
  assert.equal(state.payments.length, 0);
  assert.equal(state.debts.length, 1);
});

test('store: seedDemoData(12) seeds 12 customers + 20 debts, JSON backup round-trips, and CSV export is Pro-gated', () => {
  const mem = createMemoryStorage();
  let state = seedDemoData(createInitialState(), mem, { count: 12, referenceDate: '2026-10-24T00:00:00.000Z' });
  assert.equal(state.customers.length, 12);
  assert.equal(state.debts.length, 20);

  const json = exportBackupJson(state);
  const mem2 = createMemoryStorage();
  const restored = importBackupJson(json, mem2);
  assert.equal(restored.customers.length, 12);
  assert.equal(restored.debts.length, 20);

  assert.throws(() => exportCsv(restored), (err) => err.code === 'PRO_REQUIRED');
  const proState = updateSettings(restored, { isPro: true }, mem2);
  const csv = exportCsv(proState);
  assert.ok(csv.includes('Pak Budi Santoso'));
});
