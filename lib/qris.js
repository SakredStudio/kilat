// Kilat QRIS attachment (v3): the owner stores the shop's static QRIS image on the device
// (IndexedDB via lib/photos.js, key 'qris:<bookId>'); a reminder can carry it so the customer
// scans and pays the shop directly. No money ever moves through Kilat: this module only builds
// the share payload (text + image file) and the wording that says so.

import { ensureShareLine, SHARE_LINE } from './wa.js';
import { downloadBlob } from './canvas-share.js';

export const QRIS_LINE = 'Bisa scan QRIS warung di gambar terlampir ya, pembayaran langsung ke warung 🙏';

export function qrisKey(bookId) {
  return `qris:${String(bookId || 'book_1')}`;
}

/** Insert the QRIS line before the share line (idempotent). */
export function withQrisLine(message) {
  const body = String(message ?? '').trim();
  if (body.includes(QRIS_LINE)) return ensureShareLine(body);
  const withoutShare = body.endsWith(SHARE_LINE) ? body.slice(0, -SHARE_LINE.length).trimEnd() : body;
  return ensureShareLine(`${withoutShare}\n\n${QRIS_LINE}`);
}

/** Decode a base64 dataURL into { mime, bytes } (pure, works in Node and browsers). */
export function dataUrlToBytes(dataUrl) {
  const s = String(dataUrl || '');
  const m = s.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!m) throw new Error('Not a base64 dataURL');
  const mime = m[1];
  const b64 = m[2];
  let binary;
  if (typeof atob === 'function') {
    binary = atob(b64);
  } else {
    binary = Buffer.from(b64, 'base64').toString('binary');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { mime, bytes };
}

function slug(s) {
  return String(s || 'warung').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'warung';
}

/**
 * Build what gets shared: the reminder text with the QRIS line, plus the image as bytes.
 * @param {{ message: string, qrisDataUrl: string, warungName?: string }} input
 */
export function buildQrisSharePayload({ message, qrisDataUrl, warungName = 'Warung' } = {}) {
  if (!qrisDataUrl) throw new Error('QRIS image missing');
  const { mime, bytes } = dataUrlToBytes(qrisDataUrl);
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return {
    title: `QRIS ${warungName}`,
    text: withQrisLine(message),
    filename: `qris-${slug(warungName)}.${ext}`,
    mime,
    bytes,
    size: bytes.length
  };
}

/**
 * Browser: share text + QRIS image through the Web Share API. Fallback: open the wa.me text link,
 * download the image and tell the caller to explain "kirim gambar ini di WhatsApp".
 * @returns {Promise<{ method: 'web-share'|'cancelled'|'fallback' }>}
 */
export async function shareReminderWithQris(payload, { waHref, openLink } = {}) {
  if (typeof File !== 'undefined' && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const file = new File([payload.bytes], payload.filename, { type: payload.mime });
    if (!navigator.canShare || navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title: payload.title, text: payload.text, files: [file] });
        return { method: 'web-share' };
      } catch (err) {
        if (err && err.name === 'AbortError') return { method: 'cancelled' };
      }
    }
  }
  if (waHref) {
    if (typeof openLink === 'function') openLink(waHref);
    else if (typeof window !== 'undefined') window.open(waHref, '_blank', 'noopener,noreferrer');
  }
  downloadBlob(new Blob([payload.bytes], { type: payload.mime }), payload.filename);
  return { method: 'fallback' };
}
