// Pure ES module for Kilat WhatsApp deep links (wa.me) and 3-tone Bahasa Indonesia reminder templates (no DOM)

import { normalize } from './phone.js';
import { rp, formatDateId } from './format.js';

export const APP_LINK = 'https://kilat.sakredstudio.ca';
export const SHARE_LINE = `— Kilat · ${APP_LINK}`;

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
// Kilat never moves the money, it only sends the note.
export const SUPPLIER_TEMPLATE =
  'Halo {nama}, dari *{warung}* 🙏\n\nSekadar kabar: catatan hutang kami sebesar *{jumlah}* akan kami bayar {tanggal}.\n\nTerima kasih atas kepercayaannya, mohon maaf jika ada kekurangan.';
export const SUPPLIER_TEMPLATE_NO_DATE =
  'Halo {nama}, dari *{warung}* 🙏\n\nSekadar kabar: catatan hutang kami sebesar *{jumlah}* sedang kami siapkan pembayarannya.\n\nTerima kasih atas kepercayaannya, mohon maaf jika ada kekurangan.';

/**
 * Build the polite "kami akan bayar" note to a supplier. `tanggal` is the intended pay date
 * (ISO or free text); without it the message says the payment is being prepared.
 */
export function buildSupplierMessage({ nama = '', jumlah = 0, warung = 'Warung', tanggal = '', includeShareLine = true } = {}) {
  const tanggalText = formatTanggal(tanggal);
  const tpl = tanggalText ? SUPPLIER_TEMPLATE : SUPPLIER_TEMPLATE_NO_DATE;
  const formattedJumlah = typeof jumlah === 'number' ? rp(jumlah, { spaced: true }) : String(jumlah ?? '');
  const filled = tpl
    .replace(/\{nama\}/g, String(nama ?? '').trim())
    .replace(/\{jumlah\}/g, formattedJumlah)
    .replace(/\{warung\}/g, String(warung ?? 'Warung').trim())
    .replace(/\{tanggal\}/g, tanggalText ? `pada *${tanggalText}*` : '');
  return includeShareLine ? ensureShareLine(filled) : filled;
}

/** Format a {tanggal} value: ISO dates become '24 Okt 2026', anything else passes through. */
export function formatTanggal(tanggal) {
  const s = String(tanggal ?? '').trim();
  if (!s) return '';
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? formatDateId(s, 'id') : s;
}

/**
 * Ensure any outbound WhatsApp message ends with the mandatory Kilat share line.
 * @param {string} msg
 * @returns {string}
 */
export function ensureShareLine(msg) {
  const body = String(msg ?? '').trim();
  if (body.endsWith(SHARE_LINE)) {
    return body;
  }
  return body ? `${body}\n\n${SHARE_LINE}` : SHARE_LINE;
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
  includeShareLine = true
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

  return includeShareLine ? ensureShareLine(filled) : filled;
}

/**
 * Build a `https://wa.me/<phone62>?text=<encoded>` URL.
 * Properly URL-encodes Bahasa Indonesia text, emojis, asterisks, and newlines,
 * and ensures the outbound message ends with `— Kilat · https://kilat.sakredstudio.ca`.
 * @param {string} phoneInput
 * @param {string} messageText
 * @returns {string}
 */
export function link(phoneInput, messageText) {
  const phone62 = normalize(phoneInput);
  const fullText = ensureShareLine(messageText);
  const encoded = encodeURIComponent(fullText);
  return phone62 ? `https://wa.me/${phone62}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
}
