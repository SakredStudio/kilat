// Pure ES module for Kilat broadcast reminders: which customers are overdue, in which order to
// walk them (highest risk first), and the per-customer "last reminded" lookup (no DOM).

const RISK_RANK = { Tinggi: 3, Sedang: 2, Rendah: 1 };

/**
 * A customer belongs in the broadcast queue when they still owe something and are either
 * past the aging thresholds (Sedang / Tinggi) or past/at their jatuh tempo.
 */
export function isOverdueForBroadcast(c) {
  if (!c || !(c.balance > 0)) return false;
  if (c.risk === 'Tinggi' || c.risk === 'Sedang') return true;
  return c.dueStatus === 'overdue' || c.dueStatus === 'today';
}

/**
 * Latest reminder per customer: { [customerId]: { sentAt, tone } }.
 * @param {Array<{customerId:string, sentAt:string, tone:string}>} reminders
 */
export function latestReminderByCustomer(reminders = []) {
  const out = {};
  for (const r of reminders || []) {
    if (!r || !r.customerId || !r.sentAt) continue;
    const prev = out[r.customerId];
    if (!prev || String(r.sentAt) > String(prev.sentAt)) {
      out[r.customerId] = { sentAt: String(r.sentAt), tone: String(r.tone || 'sopan') };
    }
  }
  return out;
}

/**
 * Build the ordered broadcast queue from customer summaries (computeWarungLedger().customers):
 * highest risk first, then most days overdue, then largest balance. Each item carries
 * `lastRemindedAt` (ISO string or null).
 */
export function buildBroadcastQueue(customerSummaries = [], reminders = []) {
  const latest = latestReminderByCustomer(reminders);
  return (customerSummaries || [])
    .filter(isOverdueForBroadcast)
    .slice()
    .sort((a, b) => {
      const rr = (RISK_RANK[b.risk] || 0) - (RISK_RANK[a.risk] || 0);
      if (rr !== 0) return rr;
      if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
      return b.balance - a.balance;
    })
    .map((c) => ({ ...c, lastRemindedAt: latest[c.id] ? latest[c.id].sentAt : null }));
}

/**
 * Progress summary for the queue screen.
 * @param {Array} queue
 * @param {number} index 0-based current position
 * @param {Set<string>|Array<string>} sentIds
 */
export function queueProgress(queue, index, sentIds = new Set()) {
  const total = queue.length;
  const sent = sentIds instanceof Set ? sentIds : new Set(sentIds);
  const current = Math.min(Math.max(0, Number(index) || 0), total);
  const sentCount = queue.filter((c) => sent.has(c.id)).length;
  return {
    total,
    position: Math.min(current + 1, total),
    done: current >= total,
    sentCount,
    skippedCount: Math.max(0, Math.min(current, total) - sentCount)
  };
}
