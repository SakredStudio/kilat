// Shared <canvas> drawing + PNG sharing helpers for Bonrapi cards (summary card, receipt card).
// Pure where possible; the share/download functions touch navigator/document only when present.

export const BRAND_MARK_SRC = './icons/mark.png';

let brandMarkImage = null;
let brandMarkPromise = null;

/**
 * Load the Bonrapi mark (notebook + tick) once so the canvas cards can draw it.
 * Resolves to the image, or null outside the DOM / when the file cannot be loaded.
 * @returns {Promise<HTMLImageElement|null>}
 */
export function loadBrandMark(src = BRAND_MARK_SRC) {
  if (brandMarkImage) return Promise.resolve(brandMarkImage);
  if (typeof Image === 'undefined') return Promise.resolve(null);
  if (!brandMarkPromise) {
    brandMarkPromise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        brandMarkImage = img;
        resolve(img);
      };
      img.onerror = () => {
        brandMarkPromise = null;
        resolve(null);
      };
      img.src = src;
    });
  }
  return brandMarkPromise;
}

/** The mark if it has already been loaded, else null (synchronous, for immediate redraws). */
export function getBrandMark() {
  return brandMarkImage;
}

export function drawRoundedRect(ctx, x, y, w, h, r) {
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
 * Draw a QR matrix (rows of '0'/'1', see lib/qr-data.js) as crisp whole-pixel modules inside a
 * size x size square, with a light background and a quiet zone of `quiet` modules on each side.
 * @returns {{ x: number, y: number, size: number, module: number }} the square actually drawn
 */
export function drawQr(ctx, qr, x, y, size, { dark = '#1C1917', light = '#FFFFFF', quiet = 4 } = {}) {
  const rows = qr && Array.isArray(qr.rows) ? qr.rows : [];
  const n = rows.length;
  if (!n) return { x, y, size: 0, module: 0 };
  const total = n + quiet * 2;
  const module = Math.max(1, Math.floor(size / total));
  const drawn = module * total;
  const ox = Math.round(x + (size - drawn) / 2);
  const oy = Math.round(y + (size - drawn) / 2);
  ctx.fillStyle = light;
  ctx.fillRect(ox, oy, drawn, drawn);
  ctx.fillStyle = dark;
  for (let r = 0; r < n; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === '1') ctx.fillRect(ox + (c + quiet) * module, oy + (r + quiet) * module, module, module);
    }
  }
  return { x: ox, y: oy, size: drawn, module };
}

/** Draw text right-aligned to `rightX` (uses measureText when available). */
export function fillTextRight(ctx, text, rightX, y, fallbackWidth = 220) {
  const measured = ctx.measureText ? ctx.measureText(text).width : fallbackWidth;
  ctx.fillText(text, rightX - measured, y);
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

/** Trigger a browser download of a Blob (no-op outside the DOM). */
export function downloadBlob(blob, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  return true;
}

/**
 * Share files + text through the Web Share API, falling back to a PNG download.
 * @param {{ blob: Blob, filename: string, title: string, text: string, forceDownload?: boolean, mime?: string }} opts
 * @returns {Promise<{method:'web-share'|'cancelled'|'download'|'none', size:number}>}
 */
export async function shareOrDownloadBlob({ blob, filename, title, text, forceDownload = false, mime = 'image/png' }) {
  if (
    !forceDownload &&
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof File !== 'undefined'
  ) {
    const file = new File([blob], filename, { type: mime });
    if (!navigator.canShare || navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title, text, files: [file] });
        return { method: 'web-share', size: blob.size };
      } catch (err) {
        // User dismissed the share sheet: do not force a download on them
        if (err && err.name === 'AbortError') {
          return { method: 'cancelled', size: blob.size };
        }
        // Any other share failure falls through to the download
      }
    }
  }
  const ok = downloadBlob(blob, filename);
  return { method: ok ? 'download' : 'none', size: blob.size };
}
