// Pure ES module for normalizing Indonesian phone numbers for WhatsApp (62XXXXXXXXXX) (no DOM)

/**
 * Normalize an Indonesian or international phone number string for WhatsApp `wa.me`:
 * - Indonesian numbers (`0812-3456-7890`, `+62 812 3456 7890`, `6281234567890`, `81234567890`, `+620812...`)
 *   -> `'6281234567890'`
 * - Preserves non-Indonesian international numbers with explicit country code as digits.
 * @param {string} rawInput
 * @returns {string}
 */
export function normalize(rawInput) {
  const str = String(rawInput ?? '').trim();
  if (!str) return '';

  const compact = str.replace(/[\s\-().\u00A0]/g, '');

  // Explicit international prefix (+ or 00)
  if (compact.startsWith('+') || compact.startsWith('00')) {
    const withoutPrefix = compact.startsWith('+') ? compact.slice(1) : compact.slice(2);
    const digitsOnly = withoutPrefix.replace(/\D/g, '');
    if (!digitsOnly) return '';

    if (digitsOnly.startsWith('62')) {
      let rest = digitsOnly.slice(2);
      // Strip trunk '0' if user typed +62 0812...
      if (rest.startsWith('0')) {
        rest = rest.slice(1);
      }
      return rest ? `62${rest}` : '';
    }
    return digitsOnly;
  }

  const digits = compact.replace(/\D/g, '');
  if (!digits) return '';

  // Leading '0' trunk prefix (e.g. 081234567890 -> 6281234567890)
  if (digits.startsWith('0')) {
    const rest = digits.replace(/^0+/, '');
    return rest ? `62${rest}` : '';
  }

  // Already prefixed with '62' (e.g. 6281234567890 or 62081234567890)
  if (digits.startsWith('62') && digits.length >= 10) {
    let rest = digits.slice(2);
    if (rest.startsWith('0')) {
      rest = rest.slice(1);
    }
    return `62${rest}`;
  }

  // Bare Indonesian mobile starting with '8' (e.g. 81234567890 -> 6281234567890)
  if (digits.startsWith('8') && digits.length >= 8 && digits.length <= 13) {
    return `62${digits}`;
  }

  return digits;
}

/**
 * Normalize a phone number and keep the original raw string alongside it.
 * @param {string} rawInput
 * @returns {{ phone62: string, phoneRaw: string }}
 */
export function parsePhone(rawInput) {
  const phoneRaw = String(rawInput ?? '').trim();
  return {
    phone62: normalize(phoneRaw),
    phoneRaw
  };
}

/**
 * Format an Indonesian phone number for friendly local display (e.g. 0812-3456-7890).
 * @param {string} phoneInput
 * @returns {string}
 */
export function formatLocalPhone(phoneInput) {
  const norm = normalize(phoneInput);
  if (!norm) return String(phoneInput ?? '');
  if (norm.startsWith('62')) {
    const local = `0${norm.slice(2)}`;
    if (local.length >= 10 && local.length <= 13) {
      return `${local.slice(0, 4)}-${local.slice(4, 8)}-${local.slice(8)}`;
    }
    return local;
  }
  return norm;
}
