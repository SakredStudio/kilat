// Pure ES module for Kilat WhatsApp deep links (wa.me) and 3-tone Bahasa Indonesia reminder templates (no DOM)

import { normalize } from './phone.js';
import { rp } from './format.js';

export const APP_LINK = 'https://sakredstudio.github.io/kilat';
export const SHARE_LINE = `— Kilat · ${APP_LINK}`;

export const REMINDER_TEMPLATES = {
  sopan:
    'Assalamualaikum {nama}, semoga sehat selalu 🙏\n\nIzin mengingatkan catatan belanja di *{warung}* sebesar *{jumlah}* (sudah {hari} hari).\n\nKalau sudah longgar boleh ditransfer atau mampir ya. Terima kasih banyak sebelumnya 😊',
  singkat:
    'Halo {nama}, pengingat ramah dari *{warung}*: tagihan belanja sebesar *{jumlah}* ({hari} hari lalu) belum tercatat lunas. Mohon konfirmasinya ya, terima kasih 🙏',
  tegas:
    'Yth. {nama},\n\nKami dari *{warung}* ingin mengingatkan bahwa catatan piutang sebesar *{jumlah}* telah melewati {hari} hari.\n\nMohon segera diselesaikan minggu ini. Hubungi kami jika ingin cicil. Terima kasih.'
};

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
  customTemplate = '',
  includeShareLine = true
} = {}) {
  const tpl =
    customTemplate && String(customTemplate).trim()
      ? String(customTemplate)
      : REMINDER_TEMPLATES[tone] || REMINDER_TEMPLATES.sopan;

  const formattedJumlah =
    typeof jumlah === 'number' ? rp(jumlah, { spaced: true }) : String(jumlah ?? '');

  const filled = tpl
    .replace(/\{nama\}/g, String(nama ?? '').trim())
    .replace(/\{jumlah\}/g, formattedJumlah)
    .replace(/\{hari\}/g, String(hari ?? 0))
    .replace(/\{warung\}/g, String(warung ?? 'Warung').trim());

  return includeShareLine ? ensureShareLine(filled) : filled;
}

/**
 * Build a `https://wa.me/<phone62>?text=<encoded>` URL.
 * Properly URL-encodes Bahasa Indonesia text, emojis, asterisks, and newlines,
 * and ensures the outbound message ends with `— Kilat · https://sakredstudio.github.io/kilat`.
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
