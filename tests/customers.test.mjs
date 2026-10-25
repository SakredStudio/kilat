import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  addCustomer,
  addDebt,
  addPayment,
  deleteCustomer,
  mergeCustomers,
  findCustomerByPhone,
  undoLastAction,
  getUndoMeta
} from '../lib/store.js';
import { computeWarungLedger } from '../lib/ledger.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

function seed() {
  const st = mem();
  let s = createInitialState();
  s = addCustomer(s, { id: 'a', name: 'Pak Budi', phone: '0812-3456-7890', note: 'Sembako' }, st);
  s = addCustomer(s, { id: 'b', name: 'Budi S.', phone: '+62 857 0000 1111', note: 'Rokok' }, st);
  s = addCustomer(s, { id: 'c', name: 'Bu Sari', phone: '0813' }, st);
  s = addDebt(s, { customerId: 'a', amountIdr: 100000, date: '2026-10-01' }, st);
  s = addDebt(s, { customerId: 'b', amountIdr: 50000, date: '2026-10-05' }, st);
  s = addDebt(s, { customerId: 'b', amountIdr: 25000, date: '2026-10-10' }, st);
  s = addPayment(s, { customerId: 'b', amountIdr: 30000, date: '2026-10-12' }, st);
  return { s, st };
}

test('customers: mergeCustomers moves debts and payments, sums balances, keeps both phones in the note, and is undoable', () => {
  let { s, st } = seed();
  s = mergeCustomers(s, 'b', 'a', st);
  assert.equal(s.customers.length, 2);
  assert.ok(!s.customers.some((c) => c.id === 'b'));
  const a = s.customers.find((c) => c.id === 'a');
  assert.equal(a.phone62, '6281234567890');
  assert.ok(a.note.includes('Sembako'));
  assert.ok(a.note.includes('Rokok'));
  assert.ok(a.note.includes('Nomor lain: +62 857 0000 1111'));
  assert.equal(s.debts.filter((d) => d.customerId === 'a').length, 3);
  assert.equal(s.payments.filter((p) => p.customerId === 'a').length, 1);
  assert.equal(s.debts.filter((d) => d.customerId === 'b').length, 0);

  const ledger = computeWarungLedger(s, '2026-10-24');
  const merged = ledger.customers.find((c) => c.id === 'a');
  assert.equal(merged.totalDebt, 175000);
  assert.equal(merged.totalPaid, 30000);
  assert.equal(merged.balance, 145000);
  assert.equal(merged.oldestUnpaidDate, '2026-10-01');

  assert.equal(getUndoMeta().type, 'merge');
  s = undoLastAction(st);
  assert.equal(s.customers.length, 3);
  assert.equal(s.debts.filter((d) => d.customerId === 'b').length, 2);

  assert.throws(() => mergeCustomers(s, 'a', 'a', st), /itself/);
  assert.throws(() => mergeCustomers(s, 'a', 'zzz', st), /not found/);
});

test('customers: findCustomerByPhone detects duplicates across formats and respects excludeId', () => {
  const { s } = seed();
  assert.equal(findCustomerByPhone(s, '081234567890').id, 'a');
  assert.equal(findCustomerByPhone(s, '+62 812 3456 7890').id, 'a');
  assert.equal(findCustomerByPhone(s, '6281234567890').id, 'a');
  assert.equal(findCustomerByPhone(s, '085700001111').id, 'b');
  assert.equal(findCustomerByPhone(s, '081234567890', { excludeId: 'a' }), null);
  assert.equal(findCustomerByPhone(s, '089999999999'), null);
  assert.equal(findCustomerByPhone(s, ''), null);
});

test('customers: deleteCustomer removes the customer with their records and can be undone', () => {
  let { s, st } = seed();
  s = deleteCustomer(s, 'b', st);
  assert.equal(s.customers.length, 2);
  assert.equal(s.debts.length, 1);
  assert.equal(s.payments.length, 0);
  assert.equal(getUndoMeta().type, 'customer');
  s = undoLastAction(st);
  assert.equal(s.customers.length, 3);
  assert.equal(s.debts.length, 3);
  assert.equal(s.payments.length, 1);
  // Unknown id is a no-op
  assert.equal(deleteCustomer(s, 'nope', st).customers.length, 3);
});
