import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, addCustomer, addDebt, addPayment, logReminder, deleteCustomer, mergeCustomers, migrate } from '../lib/store.js';
import { activeBook } from '../lib/books.js';
import { computeWarungLedger } from '../lib/ledger.js';
import { buildBroadcastQueue, queueProgress, latestReminderByCustomer, isOverdueForBroadcast } from '../lib/broadcast.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

function seed() {
  const st = mem();
  let s = createInitialState();
  s = addCustomer(s, { id: 'low', name: 'Rendah', phone: '0811' }, st);
  s = addCustomer(s, { id: 'mid', name: 'Sedang', phone: '0812' }, st);
  s = addCustomer(s, { id: 'hiSmall', name: 'Tinggi Kecil', phone: '0813' }, st);
  s = addCustomer(s, { id: 'hiBig', name: 'Tinggi Besar', phone: '0814' }, st);
  s = addCustomer(s, { id: 'dueOnly', name: 'Jatuh Tempo', phone: '0815' }, st);
  s = addCustomer(s, { id: 'paid', name: 'Lunas', phone: '0816' }, st);
  s = addDebt(s, { customerId: 'low', amountIdr: 900000, date: '2026-10-21', dueDate: null }, st); // 3d, no due
  s = addDebt(s, { customerId: 'mid', amountIdr: 100000, date: '2026-10-09', dueDate: null }, st); // 15d
  s = addDebt(s, { customerId: 'hiSmall', amountIdr: 50000, date: '2026-09-14', dueDate: null }, st); // 40d
  s = addDebt(s, { customerId: 'hiBig', amountIdr: 500000, date: '2026-09-14', dueDate: null }, st); // 40d
  s = addDebt(s, { customerId: 'dueOnly', amountIdr: 70000, date: '2026-10-22', dueDate: '2026-10-23' }, st); // 2d but overdue by date
  s = addDebt(s, { customerId: 'paid', amountIdr: 70000, date: '2026-09-01' }, st);
  s = addPayment(s, { customerId: 'paid', amountIdr: 70000, date: '2026-09-02' }, st);
  return { s, st };
}

test('broadcast: queue contains only overdue customers, highest risk first, then days, then balance', () => {
  const { s } = seed();
  const ledger = computeWarungLedger(s, '2026-10-24');
  const queue = buildBroadcastQueue(ledger.customers, activeBook(s).reminders);
  assert.deepEqual(queue.map((c) => c.id), ['hiBig', 'hiSmall', 'mid', 'dueOnly']);
  assert.ok(queue.every((c) => c.lastRemindedAt === null));
  const low = ledger.customers.find((c) => c.id === 'low');
  assert.equal(isOverdueForBroadcast(low), false, 'Rendah without due date is not in the queue');
  assert.equal(isOverdueForBroadcast(ledger.customers.find((c) => c.id === 'paid')), false);
});

test('broadcast: logReminder journals {customerId, sentAt, tone}, latest wins, follows delete and merge', () => {
  let { s, st } = seed();
  s = logReminder(s, { customerId: 'hiBig', tone: 'tegas', sentAt: '2026-10-20T09:00:00.000Z' }, st);
  s = logReminder(s, { customerId: 'hiBig', tone: 'sopan', sentAt: '2026-10-24T09:41:00.000Z' }, st);
  s = logReminder(s, { customerId: 'mid', tone: 'singkat', sentAt: '2026-10-23T08:00:00.000Z' }, st);
  assert.equal(activeBook(s).reminders.length, 3);
  assert.ok(activeBook(s).reminders.every((r) => r.id && r.customerId && r.sentAt && r.tone));
  assert.throws(() => logReminder(s, { customerId: 'ghost' }, st), /not found/);

  const latest = latestReminderByCustomer(activeBook(s).reminders);
  assert.equal(latest.hiBig.sentAt, '2026-10-24T09:41:00.000Z');
  assert.equal(latest.hiBig.tone, 'sopan');
  assert.equal(latest.mid.tone, 'singkat');
  assert.equal(latest.low, undefined);

  const queue = buildBroadcastQueue(computeWarungLedger(s, '2026-10-24').customers, activeBook(s).reminders);
  assert.equal(queue[0].lastRemindedAt, '2026-10-24T09:41:00.000Z');

  // Survives a JSON round trip through migrate
  const again = migrate(JSON.parse(JSON.stringify(s)));
  assert.equal(activeBook(again).reminders.length, 3);

  // Merge moves the journal; delete drops it
  s = mergeCustomers(s, 'mid', 'hiSmall', st);
  assert.equal(activeBook(s).reminders.filter((r) => r.customerId === 'hiSmall').length, 1);
  s = deleteCustomer(s, 'hiBig', st);
  assert.equal(activeBook(s).reminders.filter((r) => r.customerId === 'hiBig').length, 0);
});

test('broadcast: queueProgress reports position, sent and skipped counts and completion', () => {
  const queue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(queueProgress(queue, 0, new Set()), { total: 3, position: 1, done: false, sentCount: 0, skippedCount: 0 });
  assert.deepEqual(queueProgress(queue, 2, new Set(['a'])), { total: 3, position: 3, done: false, sentCount: 1, skippedCount: 1 });
  assert.deepEqual(queueProgress(queue, 3, ['a', 'c']), { total: 3, position: 3, done: true, sentCount: 2, skippedCount: 1 });
  assert.equal(queueProgress([], 0).done, true);
});
