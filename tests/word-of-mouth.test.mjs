// Bonrapi 1.3 "every message brings a warung": link-page footer per surface, Pro switch,
// receipt QR, counter poster, invite link, settings migration, backup + rating nudges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_LINK,
  LINK_HOST,
  LINK_PATHS,
  SHARE_LINE,
  LEGACY_SHARE_LINES,
  shareLineFor,
  surfaceLink,
  playLink,
  stripShareLine,
  ensureShareLine,
  buildReminderMessage,
  buildSupplierMessage,
  buildInviteMessage,
  inviteLink,
  link
} from '../lib/wa.js';
import { withQrisLine, QRIS_LINE } from '../lib/qris.js';
import { shareLineEnabled } from '../lib/books.js';
import { createInitialState, migrate, updateSettings, addCustomer, addDebt, addPayment } from '../lib/store.js';
import { buildReceiptModel, drawReceiptToCanvas, RECEIPT_QR_LABEL } from '../lib/receipt-card.js';
import { buildShareCardModel } from '../lib/share-card.js';
import { QR } from '../lib/qr-data.js';
import { drawQr } from '../lib/canvas-share.js';
import { buildSignModel, drawSignToCanvas, SIGN_WIDTH, SIGN_HEIGHT } from '../lib/sign-card.js';
import { daysSince, usageStats, backupNudgeDue, rateNudgeDue, activeNudge, BACKUP_MIN_RECORDS } from '../lib/nudges.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

function mockCanvas() {
  const texts = [];
  const rects = [];
  const images = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', lineCap: '', lineJoin: '',
    createLinearGradient: () => ({ addColorStop: () => {} }),
    fillRect: (x, y, w, h) => rects.push([x, y, w, h]),
    beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {}, arc() {},
    drawImage: (img, ...args) => images.push([img, ...args]),
    measureText: (s) => ({ width: String(s).length * 20 }),
    fillText: (s) => texts.push(String(s))
  };
  return { width: 0, height: 0, texts, rects, images, getContext: (k) => (k === '2d' ? ctx : null) };
}

/** A shop with `debts` debts and `payments` payments starting `startDate`, one per day. */
function shop({ debts = 0, payments = 0, startDate = '2026-11-01' } = {}) {
  const st = mem();
  let s = addCustomer(createInitialState(), { id: 'c1', name: 'Pak Budi', phone: '0812' }, st);
  const day = (i) => new Date(Date.parse(`${startDate}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
  for (let i = 0; i < debts; i++) s = addDebt(s, { customerId: 'c1', amountIdr: 10000, date: day(i) }, st);
  for (let i = 0; i < payments; i++) s = addPayment(s, { customerId: 'c1', amountIdr: 1000, date: day(i) }, st);
  return { s, st };
}

// ---- footer and links

test('1.3 footer: one line per surface, on the link page host, never the app host', () => {
  assert.equal(LINK_HOST, 'https://bonrapi.sakredstudio.ca');
  assert.equal(SHARE_LINE, shareLineFor('reminder'));
  for (const [surface, code] of Object.entries(LINK_PATHS)) {
    assert.equal(surfaceLink(surface), `${LINK_HOST}/${code}`);
    assert.equal(playLink(surface), `${LINK_HOST}/go/${code}`);
    assert.equal(shareLineFor(surface), `— dicatat rapi dengan Bonrapi · ${LINK_HOST}/${code}`);
    assert.ok(!shareLineFor(surface).includes('kilat'), 'the loan-sounding old name never reaches a debtor');
  }
  assert.equal(surfaceLink('nope'), `${LINK_HOST}/r`);
  assert.equal(new Set(Object.values(LINK_PATHS)).size, Object.keys(LINK_PATHS).length, 'codes are unique');
});

test('1.3 footer: old signatures (1.2 and pre-rename) are replaced, never doubled', () => {
  for (const old of LEGACY_SHARE_LINES) {
    assert.ok(old.includes(APP_LINK));
    assert.equal(ensureShareLine(`Halo\n\n${old}`), `Halo\n\n${SHARE_LINE}`);
  }
  // switching surface replaces the line instead of stacking a second one
  const asReceipt = ensureShareLine(`Halo\n\n${SHARE_LINE}`, { surface: 'receipt' });
  assert.equal(asReceipt, `Halo\n\n${shareLineFor('receipt')}`);
  assert.equal(stripShareLine(`Halo\n\n${shareLineFor('supplier')}\n\n${SHARE_LINE}`), 'Halo');
});

test('1.3 footer: switched off removes every signature and adds none', () => {
  assert.equal(ensureShareLine(`Halo\n\n${SHARE_LINE}`, { enabled: false }), 'Halo');
  const msg = buildReminderMessage({ nama: 'A', jumlah: 1, hari: 1, warung: 'W', shareLine: false });
  assert.ok(!msg.includes('Bonrapi'));
  const url = link('0812', msg, { enabled: false });
  assert.ok(!decodeURIComponent(url.split('?text=')[1]).includes('Bonrapi'));
  const sup = buildSupplierMessage({ nama: 'Bu Grosir', jumlah: 1, warung: 'W', shareLine: false });
  assert.ok(!sup.includes('Bonrapi'));
  // link() keeps the surface it is told: a receipt text stays a receipt text
  const receiptText = ensureShareLine('Lunas', { surface: 'receipt' });
  const receiptUrl = link('0812', receiptText, { surface: 'receipt' });
  assert.ok(decodeURIComponent(receiptUrl.split('?text=')[1]).endsWith(shareLineFor('receipt')));
});

test('1.3 footer: supplier notes link /s, QRIS line stays above the footer for any surface', () => {
  const sup = buildSupplierMessage({ nama: 'Bu Grosir', jumlah: 1500000, warung: 'W' });
  assert.ok(sup.endsWith(shareLineFor('supplier')));
  const q = withQrisLine(`Halo\n\n${SHARE_LINE}`, { surface: 'reminder' });
  assert.equal(q, `Halo\n\n${QRIS_LINE}\n\n${SHARE_LINE}`);
  assert.equal(withQrisLine(q), q, 'idempotent');
  assert.equal(withQrisLine('Halo', { enabled: false }), `Halo\n\n${QRIS_LINE}`);
});

test('1.3 Pro switch: free always signs; Pro signs unless switched off', () => {
  const st = mem();
  let s = createInitialState();
  assert.equal(s.settings.shareLine, true);
  assert.equal(shareLineEnabled(s), true);
  s = updateSettings(s, { shareLine: false }, st);
  assert.equal(shareLineEnabled(s), true, 'free cannot switch it off, even with the flag set');
  s = updateSettings(s, { isPro: true }, st);
  assert.equal(shareLineEnabled(s), false);
  s = updateSettings(s, { shareLine: true }, st);
  assert.equal(shareLineEnabled(s), true);
  s = updateSettings(s, { isPro: false, reviewerAccess: true, shareLine: false }, st);
  assert.equal(shareLineEnabled(s), false, 'reviewer access counts as Pro');
});

test('1.3 cards: summary card and receipt text follow the switch and their own surface', () => {
  const st = mem();
  let { s } = shop({ debts: 1 });
  s = addPayment(s, { id: 'p1', customerId: 'c1', amountIdr: 10000, date: '2026-11-02' }, st);
  assert.ok(buildShareCardModel(s, '2026-11-03').shareText.endsWith(shareLineFor('card')));
  const free = buildReceiptModel(s, { customerId: 'c1', paymentId: 'p1' }, '2026-11-03');
  assert.ok(free.shareText.endsWith(shareLineFor('receipt')));
  s = updateSettings(s, { isPro: true, shareLine: false }, st);
  assert.ok(!buildShareCardModel(s, '2026-11-03').shareText.includes('Bonrapi'));
  assert.ok(!buildReceiptModel(s, { customerId: 'c1', paymentId: 'p1' }, '2026-11-03').shareText.includes('Bonrapi'));
});

test('1.3 invite: wa.me without a number, owner voice, /a link', () => {
  const msg = buildInviteMessage();
  assert.ok(msg.startsWith('Saya pakai Bonrapi'));
  assert.ok(msg.includes('bukan aplikasi pinjaman'));
  assert.ok(msg.endsWith(`${LINK_HOST}/a`));
  const url = inviteLink();
  assert.ok(url.startsWith('https://wa.me/?text='));
  assert.equal(decodeURIComponent(url.split('?text=')[1]), msg);
});

// ---- receipt QR

test('1.3 QR data: a valid version-3 matrix for the receipt link, with three finder patterns', () => {
  const qr = QR.receipt;
  assert.equal(qr.url, surfaceLink('receipt'), 'regenerate with tools/make-qr.py after changing LINK_HOST/LINK_PATHS');
  const n = qr.rows.length;
  assert.equal(n, 17 + 4 * qr.version);
  assert.ok(qr.rows.every((r) => r.length === n && /^[01]+$/.test(r)));
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  const at = (r0, c0) => finder.every((line, i) => qr.rows[r0 + i].slice(c0, c0 + 7) === line);
  assert.ok(at(0, 0) && at(0, n - 7) && at(n - 7, 0));
});

test('1.3 drawQr: whole-pixel modules inside the box, quiet zone kept light', () => {
  const canvas = mockCanvas();
  const ctx = canvas.getContext('2d');
  const box = drawQr(ctx, QR.receipt, 100, 200, 170, { quiet: 3 });
  assert.equal(box.module, Math.floor(170 / (29 + 6)));
  assert.ok(box.size <= 170 && box.x >= 100 && box.y >= 200);
  const [bg, ...modules] = canvas.rects;
  assert.deepEqual(bg, [box.x, box.y, box.size, box.size]);
  const darkCount = QR.receipt.rows.join('').split('').filter((c) => c === '1').length;
  assert.equal(modules.length, darkCount);
  const minX = Math.min(...modules.map((m) => m[0]));
  assert.equal(minX, box.x + 3 * box.module, 'first dark module sits after the quiet zone');
});

test('1.3 receipt: free receipt carries the labelled QR, Pro receipt does not', () => {
  const st = mem();
  let { s } = shop({ debts: 1 });
  s = addPayment(s, { id: 'p1', customerId: 'c1', amountIdr: 10000, date: '2026-11-02' }, st);
  const free = buildReceiptModel(s, { customerId: 'c1', paymentId: 'p1' }, '2026-11-03');
  assert.equal(free.qr, QR.receipt);
  assert.equal(free.watermarkText, 'Dibuat dengan Bonrapi · bonrapi.sakredstudio.ca/b');
  const c1 = mockCanvas();
  drawReceiptToCanvas(c1, free);
  assert.ok(c1.texts.includes(RECEIPT_QR_LABEL));
  assert.match(RECEIPT_QR_LABEL, /bukan untuk bayar/);
  assert.ok(c1.texts.includes('Bonrapi hanya mencatat, tidak memindahkan uang.'));

  s = updateSettings(s, { isPro: true }, st);
  const pro = buildReceiptModel(s, { customerId: 'c1', paymentId: 'p1' }, '2026-11-03');
  assert.equal(pro.qr, null);
  const c2 = mockCanvas();
  drawReceiptToCanvas(c2, pro);
  assert.ok(!c2.texts.includes(RECEIPT_QR_LABEL));
});

// ---- counter poster

test('1.3 poster: QRIS version, no-QRIS version, footer follows the switch, no Bonrapi QR', () => {
  const st = mem();
  let s = createInitialState();
  s = migrate({ ...s, books: [{ ...s.books[0], warung: { ...s.books[0].warung, name: 'Warung Bu Siti' } }] });

  const withQris = buildSignModel(s, { hasQris: true });
  assert.equal(withQris.title, 'Bayar pakai QRIS');
  assert.equal(withQris.showFooter, true);
  assert.equal(withQris.footerLine2, 'Buku kasbon gratis untuk warung: bonrapi.sakredstudio.ca/q');
  assert.equal(withQris.filename, 'bonrapi-poster-warung-bu-siti.png');

  const qrisImg = { width: 600, height: 900 };
  const c = mockCanvas();
  drawSignToCanvas(c, withQris, { qrisImage: qrisImg });
  assert.equal(c.width, SIGN_WIDTH);
  assert.equal(c.height, SIGN_HEIGHT);
  assert.ok(c.texts.includes('Warung Bu Siti'));
  assert.ok(c.texts.includes('Bayar pakai QRIS'));
  assert.ok(c.texts.includes(withQris.footerLine1));
  assert.equal(c.images.length, 1);
  assert.equal(c.images[0][0], qrisImg);
  const [, x, y, w, h] = c.images[0];
  assert.ok(w <= 860 && h <= 860 && Math.abs(w / h - 600 / 900) < 0.01, 'QRIS keeps its proportions inside the panel');
  assert.ok(x >= 0 && x + w <= SIGN_WIDTH && y >= 600);
  // a QR drawn with drawQr would add hundreds of small squares; the poster draws only its background + header
  assert.ok(c.rects.length <= 3, 'no Bonrapi QR on a counter sign');

  const noQris = buildSignModel(s, { hasQris: false });
  assert.equal(noQris.title, 'Kasbon tercatat rapi di sini');
  const c2 = mockCanvas();
  drawSignToCanvas(c2, noQris, { qrisImage: null });
  assert.equal(c2.images.length, 0);

  s = updateSettings(s, { isPro: true, shareLine: false }, st);
  const proOff = buildSignModel(s, { hasQris: true });
  assert.equal(proOff.showFooter, false);
  const c3 = mockCanvas();
  drawSignToCanvas(c3, proOff, { qrisImage: qrisImg });
  assert.ok(!c3.texts.some((t) => t.includes('Bonrapi')));
  assert.ok(c3.texts.includes('Terima kasih sudah belanja di Warung Bu Siti'));
});

// ---- settings migration

test('1.3 settings: new fields default safely and garbage is cleaned', () => {
  const fresh = createInitialState().settings;
  assert.deepEqual(
    { shareLine: fresh.shareLine, lastExportAt: fresh.lastExportAt, nudges: fresh.nudges },
    { shareLine: true, lastExportAt: null, nudges: { backupSnoozedAt: null, rate: 'pending', rateSnoozedAt: null } }
  );
  const old12 = migrate({ settings: { isPro: true } }); // a 1.2 state has none of the new keys
  assert.equal(old12.settings.shareLine, true);
  assert.equal(old12.settings.nudges.rate, 'pending');
  const junk = migrate({
    settings: { shareLine: 'no', lastExportAt: 'yesterday', nudges: { rate: 'maybe', backupSnoozedAt: 42, rateSnoozedAt: '2026-11-01T00:00:00Z' } }
  });
  assert.equal(junk.settings.shareLine, true, 'only an explicit false switches it off');
  assert.equal(junk.settings.lastExportAt, null);
  assert.deepEqual(junk.settings.nudges, { backupSnoozedAt: null, rate: 'pending', rateSnoozedAt: '2026-11-01T00:00:00Z' });
  assert.equal(migrate({ settings: { shareLine: false } }).settings.shareLine, false);
});

// ---- nudges

test('1.3 nudges: daysSince and usage stats across books', () => {
  const now = new Date('2026-11-17T10:00:00Z');
  assert.equal(daysSince('2026-11-10', now), 7);
  assert.equal(daysSince('2026-11-17T09:00:00Z', now), 0);
  assert.equal(daysSince('', now), null);
  const { s } = shop({ debts: 4, payments: 2, startDate: '2026-10-20' });
  assert.deepEqual(usageStats(s), { records: 6, payments: 2, firstDate: '2026-10-20' });
});

test('1.3 nudges: backup reminder after real use, weekly, snoozable, never with a cloud vault', () => {
  const st = mem();
  const now = new Date('2026-11-17T10:00:00Z');
  assert.equal(backupNudgeDue(shop({ debts: BACKUP_MIN_RECORDS - 1, startDate: '2026-10-01' }).s, now), false, 'too little data');
  assert.equal(backupNudgeDue(shop({ debts: 10, startDate: '2026-11-15' }).s, now), false, 'first entry is fresh');
  let { s } = shop({ debts: 10, startDate: '2026-11-01' });
  assert.equal(backupNudgeDue(s, now), true);
  assert.equal(activeNudge(s, now, { inPlayApp: true }), 'backup');

  s = updateSettings(s, { lastExportAt: '2026-11-14T08:00:00Z' }, st);
  assert.equal(backupNudgeDue(s, now), false, 'saved 3 days ago');
  assert.equal(backupNudgeDue(s, new Date('2026-11-22T10:00:00Z')), true, 'a week later it comes back');

  s = updateSettings(s, { nudges: { ...s.settings.nudges, backupSnoozedAt: '2026-11-21T10:00:00Z' } }, st);
  assert.equal(backupNudgeDue(s, new Date('2026-11-22T10:00:00Z')), false, 'snoozed');
  assert.equal(backupNudgeDue(s, new Date('2026-11-29T10:00:00Z')), true, 'snooze lasts a week');

  s = updateSettings(s, { cloud: { vaultId: 'a'.repeat(32), autoBackup: true, lastBackupAt: null } }, st);
  assert.equal(backupNudgeDue(s, new Date('2026-12-30T10:00:00Z')), false, 'encrypted cloud vault covers it');
});

test('1.3 nudges: rating ask only in the Play app, after 3 payments over a week, once', () => {
  const st = mem();
  const now = new Date('2026-11-17T10:00:00Z');
  let { s } = shop({ debts: 2, payments: 3, startDate: '2026-11-05' });
  assert.equal(rateNudgeDue(s, now, { inPlayApp: false }), false, 'never in a browser tab');
  assert.equal(rateNudgeDue(s, now, { inPlayApp: true }), true);
  assert.equal(activeNudge(s, now, { inPlayApp: true }), 'rate', 'backup not due yet (5 records)');
  assert.equal(rateNudgeDue(shop({ debts: 2, payments: 2, startDate: '2026-11-05' }).s, now, { inPlayApp: true }), false, 'needs 3 payments');
  assert.equal(rateNudgeDue(shop({ debts: 2, payments: 3, startDate: '2026-11-14' }).s, now, { inPlayApp: true }), false, 'needs a week of use');

  s = updateSettings(s, { nudges: { ...s.settings.nudges, rateSnoozedAt: '2026-11-17T09:00:00Z' } }, st);
  assert.equal(rateNudgeDue(s, now, { inPlayApp: true }), false, '"Nanti" snoozes');
  assert.equal(rateNudgeDue(s, new Date('2026-12-18T10:00:00Z'), { inPlayApp: true }), true, 'for 30 days');

  s = updateSettings(s, { nudges: { ...s.settings.nudges, rate: 'done' } }, st);
  assert.equal(rateNudgeDue(s, new Date('2027-06-01T10:00:00Z'), { inPlayApp: true }), false, 'never again after rating');
  assert.equal(activeNudge(createInitialState(), now, { inPlayApp: true }), null);
});
