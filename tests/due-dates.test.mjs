import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, addCustomer, addDebt, addPayment, migrate } from '../lib/store.js';
import { computeWarungLedger, dueBuckets } from '../lib/ledger.js';
import { buildReminderMessage, REMINDER_TEMPLATES_DUE, SHARE_LINE, formatTanggal } from '../lib/wa.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('due-dates: migrate adds dueDate=null to debts without one and keeps valid ones', () => {
  const s = migrate({
    schemaVersion: 1,
    customers: [{ id: 'c1', name: 'A', phone: '0812' }],
    debts: [
      { id: 'd1', customerId: 'c1', amountIdr: 1000, date: '2026-10-01' },
      { id: 'd2', customerId: 'c1', amountIdr: 1000, date: '2026-10-01', dueDate: '2026-10-15' },
      { id: 'd3', customerId: 'c1', amountIdr: 1000, date: '2026-10-01', dueDate: 'garbage' }
    ]
  });
  assert.equal(s.debts[0].dueDate, null);
  assert.equal(s.debts[1].dueDate, '2026-10-15');
  assert.equal(s.debts[2].dueDate, null);
});

test('due-dates: addDebt defaults dueDate to date + dueDays, honours explicit date, and null clears it', () => {
  const st = mem();
  let s = addCustomer(createInitialState(), { id: 'c1', name: 'Pak Budi', phone: '081234567890' }, st);
  s = addDebt(s, { customerId: 'c1', amountIdr: 10000, date: '2026-10-01' }, st);
  assert.equal(s.debts[0].dueDate, '2026-10-15'); // dueDays 14
  s = addDebt(s, { customerId: 'c1', amountIdr: 10000, date: '2026-10-01', dueDate: '2026-10-05' }, st);
  assert.equal(s.debts[1].dueDate, '2026-10-05');
  s = addDebt(s, { customerId: 'c1', amountIdr: 10000, date: '2026-10-01', dueDate: null }, st);
  assert.equal(s.debts[2].dueDate, null);
});

test('due-dates: dueBuckets with injected today splits today / overdue / upcoming and follows FIFO payments', () => {
  const st = mem();
  let s = createInitialState();
  s = addCustomer(s, { id: 'today', name: 'Hari Ini', phone: '0811' }, st);
  s = addCustomer(s, { id: 'late', name: 'Telat', phone: '0812' }, st);
  s = addCustomer(s, { id: 'soon', name: 'Nanti', phone: '0813' }, st);
  s = addCustomer(s, { id: 'paid', name: 'Lunas', phone: '0814' }, st);
  s = addCustomer(s, { id: 'none', name: 'Tanpa', phone: '0815' }, st);
  s = addDebt(s, { customerId: 'today', amountIdr: 50000, date: '2026-10-10', dueDate: '2026-10-24' }, st);
  s = addDebt(s, { customerId: 'late', amountIdr: 70000, date: '2026-10-01', dueDate: '2026-10-20' }, st);
  s = addDebt(s, { customerId: 'late', amountIdr: 20000, date: '2026-10-21', dueDate: '2026-11-04' }, st);
  s = addDebt(s, { customerId: 'soon', amountIdr: 30000, date: '2026-10-20', dueDate: '2026-10-30' }, st);
  s = addDebt(s, { customerId: 'paid', amountIdr: 30000, date: '2026-10-01', dueDate: '2026-10-05' }, st);
  s = addPayment(s, { customerId: 'paid', amountIdr: 30000, date: '2026-10-03' }, st);
  s = addDebt(s, { customerId: 'none', amountIdr: 30000, date: '2026-10-01', dueDate: null }, st);

  const ledger = computeWarungLedger(s, '2026-10-24');
  const byId = Object.fromEntries(ledger.customers.map((c) => [c.id, c]));
  assert.equal(byId.today.dueStatus, 'today');
  assert.equal(byId.today.daysToDue, 0);
  assert.equal(byId.late.dueStatus, 'overdue');
  assert.equal(byId.late.daysToDue, -4);
  assert.equal(byId.late.nextDueDate, '2026-10-20');
  assert.equal(byId.soon.dueStatus, 'upcoming');
  assert.equal(byId.paid.dueStatus, null);
  assert.equal(byId.none.dueStatus, null);
  assert.equal(byId.none.risk, 'Sedang', 'risk aging is independent of due date');

  const b = dueBuckets(ledger.customers);
  assert.deepEqual(b.today.map((c) => c.id), ['today']);
  assert.deepEqual(b.overdue.map((c) => c.id), ['late']);
  assert.equal(ledger.dueCount, 2);

  // Paying off the first debt of 'late' moves nextDueDate to the second debt (FIFO)
  s = addPayment(s, { customerId: 'late', amountIdr: 70000, date: '2026-10-24' }, st);
  const after = computeWarungLedger(s, '2026-10-24').customers.find((c) => c.id === 'late');
  assert.equal(after.nextDueDate, '2026-11-04');
  assert.equal(after.dueStatus, 'upcoming');
});

test('due-dates: reminder templates mention {tanggal} only when a due date is given; share line always present', () => {
  const base = { nama: 'Pak Budi', jumlah: 350000, hari: 21, warung: 'Warung Bu Siti' };
  for (const tone of ['sopan', 'singkat', 'tegas']) {
    const without = buildReminderMessage({ ...base, tone });
    assert.ok(!without.includes('jatuh tempo'), `${tone} without date must not mention jatuh tempo`);
    assert.ok(!without.includes('{tanggal}'));
    assert.ok(without.endsWith(SHARE_LINE));

    const withDate = buildReminderMessage({ ...base, tone, tanggal: '2026-10-24' });
    assert.ok(withDate.includes('24 Okt 2026'), `${tone} with date must include formatted date`);
    assert.ok(withDate.includes('jatuh tempo'));
    assert.ok(withDate.includes('Rp 350.000'));
    assert.ok(withDate.endsWith(SHARE_LINE));
    assert.ok(REMINDER_TEMPLATES_DUE[tone].includes('{tanggal}'));
  }
  assert.equal(formatTanggal('2026-01-05'), '5 Jan 2026');
  assert.equal(formatTanggal('besok'), 'besok');
  // Custom template can use {tanggal} too
  const custom = buildReminderMessage({ ...base, tanggal: '2026-10-24', customTemplate: 'Halo {nama}, {jumlah} jatuh tempo {tanggal}.' });
  assert.ok(custom.startsWith('Halo Pak Budi, Rp 350.000 jatuh tempo 24 Okt 2026.'));
});
