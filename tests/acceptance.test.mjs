import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeBook } from '../lib/books.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInitialState,
  addCustomer,
  addDebt,
  addPayment,
  undoLastAction,
  exportBackupJson,
  importBackupJson,
  updateWarung,
  updateSettings,
  addDaysIsoDate,
  logReminder,
  addSupplier,
  addSupplierDebt,
  addSupplierPayment,
  setSupplierPayPlan,
  addBook,
  switchBook,
  parseBackup
} from '../lib/store.js';
import { computeWarungLedger, filterCustomers, dueBuckets } from '../lib/ledger.js';
import { buildReminderMessage, buildSupplierMessage, link as buildWaLink, SHARE_LINE } from '../lib/wa.js';
import { buildShareCardModel, drawShareCardToCanvas, CARD_WIDTH, CARD_HEIGHT } from '../lib/share-card.js';
import { buildBroadcastQueue, queueProgress } from '../lib/broadcast.js';
import { buildReceiptModel } from '../lib/receipt-card.js';
import { computeStats } from '../lib/stats.js';
import { encryptBackup, decryptBackup, newVaultId, isValidVaultId } from '../lib/cloud.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    clear() { map.clear(); }
  };
}

test('acceptance: 12 customers + 20 debts added, Tinggi filter, sopan WA reminder, partial payment + undo, 1080x1350 share card, JSON backup round-trip', () => {
  const mem = createMemoryStorage();
  const t0 = performance.now();
  let state = updateWarung(
    createInitialState(),
    { name: 'Warung Bu Siti', ownerName: 'Bu Siti', phone: '08111222333', dueDays: 14, hasCompletedSetup: true },
    mem
  );

  // 1. Add 12 customers
  const customersInput = [
    { id: 'c1', name: 'Pak Budi Santoso', phone: '0812-3456-7890', note: 'Sembako + rokok' },
    { id: 'c2', name: 'Ibu Sari Dewi', phone: '+62 823 4567 8901', note: 'Beras 5kg' },
    { id: 'c3', name: 'Mas Agus Wibowo', phone: '6285678901234', note: 'Belanja bulanan' },
    { id: 'c4', name: 'Mbak Rina Kusuma', phone: '81356789012', note: 'Pulsa + snack' },
    { id: 'c5', name: 'Pak Hendra Gunawan', phone: '087890123456', note: 'Gula, kopi' },
    { id: 'c6', name: 'Bu Lestari Wulandari', phone: '089012345678', note: 'Sabun, sampo' },
    { id: 'c7', name: 'Pak Joko Widodo', phone: '081298765432', note: 'Gas LPG 3kg' },
    { id: 'c8', name: 'Bu Ratna Sari', phone: '081387654321', note: 'Telur 2kg' },
    { id: 'c9', name: 'Kang Dedi Mulyadi', phone: '085712345678', note: 'Kopi sachet' },
    { id: 'c10', name: 'Mbak Fitri Handayani', phone: '087712345678', note: 'Susu anak' },
    { id: 'c11', name: 'Pak Bambang Pamungkas', phone: '081912345678', note: 'Sembako hajatan' },
    { id: 'c12', name: 'Bu Yuni Shara', phone: '082112345678', note: 'Bumbu dapur' }
  ];

  for (const c of customersInput) {
    state = addCustomer(state, c, mem);
  }
  assert.equal(activeBook(state).customers.length, 12);

  // 2. Add 20 debts across all risk levels relative to 2026-10-24
  const debtsInput = [
    { customerId: 'c1', amountIdr: 300000, date: '2026-10-03', note: 'Sembako' }, // 21d -> Sedang
    { customerId: 'c1', amountIdr: 50000, date: '2026-10-20', note: 'Galon' },
    { customerId: 'c2', amountIdr: 100000, date: '2026-10-17', note: 'Beras' }, // 7d -> Rendah
    { customerId: 'c2', amountIdr: 25000, date: '2026-10-22', note: 'Minyak' },
    { customerId: 'c3', amountIdr: 600000, date: '2026-09-09', note: 'Belanja' }, // 45d -> Tinggi
    { customerId: 'c3', amountIdr: 180000, date: '2026-10-10', note: 'Rokok' },
    { customerId: 'c4', amountIdr: 40000, date: '2026-10-21', note: 'Pulsa' }, // 3d -> Rendah
    { customerId: 'c4', amountIdr: 20000, date: '2026-10-23', note: 'Snack' },
    { customerId: 'c5', amountIdr: 400000, date: '2026-09-21', note: 'Gula' }, // 33d -> Tinggi
    { customerId: 'c5', amountIdr: 100000, date: '2026-10-12', note: 'Kopi' },
    { customerId: 'c6', amountIdr: 150000, date: '2026-10-10', note: 'Sabun' }, // 14d -> Sedang
    { customerId: 'c6', amountIdr: 65000, date: '2026-10-18', note: 'Odol' },
    { customerId: 'c7', amountIdr: 120000, date: '2026-10-13', note: 'LPG' }, // 11d -> Sedang
    { customerId: 'c7', amountIdr: 70000, date: '2026-10-21', note: 'Telur' },
    { customerId: 'c8', amountIdr: 340000, date: '2026-09-19', note: 'Minyak' }, // 35d -> Tinggi
    { customerId: 'c8', amountIdr: 80000, date: '2026-10-15', note: 'Beras' },
    { customerId: 'c9', amountIdr: 85000, date: '2026-10-19', note: 'Mie' }, // 5d -> Rendah
    { customerId: 'c10', amountIdr: 310000, date: '2026-10-06', note: 'Susu' }, // 18d -> Sedang
    { customerId: 'c11', amountIdr: 640000, date: '2026-09-14', note: 'Sembako' }, // 40d -> Tinggi
    { customerId: 'c12', amountIdr: 95000, date: '2026-10-22', note: 'Kecap' } // 2d -> Rendah
  ];

  for (const d of debtsInput) {
    state = addDebt(state, d, mem);
  }
  assert.equal(activeBook(state).debts.length, 20);
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 180_000, `Adding 12 customers + 20 debts took ${elapsedMs}ms`);

  // 3. Filter by Tinggi and send 'sopan' reminder to top Tinggi debtor (Mas Agus Wibowo)
  const ledger = computeWarungLedger(state, '2026-10-24');
  const tinggiList = filterCustomers(ledger.customers, { riskFilter: 'Tinggi' });
  assert.equal(tinggiList.length, 4);
  const topTinggi = tinggiList[0];
  assert.equal(topTinggi.name, 'Mas Agus Wibowo');
  assert.equal(topTinggi.balance, 780000);

  const sopanMsg = buildReminderMessage({
    tone: 'sopan',
    nama: topTinggi.name,
    jumlah: topTinggi.balance,
    hari: topTinggi.daysOverdue,
    warung: activeBook(state).warung.name
  });
  const waUrl = buildWaLink(topTinggi.phone62, sopanMsg);
  assert.ok(waUrl.startsWith('https://wa.me/6285678901234?text='));
  assert.ok(decodeURIComponent(waUrl.split('?text=')[1]).endsWith(SHARE_LINE));

  // 4. Record partial payment of Rp 280.000 on Mas Agus Wibowo -> balance drops to Rp 500.000
  state = addPayment(state, { customerId: 'c3', amountIdr: 280000, date: '2026-10-24', note: 'Bayar sebagian' }, mem);
  const afterPayLedger = computeWarungLedger(state, '2026-10-24');
  const agusAfterPay = afterPayLedger.customers.find((c) => c.id === 'c3');
  assert.equal(agusAfterPay.balance, 500000);

  // Undo payment -> balance returns to Rp 780.000, then re-apply payment
  state = undoLastAction(mem);
  assert.equal(computeWarungLedger(state, '2026-10-24').customers.find((c) => c.id === 'c3').balance, 780000);
  state = addPayment(state, { customerId: 'c3', amountIdr: 280000, date: '2026-10-24', note: 'Bayar sebagian' }, mem);

  // 5. Render Kartu Ringkasan 1080x1350 PNG model & canvas
  const cardModel = buildShareCardModel(state, '2026-10-24');
  assert.equal(cardModel.width, CARD_WIDTH);
  assert.equal(cardModel.height, CARD_HEIGHT);
  assert.equal(cardModel.topDebtors.length, 3);
  const mockCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      createLinearGradient: () => ({ addColorStop: () => {} }),
      fillRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      closePath: () => {},
      fill: () => {},
      stroke: () => {},
      arc: () => {},
      measureText: () => ({ width: 200 }),
      fillText: () => {}
    })
  };
  drawShareCardToCanvas(mockCanvas, cardModel);
  assert.equal(mockCanvas.width, 1080);
  assert.equal(mockCanvas.height, 1350);

  // 6. Export JSON, clear storage, import JSON, verify state matches
  const backupJson = exportBackupJson(state);
  mem.clear();
  const reimported = importBackupJson(backupJson, mem);
  assert.equal(activeBook(reimported).customers.length, 12);
  assert.equal(activeBook(reimported).debts.length, 20);
  assert.equal(activeBook(reimported).payments.length, 1);
});

test('acceptance v2/v3: 12 customers with due dates -> Hari ini + broadcast queue, supplier book, 2 warung books, backup of everything', async () => {
  const mem = createMemoryStorage();
  let state = updateWarung(createInitialState(), { name: 'Warung Utama', dueDays: 14, hasCompletedSetup: true }, mem);
  state = updateSettings(state, { isPro: true }, mem);

  // 12 customers, each with one utang; due dates spread around today (2026-10-24)
  const dueOffsets = [-10, -3, 0, 0, 2, 5, 9, 12, -1, 20, 30, null]; // null = no due date
  for (let i = 1; i <= 12; i++) {
    state = addCustomer(state, { id: `c${i}`, name: `Pelanggan ${i}`, phone: `08120000000${String(i).padStart(2, '0')}` }, mem);
    const off = dueOffsets[i - 1];
    state = addDebt(
      state,
      { customerId: `c${i}`, amountIdr: 50000 * i, date: '2026-09-20', dueDate: off === null ? null : addDaysIsoDate('2026-10-24', off) },
      mem
    );
  }
  const ledger = computeWarungLedger(state, '2026-10-24');
  assert.equal(ledger.customers.length, 12);
  assert.equal(ledger.dueToday.length, 2);
  assert.equal(ledger.dueOverdue.length, 3);
  assert.deepEqual(dueBuckets(ledger.customers).overdue.map((c) => c.id), ['c1', 'c2', 'c9']);
  const c3 = ledger.customers.find((c) => c.id === 'c3');
  const dueMsg = buildReminderMessage({ tone: 'sopan', nama: c3.name, jumlah: c3.balance, hari: c3.daysOverdue, warung: 'Warung Utama', tanggal: c3.nextDueDate });
  assert.ok(dueMsg.includes('jatuh tempo *24 Okt 2026*'));
  assert.ok(dueMsg.endsWith(SHARE_LINE));

  // Broadcast: every customer is 34 days old -> Tinggi, so all 12 queue; walk it, log 3, skip the rest
  const book0 = activeBook(state);
  let queue = buildBroadcastQueue(ledger.customers, book0.reminders);
  assert.equal(queue.length, 12);
  assert.equal(queue[0].id, 'c12', 'largest balance first among equal risk/days');
  const sent = new Set();
  for (const item of queue.slice(0, 3)) {
    state = logReminder(state, { customerId: item.id, tone: 'tegas', sentAt: '2026-10-24T09:00:00.000Z' }, mem);
    sent.add(item.id);
  }
  assert.deepEqual(queueProgress(queue, 12, sent), { total: 12, position: 12, done: true, sentCount: 3, skippedCount: 9 });
  assert.equal(activeBook(state).reminders.length, 3);
  queue = buildBroadcastQueue(computeWarungLedger(state, '2026-10-24').customers, activeBook(state).reminders);
  assert.equal(queue.filter((c) => c.lastRemindedAt).length, 3);

  // Receipt after a partial payment on c12
  state = addPayment(state, { id: 'pay_c12', customerId: 'c12', amountIdr: 100000, date: '2026-10-24' }, mem);
  const receipt = buildReceiptModel(state, { customerId: 'c12', paymentId: 'pay_c12' }, '2026-10-24');
  assert.equal(receipt.remaining, 500000);
  assert.equal(receipt.isLunas, false);
  assert.equal(receipt.showWatermark, false);

  // Supplier book in the same warung, isolated from the customer ledger
  state = addSupplier(state, { id: 's1', name: 'Agen Beras', phone: '0813' }, mem);
  state = addSupplierDebt(state, { customerId: 's1', amountIdr: 2000000, date: '2026-10-10', dueDate: '2026-10-24' }, mem);
  state = addSupplierPayment(state, { customerId: 's1', amountIdr: 500000, date: '2026-10-20' }, mem);
  state = setSupplierPayPlan(state, 's1', { date: '2026-10-31', note: 'setelah setoran' }, mem);
  const supLedger = computeWarungLedger(state, '2026-10-24', { book: 'supplier' });
  assert.equal(supLedger.totalPiutang, 1500000);
  assert.equal(supLedger.dueToday.length, 1);
  assert.equal(computeWarungLedger(state, '2026-10-24').totalPiutang, 3900000 - 100000);
  const supMsg = buildSupplierMessage({ nama: 'Agen Beras', jumlah: 1500000, warung: 'Warung Utama', tanggal: '2026-10-31' });
  assert.ok(supMsg.includes('akan kami bayar pada *31 Okt 2026*'));

  // Second warung (Pro): its own empty ledgers; stats and cards follow the active book
  state = addBook(state, { name: 'Cabang Pasar' }, mem);
  assert.equal(state.books.length, 2);
  assert.equal(computeWarungLedger(state, '2026-10-24').customers.length, 0);
  state = addCustomer(state, { id: 'x1', name: 'Bu Cabang', phone: '0814' }, mem);
  state = addDebt(state, { customerId: 'x1', amountIdr: 75000, date: '2026-10-24' }, mem);
  assert.equal(buildShareCardModel(state, '2026-10-24').warungName, 'Cabang Pasar');
  assert.equal(computeStats(state, '2026-10-24').totalOutstanding, 75000);
  const firstBookId = state.books[0].id;
  state = switchBook(state, firstBookId, mem);
  assert.equal(computeStats(state, '2026-10-24').remindersThisMonth, 3);
  assert.equal(computeStats(state, '2026-10-24').topDebtors[0].id, 'c11');

  // Backup carries both books, every record, and round-trips through parse + encrypt/decrypt
  const json = exportBackupJson(state);
  const back = parseBackup(json).state;
  assert.equal(back.books.length, 2);
  assert.equal(back.books[0].customers.length, 12);
  assert.equal(back.books[0].suppliers.length, 1);
  assert.equal(back.books[0].reminders.length, 3);
  assert.equal(back.books[1].customers.length, 1);
  const vault = await encryptBackup(json, 'warung utama 2026');
  assert.equal(await decryptBackup(vault, 'warung utama 2026'), json);
  assert.ok(isValidVaultId(newVaultId()));
});

test('acceptance: offline precache assets exist and zero external CDN calls in HTML/CSS/JS', () => {
  const swSource = fs.readFileSync(path.join(appDir, 'sw.js'), 'utf8');
  const match = swSource.match(/const PRECACHE_ASSETS = \[([\s\S]*?)\];/);
  assert.ok(match, 'PRECACHE_ASSETS array must exist in sw.js');
  const assets = Array.from(match[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
  assert.ok(assets.length >= 20);

  for (const rel of assets) {
    if (rel === './') continue;
    const fullPath = path.join(appDir, rel.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(fullPath), `Precached file missing on disk: ${rel}`);
  }

  const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(appDir, 'styles.css'), 'utf8');
  assert.ok(!html.includes('fonts.googleapis.com'), 'index.html must not load Google Fonts CDN');
  assert.ok(!html.includes('unpkg.com'), 'index.html must not load unpkg CDN');
  assert.ok(!css.includes('fonts.googleapis.com'), 'styles.css must not load Google Fonts CDN');
});
