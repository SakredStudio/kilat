// Pure ES module for Kilat multi-warung books (v3). A state holds `books[]` (each with its own
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

export function bookLimit(state) {
  return state?.settings?.isPro ? PRO_BOOK_LIMIT : FREE_BOOK_LIMIT;
}

/** Free = 1 warung, Pro = up to 5. */
export function canAddBook(state) {
  return listBooks(state).length < bookLimit(state);
}
