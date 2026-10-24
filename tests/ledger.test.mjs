import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRisk,
  computeCustomerSummary,
  computeWarungLedger,
  filterCustomers
} from '../lib/ledger.js';
import { createInitialState, seedDemoData } from '../lib/store.js';

test('ledger: classifyRisk boundaries at 9, 10, 29, 30 days', () => {
  assert.equal(classifyRisk(0), 'Rendah');
  assert.equal(classifyRisk(9), 'Rendah');
  assert.equal(classifyRisk(10), 'Sedang');
  assert.equal(classifyRisk(29), 'Sedang');
  assert.equal(classifyRisk(30), 'Tinggi');
  assert.equal(classifyRisk(45), 'Tinggi');
});

test('ledger: computeCustomerSummary calculates balance, FIFO oldestUnpaidDate, and partial payments', () => {
  const customer = { id: 'c1', name: 'Pak Budi Santoso', phoneRaw: '081234567890', phone62: '6281234567890' };
  const debts = [
    { id: 'd1', customerId: 'c1', amountIdr: 100000, date: '2026-09-20', note: 'Beras' }, // 34 days before Oct 24
    { id: 'd2', customerId: 'c1', amountIdr: 250000, date: '2026-10-10', note: 'Minyak' } // 14 days before Oct 24
  ];

  // 1) No payments -> balance 350.000, oldestUnpaidDate 2026-09-20 (34 days -> Tinggi)
  const s1 = computeCustomerSummary(customer, debts, [], '2026-10-24');
  assert.equal(s1.balance, 350000);
  assert.equal(s1.oldestUnpaidDate, '2026-09-20');
  assert.equal(s1.daysOverdue, 34);
  assert.equal(s1.risk, 'Tinggi');

  // 2) Partial payment Rp 60.000 -> d1 still partially unpaid -> oldestUnpaidDate remains 2026-09-20
  const s2 = computeCustomerSummary(
    customer,
    debts,
    [{ id: 'p1', customerId: 'c1', amountIdr: 60000, date: '2026-10-12' }],
    '2026-10-24'
  );
  assert.equal(s2.balance, 290000);
  assert.equal(s2.oldestUnpaidDate, '2026-09-20');
  assert.equal(s2.daysOverdue, 34);
  assert.equal(s2.risk, 'Tinggi');

  // 3) Payment Rp 100.000 -> d1 fully paid off, oldestUnpaidDate advances to d2 (2026-10-10, 14 days -> Sedang)
  const s3 = computeCustomerSummary(
    customer,
    debts,
    [{ id: 'p1', customerId: 'c1', amountIdr: 100000, date: '2026-10-12' }],
    '2026-10-24'
  );
  assert.equal(s3.balance, 250000);
  assert.equal(s3.oldestUnpaidDate, '2026-10-10');
  assert.equal(s3.daysOverdue, 14);
  assert.equal(s3.risk, 'Sedang');

  // 4) Full payment Rp 350.000 -> balance 0, isPaid true, daysOverdue 0, risk Rendah
  const s4 = computeCustomerSummary(
    customer,
    debts,
    [{ id: 'p1', customerId: 'c1', amountIdr: 350000, date: '2026-10-20' }],
    '2026-10-24'
  );
  assert.equal(s4.balance, 0);
  assert.equal(s4.isPaid, true);
  assert.equal(s4.oldestUnpaidDate, null);
  assert.equal(s4.daysOverdue, 0);
  assert.equal(s4.risk, 'Rendah');
});

test('ledger: computeWarungLedger and filterCustomers match prototype 6 customers', () => {
  const state = seedDemoData(createInitialState(), null, {
    count: 6,
    referenceDate: '2026-10-24T00:00:00.000Z'
  });
  const ledger = computeWarungLedger(state, '2026-10-24');
  // 350k + 125k + 780k + 60k + 500k + 215k = 2.030.000
  assert.equal(ledger.totalPiutang, 2030000);
  assert.equal(ledger.highRiskCount, 2); // Mas Agus (45d) + Pak Hendra (33d)
  assert.equal(ledger.mediumRiskCount, 2); // Pak Budi (21d) + Bu Lestari (14d)
  assert.equal(ledger.lowRiskCount, 2); // Ibu Sari (7d) + Mbak Rina (3d)
  assert.equal(ledger.needFollowupCount, 4);

  const highOnly = filterCustomers(ledger.customers, { riskFilter: 'Tinggi' });
  assert.equal(highOnly.length, 2);
  assert.equal(highOnly[0].name, 'Mas Agus Wibowo');

  const searchBudi = filterCustomers(ledger.customers, { search: 'budi' });
  assert.equal(searchBudi.length, 1);
  assert.equal(searchBudi[0].name, 'Pak Budi Santoso');
});

test('ledger: customer detail history merges utang and bayar entries sorted newest first', () => {
  const customer = { id: 'c1', name: 'Pak Budi Santoso', phoneRaw: '081234567890', phone62: '6281234567890' };
  const debts = [
    { id: 'd1', customerId: 'c1', amountIdr: 200000, date: '2026-10-01', note: 'Sembako awal' },
    { id: 'd2', customerId: 'c1', amountIdr: 150000, date: '2026-10-15', note: 'Beras 5kg' }
  ];
  const payments = [
    { id: 'p1', customerId: 'c1', amountIdr: 100000, date: '2026-10-10', note: 'Cicilan tunai' }
  ];
  const summary = computeCustomerSummary(customer, debts, payments, '2026-10-24');
  assert.equal(summary.history.length, 3);
  assert.equal(summary.history[0].id, 'd2');
  assert.equal(summary.history[0].type, 'debt');
  assert.equal(summary.history[1].id, 'p1');
  assert.equal(summary.history[1].type, 'payment');
  assert.equal(summary.history[2].id, 'd1');
  assert.equal(summary.balance, 250000);
});
