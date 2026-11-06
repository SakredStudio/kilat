// Reviewer access code for Bonrapi Pro. Google Play reviewers cannot buy in-app products, so a code
// (given to them in the Play Console review notes) unlocks the Pro features on that one device.
// The plain code is never stored in this repo or shipped in the app: only its SHA-256 hash is, and
// the typed input is hashed with Web Crypto and compared hash-to-hash.
// The unlock is persisted as settings.reviewerAccess (see lib/store.js) and honoured by
// isProActive() in lib/books.js; it is separate from the Play purchase flag settings.isPro.

/** SHA-256 (hex, lowercase) of the reviewer code after normalizeReviewerCode(). */
export const REVIEWER_CODE_SHA256 = '401e21fe4158f5714e94867b948de36c075774c2f7ceed6b1200a719593f90b2';

/** Codes are upper-case letters, digits and hyphens: trim the edges and upper-case before hashing. */
export function normalizeReviewerCode(input) {
  return String(input ?? '').trim().toUpperCase();
}

/** SHA-256 of a string as lowercase hex, via Web Crypto (browsers on https/localhost, Node 20+). */
export async function sha256Hex(text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('Web Crypto is not available');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Does `input` (after trim + upper-case) hash to `expectedSha256Hex`? Empty input, a malformed
 * expected hash or a missing Web Crypto all answer false; this never throws.
 */
export async function matchesCodeHash(input, expectedSha256Hex) {
  const code = normalizeReviewerCode(input);
  const expected = String(expectedSha256Hex ?? '').trim().toLowerCase();
  if (!code || !/^[0-9a-f]{64}$/.test(expected)) return false;
  try {
    return (await sha256Hex(code)) === expected;
  } catch {
    return false;
  }
}

/** True only for the real reviewer code. */
export async function isReviewerCode(input) {
  return matchesCodeHash(input, REVIEWER_CODE_SHA256);
}
