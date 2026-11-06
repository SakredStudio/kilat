// Pure ES module for Bonrapi multi-warung books (v3). A state holds `books[]` (each with its own
// warung, customers, debts, payments, suppliers, supplier records and reminders journal) and an
// `activeBookId`. Everything else in the app reads the active book through activeBook(state), so a
// legacy single-book state (no `books` array) resolves to itself.

export const FREE_BOOK_LIMIT = 1;
export const PRO_BOOK_LIMIT = 5;

/**
 * The book the app is currently working in. Falls back to the first book, or to the state itself
 * for a legacy flat shape.
 */
export function activeBook(state) {
  if (!state || typeof state !== 'object') return null;
  if (Array.isArray(state.books)) {
    return state.books.find((b) => b && b.id === state.activeBookId) || state.books[0] || null;
  }
  return state;
}

export function listBooks(state) {
  return Array.isArray(state?.books) ? state.books : state ? [state] : [];
}

/**
 * THE "is this user Pro?" check: every Pro gate goes through here, never through settings.isPro
 * directly. Pro is on when Play Billing recorded a purchase (settings.isPro) OR a reviewer access
 * code was accepted on this device (settings.reviewerAccess, see lib/reviewer.js). The two flags
 * are independent, so a billing sync that finds no purchase cannot switch reviewer access off.
 */
export function isProActive(state) {
  const s = state?.settings;
  return Boolean(s && (s.isPro || s.reviewerAccess));
}

export function bookLimit(state) {
  return isProActive(state) ? PRO_BOOK_LIMIT : FREE_BOOK_LIMIT;
}

/** Free = 1 warung, Pro = up to 5. */
export function canAddBook(state) {
  return listBooks(state).length < bookLimit(state);
}
