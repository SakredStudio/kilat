// Pure ES module for Kilat localStorage persistence ('kilat.v1'), schema migration,
// 25-customer free tier limit, 5-second undo snapshots, demo seeding, and JSON/CSV export (no DOM).

import { normalize } from './phone.js';
import { parseIdr } from './format.js';
import { DEFAULT_LANG, normalizeLang } from './i18n.js';

export const STORAGE_KEY = 'kilat.v1';
export const CURRENT_SCHEMA_VERSION = 1;
export const FREE_CUSTOMER_LIMIT = 25;
export const VALID_TONES = ['sopan', 'singkat', 'tegas'];

let lastUndoSnapshot = null;

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function todayIsoDate(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return d.toISOString().slice(0, 10);
}

function daysAgoIsoDate(daysAgo, refDate = new Date()) {
  const base = refDate instanceof Date ? new Date(refDate.getTime()) : new Date(refDate);
  base.setUTCDate(base.getUTCDate() - Math.max(0, Math.round(Number(daysAgo) || 0)));
  return base.toISOString().slice(0, 10);
}

function addDaysIsoDate(isoDate, daysToAdd) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  d.setUTCDate(d.getUTCDate() + Math.round(Number(daysToAdd) || 0));
  return d.toISOString().slice(0, 10);
}

export function createInitialState() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    warung: {
      name: 'Warung Bu Siti',
      ownerName: 'Bu Siti',
      phone: '08111222333',
      currency: 'IDR',
      dueDays: 14
    },
    customers: [],
    debts: [],
    payments: [],
    settings: {
      tone: 'sopan',
      isPro: false,
      lang: DEFAULT_LANG,
      darkMode: false,
      hasCompletedSetup: false
    }
  };
}

function normalizeCustomer(c) {
  if (!c || typeof c !== 'object') {
    throw new Error('Invalid customer object');
  }
  const phoneRaw = String(c.phoneRaw ?? c.phone ?? '').trim();
  const phone62 = String(c.phone62 || normalize(phoneRaw));
  return {
    id: String(c.id || makeId('cust')),
    name: String(c.name || '').trim(),
    phoneRaw,
    phone62,
    note: String(c.note || '').trim(),
    createdAt: String(c.createdAt || new Date().toISOString())
  };
}

function normalizeDebt(d) {
  if (!d || typeof d !== 'object') {
    throw new Error('Invalid debt object');
  }
  const amountIdr = typeof d.amountIdr === 'number' ? Math.round(d.amountIdr) : parseIdr(d.amountIdr || 0);
  const date = String(d.date || todayIsoDate()).slice(0, 10);
  const entry = {
    id: String(d.id || makeId('debt')),
    customerId: String(d.customerId || ''),
    amountIdr: Math.max(0, amountIdr),
    note: String(d.note || '').trim(),
    date
  };
  if (d.dueDate) {
    entry.dueDate = String(d.dueDate).slice(0, 10);
  }
  return entry;
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

/**
 * Migrate any older or partial state structure to schemaVersion: 1.
 */
export function migrate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid state data: must be an object');
  }
  const base = createInitialState();
  const warungIn = data.warung && typeof data.warung === 'object' ? data.warung : {};
  const settingsIn = data.settings && typeof data.settings === 'object' ? data.settings : {};

  const dueDaysNum = Number(warungIn.dueDays ?? base.warung.dueDays);
  const dueDays = Number.isFinite(dueDaysNum) && dueDaysNum > 0 ? Math.round(dueDaysNum) : 14;

  const customers = Array.isArray(data.customers)
    ? data.customers.map(normalizeCustomer)
    : [];
  const debts = Array.isArray(data.debts)
    ? data.debts.map(normalizeDebt)
    : [];
  const payments = Array.isArray(data.payments)
    ? data.payments.map(normalizePayment)
    : [];

  const tone = VALID_TONES.includes(settingsIn.tone) ? settingsIn.tone : base.settings.tone;

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    warung: {
      name: String(warungIn.name ?? base.warung.name).trim() || base.warung.name,
      ownerName: String(warungIn.ownerName ?? base.warung.ownerName).trim(),
      phone: String(warungIn.phone ?? base.warung.phone).trim(),
      currency: 'IDR',
      dueDays
    },
    customers,
    debts,
    payments,
    settings: {
      tone,
      isPro: Boolean(settingsIn.isPro),
      lang: normalizeLang(settingsIn.lang || base.settings.lang),
      darkMode: Boolean(settingsIn.darkMode),
      hasCompletedSetup: Boolean(settingsIn.hasCompletedSetup)
    }
  };
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

export function updateWarung(state, patch, storage = globalThis.localStorage) {
  const current = migrate(state);
  const next = migrate({
    ...current,
    warung: {
      ...current.warung,
      ...(patch || {})
    },
    settings: {
      ...current.settings,
      hasCompletedSetup: patch?.hasCompletedSetup !== undefined
        ? Boolean(patch.hasCompletedSetup)
        : current.settings.hasCompletedSetup
    }
  });
  return saveState(next, storage);
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

export function canAddCustomer(state) {
  const current = migrate(state);
  if (current.settings.isPro) return true;
  return current.customers.length < FREE_CUSTOMER_LIMIT;
}

/**
 * Add a customer (enforcing the 25-customer free tier limit unless settings.isPro is true).
 * Optional `initialDebtIdr` and `daysAgo` create an initial debt entry simultaneously.
 */
export function addCustomer(state, input, storage = globalThis.localStorage) {
  const current = migrate(state);
  if (!canAddCustomer(current)) {
    const err = new Error(`Free tier limit of ${FREE_CUSTOMER_LIMIT} customers reached. Upgrade to Kilat Pro.`);
    err.code = 'PRO_LIMIT_REACHED';
    throw err;
  }
  const name = String(input?.name ?? '').trim();
  if (!name) {
    throw new Error('Nama pelanggan wajib diisi');
  }
  const phoneRaw = String(input?.phoneRaw ?? input?.phone ?? '').trim();
  const phone62 = normalize(phoneRaw);
  const customerId = String(input?.id || makeId('cust'));
  const customer = {
    id: customerId,
    name,
    phoneRaw,
    phone62,
    note: String(input?.note ?? '').trim(),
    createdAt: String(input?.createdAt || new Date().toISOString())
  };

  const nextDebts = [...current.debts];
  if (input?.initialDebtIdr !== undefined && input?.initialDebtIdr !== '' && Number(input?.initialDebtIdr) > 0) {
    const amountIdr = typeof input.initialDebtIdr === 'number'
      ? Math.round(input.initialDebtIdr)
      : parseIdr(input.initialDebtIdr);
    if (amountIdr > 0) {
      const daysAgo = Number(input.daysAgo ?? 0) || 0;
      const date = input.date
        ? String(input.date).slice(0, 10)
        : daysAgoIsoDate(daysAgo);
      const dueDate = addDaysIsoDate(date, current.warung.dueDays);
      nextDebts.push({
        id: makeId('debt'),
        customerId,
        amountIdr,
        note: customer.note || 'Utang awal',
        date,
        dueDate
      });
    }
  }

  const next = migrate({
    ...current,
    customers: [...current.customers, customer],
    debts: nextDebts
  });
  return saveState(next, storage);
}

export function updateCustomer(state, customerId, patch, storage = globalThis.localStorage) {
  const current = migrate(state);
  const idx = current.customers.findIndex((c) => c.id === customerId);
  if (idx === -1) {
    throw new Error(`Customer not found: ${customerId}`);
  }
  const existing = current.customers[idx];
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
  const nextCustomers = [...current.customers];
  nextCustomers[idx] = updated;
  return saveState({ ...current, customers: nextCustomers }, storage);
}

export function deleteCustomer(state, customerId, storage = globalThis.localStorage) {
  const current = migrate(state);
  const target = current.customers.find((c) => c.id === customerId);
  if (!target) {
    return current;
  }
  lastUndoSnapshot = {
    previousState: deepClone(current),
    meta: {
      type: 'customer',
      customerId,
      customerName: target.name,
      timestamp: Date.now()
    }
  };
  const next = migrate({
    ...current,
    customers: current.customers.filter((c) => c.id !== customerId),
    debts: current.debts.filter((d) => d.customerId !== customerId),
    payments: current.payments.filter((p) => p.customerId !== customerId)
  });
  return saveState(next, storage);
}

/**
 * Add a debt entry for a customer and store a 5-second undo snapshot.
 */
export function addDebt(state, input, storage = globalThis.localStorage) {
  const current = migrate(state);
  const customerId = String(input?.customerId || '');
  const customer = current.customers.find((c) => c.id === customerId);
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
  const dueDate = input?.dueDate
    ? String(input.dueDate).slice(0, 10)
    : addDaysIsoDate(date, current.warung.dueDays);
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
      entryId: debt.id,
      customerId,
      amountIdr: debt.amountIdr,
      timestamp: Date.now()
    }
  };

  // Update customer's summary note if note was provided and customer note was empty
  const nextCustomers = current.customers.map((c) => {
    if (c.id === customerId && debt.note && !c.note) {
      return { ...c, note: debt.note };
    }
    return c;
  });

  const next = migrate({
    ...current,
    customers: nextCustomers,
    debts: [...current.debts, debt]
  });
  return saveState(next, storage);
}

/**
 * Record a payment entry for a customer and store a 5-second undo snapshot.
 */
export function addPayment(state, input, storage = globalThis.localStorage) {
  const current = migrate(state);
  const customerId = String(input?.customerId || '');
  const customer = current.customers.find((c) => c.id === customerId);
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
      entryId: payment.id,
      customerId,
      amountIdr: payment.amountIdr,
      timestamp: Date.now()
    }
  };

  const next = migrate({
    ...current,
    payments: [...current.payments, payment]
  });
  return saveState(next, storage);
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
 * Seed sample warung customers and debts.
 * - count = 6: matches the 6 customers in WarungPay Reminder.html prototype
 * - count = 12: seeds 12 customers and 20 debts across all risk levels
 */
export function seedDemoData(state, storage = globalThis.localStorage, options = {}) {
  const current = migrate(state);
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
      dueDate: addDaysIsoDate(date, current.warung.dueDays)
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
        dueDate: addDaysIsoDate(date, current.warung.dueDays)
      });
    });
  }

  const next = migrate({
    ...current,
    customers,
    debts,
    payments: [],
    settings: {
      ...current.settings,
      hasCompletedSetup: true
    }
  });
  return saveState(next, storage);
}

export function exportBackupJson(state) {
  const clean = migrate(state);
  return JSON.stringify(clean, null, 2);
}

export function importBackupJson(jsonString, storage = globalThis.localStorage) {
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
  if (typeof parsed.schemaVersion !== 'number' || !Array.isArray(parsed.customers)) {
    throw new Error('Backup missing required Kilat fields (schemaVersion, customers)');
  }
  const migrated = migrate(parsed);
  return saveState(migrated, storage);
}

/**
 * Export ledger summary as CSV (Pro feature).
 */
export function exportCsv(state) {
  const current = migrate(state);
  if (!current.settings.isPro) {
    const err = new Error('Ekspor CSV memerlukan Kilat Pro');
    err.code = 'PRO_REQUIRED';
    throw err;
  }
  const header = ['Nama', 'Telepon', 'Total Utang (Rp)', 'Total Bayar (Rp)', 'Sisa Utang (Rp)', 'Catatan'];
  const rows = [header.join(',')];
  for (const c of current.customers) {
    const totalDebt = current.debts
      .filter((d) => d.customerId === c.id)
      .reduce((acc, d) => acc + d.amountIdr, 0);
    const totalPaid = current.payments
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
