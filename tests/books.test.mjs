import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  migrate,
  addCustomer,
  addDebt,
  addSupplier,
  addSupplierDebt,
  addBook,
  switchBook,
  deleteBook,
  updateWarung,
  updateSettings,
  undoLastAction,
  exportBackupJson,
  parseBackup,
  seedDemoData,
  CURRENT_SCHEMA_VERSION
} from '../lib/store.js';
import { activeBook, canAddBook, listBooks, FREE_BOOK_LIMIT, PRO_BOOK_LIMIT } from '../lib/books.js';
import { computeWarungLedger } from '../lib/ledger.js';
import { buildShareCardModel } from '../lib/share-card.js';
import { computeStats } from '../lib/stats.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('books: migrate wraps a v1 single-book state as books[0] and keeps every record', () => {
  const v1 = {
    schemaVersion: 1,
    warung: { name: 'Warung Lama', ownerName: 'Bu Ani', phone: '0812', dueDays: 7 },
    customers: [{ id: 'c1', name: 'Pak Budi', phone: '0813' }],
    debts: [{ id: 'd1', customerId: 'c1', amountIdr: 50000, date: '2026-10-01' }],
    payments: [{ id: 'p1', customerId: 'c1', amountIdr: 20000, date: '2026-10-05' }],
    reminders: [{ customerId: 'c1', sentAt: '2026-10-06T00:00:00.000Z', tone: 'sopan' }],
    settings: { tone: 'tegas', isPro: true, lang: 'en', darkMode: true, hasCompletedSetup: true }
  };
  const s = migrate(v1);
  assert.equal(s.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(s.books.length, 1);
  assert.equal(s.activeBookId, s.books[0].id);
  const b = activeBook(s);
  assert.equal(b.warung.name, 'Warung Lama');
  assert.equal(b.warung.dueDays, 7);
  assert.equal(b.customers.length, 1);
  assert.equal(b.debts[0].id, 'd1');
  assert.equal(b.payments[0].id, 'p1');
  assert.equal(b.reminders.length, 1);
  assert.deepEqual(b.suppliers, []);
  assert.equal(s.settings.tone, 'tegas');
  assert.equal(s.settings.isPro, true);
  assert.equal(s.settings.lang, 'en');
  assert.equal(s.customers, undefined, 'no flat arrays left at the top level');
  // Idempotent and stable through JSON
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(s))), s);
  // Legacy flat shape still resolves through the accessor
  assert.equal(activeBook(v1).warung.name, 'Warung Lama');
  assert.equal(listBooks(v1).length, 1);
  // A v1 JSON backup imports
  const parsed = parseBackup(JSON.stringify(v1));
  assert.equal(activeBook(parsed.state).customers[0].name, 'Pak Budi');
});

test('books: free tier = 1 book, Pro = up to 5; addBook switches to the new book', () => {
  const st = mem();
  let s = createInitialState();
  assert.equal(FREE_BOOK_LIMIT, 1);
  assert.equal(PRO_BOOK_LIMIT, 5);
  assert.equal(canAddBook(s), false);
  assert.throws(() => addBook(s, { name: 'Cabang' }, st), (err) => err.code === 'PRO_LIMIT_REACHED');

  s = updateSettings(s, { isPro: true }, st);
  assert.equal(canAddBook(s), true);
  for (let i = 2; i <= 5; i++) {
    s = addBook(s, { name: `Warung ${i}` }, st);
    assert.equal(s.books.length, i);
    assert.equal(activeBook(s).warung.name, `Warung ${i}`);
  }
  assert.equal(canAddBook(s), false);
  assert.throws(() => addBook(s, { name: 'Enam' }, st), (err) => err.code === 'PRO_LIMIT_REACHED');
  const ids = new Set(s.books.map((b) => b.id));
  assert.equal(ids.size, 5, 'book ids are unique');
});

test('books: isolation - records, warung profile, seeds and ledgers stay inside their book; backup exports all', () => {
  const st = mem();
  let s = updateSettings(createInitialState(), { isPro: true }, st);
  s = updateWarung(s, { name: 'Warung Utama', dueDays: 30 }, st);
  s = addCustomer(s, { id: 'c1', name: 'Pak Budi', phone: '0811' }, st);
  s = addDebt(s, { customerId: 'c1', amountIdr: 100000, date: '2026-10-01' }, st);
  s = addSupplier(s, { id: 's1', name: 'Agen', phone: '0812' }, st);
  s = addSupplierDebt(s, { customerId: 's1', amountIdr: 700000, date: '2026-10-01' }, st);
  const firstId = s.activeBookId;

  s = addBook(s, { name: 'Cabang Pasar' }, st);
  const secondId = s.activeBookId;
  assert.notEqual(firstId, secondId);
  assert.equal(activeBook(s).warung.name, 'Cabang Pasar');
  assert.equal(activeBook(s).warung.dueDays, 30, 'new book inherits due days');
  assert.equal(activeBook(s).customers.length, 0);
  assert.equal(computeWarungLedger(s, '2026-10-24').totalPiutang, 0);
  assert.equal(computeWarungLedger(s, '2026-10-24', { book: 'supplier' }).totalPiutang, 0);

  s = addCustomer(s, { id: 'c1', name: 'Bu Sari', phone: '0813' }, st); // same id as in book 1: fine
  s = addDebt(s, { customerId: 'c1', amountIdr: 25000, date: '2026-10-10' }, st);
  s = seedDemoData(s, st, { count: 6, referenceDate: '2026-10-24T00:00:00.000Z' });
  assert.equal(activeBook(s).customers.length, 6, 'seed replaced only the active book');
  assert.equal(buildShareCardModel(s, '2026-10-24').warungName, 'Cabang Pasar');
  assert.equal(computeStats(s, '2026-10-24').totalOutstanding, 2030000);

  s = switchBook(s, firstId, st);
  const b1 = activeBook(s);
  assert.equal(b1.warung.name, 'Warung Utama');
  assert.equal(b1.customers[0].name, 'Pak Budi');
  assert.equal(computeWarungLedger(s, '2026-10-24').totalPiutang, 100000);
  assert.equal(computeWarungLedger(s, '2026-10-24', { book: 'supplier' }).totalPiutang, 700000);
  assert.throws(() => switchBook(s, 'nope', st), /not found/);

  // Backup carries every book and round-trips with the active id
  const json = exportBackupJson(s);
  const back = parseBackup(json).state;
  assert.equal(back.books.length, 2);
  assert.equal(back.activeBookId, firstId);
  assert.equal(back.books[1].customers.length, 6);

  // Delete the second book (undoable); the last one can never be deleted
  s = switchBook(s, secondId, st);
  s = deleteBook(s, secondId, st);
  assert.equal(s.books.length, 1);
  assert.equal(s.activeBookId, firstId);
  s = undoLastAction(st);
  assert.equal(s.books.length, 2);
  s = deleteBook(s, secondId, st);
  assert.throws(() => deleteBook(s, firstId, st), /only book/);
});
