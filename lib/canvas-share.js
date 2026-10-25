// Shared <canvas> drawing + PNG sharing helpers for Kilat cards (summary card, receipt card).
// Pure where possible; the share/download functions touch navigator/document only when present.

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
