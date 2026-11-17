// Bonrapi 1.3 counter sign: a printable A4 poster (1240x1754 = A4 at 150 dpi) with the warung's
// own static QRIS image, for the owner to print at a copy shop and stick by the till.
// There is deliberately NO Bonrapi QR code on it: at a warung counter every QR reads as
// "scan to pay". The Bonrapi credit is a small text footer, shown whenever the share line is on.

import { activeBook, shareLineEnabled } from './books.js';
import { LINK_HOST, LINK_PATHS } from './wa.js';
import { drawRoundedRect, canvasToPngBlob, shareOrDownloadBlob } from './canvas-share.js';

export const SIGN_WIDTH = 1240;
export const SIGN_HEIGHT = 1754;

function slug(s) {
  return String(s || 'warung').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'warung';
}

/**
 * @param {object} state
 * @param {{ hasQris?: boolean }} [opts]
 */
export function buildSignModel(state, { hasQris = false } = {}) {
  const warungName = String(activeBook(state)?.warung?.name || 'Warung').trim() || 'Warung';
  return {
    width: SIGN_WIDTH,
    height: SIGN_HEIGHT,
    warungName,
    hasQris: Boolean(hasQris),
    title: hasQris ? 'Bayar pakai QRIS' : 'Kasbon tercatat rapi di sini',
    subtitle: hasQris
      ? 'Scan dengan aplikasi bank atau e-wallet apa saja'
      : 'Setelah bayar, minta bukti catatan. Kami kirim lewat WhatsApp.',
    showFooter: shareLineEnabled(state),
    footerLine1: 'Kasbon warung ini dicatat rapi dengan Bonrapi',
    footerLine2: `Buku kasbon gratis untuk warung: ${LINK_HOST.replace(/^https:\/\//, '')}/${LINK_PATHS.sign}`,
    thanksLine: `Terima kasih sudah belanja di ${warungName}`,
    filename: `bonrapi-poster-${slug(warungName)}.png`
  };
}

/** Largest font size (<= max) at which `text` fits `maxWidth`; uses measureText when available. */
export function fitFont(ctx, text, maxWidth, { max = 110, min = 40, weight = '400', family = '"DM Serif Display", Georgia, serif' } = {}) {
  for (let size = max; size >= min; size -= 4) {
    ctx.font = `${weight} ${size}px ${family}`;
    const w = ctx.measureText ? ctx.measureText(text).width : text.length * size * 0.5;
    if (w <= maxWidth) return size;
  }
  ctx.font = `${weight} ${min}px ${family}`;
  return min;
}

/** The Bonrapi notebook + tick drawn as vectors (stays sharp when printed), centred on (cx, cy). */
export function drawNotebookMark(ctx, cx, cy, height) {
  const h = height;
  const w = Math.round(h * 0.72);
  const x = Math.round(cx - w / 2);
  const y = Math.round(cy - h / 2);
  ctx.fillStyle = '#FFFFFF';
  drawRoundedRect(ctx, x, y, w, h * 0.86, h * 0.07);
  ctx.fill();
  ctx.strokeStyle = '#0D9488';
  ctx.lineWidth = Math.max(4, h * 0.03);
  ctx.stroke();
  // spine band at the bottom
  ctx.fillStyle = '#0D9488';
  drawRoundedRect(ctx, x, y + h * 0.82, w, h * 0.1, h * 0.04);
  ctx.fill();
  // bookmark
  ctx.fillStyle = '#F5C842';
  const bw = w * 0.16;
  const bx = x + w * 0.2;
  const by = y + h * 0.84;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + bw, by);
  ctx.lineTo(bx + bw, by + h * 0.16);
  ctx.lineTo(bx + bw / 2, by + h * 0.11);
  ctx.lineTo(bx, by + h * 0.16);
  ctx.closePath();
  ctx.fill();
  // tick
  ctx.strokeStyle = '#115E59';
  ctx.lineWidth = h * 0.085;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.26, cy - h * 0.06);
  ctx.lineTo(cx - w * 0.06, cy + h * 0.12);
  ctx.lineTo(cx + w * 0.28, cy - h * 0.22);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
}

function centerText(ctx, text, y) {
  const w = ctx.measureText ? ctx.measureText(text).width : 0;
  ctx.fillText(text, Math.round((SIGN_WIDTH - w) / 2), y);
}

/**
 * Draw the sign. `qrisImage` is the decoded QRIS picture (HTMLImageElement / ImageBitmap) or null.
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<typeof buildSignModel>} model
 * @param {{ qrisImage?: CanvasImageSource|null, mark?: CanvasImageSource|null }} [options]
 */
export function drawSignToCanvas(canvas, model, options = {}) {
  canvas.width = SIGN_WIDTH;
  canvas.height = SIGN_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.fillStyle = '#FBF8EF';
  ctx.fillRect(0, 0, SIGN_WIDTH, SIGN_HEIGHT);

  // Header band with the warung's name
  ctx.fillStyle = '#0D9488';
  ctx.fillRect(0, 0, SIGN_WIDTH, 330);
  ctx.fillStyle = '#FFFFFF';
  fitFont(ctx, model.warungName, SIGN_WIDTH - 160, { max: 120, min: 48 });
  centerText(ctx, model.warungName, 205);

  ctx.fillStyle = '#115E59';
  fitFont(ctx, model.title, SIGN_WIDTH - 160, { max: 76, min: 40, weight: '700', family: '"DM Sans", sans-serif' });
  centerText(ctx, model.title, 470);
  ctx.fillStyle = '#57534E';
  fitFont(ctx, model.subtitle, SIGN_WIDTH - 160, { max: 36, min: 24, weight: '500', family: '"DM Sans", sans-serif' });
  centerText(ctx, model.subtitle, 540);

  const img = options.qrisImage;
  const canDraw = typeof ctx.drawImage === 'function';
  if (model.hasQris && img && img.width && img.height && canDraw) {
    const panel = 920;
    const px = (SIGN_WIDTH - panel) / 2;
    const py = 600;
    ctx.fillStyle = '#FFFFFF';
    drawRoundedRect(ctx, px, py, panel, panel, 36);
    ctx.fill();
    const inner = panel - 60;
    const scale = Math.min(inner / img.width, inner / img.height);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    ctx.drawImage(img, Math.round((SIGN_WIDTH - w) / 2), Math.round(py + (panel - h) / 2), w, h);
  } else {
    drawNotebookMark(ctx, SIGN_WIDTH / 2, 1030, 480);
  }

  // Footer
  ctx.strokeStyle = '#E7E2D8';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(120, 1580);
  ctx.lineTo(SIGN_WIDTH - 120, 1580);
  ctx.stroke();
  if (model.showFooter) {
    ctx.fillStyle = '#1C1917';
    fitFont(ctx, model.footerLine1, SIGN_WIDTH - 200, { max: 36, min: 24, weight: '700', family: '"DM Sans", sans-serif' });
    centerText(ctx, model.footerLine1, 1652);
    ctx.fillStyle = '#57534E';
    fitFont(ctx, model.footerLine2, SIGN_WIDTH - 200, { max: 30, min: 22, weight: '500', family: '"DM Sans", sans-serif' });
    centerText(ctx, model.footerLine2, 1702);
  } else {
    ctx.fillStyle = '#57534E';
    fitFont(ctx, model.thanksLine, SIGN_WIDTH - 200, { max: 34, min: 22, weight: '600', family: '"DM Sans", sans-serif' });
    centerText(ctx, model.thanksLine, 1672);
  }
  return canvas;
}

/** Share the sign PNG (e.g. to a copy shop on WhatsApp) or download it. */
export async function shareOrDownloadSign(canvas, model, options = {}) {
  const blob = await canvasToPngBlob(canvas);
  return shareOrDownloadBlob({
    blob,
    filename: model.filename,
    title: `Poster ${model.warungName}`,
    text: `Poster kasir ${model.warungName} (cetak A4 atau A5)`,
    forceDownload: Boolean(options.forceDownload)
  });
}
