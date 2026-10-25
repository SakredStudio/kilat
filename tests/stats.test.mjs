import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, addCustomer, addDebt, addPayment, logReminder } from '../lib/store.js';
import { computeStats, outstandingAsOf, weekStartOf, toUtcDay, STATS_WEEKS } from '../lib/stats.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

function seed() {
  const st = mem();
  let s = createInitialState();
  s = addCustomer(s, { id: 'a', name: 'Pak Budi', phone: '0811' }, st);
  s = addCustomer(s, { id: 'b', name: 'Bu Sari', phone: '0812' }, st);
  s = addCustomer(s, { id: 'c', name: 'Mas Agus', phone: '0813' }, st);
  s = addDebt(s, { customerId: 'a', amountIdr: 300000, date: '2026-08-20' }, st); // long ago
  s = addDebt(s, { customerId: 'b', amountIdr: 100000, date: '2026-10-06' }, st);
  s = addDebt(s, { customerId: 'c', amountIdr: 700000, date: '2026-10-19' }, st);
  s = addPayment(s, { customerId: 'a', amountIdr: 50000, date: '2026-09-15' }, st); // last month
  s = addPayment(s, { customerId: 'b', amountIdr: 40000, date: '2026-10-10' }, st); // this month
  s = addPayment(s, { customerId: 'c', amountIdr: 200000, date: '2026-10-22' }, st); // this month
  s = logReminder(s, { customerId: 'a', sentAt: '2026-10-02T08:00:00.000Z' }, st);
  s = logReminder(s, { customerId: 'c', sentAt: '2026-10-23T08:00:00.000Z' }, st);
  s = logReminder(s, { customerId: 'a', sentAt: '2026-09-28T08:00:00.000Z' }, st);
  return s;
}

test('stats: week helpers (Monday start) and outstandingAsOf clamp per customer', () => {
  assert.equal(weekStartOf(toUtcDay('2026-10-24')).toISOString().slice(0, 10), '2026-10-19'); // Sat -> Mon
  assert.equal(weekStartOf(toUtcDay('2026-10-19')).toISOString().slice(0, 10), '2026-10-19'); // Mon
  assert.equal(weekStartOf(toUtcDay('2026-10-25')).toISOString().slice(0, 10), '2026-10-19'); // Sun
  const s = seed();
  assert.equal(outstandingAsOf(s, '2026-08-31'), 300000);
  assert.equal(outstandingAsOf(s, '2026-09-30'), 250000);
  assert.equal(outstandingAsOf(s, '2026-10-24'), 250000 + 60000 + 500000);
  // Overpayment of one customer never offsets another's balance
  const over = addPayment(s, { customerId: 'c', amountIdr: 999999, date: '2026-11-01' }, mem());
  assert.equal(outstandingAsOf(over, '2026-11-30'), 250000 + 60000 + 0, 'overpayment clamps to zero');
});

test('stats: computeStats gives 8 weekly bars ending today, top 5 debtors, month comparison, reminder count', () => {
  const s = seed();
  const st = computeStats(s, '2026-10-24');
  assert.equal(st.weekly.length, STATS_WEEKS);
  assert.equal(st.weekly[7].weekStart, '2026-10-19');
  assert.equal(st.weekly[7].isCurrent, true);
  assert.equal(st.weekly[0].weekStart, '2026-08-31');
  assert.equal(st.weekly[7].outstanding, 810000);
  assert.equal(st.weekly[5].weekEnd, '2026-10-11');
  assert.equal(st.weekly[5].outstanding, 250000 + 60000); // b's debt and payment both before 11 Oct
  assert.equal(st.maxWeekly, 810000);
  assert.equal(st.weekly[7].ratio, 1);
  assert.ok(st.weekly[0].ratio > 0 && st.weekly[0].ratio < 1);

  assert.deepEqual(st.topDebtors.map((c) => c.id), ['c', 'a', 'b']);
  assert.equal(st.topDebtors[0].rank, 1);
  assert.equal(st.topDebtors[0].balance, 500000);
  assert.equal(st.totalOutstanding, 810000);
  assert.equal(st.activeCount, 3);

  assert.equal(st.thisMonth, '2026-10');
  assert.equal(st.lastMonth, '2026-09');
  assert.equal(st.collectedThisMonth, 240000);
  assert.equal(st.collectedLastMonth, 50000);
  assert.equal(st.collectedDeltaPct, 380);
  assert.equal(st.remindersThisMonth, 2);

  // January rolls back to December of the previous year; no last-month payments -> delta null
  const jan = computeStats(s, '2027-01-05');
  assert.equal(jan.lastMonth, '2026-12');
  assert.equal(jan.collectedDeltaPct, null);

  // Empty state is safe
  const empty = computeStats(createInitialState(), '2026-10-24');
  assert.equal(empty.weekly.length, 8);
  assert.equal(empty.maxWeekly, 0);
  assert.deepEqual(empty.topDebtors, []);
});
