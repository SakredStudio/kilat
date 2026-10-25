import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeBook } from '../lib/books.js';
import {
  createInitialState,
  addCustomer,
  addDebt,
  addSupplier,
  addSupplierDebt,
  addSupplierPayment,
  deleteSupplier,
  setSupplierPayPlan,
  logReminder,
  undoLastAction,
  findCustomerByPhone,
  migrate,
  BOOKS
} from '../lib/store.js';
import { computeWarungLedger, bookView } from '../lib/ledger.js';
import { buildSupplierMessage, SHARE_LINE } from '../lib/wa.js';
import { latestReminderByCustomer } from '../lib/broadcast.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('supplier: hutang ledger math (FIFO, balance, due dates) on the supplier book', () => {
  const st = mem();
  let s = createInitialState();
  s = addSupplier(s, { id: 's1', name: 'Agen Beras Pak Haji', phone: '0812-1111-2222', note: 'Beras' }, st);
  s = addSupplierDebt(s, { customerId: 's1', amountIdr: 2000000, date: '2026-10-01', dueDate: '2026-10-20' }, st);
  s = addSupplierDebt(s, { customerId: 's1', amountIdr: 500000, date: '2026-10-15', dueDate: '2026-11-01' }, st);
  s = addSupplierPayment(s, { customerId: 's1', amountIdr: 2000000, date: '2026-10-18' }, st);
  assert.equal(activeBook(s).suppliers.length, 1);
  assert.equal(activeBook(s).supplierDebts.length, 2);
  assert.equal(activeBook(s).supplierPayments.length, 1);
  assert.equal(activeBook(s).suppliers[0].id, 's1');
  assert.equal(activeBook(s).suppliers[0].phone62, '6281211112222');
  assert.equal(BOOKS.supplier.parties, 'suppliers');

  const ledger = computeWarungLedger(s, '2026-10-24', { book: 'supplier' });
  const sup = ledger.customers[0];
  assert.equal(sup.totalDebt, 2500000);
  assert.equal(sup.totalPaid, 2000000);
  assert.equal(sup.balance, 500000);
  assert.equal(sup.oldestUnpaidDate, '2026-10-15', 'FIFO: first hutang paid off');
  assert.equal(sup.nextDueDate, '2026-11-01');
  assert.equal(sup.dueStatus, 'upcoming');
  assert.equal(ledger.totalPiutang, 500000);

  // undo works for supplier entries too
  s = undoLastAction(st);
  assert.equal(activeBook(s).supplierPayments.length, 0);
});

test('supplier: the two books are isolated (customers untouched by supplier ops and vice versa)', () => {
  const st = mem();
  let s = createInitialState();
  s = addCustomer(s, { id: 'c1', name: 'Pak Budi', phone: '0811' }, st);
  s = addDebt(s, { customerId: 'c1', amountIdr: 100000, date: '2026-10-01' }, st);
  s = addSupplier(s, { id: 'c1', name: 'Same Id Supplier', phone: '0811' }, st); // same id and phone on purpose
  s = addSupplierDebt(s, { customerId: 'c1', amountIdr: 900000, date: '2026-10-02' }, st);

  const cust = computeWarungLedger(s, '2026-10-24');
  const supp = computeWarungLedger(s, '2026-10-24', { book: 'supplier' });
  assert.equal(cust.totalPiutang, 100000);
  assert.equal(supp.totalPiutang, 900000);
  assert.equal(cust.customers[0].name, 'Pak Budi');
  assert.equal(supp.customers[0].name, 'Same Id Supplier');
  assert.deepEqual(bookView(s, 'supplier').debts.map((d) => d.amountIdr), [900000]);

  // duplicate detection is per book
  assert.equal(findCustomerByPhone(s, '0811').name, 'Pak Budi');
  assert.equal(findCustomerByPhone(s, '0811', { book: 'supplier' }).name, 'Same Id Supplier');

  // reminders are tagged with their book
  s = logReminder(s, { customerId: 'c1', book: 'supplier', sentAt: '2026-10-20T08:00:00.000Z' }, st);
  s = logReminder(s, { customerId: 'c1', sentAt: '2026-10-21T08:00:00.000Z' }, st);
  assert.deepEqual(activeBook(s).reminders.map((r) => r.book), ['supplier', 'customer']);
  const supLatest = latestReminderByCustomer(activeBook(s).reminders.filter((r) => r.book === 'supplier'));
  assert.equal(supLatest.c1.sentAt, '2026-10-20T08:00:00.000Z');

  // deleting the supplier leaves the customer, its debt and its reminder alone
  s = deleteSupplier(s, 'c1', st);
  assert.equal(activeBook(s).suppliers.length, 0);
  assert.equal(activeBook(s).supplierDebts.length, 0);
  assert.equal(activeBook(s).customers.length, 1);
  assert.equal(activeBook(s).debts.length, 1);
  assert.deepEqual(activeBook(s).reminders.map((r) => r.book), ['customer']);

  // old v1 states migrate with empty supplier arrays
  const old = migrate({ schemaVersion: 1, customers: [], debts: [], payments: [] });
  assert.deepEqual([activeBook(old).suppliers, activeBook(old).supplierDebts, activeBook(old).supplierPayments], [[], [], []]);
});

test('supplier: "ingatkan saya" pay plan persists and the polite WhatsApp note mentions it', () => {
  const st = mem();
  let s = addSupplier(createInitialState(), { id: 's1', name: 'Bu Grosir', phone: '0813' }, st);
  s = setSupplierPayPlan(s, 's1', { date: '2026-10-30', note: 'setelah setoran' }, st);
  assert.deepEqual(activeBook(s).suppliers[0].payPlan, { date: '2026-10-30', note: 'setelah setoran' });
  assert.deepEqual(activeBook(migrate(JSON.parse(JSON.stringify(s)))).suppliers[0].payPlan, { date: '2026-10-30', note: 'setelah setoran' });
  s = setSupplierPayPlan(s, 's1', { date: 'bad', note: '' }, st);
  assert.equal(activeBook(s).suppliers[0].payPlan, undefined, 'empty plan is dropped');
  s = setSupplierPayPlan(s, 's1', null, st);
  assert.equal(activeBook(s).suppliers[0].payPlan, undefined);
  assert.throws(() => setSupplierPayPlan(s, 'nope', null, st), /not found/);

  const withDate = buildSupplierMessage({ nama: 'Bu Grosir', jumlah: 1500000, warung: 'Warung Bu Siti', tanggal: '2026-10-30' });
  assert.ok(withDate.includes('*Rp 1.500.000*'));
  assert.ok(withDate.includes('akan kami bayar pada *30 Okt 2026*'));
  assert.ok(withDate.endsWith(SHARE_LINE));
  assert.ok(!/menagih|tegas/i.test(withDate), 'polite tone only');
  const noDate = buildSupplierMessage({ nama: 'Bu Grosir', jumlah: 1500000, warung: 'Warung Bu Siti' });
  assert.ok(noDate.includes('sedang kami siapkan'));
  assert.ok(noDate.endsWith(SHARE_LINE));
});
