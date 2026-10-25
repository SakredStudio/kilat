import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, addCustomer, addDebt, addPayment, updateSettings } from '../lib/store.js';
import { buildReceiptModel, drawReceiptToCanvas, RECEIPT_WIDTH, RECEIPT_HEIGHT } from '../lib/receipt-card.js';
import { SHARE_LINE } from '../lib/wa.js';
import { WATERMARK_TEXT } from '../lib/share-card.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

function mockCanvas() {
  const texts = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    createLinearGradient: () => ({ addColorStop: () => {} }),
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {}, arc() {},
    measureText: (s) => ({ width: String(s).length * 20 }),
    fillText: (s) => texts.push(String(s))
  };
  return { width: 0, height: 0, texts, getContext: (k) => (k === '2d' ? ctx : null) };
}

test('receipt-card: partial payment model has amount paid, remaining, lunas=false, watermark on free', () => {
  const st = mem();
  let s = addCustomer(createInitialState(), { id: 'c1', name: 'Pak Budi', phone: '0812' }, st);
  s = addDebt(s, { customerId: 'c1', amountIdr: 300000, date: '2026-10-01' }, st);
  s = addDebt(s, { customerId: 'c1', amountIdr: 50000, date: '2026-10-20' }, st);
  s = addPayment(s, { id: 'p1', customerId: 'c1', amountIdr: 100000, date: '2026-10-22', note: 'Cicilan 1' }, st);

  const m = buildReceiptModel(s, { customerId: 'c1', paymentId: 'p1' }, '2026-10-24');
  assert.equal(m.width, RECEIPT_WIDTH);
  assert.equal(m.height, RECEIPT_HEIGHT);
  assert.equal(m.amountPaid, 100000);
  assert.equal(m.amountPaidFormatted, 'Rp 100.000');
  assert.equal(m.remaining, 250000);
  assert.equal(m.isLunas, false);
  assert.equal(m.customerName, 'Pak Budi');
  assert.equal(m.dateLabel, '22 Okt 2026');
  assert.equal(m.showWatermark, true);
  assert.ok(m.shareText.includes('Sisa catatan: *Rp 250.000*'));
  assert.ok(m.shareText.includes('Cicilan 1'));
  assert.ok(m.shareText.endsWith(SHARE_LINE));
  assert.ok(!/Kilat (menerima|mentransfer)/i.test(m.shareText));
});

test('receipt-card: remaining is computed as of that payment; later payments give lunas; Pro drops watermark', () => {
  const st = mem();
  let s = addCustomer(createInitialState(), { id: 'c1', name: 'Bu Sari', phone: '0813' }, st);
  s = addDebt(s, { customerId: 'c1', amountIdr: 200000, date: '2026-10-01' }, st);
  s = addPayment(s, { id: 'p1', customerId: 'c1', amountIdr: 120000, date: '2026-10-10' }, st);
  s = addPayment(s, { id: 'p2', customerId: 'c1', amountIdr: 80000, date: '2026-10-20' }, st);

  const first = buildReceiptModel(s, { customerId: 'c1', paymentId: 'p1' }, '2026-10-24');
  assert.equal(first.remaining, 80000);
  assert.equal(first.isLunas, false);
  assert.equal(first.currentBalance, 0);

  const second = buildReceiptModel(s, { customerId: 'c1', paymentId: 'p2' }, '2026-10-24');
  assert.equal(second.remaining, 0);
  assert.equal(second.isLunas, true);
  assert.ok(second.shareText.includes('*LUNAS*'));

  s = updateSettings(s, { isPro: true }, st);
  const pro = buildReceiptModel(s, { customerId: 'c1', paymentId: 'p2' }, '2026-10-24');
  assert.equal(pro.showWatermark, false);

  assert.throws(() => buildReceiptModel(s, { customerId: 'c1', paymentId: 'nope' }), /Payment not found/);
  assert.throws(() => buildReceiptModel(s, { customerId: 'zz', paymentId: 'p1' }), /Customer not found/);
});

test('receipt-card: drawReceiptToCanvas renders 1080x1350 with name, amount, status and watermark', () => {
  const st = mem();
  let s = addCustomer(createInitialState(), { id: 'c1', name: 'Pak Budi', phone: '0812' }, st);
  s = addDebt(s, { customerId: 'c1', amountIdr: 100000, date: '2026-10-01' }, st);
  s = addPayment(s, { id: 'p1', customerId: 'c1', amountIdr: 100000, date: '2026-10-22' }, st);
  const m = buildReceiptModel(s, { customerId: 'c1', paymentId: 'p1' }, '2026-10-24');
  const canvas = mockCanvas();
  drawReceiptToCanvas(canvas, m);
  assert.equal(canvas.width, 1080);
  assert.equal(canvas.height, 1350);
  assert.ok(canvas.texts.includes('Pak Budi'));
  assert.ok(canvas.texts.includes('Rp 100.000'));
  assert.ok(canvas.texts.includes('LUNAS ✅'));
  assert.ok(canvas.texts.includes(WATERMARK_TEXT));
});
