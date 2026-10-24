// Pure ES module for Kilat customer balance math, FIFO oldest-unpaid aging,
// risk classification (Tinggi >= 30d, Sedang >= 10d, Rendah < 10d), and list filtering (no DOM).

const MS_PER_DAY = 86_400_000;

/**
 * Classify risk level by days overdue/elapsed since oldest unpaid debt.
 * Thresholds from WarungPay Reminder.html & AG-ROUND-2.md:
 * - >= 30 days: 'Tinggi'
 * - >= 10 days: 'Sedang'
 * - < 10 days: 'Rendah'
 * @param {number} days
 * @returns {'Tinggi'|'Sedang'|'Rendah'}
 */
export function classifyRisk(days) {
  const d = Number(days) || 0;
  if (d >= 30) return 'Tinggi';
  if (d >= 10) return 'Sedang';
  return 'Rendah';
}

function parseUtcDateMs(isoDate) {
  const s = String(isoDate || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return Date.now();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Compute full derived summary for a single customer given state debts & payments.
 * Uses FIFO payment allocation against chronological debts so paying off an older debt
 * advances `oldestUnpaidDate` to the next unpaid debt.
 * @param {object} customer
 * @param {Array<object>} debts
 * @param {Array<object>} payments
 * @param {string|Date} [referenceDate]
 */
export function computeCustomerSummary(customer, debts = [], payments = [], referenceDate = new Date()) {
  const custDebts = debts
    .filter((d) => d && d.customerId === customer.id && Number(d.amountIdr) > 0)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const custPayments = payments
    .filter((p) => p && p.customerId === customer.id && Number(p.amountIdr) > 0)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const totalDebt = custDebts.reduce((acc, d) => acc + Math.round(d.amountIdr), 0);
  const totalPaid = custPayments.reduce((acc, p) => acc + Math.round(p.amountIdr), 0);
  const balance = Math.max(0, totalDebt - totalPaid);

  let remainingPaidPool = totalPaid;
  let oldestUnpaidDate = null;

  if (balance > 0) {
    for (const d of custDebts) {
      const amt = Math.round(d.amountIdr);
      if (remainingPaidPool >= amt) {
        remainingPaidPool -= amt;
      } else {
        oldestUnpaidDate = d.date;
        break;
      }
    }
  }

  let daysOverdue = 0;
  if (balance > 0 && oldestUnpaidDate) {
    const refMs = parseUtcDateMs(
      referenceDate instanceof Date ? referenceDate.toISOString().slice(0, 10) : String(referenceDate)
    );
    const debtMs = parseUtcDateMs(oldestUnpaidDate);
    daysOverdue = Math.max(0, Math.round((refMs - debtMs) / MS_PER_DAY));
  }

  const risk = classifyRisk(daysOverdue);

  // Combined chronological ledger rows (newest first for display, with running info)
  const history = [
    ...custDebts.map((d) => ({
      id: d.id,
      type: 'debt',
      amountIdr: Math.round(d.amountIdr),
      date: d.date,
      dueDate: d.dueDate || null,
      note: d.note || ''
    })),
    ...custPayments.map((p) => ({
      id: p.id,
      type: 'payment',
      amountIdr: Math.round(p.amountIdr),
      date: p.date,
      dueDate: null,
      note: p.note || ''
    }))
  ].sort((a, b) => {
    const cmp = String(b.date).localeCompare(String(a.date));
    if (cmp !== 0) return cmp;
    return a.type === 'payment' ? -1 : 1;
  });

  return {
    ...customer,
    totalDebt,
    totalPaid,
    balance,
    debt: balance, // alias used in prototype
    oldestUnpaidDate,
    daysOverdue,
    days: daysOverdue, // alias used in prototype
    risk,
    isPaid: balance === 0,
    history
  };
}

/**
 * Compute derived summaries for all customers and aggregate warung totals.
 * @param {object} state
 * @param {string|Date} [referenceDate]
 */
export function computeWarungLedger(state, referenceDate = new Date()) {
  const customers = Array.isArray(state?.customers) ? state.customers : [];
  const debts = Array.isArray(state?.debts) ? state.debts : [];
  const payments = Array.isArray(state?.payments) ? state.payments : [];

  const summaries = customers.map((c) =>
    computeCustomerSummary(c, debts, payments, referenceDate)
  );

  const activeSummaries = summaries.filter((c) => c.balance > 0);
  const totalPiutang = activeSummaries.reduce((acc, c) => acc + c.balance, 0);
  const highRiskCount = activeSummaries.filter((c) => c.risk === 'Tinggi').length;
  const mediumRiskCount = activeSummaries.filter((c) => c.risk === 'Sedang').length;
  const lowRiskCount = activeSummaries.filter((c) => c.risk === 'Rendah').length;
  const needFollowupCount = highRiskCount + mediumRiskCount;

  // Top debtors sorted by balance descending
  const topDebtors = activeSummaries
    .slice()
    .sort((a, b) => b.balance - a.balance || b.daysOverdue - a.daysOverdue);

  return {
    customers: summaries,
    activeCustomers: activeSummaries,
    totalPiutang,
    highRiskCount,
    mediumRiskCount,
    lowRiskCount,
    needFollowupCount,
    topDebtors
  };
}

/**
 * Filter customer summaries by search query and risk chip ('Semua' | 'Tinggi' | 'Sedang' | 'Rendah').
 * Customers with balance > 0 are sorted by daysOverdue descending, then balance descending,
 * with paid-off customers at the bottom.
 */
export function filterCustomers(customerSummaries, { search = '', riskFilter = 'Semua' } = {}) {
  const q = String(search || '').trim().toLowerCase();
  const rf = String(riskFilter || 'Semua');

  return customerSummaries
    .filter((c) => {
      const matchSearch =
        !q ||
        String(c.name || '').toLowerCase().includes(q) ||
        String(c.note || '').toLowerCase().includes(q) ||
        String(c.phoneRaw || '').toLowerCase().includes(q);
      const matchRisk = rf === 'Semua' || c.risk === rf;
      return matchSearch && matchRisk;
    })
    .slice()
    .sort((a, b) => {
      if ((a.balance > 0) !== (b.balance > 0)) {
        return a.balance > 0 ? -1 : 1;
      }
      if (b.daysOverdue !== a.daysOverdue) {
        return b.daysOverdue - a.daysOverdue;
      }
      return b.balance - a.balance;
    });
}
