// Pure ES module for the Kilat Statistik screen: outstanding by week (last 8 weeks), top 5 debtors,
// collected this month vs last month, reminders sent this month (no DOM).

import { computeWarungLedger, bookView } from './ledger.js';
import { activeBook } from './books.js';

const MS_PER_DAY = 86_400_000;
export const STATS_WEEKS = 8;

function isoOf(d) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localIsoDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Normalise a Date or 'YYYY-MM-DD' to a UTC-midnight Date for arithmetic. */
export function toUtcDay(ref) {
  const iso = ref instanceof Date ? localIsoDate(ref) : String(ref).slice(0, 10);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date(Date.UTC(1970, 0, 1));
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Monday of the week containing `day` (UTC-midnight Date). */
export function weekStartOf(day) {
  const d = new Date(day.getTime());
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}

/** Sum over customers of max(0, debts <= cutoff − payments <= cutoff). */
export function outstandingAsOf(state, cutoffIso) {
  const { debts, payments } = bookView(state, 'customer');
  const byCustomer = new Map();
  for (const d of debts) {
    if (String(d.date) <= cutoffIso) byCustomer.set(d.customerId, (byCustomer.get(d.customerId) || 0) + Math.round(d.amountIdr || 0));
  }
  for (const p of payments) {
    if (String(p.date) <= cutoffIso) byCustomer.set(p.customerId, (byCustomer.get(p.customerId) || 0) - Math.round(p.amountIdr || 0));
  }
  let total = 0;
  for (const v of byCustomer.values()) total += Math.max(0, v);
  return total;
}

function monthKey(iso) {
  return String(iso || '').slice(0, 7);
}

function prevMonthKey(key) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * @param {object} state
 * @param {string|Date} [today]
 */
export function computeStats(state, today = new Date()) {
  const todayDay = toUtcDay(today);
  const todayIso = isoOf(todayDay);
  const thisWeekStart = weekStartOf(todayDay);

  const weekly = [];
  for (let i = STATS_WEEKS - 1; i >= 0; i--) {
    const start = new Date(thisWeekStart.getTime() - i * 7 * MS_PER_DAY);
    const end = new Date(start.getTime() + 6 * MS_PER_DAY);
    const cutoff = i === 0 ? todayIso : isoOf(end); // current week: as of today
    weekly.push({
      weekStart: isoOf(start),
      weekEnd: isoOf(end),
      outstanding: outstandingAsOf(state, cutoff),
      isCurrent: i === 0
    });
  }
  const maxWeekly = weekly.reduce((m, w) => Math.max(m, w.outstanding), 0);
  for (const w of weekly) w.ratio = maxWeekly > 0 ? w.outstanding / maxWeekly : 0;

  const ledger = computeWarungLedger(state, todayIso);
  const topDebtors = ledger.topDebtors.slice(0, 5).map((c, idx) => ({
    rank: idx + 1,
    id: c.id,
    name: c.name,
    balance: c.balance,
    daysOverdue: c.daysOverdue,
    risk: c.risk
  }));

  const thisMonth = monthKey(todayIso);
  const lastMonth = prevMonthKey(thisMonth);
  const payments = bookView(state, 'customer').payments;
  const collectedThisMonth = payments.filter((p) => monthKey(p.date) === thisMonth).reduce((a, p) => a + Math.round(p.amountIdr || 0), 0);
  const collectedLastMonth = payments.filter((p) => monthKey(p.date) === lastMonth).reduce((a, p) => a + Math.round(p.amountIdr || 0), 0);
  const collectedDeltaPct = collectedLastMonth > 0
    ? Math.round(((collectedThisMonth - collectedLastMonth) / collectedLastMonth) * 100)
    : null;

  const book = activeBook(state) || {};
  const reminders = Array.isArray(book.reminders) ? book.reminders : [];
  const remindersThisMonth = reminders.filter((r) => monthKey(r.sentAt) === thisMonth && (r.book || 'customer') === 'customer').length;

  return {
    todayIso,
    thisMonth,
    lastMonth,
    weekly,
    maxWeekly,
    topDebtors,
    totalOutstanding: ledger.totalPiutang,
    activeCount: ledger.activeCustomers.length,
    collectedThisMonth,
    collectedLastMonth,
    collectedDeltaPct,
    remindersThisMonth
  };
}
