// Pure ES module for Indonesian Rupiah (IDR) formatting, parsing, avatars, and dates (no DOM)

export const AVATAR_PALETTE = [
  '#0D9488',
  '#D97706',
  '#DC2626',
  '#2563EB',
  '#7C3AED',
  '#059669',
  '#DB2777'
];

const ID_MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'
];

/**
 * Format an integer Rupiah amount using Indonesian dot thousands separator (`1.250.000`).
 * Never uses floating-point decimals for IDR.
 * @param {number} amountIdr - integer amount in Rupiah (e.g. 1250000)
 * @param {{ spaced?: boolean, withPrefix?: boolean }} [options]
 * @returns {string} e.g. 'Rp1.250.000' or 'Rp 1.250.000'
 */
export function rp(amountIdr, options = {}) {
  if (typeof amountIdr !== 'number' || !Number.isFinite(amountIdr)) {
    throw new TypeError('Amount in IDR must be a finite number');
  }
  const intAmount = Math.round(amountIdr);
  const sign = intAmount < 0 ? '-' : '';
  const absStr = String(Math.abs(intAmount));
  const formattedDigits = absStr.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (options.withPrefix === false) {
    return `${sign}${formattedDigits}`;
  }
  const prefix = options.spaced ? 'Rp ' : 'Rp';
  return `${sign}${prefix}${formattedDigits}`;
}

export const formatIdr = rp;

/**
 * Parse a Rupiah string or number (e.g. 'Rp 1.250.000', '350.000', 350000) into an integer IDR amount.
 * @param {string|number} raw
 * @returns {number}
 */
export function parseIdr(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new RangeError('IDR amount must be a non-negative finite number');
    }
    return Math.round(raw);
  }
  const str = String(raw ?? '').trim();
  if (!str) {
    throw new RangeError('IDR amount cannot be empty');
  }
  // Remove Rp prefix, dots, spaces, commas
  const cleaned = str.replace(/^[Rr][Pp]\s*/, '').replace(/[.\s,]/g, '');
  if (!/^\d+$/.test(cleaned)) {
    throw new RangeError(`Invalid IDR amount: "${raw}"`);
  }
  const num = Number(cleaned);
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new RangeError(`IDR amount out of safe integer range: "${raw}"`);
  }
  return num;
}

/**
 * Deterministically pick an avatar color by hashing the name.
 * @param {string} name
 * @returns {string}
 */
export function avatarColor(name) {
  const str = String(name || '').trim();
  if (!str) return AVATAR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

/**
 * Extract 1-2 uppercase initials for avatar circle (e.g. "Pak Budi Santoso" -> "PB").
 * @param {string} name
 * @returns {string}
 */
export function avatarInitials(name) {
  const str = String(name || '').trim();
  if (!str) return '?';
  const parts = str.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return Array.from(parts[0])[0].toUpperCase();
  }
  return (Array.from(parts[0])[0] + Array.from(parts[1])[0]).toUpperCase();
}

/**
 * Format an ISO date string ('YYYY-MM-DD' or full ISO) in Indonesian short format ('24 Okt 2026').
 * @param {string} dateStr
 * @returns {string}
 */
export function formatDateId(dateStr) {
  const s = String(dateStr || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const year = Number(m[1]);
    const monthIdx = Number(m[2]) - 1;
    const day = Number(m[3]);
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${day} ${ID_MONTHS_SHORT[monthIdx]} ${year}`;
    }
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getUTCDate()} ${ID_MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
