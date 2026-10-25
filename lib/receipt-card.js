// Pure ES module for the Kilat "Bukti Catatan Pembayaran" receipt card (1080x1350 PNG) that the
// owner sends back to a customer after recording a payment. Kilat only records: the card states
// what was noted, never that money passed through the app.

import { rp, formatDateId } from './format.js';
import { computeCustomerSummary } from './ledger.js';
import { ensureShareLine } from './wa.js';
import { WATERMARK_TEXT } from './share-card.js';
import { drawRoundedRect, fillTextRight, canvasToPngBlob, shareOrDownloadBlob } from './canvas-share.js';

export const RECEIPT_WIDTH = 1080;
export const RECEIPT_HEIGHT = 1350;

/**
 * Build the receipt model for one payment of one customer.
 * `remaining` is the customer's balance right after that payment (payments up to and including
 * its date and position are applied against all debts dated up to the reference date).
 * @param {object} state
 * @param {{ customerId: string, paymentId: string }} ref
 * @param {string|Date} [referenceDate] used only for days-overdue of the remaining balance
 */
export function buildReceiptModel(state, { customerId, paymentId }, referenceDate = new Date()) {
  const customers = Array.isArray(state?.customers) ? state.customers : [];
  const debts = Array.isArray(state?.debts) ? state.debts : [];
  const payments = Array.isArray(state?.payments) ? state.payments : [];
  const customer = customers.find((c) => c.id === customerId);
  if (!customer) throw new Error(`Customer not found: ${customerId}`);
  const payment = payments.find((p) => p.id === paymentId && p.customerId === customerId);
  if (!payment) throw new Error(`Payment not found: ${paymentId}`);

  // Balance as of this payment: every debt the customer has, minus payments up to this one.
  const custPayments = payments
    .filter((p) => p.customerId === customerId)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  const idx = custPayments.findIndex((p) => p.id === paymentId);
  const paymentsThrough = custPayments.slice(0, idx + 1);
  const summary = computeCustomerSummary(customer, debts, paymentsThrough, referenceDate);
  const latest = computeCustomerSummary(customer, debts, payments, referenceDate);

  const warungName = String(state?.warung?.name || 'Warung').trim();
  const isPro = Boolean(state?.settings?.isPro);
  const amountPaid = Math.round(Number(payment.amountIdr) || 0);
  const remaining = summary.balance;
  const isLunas = remaining === 0;

  const lines = [
    `🧾 *BUKTI CATATAN PEMBAYARAN — ${warungName.toUpperCase()}*`,
    `Pelanggan: ${customer.name}`,
    `Tanggal: ${formatDateId(payment.date)}`,
    `Dibayar: *${rp(amountPaid, { spaced: true })}*${payment.note ? ` (${payment.note})` : ''}`,
    isLunas ? 'Status: *LUNAS* ✅ Terima kasih 🙏' : `Sisa catatan: *${rp(remaining, { spaced: true })}*`,
    '',
    'Catatan ini dibuat oleh pemilik warung. Pembayaran terjadi langsung di warung.'
  ];

  return {
    width: RECEIPT_WIDTH,
    height: RECEIPT_HEIGHT,
    warungName,
    customerName: customer.name,
    paymentId,
    dateLabel: formatDateId(payment.date),
    amountPaid,
    amountPaidFormatted: rp(amountPaid, { spaced: true }),
    remaining,
    remainingFormatted: rp(remaining, { spaced: true }),
    isLunas,
    note: String(payment.note || ''),
    totalDebt: summary.totalDebt,
    totalPaidThrough: summary.totalPaid,
    currentBalance: latest.balance,
    showWatermark: !isPro,
    watermarkText: !isPro ? WATERMARK_TEXT : '',
    shareText: ensureShareLine(lines.join('\n'))
  };
}

/**
 * Render the receipt card on a <canvas> (1080x1350). Light paper look, green when lunas.
 */
export function drawReceiptToCanvas(canvas, model) {
  canvas.width = RECEIPT_WIDTH;
  canvas.height = RECEIPT_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const accent = model.isLunas ? '#0D9488' : '#D97706';
  const grad = ctx.createLinearGradient(0, 0, 0, RECEIPT_HEIGHT);
  grad.addColorStop(0, '#F9F7F3');
  grad.addColorStop(1, '#EFEAE0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, RECEIPT_WIDTH, RECEIPT_HEIGHT);

  // Header band
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, RECEIPT_WIDTH, 230);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '600 28px "DM Sans", sans-serif';
  ctx.fillText('BUKTI CATATAN PEMBAYARAN', 80, 100);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 56px "DM Serif Display", Georgia, serif';
  ctx.fillText(model.warungName, 80, 170);

  // Paper card
  const padX = 80;
  const cardY = 290;
  const cardH = 760;
  ctx.fillStyle = '#FFFFFF';
  drawRoundedRect(ctx, padX, cardY, RECEIPT_WIDTH - padX * 2, cardH, 36);
  ctx.fill();

  ctx.fillStyle = '#57534E';
  ctx.font = '500 28px "DM Sans", sans-serif';
  ctx.fillText('Pelanggan', padX + 50, cardY + 80);
  ctx.fillText('Tanggal', padX + 50, cardY + 170);
  ctx.fillStyle = '#1C1917';
  ctx.font = '700 40px "DM Sans", sans-serif';
  ctx.fillText(model.customerName, padX + 50, cardY + 125);
  ctx.font = '600 34px "DM Sans", sans-serif';
  ctx.fillText(model.dateLabel, padX + 50, cardY + 215);

  // Divider
  ctx.strokeStyle = '#E7E2D8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padX + 50, cardY + 260);
  ctx.lineTo(RECEIPT_WIDTH - padX - 50, cardY + 260);
  ctx.stroke();

  ctx.fillStyle = '#57534E';
  ctx.font = '500 30px "DM Sans", sans-serif';
  ctx.fillText('Dibayar (dicatat)', padX + 50, cardY + 330);
  ctx.fillStyle = '#0D9488';
  ctx.font = '700 84px "DM Serif Display", Georgia, serif';
  ctx.fillText(model.amountPaidFormatted, padX + 50, cardY + 430);
  if (model.note) {
    ctx.fillStyle = '#78716C';
    ctx.font = '500 28px "DM Sans", sans-serif';
    ctx.fillText(model.note.slice(0, 48), padX + 50, cardY + 485);
  }

  // Status pill
  const pillY = cardY + 560;
  ctx.fillStyle = model.isLunas ? 'rgba(13,148,136,0.12)' : 'rgba(217,119,6,0.12)';
  drawRoundedRect(ctx, padX + 50, pillY, RECEIPT_WIDTH - padX * 2 - 100, 130, 28);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.font = '700 30px "DM Sans", sans-serif';
  ctx.fillText(model.isLunas ? 'STATUS' : 'SISA CATATAN', padX + 90, pillY + 55);
  ctx.font = '700 52px "DM Serif Display", Georgia, serif';
  const statusText = model.isLunas ? 'LUNAS ✅' : model.remainingFormatted;
  fillTextRight(ctx, statusText, RECEIPT_WIDTH - padX - 90, pillY + 90);

  // Footer: honesty line + watermark
  ctx.fillStyle = '#78716C';
  ctx.font = '500 26px "DM Sans", sans-serif';
  ctx.fillText('Catatan dibuat oleh pemilik warung. Pembayaran terjadi langsung di warung.', padX, 1150);
  ctx.fillText('Kilat hanya mencatat, tidak memindahkan uang.', padX, 1195);
  ctx.fillStyle = '#A8A29E';
  ctx.font = '600 26px "DM Sans", sans-serif';
  ctx.fillText(model.showWatermark ? model.watermarkText : `Terima kasih sudah belanja di ${model.warungName}`, padX, 1270);

  return canvas;
}

/** Share the receipt PNG via Web Share (text + image), download fallback. */
export async function shareOrDownloadReceipt(canvas, model, options = {}) {
  drawReceiptToCanvas(canvas, model);
  const blob = await canvasToPngBlob(canvas);
  const filename = `kilat-bukti-${model.customerName.replace(/\s+/g, '-').toLowerCase()}-${model.dateLabel.replace(/\s+/g, '-').toLowerCase()}.png`;
  return shareOrDownloadBlob({
    blob,
    filename,
    title: `Bukti catatan pembayaran — ${model.warungName}`,
    text: model.shareText,
    forceDownload: Boolean(options.forceDownload)
  });
}
