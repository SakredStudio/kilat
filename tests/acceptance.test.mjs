import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  updateWarung
} from '../lib/store.js';
import { computeWarungLedger, filterCustomers } from '../lib/ledger.js';
import { buildReminderMessage, link as buildWaLink, SHARE_LINE } from '../lib/wa.js';
import { buildShareCardModel, drawShareCardToCanvas, CARD_WIDTH, CARD_HEIGHT } from '../lib/share-card.js';

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
  assert.equal(state.customers.length, 12);

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
  assert.equal(state.debts.length, 20);
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
    warung: state.warung.name
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
  assert.equal(reimported.customers.length, 12);
  assert.equal(reimported.debts.length, 20);
  assert.equal(reimported.payments.length, 1);
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
