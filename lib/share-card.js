// Pure ES module for Kilat Kartu Ringkasan (1080x1350 dark summary card) model,
// <canvas> 2D renderer, and Web Share API / PNG download fallback.

import { rp, formatDateId } from './format.js';
import { computeWarungLedger } from './ledger.js';
import { ensureShareLine } from './wa.js';

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;
export const WATERMARK_TEXT = 'Dibuat dengan Kilat · sakred.in/kilat';

/**
 * Build a pure data model for the Kartu Ringkasan summary card.
 * @param {object} state
 * @param {string|Date} [referenceDate]
 */
export function buildShareCardModel(state, referenceDate = new Date()) {
  const ledger = computeWarungLedger(state, referenceDate);
  const warungName = String(state?.warung?.name || 'Warung Bu Siti').trim();
  const isPro = Boolean(state?.settings?.isPro);
  const isoDate =
    referenceDate instanceof Date
      ? referenceDate.toISOString().slice(0, 10)
      : String(referenceDate).slice(0, 10);

  const top3 = ledger.topDebtors.slice(0, 3).map((c, idx) => ({
    rank: idx + 1,
    id: c.id,
    name: c.name,
    daysOverdue: c.daysOverdue,
    risk: c.risk,
    balance: c.balance,
    balanceFormatted: rp(c.balance, { spaced: true })
  }));

  const textLines = [
    `📊 *LAPORAN PIUTANG — ${warungName.toUpperCase()}*`,
    `Tanggal: ${formatDateId(isoDate)}`,
    `Total Piutang: *${rp(ledger.totalPiutang, { spaced: true })}* (${ledger.activeCustomers.length} pelanggan aktif, ${ledger.highRiskCount} > 30 hari)`
  ];
  if (top3.length > 0) {
    textLines.push('\nDaftar tertinggi:');
    for (const item of top3) {
      textLines.push(`${item.rank}. ${item.name}: ${item.balanceFormatted} (${item.daysOverdue} hr)`);
    }
  }

  return {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    warungName,
    dateLabel: formatDateId(isoDate),
    totalPiutang: ledger.totalPiutang,
    totalFormatted: rp(ledger.totalPiutang, { spaced: true }),
    activeCount: ledger.activeCustomers.length,
    highRiskCount: ledger.highRiskCount,
    topDebtors: top3,
    showWatermark: !isPro,
    watermarkText: !isPro ? WATERMARK_TEXT : '',
    shareText: ensureShareLine(textLines.join('\n'))
  };
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Render the 1080x1350 dark Kartu Ringkasan onto a <canvas> element.
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<typeof buildShareCardModel>} model
 */
export function drawShareCardToCanvas(canvas, model) {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // 1. Background gradient
  const grad = ctx.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT);
  grad.addColorStop(0, '#092228');
  grad.addColorStop(1, '#10353E');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // Decorative glow circle
  ctx.fillStyle = 'rgba(45, 212, 191, 0.08)';
  ctx.beginPath();
  ctx.arc(CARD_WIDTH - 120, 120, 320, 0, Math.PI * 2);
  ctx.fill();

  const padX = 80;

  // 2. Top row: Date & Warung Name + Badge
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.font = '600 28px "DM Sans", sans-serif';
  ctx.fillText(model.dateLabel.toUpperCase(), padX, 120);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 54px "DM Serif Display", Georgia, serif';
  ctx.fillText(model.warungName, padX, 190);

  // Badge on right
  const badgeW = 310;
  const badgeH = 64;
  const badgeX = CARD_WIDTH - padX - badgeW;
  const badgeY = 132;
  ctx.fillStyle = 'rgba(45, 212, 191, 0.16)';
  drawRoundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 32);
  ctx.fill();
  ctx.fillStyle = '#5EEAD4';
  ctx.font = '700 26px "DM Sans", sans-serif';
  ctx.fillText('⚡ LAPORAN PIUTANG', badgeX + 26, badgeY + 41);

  // 3. Total Piutang Box
  const boxY = 250;
  const boxH = 290;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
  drawRoundedRect(ctx, padX, boxY, CARD_WIDTH - padX * 2, boxH, 32);
  ctx.fill();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.font = '500 30px "DM Sans", sans-serif';
  ctx.fillText('Total Piutang Belum Lunas', padX + 44, boxY + 68);

  ctx.fillStyle = '#5EEAD4';
  ctx.font = '700 86px "DM Serif Display", Georgia, serif';
  ctx.fillText(model.totalFormatted, padX + 44, boxY + 175);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.font = '600 28px "DM Sans", sans-serif';
  ctx.fillText(`${model.activeCount} pelanggan aktif`, padX + 44, boxY + 242);

  ctx.fillStyle = '#FCD34D';
  ctx.fillText(`🔴 ${model.highRiskCount} > 30 hari`, padX + 420, boxY + 242);

  // 4. Top 3 Debtors Rows
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = '700 28px "DM Sans", sans-serif';
  ctx.fillText('PELANGGAN PRIORITAS TAGIH:', padX, 615);

  let rowY = 650;
  for (const item of model.topDebtors) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    drawRoundedRect(ctx, padX, rowY, CARD_WIDTH - padX * 2, 130, 24);
    ctx.fill();

    // Rank circle
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.beginPath();
    ctx.arc(padX + 56, rowY + 65, 28, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 28px "DM Sans", sans-serif';
    ctx.fillText(String(item.rank), padX + 47, rowY + 75);

    // Name & days
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 34px "DM Sans", sans-serif';
    ctx.fillText(item.name, padX + 110, rowY + 58);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.font = '500 26px "DM Sans", sans-serif';
    ctx.fillText(`Menunggak ${item.daysOverdue} hari`, padX + 110, rowY + 98);

    // Amount on right
    ctx.fillStyle = item.risk === 'Tinggi' ? '#FCA5A5' : '#FCD34D';
    ctx.font = '700 36px "DM Sans", sans-serif';
    const amtText = item.balanceFormatted;
    const measured = ctx.measureText ? ctx.measureText(amtText).width : 220;
    ctx.fillText(amtText, CARD_WIDTH - padX - 40 - measured, rowY + 76);

    rowY += 155;
  }

  // 5. Divider & Footer / Watermark
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padX, 1185);
  ctx.lineTo(CARD_WIDTH - padX, 1185);
  ctx.stroke();

  if (model.showWatermark) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '600 28px "DM Sans", sans-serif';
    ctx.fillText(model.watermarkText, padX, 1255);
  } else {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '600 28px "DM Sans", sans-serif';
    ctx.fillText(`Laporan Resmi ${model.warungName}`, padX, 1255);
  }

  return canvas;
}

/**
 * Convert canvas to PNG Blob.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
export function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to generate PNG blob'));
      }, 'image/png');
    } else {
      reject(new Error('Canvas toBlob not supported'));
    }
  });
}

/**
 * Trigger PNG download or native Web Share API with PNG file.
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<typeof buildShareCardModel>} model
 * @param {{ forceDownload?: boolean }} [options]
 */
export async function shareOrDownloadCard(canvas, model, options = {}) {
  drawShareCardToCanvas(canvas, model);
  const blob = await canvasToPngBlob(canvas);
  const filename = `kilat-ringkasan-${model.dateLabel.replace(/\s+/g, '-').toLowerCase()}.png`;

  if (
    !options.forceDownload &&
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof File !== 'undefined'
  ) {
    const file = new File([blob], filename, { type: 'image/png' });
    if (!navigator.canShare || navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: `Laporan Piutang ${model.warungName}`,
          text: model.shareText,
          files: [file]
        });
        return { method: 'web-share', size: blob.size };
      } catch {
        // Fall through to download if user cancels or share fails
      }
    }
  }

  if (typeof document !== 'undefined' && typeof URL !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  return { method: 'download', size: blob.size };
}
