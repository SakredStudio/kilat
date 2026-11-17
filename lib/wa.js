// Pure ES module for Bonrapi WhatsApp deep links (wa.me) and 3-tone Bahasa Indonesia reminder templates (no DOM)

import { normalize } from './phone.js';
import { rp, formatDateId } from './format.js';

// The app itself (TWA origin; Play Billing is tied to it, so it never moves).
export const APP_LINK = 'https://kilat.sakredstudio.ca';
// The public link page every message, card and counter sign points to (projects/kilat/link).
// It explains Bonrapi to whoever received the message and counts visits per surface; the
// one-letter paths must match projects/kilat/link/src/surfaces.js (a test checks both).
export const LINK_HOST = 'https://bonrapi.sakredstudio.ca';
export const LINK_PATHS = Object.freeze({
  reminder: 'r',
  receipt: 'b',
  supplier: 's',
  card: 'k',
  invite: 'a',
  sign: 'q',
  webapp: 'w'
});

/** Public link for one surface, e.g. surfaceLink('receipt') -> 'https://bonrapi.sakredstudio.ca/b'. */
export function surfaceLink(surface = 'reminder') {
  const code = Object.prototype.hasOwnProperty.call(LINK_PATHS, surface) ? LINK_PATHS[surface] : LINK_PATHS.reminder;
  return `${LINK_HOST}/${code}`;
}

/** Install link that goes straight to Google Play through the link page's counter. */
export function playLink(surface = 'webapp') {
  const code = Object.prototype.hasOwnProperty.call(LINK_PATHS, surface) ? LINK_PATHS[surface] : LINK_PATHS.webapp;
  return `${LINK_HOST}/go/${code}`;
}

// Owner-to-owner invite (Settings → "Ajak warung lain"). Written in the owner's own voice.
export const INVITE_TEXT =
  'Saya pakai Bonrapi untuk mencatat kasbon warung. Gratis, bukan aplikasi pinjaman, dan datanya tetap di HP sendiri. Coba: ';
export function buildInviteMessage() {
  return `${INVITE_TEXT}${surfaceLink('invite')}`;
}
/** wa.me link without a number: WhatsApp opens its contact picker with the invite filled in. */
export function inviteLink() {
  return `https://wa.me/?text=${encodeURIComponent(buildInviteMessage())}`;
}

// "Neatly recorded with Bonrapi": says who keeps the record, not who is asking for money.
export const SIGNATURE_TEXT = 'dicatat rapi dengan Bonrapi';
export function shareLineFor(surface = 'reminder') {
  return `— ${SIGNATURE_TEXT} · ${surfaceLink(surface)}`;
}
export const SHARE_LINE = shareLineFor('reminder');
// Signatures used before 1.3 (and before the 2026-11 rename). Only read, never written: a saved
// custom template or pasted draft that still ends with one gets the current line, never two.
export const LEGACY_SHARE_LINES = [`— Bonrapi · ${APP_LINK}`, `— Kilat · ${APP_LINK}`];
const KNOWN_SHARE_LINES = [...Object.keys(LINK_PATHS).map(shareLineFor), ...LEGACY_SHARE_LINES];

export const REMINDER_TEMPLATES = {
  sopan:
    'Assalamualaikum {nama}, semoga sehat selalu 🙏\n\nIzin mengingatkan catatan belanja di *{warung}* sebesar *{jumlah}* (sudah {hari} hari).\n\nKalau sudah longgar boleh ditransfer atau mampir ya. Terima kasih banyak sebelumnya 😊',
  singkat:
    'Halo {nama}, pengingat ramah dari *{warung}*: tagihan belanja sebesar *{jumlah}* ({hari} hari lalu) belum tercatat lunas. Mohon konfirmasinya ya, terima kasih 🙏',
  tegas:
    'Yth. {nama},\n\nKami dari *{warung}* ingin mengingatkan bahwa catatan piutang sebesar *{jumlah}* telah melewati {hari} hari.\n\nMohon segera diselesaikan minggu ini. Hubungi kami jika ingin cicil. Terima kasih.'
};

// Variants used when the debt has a jatuh tempo (due date): {tanggal} is the formatted due date.
export const REMINDER_TEMPLATES_DUE = {
  sopan:
    'Assalamualaikum {nama}, semoga sehat selalu 🙏\n\nIzin mengingatkan catatan belanja di *{warung}* sebesar *{jumlah}* yang jatuh tempo *{tanggal}* (sudah {hari} hari).\n\nKalau sudah longgar boleh ditransfer atau mampir ya. Terima kasih banyak sebelumnya 😊',
  singkat:
    'Halo {nama}, pengingat ramah dari *{warung}*: tagihan belanja sebesar *{jumlah}* jatuh tempo *{tanggal}* ({hari} hari lalu dicatat). Mohon konfirmasinya ya, terima kasih 🙏',
  tegas:
    'Yth. {nama},\n\nKami dari *{warung}* ingin mengingatkan bahwa catatan piutang sebesar *{jumlah}* jatuh tempo pada *{tanggal}* dan telah melewati {hari} hari.\n\nMohon segera diselesaikan minggu ini. Hubungi kami jika ingin cicil. Terima kasih.'
};

export const TEMPLATE_VARIABLES = ['{nama}', '{jumlah}', '{hari}', '{warung}', '{tanggal}'];

// Supplier book (hutang): the warung tells its supplier when it intends to pay. Polite tone only;
// Bonrapi never moves the money, it only sends the note.
export const SUPPLIER_TEMPLATE =
  'Halo {nama}, dari *{warung}* 🙏\n\nSekadar kabar: catatan hutang kami sebesar *{jumlah}* akan kami bayar {tanggal}.\n\nTerima kasih atas kepercayaannya, mohon maaf jika ada kekurangan.';
export const SUPPLIER_TEMPLATE_NO_DATE =
  'Halo {nama}, dari *{warung}* 🙏\n\nSekadar kabar: catatan hutang kami sebesar *{jumlah}* sedang kami siapkan pembayarannya.\n\nTerima kasih atas kepercayaannya, mohon maaf jika ada kekurangan.';

/**
 * Build the polite "kami akan bayar" note to a supplier. `tanggal` is the intended pay date
 * (ISO or free text); without it the message says the payment is being prepared.
 */
export function buildSupplierMessage({ nama = '', jumlah = 0, warung = 'Warung', tanggal = '', includeShareLine = true, shareLine = true } = {}) {
  const tanggalText = formatTanggal(tanggal);
  const tpl = tanggalText ? SUPPLIER_TEMPLATE : SUPPLIER_TEMPLATE_NO_DATE;
  const formattedJumlah = typeof jumlah === 'number' ? rp(jumlah, { spaced: true }) : String(jumlah ?? '');
  const filled = tpl
    .replace(/\{nama\}/g, String(nama ?? '').trim())
    .replace(/\{jumlah\}/g, formattedJumlah)
    .replace(/\{warung\}/g, String(warung ?? 'Warung').trim())
    .replace(/\{tanggal\}/g, tanggalText ? `pada *${tanggalText}*` : '');
  return includeShareLine ? ensureShareLine(filled, { surface: 'supplier', enabled: shareLine }) : filled;
}

/** Format a {tanggal} value: ISO dates become '24 Okt 2026', anything else passes through. */
export function formatTanggal(tanggal) {
  const s = String(tanggal ?? '').trim();
  if (!s) return '';
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? formatDateId(s, 'id') : s;
}

/** Remove any Bonrapi signature (current surface lines or legacy ones) from the end of a message. */
export function stripShareLine(msg) {
  let body = String(msg ?? '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const line of KNOWN_SHARE_LINES) {
      if (body.endsWith(line)) {
        body = body.slice(0, -line.length).trim();
        changed = true;
      }
    }
  }
  return body;
}

/**
 * End an outbound WhatsApp message with exactly one Bonrapi signature for its surface.
 * Free: always on. Pro may switch it off (settings.shareLine, see shareLineEnabled in books.js),
 * in which case any old signature is removed and none is added.
 * @param {string} msg
 * @param {{ surface?: keyof typeof LINK_PATHS, enabled?: boolean }} [opts]
 * @returns {string}
 */
export function ensureShareLine(msg, { surface = 'reminder', enabled = true } = {}) {
  const body = stripShareLine(msg);
  if (!enabled) return body;
  const line = shareLineFor(surface);
  return body ? `${body}\n\n${line}` : line;
}

/**
 * Fill one of the 3 tone templates ('sopan' | 'singkat' | 'tegas') or a custom template
 * with `{nama}`, `{jumlah}`, `{hari}`, `{warung}` and append the mandatory share line.
 * @param {{
 *   tone?: 'sopan'|'singkat'|'tegas',
 *   nama: string,
 *   jumlah: number|string,
 *   hari: number|string,
 *   warung: string,
 *   customTemplate?: string,
 *   includeShareLine?: boolean
 * }} params
 * @returns {string}
 */
export function buildReminderMessage({
  tone = 'sopan',
  nama = '',
  jumlah = 0,
  hari = 0,
  warung = 'Warung',
  tanggal = '',
  customTemplate = '',
  includeShareLine = true,
  shareLine = true
} = {}) {
  const tanggalText = formatTanggal(tanggal);
  const builtIn = tanggalText
    ? REMINDER_TEMPLATES_DUE[tone] || REMINDER_TEMPLATES_DUE.sopan
    : REMINDER_TEMPLATES[tone] || REMINDER_TEMPLATES.sopan;
  const tpl =
    customTemplate && String(customTemplate).trim()
      ? String(customTemplate)
      : builtIn;

  const formattedJumlah =
    typeof jumlah === 'number' ? rp(jumlah, { spaced: true }) : String(jumlah ?? '');

  const filled = tpl
    .replace(/\{nama\}/g, String(nama ?? '').trim())
    .replace(/\{jumlah\}/g, formattedJumlah)
    .replace(/\{hari\}/g, String(hari ?? 0))
    .replace(/\{warung\}/g, String(warung ?? 'Warung').trim())
    .replace(/\{tanggal\}/g, tanggalText || '-');

  return includeShareLine ? ensureShareLine(filled, { surface: 'reminder', enabled: shareLine }) : filled;
}

/**
 * Build a `https://wa.me/<phone62>?text=<encoded>` URL.
 * Properly URL-encodes Bahasa Indonesia text, emojis, asterisks, and newlines,
 * and ends the message with one signature for its surface (see ensureShareLine).
 * @param {string} phoneInput
 * @param {string} messageText
 * @param {{ surface?: string, enabled?: boolean }} [shareOpts]
 * @returns {string}
 */
export function link(phoneInput, messageText, shareOpts = {}) {
  const phone62 = normalize(phoneInput);
  const fullText = ensureShareLine(messageText, shareOpts);
  const encoded = encodeURIComponent(fullText);
  return phone62 ? `https://wa.me/${phone62}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
}
