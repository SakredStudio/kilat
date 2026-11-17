// Bonrapi 1.3: the two gentle cards on the customer list, and nothing else that nags.
//   backup: the ledger lives only on this phone; after real use, remind the owner to save a
//           backup file once a week (never when an encrypted cloud vault is set up).
//   rate:   inside the Play-installed app only, after the owner has recorded payments for a week,
//           ask once for a Google Play rating. No reward is ever offered for it (Play policy).
// Pure functions; `now` is injectable for tests.

import { listBooks } from './books.js';

export const BACKUP_MIN_RECORDS = 10;
export const BACKUP_EVERY_DAYS = 7;
export const RATE_MIN_PAYMENTS = 3;
export const RATE_MIN_DAYS = 7;
export const RATE_SNOOZE_DAYS = 30;

const DAY_MS = 24 * 3600 * 1000;

/** Whole days from an ISO date/datetime to `now` (negative in the future, null when unparseable). */
export function daysSince(iso, now = new Date()) {
  const t = Date.parse(String(iso || ''));
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / DAY_MS);
}

/** Counts across every warung book: all entries, customer payments, and the oldest entry date. */
export function usageStats(state) {
  let records = 0;
  let payments = 0;
  let firstDate = null;
  const consider = (d) => {
    const s = String(d || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && (!firstDate || s < firstDate)) firstDate = s;
  };
  for (const book of listBooks(state)) {
    for (const key of ['debts', 'payments', 'supplierDebts', 'supplierPayments']) {
      const list = Array.isArray(book?.[key]) ? book[key] : [];
      records += list.length;
      if (key === 'payments') payments += list.length;
      list.forEach((r) => consider(r && r.date));
    }
  }
  return { records, payments, firstDate };
}

export function backupNudgeDue(state, now = new Date()) {
  const s = state?.settings || {};
  if (s.cloud && s.cloud.vaultId) return false;
  const { records, firstDate } = usageStats(state);
  if (records < BACKUP_MIN_RECORDS) return false;
  const since = daysSince(s.lastExportAt || firstDate, now);
  if (since === null || since < BACKUP_EVERY_DAYS) return false;
  const snoozed = daysSince(s.nudges && s.nudges.backupSnoozedAt, now);
  return snoozed === null || snoozed >= BACKUP_EVERY_DAYS;
}

export function rateNudgeDue(state, now = new Date(), { inPlayApp = false } = {}) {
  if (!inPlayApp) return false;
  const n = state?.settings?.nudges || {};
  if (n.rate === 'done') return false;
  const snoozed = daysSince(n.rateSnoozedAt, now);
  if (snoozed !== null && snoozed < RATE_SNOOZE_DAYS) return false;
  const { payments, firstDate } = usageStats(state);
  if (payments < RATE_MIN_PAYMENTS) return false;
  const used = daysSince(firstDate, now);
  return used !== null && used >= RATE_MIN_DAYS;
}

/** At most one card at a time: the backup reminder wins. */
export function activeNudge(state, now = new Date(), opts = {}) {
  if (backupNudgeDue(state, now)) return 'backup';
  if (rateNudgeDue(state, now, opts)) return 'rate';
  return null;
}
