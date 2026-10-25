// Pure ES module for Kilat localStorage persistence ('kilat.v1'), schema migration (v1 flat ->
// v2 multi-warung books), 25-customer free tier limit, 5-second undo snapshots, demo seeding,
// and JSON/CSV export (no DOM).
//
// Shape (schemaVersion 2):
//   { schemaVersion, books: [ { id, warung, customers, debts, payments,
//                               suppliers, supplierDebts, supplierPayments, reminders } ],
//     activeBookId, settings }
// Every function below works on the ACTIVE book via activeBook(state) (lib/books.js).

import { normalize } from './phone.js';
import { parseIdr } from './format.js';
import { DEFAULT_LANG, normalizeLang } from './i18n.js';
import { activeBook, canAddBook, bookLimit } from './books.js';

export const STORAGE_KEY = 'kilat.v1';
export const CURRENT_SCHEMA_VERSION = 2;
export const FREE_CUSTOMER_LIMIT = 25;
export const VALID_TONES = ['sopan', 'singkat', 'tegas'];
export { activeBook, canAddBook };

// Two books-of-record per warung. Supplier records share the customer shapes on purpose (the party
// id of a supplier debt/payment still lives in `customerId`), so ledger math is reused unchanged.
export const BOOKS = {
  customer: { parties: 'customers', debts: 'debts', payments: 'payments' },
  supplier: { parties: 'suppliers', debts: 'supplierDebts', payments: 'supplierPayments' }
};
export const BOOK_KEYS = Object.keys(BOOKS);

function bookSpec(book) {
  const spec = BOOKS[book];
  if (!spec) throw new Error(`Unknown book: ${book}`);
  return spec;
}

let lastUndoSnapshot = null;

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Local calendar date (never toISOString: that is UTC and shows tomorrow's date in the evening west of GMT).
function todayIsoDate(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return localIsoDate(d);
}
function localIsoDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgoIsoDate(daysAgo, refDate = new Date()) {
  const base = refDate instanceof Date ? new Date(refDate.getTime()) : new Date(refDate);
  base.setUTCDate(base.getUTCDate() - Math.max(0, Math.round(Number(daysAgo) || 0)));
  return base.toISOString().slice(0, 10);
}

export function addDaysIsoDate(isoDate, daysToAdd) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  d.setUTCDate(d.getUTCDate() + Math.round(Number(daysToAdd) || 0));
  return d.toISOString().slice(0, 10);
}

export function createInitialBook(overrides = {}) {
  return {
    id: String(overrides.id || makeId('book')),
    warung: {
      name: 'Warung Bu Siti',
      ownerName: 'Bu Siti',
      phone: '08111222333',
      currency: 'IDR',
      dueDays: 14,
      ...(overrides.warung || {})
    },
    customers: [],
    debts: [],
    payments: [],
    suppliers: [],
    supplierDebts: [],
    supplierPayments: [],
    reminders: []
  };
}

export function createInitialState() {
  const book = createInitialBook({ id: 'book_1' });
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    books: [book],
    activeBookId: book.id,
    settings: {
      tone: 'sopan',
      isPro: false,
      lang: DEFAULT_LANG,
      darkMode: false,
      hasCompletedSetup: false,
      customTemplate: ''
    }
  };
}

function normalizeCustomer(c) {
  if (!c || typeof c !== 'object') {
    throw new Error('Invalid customer object');
  }
  const phoneRaw = String(c.phoneRaw ?? c.phone ?? '').trim();
  const phone62 = String(c.phone62 || normalize(phoneRaw));
  const out = {
    id: String(c.id || makeId('cust')),
    name: String(c.name || '').trim(),
    phoneRaw,
    phone62,
    note: String(c.note || '').trim(),
    createdAt: String(c.createdAt || new Date().toISOString())
  };
  // Supplier-only: "ingatkan saya" plan (when the warung intends to pay, plus a note)
  if (c.payPlan && typeof c.payPlan === 'object') {
    const date = String(c.payPlan.date || '').slice(0, 10);
    out.payPlan = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      note: String(c.payPlan.note || '').trim()
    };
    if (!out.payPlan.date && !out.payPlan.note) delete out.payPlan;
  }
  return out;
}

function normalizeDebt(d) {
  if (!d || typeof d !== 'object') {
    throw new Error('Invalid debt object');
  }
  const amountIdr = typeof d.amountIdr === 'number' ? Math.round(d.amountIdr) : parseIdr(d.amountIdr || 0);
  const date = String(d.date || todayIsoDate()).slice(0, 10);
  // dueDate is optional: null means "no jatuh tempo" (v2; migrate fills it in for older debts)
  const rawDue = d.dueDate ? String(d.dueDate).slice(0, 10) : '';
  return {
    id: String(d.id || makeId('debt')),
    customerId: String(d.customerId || ''),
    amountIdr: Math.max(0, amountIdr),
    note: String(d.note || '').trim(),
    date,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(rawDue) ? rawDue : null
  };
}

function normalizePayment(p) {
  if (!p || typeof p !== 'object') {
    throw new Error('Invalid payment object');
  }
  const amountIdr = typeof p.amountIdr === 'number' ? Math.round(p.amountIdr) : parseIdr(p.amountIdr || 0);
  const date = String(p.date || todayIsoDate()).slice(0, 10);
  return {
    id: String(p.id || makeId('pay')),
    customerId: String(p.customerId || ''),
    amountIdr: Math.max(0, amountIdr),
    date,
    note: String(p.note || '').trim()
  };
}

function normalizeReminder(r) {
  if (!r || typeof r !== 'object') {
    throw new Error('Invalid reminder object');
  }
  return {
    id: String(r.id || makeId('rem')),
    customerId: String(r.customerId || ''),
    sentAt: String(r.sentAt || new Date().toISOString()),
    tone: String(r.tone || 'sopan'),
    book: BOOK_KEYS.includes(r.book) ? r.book : 'customer'
  };
}

/** Normalise one warung book (the v1 flat state minus settings, or one entry of books[]). */
function migrateBook(data, fallbackId) {
  const src = data && typeof data === 'object' ? data : {};
  const base = createInitialBook();
  const warungIn = src.warung && typeof src.warung === 'object' ? src.warung : {};
  const dueDaysNum = Number(warungIn.dueDays ?? base.warung.dueDays);
  const dueDays = Number.isFinite(dueDaysNum) && dueDaysNum > 0 ? Math.round(dueDaysNum) : 14;
  const list = (arr, fn) => (Array.isArray(arr) ? arr.map(fn) : []);
  return {
    id: String(src.id || fallbackId || makeId('book')),
    warung: {
      name: String(warungIn.name ?? base.warung.name).trim() || base.warung.name,
      ownerName: String(warungIn.ownerName ?? base.warung.ownerName).trim(),
      phone: String(warungIn.phone ?? base.warung.phone).trim(),
      currency: 'IDR',
      dueDays
    },
    customers: list(src.customers, normalizeCustomer),
    debts: list(src.debts, normalizeDebt),
    payments: list(src.payments, normalizePayment),
    suppliers: list(src.suppliers, normalizeCustomer),
    supplierDebts: list(src.supplierDebts, normalizeDebt),
    supplierPayments: list(src.supplierPayments, normalizePayment),
    reminders: Array.isArray(src.reminders)
      ? src.reminders.filter((r) => r && r.customerId).map(normalizeReminder)
      : []
  };
}

/**
 * Migrate any older or partial state structure to schemaVersion 2 (books[] + activeBookId).
 * A v1 flat state becomes books[0]; everything in it is preserved.
 */
export function migrate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid state data: must be an object');
  }
  const base = createInitialState();
  const settingsIn = data.settings && typeof data.settings === 'object' ? data.settings : {};

  let books;
  if (Array.isArray(data.books) && data.books.length > 0) {
    books = data.books.map((b, i) => migrateBook(b, `book_${i + 1}`));
  } else {
    books = [migrateBook(data, 'book_1')];
  }
  // ids must be unique
  const seen = new Set();
  books = books.map((b) => {
    let id = b.id;
    while (seen.has(id)) id = makeId('book');
    seen.add(id);
    return { ...b, id };
  });
  const activeBookId = books.some((b) => b.id === data.activeBookId) ? String(data.activeBookId) : books[0].id;

  const tone = VALID_TONES.includes(settingsIn.tone) ? settingsIn.tone : base.settings.tone;

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    books,
    activeBookId,
    settings: {
      tone,
      isPro: Boolean(settingsIn.isPro),
      lang: normalizeLang(settingsIn.lang || base.settings.lang),
      darkMode: Boolean(settingsIn.darkMode),
      hasCompletedSetup: Boolean(settingsIn.hasCompletedSetup),
      // Pro: owner's own reminder template ('' = use the built-in tones)
      customTemplate: typeof settingsIn.customTemplate === 'string' ? settingsIn.customTemplate.slice(0, 2000) : ''
    }
  };
}

/** Replace the active book with fn(book) and re-migrate. */
function withActiveBook(current, fn) {
  const book = activeBook(current);
  const nextBook = fn(book);
  return migrate({
    ...current,
    books: current.books.map((b) => (b.id === book.id ? { ...nextBook, id: book.id } : b))
  });
}

export function loadState(storage = globalThis.localStorage) {
  if (!storage || typeof storage.getItem !== 'function') {
    return createInitialState();
  }
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) {
    return createInitialState();
  }
  try {
    const parsed = JSON.parse(raw);
    return migrate(parsed);
  } catch {
    return createInitialState();
  }
}

export function saveState(state, storage = globalThis.localStorage) {
  const migrated = migrate(state);
  if (storage && typeof storage.setItem === 'function') {
    storage.setItem(STORAGE_KEY, JSON.stringify(migrated));
  }
  return migrated;
}

/** Update the active warung's profile (name, owner, phone, dueDays) and optionally hasCompletedSetup. */
export function updateWarung(state, patch, storage = globalThis.localStorage) {
  const current = migrate(state);
  const { hasCompletedSetup, ...warungPatch } = patch || {};
  const next = withActiveBook(current, (book) => ({ ...book, warung: { ...book.warung, ...warungPatch } }));
  const withSettings = {
    ...next,
    settings: {
      ...next.settings,
      hasCompletedSetup: hasCompletedSetup !== undefined ? Boolean(hasCompletedSetup) : next.settings.hasCompletedSetup
    }
  };
  return saveState(withSettings, storage);
}

export function updateSettings(state, patch, storage = globalThis.localStorage) {
  const current = migrate(state);
  const next = migrate({
    ...current,
    settings: {
      ...current.settings,
      ...(patch || {})
    }
  });
  return saveState(next, storage);
}

// ---------------------------------------------------------------------------------------------
// Multi-warung books (Pro: up to 5, free: 1)

/** Create a new warung book and make it active. Throws PRO_LIMIT_REACHED when over the tier limit. */
export function addBook(state, { name, ownerName = '', phone = '', dueDays } = {}, storage = globalThis.localStorage) {
  const current = migrate(state);
  if (!canAddBook(current)) {
    const err = new Error(`Book limit of ${bookLimit(current)} reached`);
    err.code = 'PRO_LIMIT_REACHED';
    throw err;
  }
  const active = activeBook(current);
  const book = createInitialBook({
    warung: {
      name: String(name || '').trim() || `Warung ${current.books.length + 1}`,
      ownerName: String(ownerName || active.warung.ownerName || '').trim(),
      phone: String(phone || active.warung.phone || '').trim(),
      dueDays: Number(dueDays || active.warung.dueDays) || 14
    }
  });
  return saveState({ ...current, books: [...current.books, book], activeBookId: book.id }, storage);
}

export function switchBook(state, bookId, storage = globalThis.localStorage) {
  const current = migrate(state);
  if (!current.books.some((b) => b.id === bookId)) {
    throw new Error(`Book not found: ${bookId}`);
  }
  return saveState({ ...current, activeBookId: bookId }, storage);
}

/** Delete a warung book (never the last one). Stores an undo snapshot. */
export function deleteBook(state, bookId, storage = globalThis.localStorage) {
  const current = migrate(state);
  const target = current.books.find((b) => b.id === bookId);
  if (!target) return current;
  if (current.books.length <= 1) {
    throw new Error('Cannot delete the only book');
  }
  lastUndoSnapshot = {
    previousState: deepClone(current),
    meta: { type: 'book', bookId, bookName: target.warung.name, timestamp: Date.now() }
  };
  const books = current.books.filter((b) => b.id !== bookId);
  const activeBookId = current.activeBookId === bookId ? books[0].id : current.activeBookId;
  return saveState({ ...current, books, activeBookId }, storage);
}

// ---------------------------------------------------------------------------------------------

export function canAddCustomer(state) {
  const current = migrate(state);
  if (current.settings.isPro) return true;
  return activeBook(current).customers.length < FREE_CUSTOMER_LIMIT;
}

/** Shared body of addCustomer / addSupplier (free-tier limit applies to customers only). */
function addPartyIn(book, state, input, storage) {
  const spec = bookSpec(book);
  const current = migrate(state);
  if (book === 'customer' && !canAddCustomer(current)) {
    const err = new Error(`Free tier limit of ${FREE_CUSTOMER_LIMIT} customers reached. Upgrade to Kilat Pro.`);
    err.code = 'PRO_LIMIT_REACHED';
    throw err;
  }
  const name = String(input?.name ?? '').trim();
  if (!name) {
    throw new Error(book === 'supplier' ? 'Nama supplier wajib diisi' : 'Nama pelanggan wajib diisi');
  }
  const phoneRaw = String(input?.phoneRaw ?? input?.phone ?? '').trim();
  const phone62 = normalize(phoneRaw);
  const customerId = String(input?.id || makeId(book === 'supplier' ? 'sup' : 'cust'));
  const customer = {
    id: customerId,
    name,
    phoneRaw,
    phone62,
    note: String(input?.note ?? '').trim(),
    createdAt: String(input?.createdAt || new Date().toISOString())
  };

  const next = withActiveBook(current, (b) => {
    const nextDebts = [...b[spec.debts]];
    if (input?.initialDebtIdr !== undefined && input?.initialDebtIdr !== '' && Number(input?.initialDebtIdr) > 0) {
      const amountIdr = typeof input.initialDebtIdr === 'number'
        ? Math.round(input.initialDebtIdr)
        : parseIdr(input.initialDebtIdr);
      if (amountIdr > 0) {
        const daysAgo = Number(input.daysAgo ?? 0) || 0;
        const date = input.date
          ? String(input.date).slice(0, 10)
          : daysAgoIsoDate(daysAgo);
        nextDebts.push({
          id: makeId('debt'),
          customerId,
          amountIdr,
          note: customer.note || 'Utang awal',
          date,
          dueDate: addDaysIsoDate(date, b.warung.dueDays)
        });
      }
    }
    return { ...b, [spec.parties]: [...b[spec.parties], customer], [spec.debts]: nextDebts };
  });
  return saveState(next, storage);
}

/**
 * Add a customer (enforcing the 25-customer free tier limit unless settings.isPro is true).
 * Optional `initialDebtIdr` and `daysAgo` create an initial debt entry simultaneously.
 */
export function addCustomer(state, input, storage = globalThis.localStorage) {
  return addPartyIn('customer', state, input, storage);
}

/** Add a supplier to the hutang book (no free-tier limit; same shape as a customer). */
export function addSupplier(state, input, storage = globalThis.localStorage) {
  return addPartyIn('supplier', state, input, storage);
}

/** Set or clear a supplier's "ingatkan saya" plan: { date: 'YYYY-MM-DD'|null, note }. */
export function setSupplierPayPlan(state, supplierId, plan, storage = globalThis.localStorage) {
  const current = migrate(state);
  const book = activeBook(current);
  const idx = book.suppliers.findIndex((s) => s.id === supplierId);
  if (idx === -1) {
    throw new Error(`Supplier not found: ${supplierId}`);
  }
  const next = withActiveBook(current, (b) => {
    const nextSuppliers = [...b.suppliers];
    const { payPlan, ...rest } = nextSuppliers[idx];
    nextSuppliers[idx] = plan ? normalizeCustomer({ ...rest, payPlan: plan }) : normalizeCustomer(rest);
    return { ...b, suppliers: nextSuppliers };
  });
  return saveState(next, storage);
}

export function updateCustomer(state, customerId, patch, storage = globalThis.localStorage) {
  const current = migrate(state);
  const book = activeBook(current);
  const idx = book.customers.findIndex((c) => c.id === customerId);
  if (idx === -1) {
    throw new Error(`Customer not found: ${customerId}`);
  }
  const existing = book.customers[idx];
  const phoneRaw = patch?.phoneRaw !== undefined
    ? String(patch.phoneRaw).trim()
    : patch?.phone !== undefined
      ? String(patch.phone).trim()
      : existing.phoneRaw;
  const updated = normalizeCustomer({
    ...existing,
    ...patch,
    id: existing.id,
    phoneRaw,
    phone62: normalize(phoneRaw)
  });
  const next = withActiveBook(current, (b) => {
    const nextCustomers = [...b.customers];
    nextCustomers[idx] = updated;
    return { ...b, customers: nextCustomers };
  });
  return saveState(next, storage);
}

function deletePartyIn(book, state, customerId, storage) {
  const spec = bookSpec(book);
  const current = migrate(state);
  const target = activeBook(current)[spec.parties].find((c) => c.id === customerId);
  if (!target) {
    return current;
  }
  lastUndoSnapshot = {
    previousState: deepClone(current),
    meta: {
      type: 'customer',
      book,
      customerId,
      customerName: target.name,
      timestamp: Date.now()
    }
  };
  const next = withActiveBook(current, (b) => ({
    ...b,
    [spec.parties]: b[spec.parties].filter((c) => c.id !== customerId),
    [spec.debts]: b[spec.debts].filter((d) => d.customerId !== customerId),
    [spec.payments]: b[spec.payments].filter((p) => p.customerId !== customerId),
    reminders: b.reminders.filter((r) => !(r.customerId === customerId && r.book === book))
  }));
  return saveState(next, storage);
}

export function deleteCustomer(state, customerId, storage = globalThis.localStorage) {
  return deletePartyIn('customer', state, customerId, storage);
}

export function deleteSupplier(state, supplierId, storage = globalThis.localStorage) {
  return deletePartyIn('supplier', state, supplierId, storage);
}

/**
 * Log that a WhatsApp reminder was opened for a customer (broadcast or single). No undo: it is a
 * journal entry, and the message itself only leaves the phone when the owner taps Send in WhatsApp.
 */
export function logReminder(state, { customerId, tone = 'sopan', sentAt, book = 'customer' } = {}, storage = globalThis.localStorage) {
  const spec = bookSpec(book);
  const current = migrate(state);
  const id = String(customerId || '');
  if (!activeBook(current)[spec.parties].some((c) => c.id === id)) {
    throw new Error(`Customer not found: ${id}`);
  }
  const entry = normalizeReminder({ customerId: id, tone, book, sentAt: sentAt || new Date().toISOString() });
  const next = withActiveBook(current, (b) => ({ ...b, reminders: [...b.reminders, entry] }));
  return saveState(next, storage);
}

/**
 * Find an existing customer with the same WhatsApp number (after 62-normalisation).
 * Used for duplicate detection when adding a customer.
 */
export function findCustomerByPhone(state, phoneInput, { excludeId = null, book = 'customer' } = {}) {
  const spec = bookSpec(book);
  const current = migrate(state);
  const phone62 = normalize(phoneInput);
  if (!phone62) return null;
  return activeBook(current)[spec.parties].find((c) => c.id !== excludeId && c.phone62 === phone62) || null;
}

/**
 * Merge `sourceId` into `targetId`: every debt and payment moves to the target, the target keeps
 * both phone numbers in its note, and the source is removed. Stores an undo snapshot.
 */
export function mergeCustomers(state, sourceId, targetId, storage = globalThis.localStorage) {
  const current = migrate(state);
  const book = activeBook(current);
  if (sourceId === targetId) {
    throw new Error('Cannot merge a customer into itself');
  }
  const source = book.customers.find((c) => c.id === sourceId);
  const target = book.customers.find((c) => c.id === targetId);
  if (!source || !target) {
    throw new Error('Customer not found for merge');
  }

  lastUndoSnapshot = {
    previousState: deepClone(current),
    meta: {
      type: 'merge',
      sourceId,
      targetId,
      sourceName: source.name,
      targetName: target.name,
      timestamp: Date.now()
    }
  };

  const noteParts = [target.note, source.note && source.note !== target.note ? source.note : '']
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  const otherPhone = String(source.phoneRaw || source.phone62 || '').trim();
  if (otherPhone && source.phone62 !== target.phone62) {
    noteParts.push(`Nomor lain: ${otherPhone}`);
  }

  const mergedTarget = {
    ...target,
    note: noteParts.join(' · ')
  };

  const next = withActiveBook(current, (b) => ({
    ...b,
    customers: b.customers
      .filter((c) => c.id !== sourceId)
      .map((c) => (c.id === targetId ? mergedTarget : c)),
    debts: b.debts.map((d) => (d.customerId === sourceId ? { ...d, customerId: targetId } : d)),
    payments: b.payments.map((p) => (p.customerId === sourceId ? { ...p, customerId: targetId } : p)),
    reminders: b.reminders.map((r) => (r.customerId === sourceId && r.book === 'customer' ? { ...r, customerId: targetId } : r))
  }));
  return saveState(next, storage);
}

function addDebtIn(book, state, input, storage) {
  const spec = bookSpec(book);
  const current = migrate(state);
  const active = activeBook(current);
  const customerId = String(input?.customerId || '');
  const customer = active[spec.parties].find((c) => c.id === customerId);
  if (!customer) {
    throw new Error(`Customer not found: ${customerId}`);
  }
  const amountIdr = typeof input?.amountIdr === 'number'
    ? Math.round(input.amountIdr)
    : parseIdr(input?.amountIdr);
  if (!Number.isFinite(amountIdr) || amountIdr <= 0) {
    throw new RangeError('Jumlah utang harus lebih dari Rp0');
  }
  const date = input?.date ? String(input.date).slice(0, 10) : todayIsoDate();
  // undefined -> default (date + warung.dueDays); '' or null -> no due date
  const dueDate = input?.dueDate === undefined
    ? addDaysIsoDate(date, active.warung.dueDays)
    : input.dueDate
      ? String(input.dueDate).slice(0, 10)
      : null;
  const debt = normalizeDebt({
    id: input?.id || makeId('debt'),
    customerId,
    amountIdr,
    note: String(input?.note ?? '').trim(),
    date,
    dueDate
  });

  lastUndoSnapshot = {
    previousState: deepClone(current),
    meta: {
      type: 'debt',
      book,
      entryId: debt.id,
      customerId,
      amountIdr: debt.amountIdr,
      timestamp: Date.now()
    }
  };

  const next = withActiveBook(current, (b) => ({
    ...b,
    // Update the party's summary note if a note was provided and theirs was empty
    [spec.parties]: b[spec.parties].map((c) => (c.id === customerId && debt.note && !c.note ? { ...c, note: debt.note } : c)),
    [spec.debts]: [...b[spec.debts], debt]
  }));
  return saveState(next, storage);
}

/** Add a debt entry for a customer and store a 5-second undo snapshot. */
export function addDebt(state, input, storage = globalThis.localStorage) {
  return addDebtIn('customer', state, input, storage);
}

/** Add a hutang entry (what the warung owes) for a supplier. */
export function addSupplierDebt(state, input, storage = globalThis.localStorage) {
  return addDebtIn('supplier', state, input, storage);
}

function addPaymentIn(book, state, input, storage) {
  const spec = bookSpec(book);
  const current = migrate(state);
  const customerId = String(input?.customerId || '');
  const customer = activeBook(current)[spec.parties].find((c) => c.id === customerId);
  if (!customer) {
    throw new Error(`Customer not found: ${customerId}`);
  }
  const amountIdr = typeof input?.amountIdr === 'number'
    ? Math.round(input.amountIdr)
    : parseIdr(input?.amountIdr);
  if (!Number.isFinite(amountIdr) || amountIdr <= 0) {
    throw new RangeError('Jumlah pembayaran harus lebih dari Rp0');
  }
  const date = input?.date ? String(input.date).slice(0, 10) : todayIsoDate();
  const payment = normalizePayment({
    id: input?.id || makeId('pay'),
    customerId,
    amountIdr,
    date,
    note: String(input?.note ?? '').trim()
  });

  lastUndoSnapshot = {
    previousState: deepClone(current),
    meta: {
      type: 'payment',
      book,
      entryId: payment.id,
      customerId,
      amountIdr: payment.amountIdr,
      timestamp: Date.now()
    }
  };

  const next = withActiveBook(current, (b) => ({ ...b, [spec.payments]: [...b[spec.payments], payment] }));
  return saveState(next, storage);
}

/** Record a payment entry for a customer and store a 5-second undo snapshot. */
export function addPayment(state, input, storage = globalThis.localStorage) {
  return addPaymentIn('customer', state, input, storage);
}

/** Record a payment the warung made to a supplier. */
export function addSupplierPayment(state, input, storage = globalThis.localStorage) {
  return addPaymentIn('supplier', state, input, storage);
}

export function getUndoMeta() {
  return lastUndoSnapshot ? deepClone(lastUndoSnapshot.meta) : null;
}

export function clearUndo() {
  lastUndoSnapshot = null;
}

export function undoLastAction(storage = globalThis.localStorage) {
  if (!lastUndoSnapshot || !lastUndoSnapshot.previousState) {
    return null;
  }
  const restored = deepClone(lastUndoSnapshot.previousState);
  lastUndoSnapshot = null;
  return saveState(restored, storage);
}

/**
 * Seed sample warung customers and debts into the ACTIVE book (replaces its customer ledger).
 * - count = 6: matches the 6 customers in WarungPay Reminder.html prototype
 * - count = 12: seeds 12 customers and 20 debts across all risk levels
 */
export function seedDemoData(state, storage = globalThis.localStorage, options = {}) {
  const current = migrate(state);
  const dueDays = activeBook(current).warung.dueDays;
  const count = options.count === 12 ? 12 : 6;
  const refDate = options.referenceDate ? new Date(options.referenceDate) : new Date();

  const prototypeSix = [
    { id: 'c1', name: 'Pak Budi Santoso', phone: '081234567890', debt: 350000, days: 21, note: 'Sembako + rokok' },
    { id: 'c2', name: 'Ibu Sari Dewi', phone: '082345678901', debt: 125000, days: 7, note: 'Beras 5kg, minyak' },
    { id: 'c3', name: 'Mas Agus Wibowo', phone: '085678901234', debt: 780000, days: 45, note: 'Belanja bulanan' },
    { id: 'c4', name: 'Mbak Rina Kusuma', phone: '081356789012', debt: 60000, days: 3, note: 'Pulsa + snack' },
    { id: 'c5', name: 'Pak Hendra Gunawan', phone: '087890123456', debt: 500000, days: 33, note: 'Gula, tepung, kopi' },
    { id: 'c6', name: 'Bu Lestari Wulandari', phone: '089012345678', debt: 215000, days: 14, note: 'Sabun, sampo, odol' }
  ];

  const extraSix = [
    { id: 'c7', name: 'Pak Joko Widodo', phone: '081298765432', debt: 190000, days: 11, note: 'Gas LPG 3kg + beras' },
    { id: 'c8', name: 'Bu Ratna Sari', phone: '081387654321', debt: 420000, days: 35, note: 'Telur 2kg, minyak goreng' },
    { id: 'c9', name: 'Kang Dedi Mulyadi', phone: '085712345678', debt: 85000, days: 5, note: 'Kopi sachet + mie instan' },
    { id: 'c10', name: 'Mbak Fitri Handayani', phone: '087712345678', debt: 310000, days: 18, note: 'Susu anak + popok' },
    { id: 'c11', name: 'Pak Bambang Pamungkas', phone: '081912345678', debt: 640000, days: 40, note: 'Sembako hajatan' },
    { id: 'c12', name: 'Bu Yuni Shara', phone: '082112345678', debt: 95000, days: 2, note: 'Bumbu dapur + kecap' }
  ];

  const selected = count === 12 ? [...prototypeSix, ...extraSix] : prototypeSix;
  const customers = [];
  const debts = [];

  for (const item of selected) {
    customers.push({
      id: item.id,
      name: item.name,
      phoneRaw: item.phone,
      phone62: normalize(item.phone),
      note: item.note,
      createdAt: refDate.toISOString()
    });
    const date = daysAgoIsoDate(item.days, refDate);
    debts.push({
      id: `debt_${item.id}_1`,
      customerId: item.id,
      amountIdr: item.debt,
      note: item.note,
      date,
      dueDate: addDaysIsoDate(date, dueDays)
    });
  }

  // If count === 12, add 8 more debt entries across the first 8 customers so total debts = 20
  if (count === 12) {
    const extraDebts = [
      { customerId: 'c1', amountIdr: 50000, days: 4, note: 'Tambahan galon Aqua' },
      { customerId: 'c2', amountIdr: 45000, days: 2, note: 'Gula pasir 2kg' },
      { customerId: 'c3', amountIdr: 120000, days: 15, note: 'Rokok + kopi' },
      { customerId: 'c4', amountIdr: 30000, days: 1, note: 'Roti + susu' },
      { customerId: 'c5', amountIdr: 100000, days: 12, note: 'Minyak goreng 2L' },
      { customerId: 'c6', amountIdr: 55000, days: 6, note: 'Deterjen + pewangi' },
      { customerId: 'c7', amountIdr: 70000, days: 3, note: 'Telur ayam 1kg' },
      { customerId: 'c8', amountIdr: 80000, days: 9, note: 'Beras 3kg' }
    ];
    extraDebts.forEach((ed, idx) => {
      const date = daysAgoIsoDate(ed.days, refDate);
      debts.push({
        id: `debt_extra_${idx + 1}`,
        customerId: ed.customerId,
        amountIdr: ed.amountIdr,
        note: ed.note,
        date,
        dueDate: addDaysIsoDate(date, dueDays)
      });
    });
  }

  const next = withActiveBook(current, (b) => ({ ...b, customers, debts, payments: [], reminders: b.reminders.filter((r) => r.book !== 'customer') }));
  return saveState({ ...next, settings: { ...next.settings, hasCompletedSetup: true } }, storage);
}

/**
 * Export every book as JSON. `photos` ({ debtId: dataURL }, from lib/photos.js) is embedded under
 * a `photos` key when given so the backup carries the bon pictures too.
 */
export function exportBackupJson(state, { photos = null } = {}) {
  const clean = migrate(state);
  const out = photos && typeof photos === 'object' && Object.keys(photos).length > 0
    ? { ...clean, photos }
    : clean;
  return JSON.stringify(out, null, 2);
}

/**
 * Validate a backup string (v1 flat or v2 books) and split it into { state, photos } without saving.
 */
export function parseBackup(jsonString) {
  if (typeof jsonString !== 'string' || !jsonString.trim()) {
    throw new Error('Backup content must be a non-empty JSON string');
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON in backup file');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Backup root must be a JSON object');
  }
  const looksV1 = Array.isArray(parsed.customers);
  const looksV2 = Array.isArray(parsed.books) && parsed.books.length > 0;
  if (typeof parsed.schemaVersion !== 'number' || (!looksV1 && !looksV2)) {
    throw new Error('Backup missing required Kilat fields (schemaVersion, customers or books)');
  }
  const photos = {};
  if (parsed.photos && typeof parsed.photos === 'object' && !Array.isArray(parsed.photos)) {
    for (const [k, v] of Object.entries(parsed.photos)) {
      if (typeof v === 'string' && v.startsWith('data:image/')) photos[String(k)] = v;
    }
  }
  return { state: migrate(parsed), photos };
}

export function importBackupJson(jsonString, storage = globalThis.localStorage) {
  const { state } = parseBackup(jsonString);
  return saveState(state, storage);
}

/**
 * Export the active book's customer ledger summary as CSV (Pro feature).
 */
export function exportCsv(state) {
  const current = migrate(state);
  if (!current.settings.isPro) {
    const err = new Error('Ekspor CSV memerlukan Kilat Pro');
    err.code = 'PRO_REQUIRED';
    throw err;
  }
  const book = activeBook(current);
  const header = ['Nama', 'Telepon', 'Total Utang (Rp)', 'Total Bayar (Rp)', 'Sisa Utang (Rp)', 'Catatan'];
  const rows = [header.join(',')];
  for (const c of book.customers) {
    const totalDebt = book.debts
      .filter((d) => d.customerId === c.id)
      .reduce((acc, d) => acc + d.amountIdr, 0);
    const totalPaid = book.payments
      .filter((p) => p.customerId === c.id)
      .reduce((acc, p) => acc + p.amountIdr, 0);
    const balance = Math.max(0, totalDebt - totalPaid);
    const cols = [
      `"${String(c.name).replace(/"/g, '""')}"`,
      `"${String(c.phone62 || c.phoneRaw)}"`,
      String(totalDebt),
      String(totalPaid),
      String(balance),
      `"${String(c.note || '').replace(/"/g, '""')}"`
    ];
    rows.push(cols.join(','));
  }
  return rows.join('\n');
}
