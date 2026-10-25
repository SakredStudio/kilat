// Kilat — Main Application Controller (P0–P5)
import { registerTranslations, t } from './lib/i18n.js';
import { isPlayBillingAvailable, getProPrice, hasProPurchase, buyPro, PRO_PRICE_FALLBACK } from './lib/billing.js';
import { rp, avatarInitials, formatDateId } from './lib/format.js';
import { formatLocalPhone as fmtPhone } from './lib/phone.js';
import {
  loadState,
  saveState,
  createInitialState,
  updateWarung,
  updateSettings,
  canAddCustomer,
  addCustomer,
  addDebt,
  addPayment,
  undoLastAction,
  getUndoMeta,
  clearUndo,
  deleteCustomer,
  mergeCustomers,
  findCustomerByPhone,
  seedDemoData,
  exportBackupJson,
  parseBackup,
  exportCsv,
  addDaysIsoDate,
  logReminder,
  addSupplier,
  addSupplierDebt,
  addSupplierPayment,
  deleteSupplier,
  setSupplierPayPlan,
  activeBook,
  canAddBook,
  addBook,
  switchBook,
  deleteBook,
  onStateSaved
} from './lib/store.js';
import {
  isCloudConfigured,
  newVaultId,
  normalizeVaultId,
  isValidVaultId,
  validatePassphrase,
  encryptBackup,
  decryptBackup,
  uploadVault,
  downloadVault,
  deleteVault,
  createDebouncer
} from './lib/cloud.js';
import { bookLimit } from './lib/books.js';
import { computeWarungLedger, filterCustomers } from './lib/ledger.js';
import { buildBroadcastQueue, queueProgress, latestReminderByCustomer } from './lib/broadcast.js';
import { buildReminderMessage, buildSupplierMessage, ensureShareLine, link as buildWaLink } from './lib/wa.js';
import {
  buildShareCardModel,
  drawShareCardToCanvas,
  shareOrDownloadCard
} from './lib/share-card.js';
import { buildReceiptModel, drawReceiptToCanvas, shareOrDownloadReceipt } from './lib/receipt-card.js';
import { resizeImageFile, putPhoto, deletePhoto, getAllPhotos, clearPhotos, importPhotos, PHOTO_MAX_PX, QRIS_MAX_PX } from './lib/photos.js';
import { qrisKey, withQrisLine, buildQrisSharePayload, shareReminderWithQris } from './lib/qris.js';
import { computeStats } from './lib/stats.js';

let appState = null;
let undoTimer = null;
function localIsoDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let uiState = {
  screen: 'setup', // 'setup' | 'list' | 'detail' | 'reminder' | 'card' | 'settings'
  selectedCustomerId: null,
  searchQuery: '',
  riskFilter: 'Semua',
  activeSheet: null, // 'addCustomer' | 'addDebt' | 'recordPay' | 'proGate' | null
  toastMessage: null,
  reminderTone: 'sopan',
  customMessage: '',
  messageEdited: false,
  sentFeedback: false,
  billingAvailable: false,
  billingBusy: false,
  billingNotice: '',
  proPrice: PRO_PRICE_FALLBACK,
  broadcast: { index: 0, sentIds: [], tone: 'sopan' },
  lastPaymentId: null, // payment just recorded -> "Kirim bukti" banner on detail
  receiptPaymentId: null, // payment shown on the receipt screen
  photos: {}, // debtId -> dataURL, mirrored from IndexedDB (lib/photos.js)
  pendingPhotoDataUrl: null, // picked in the add-debt sheet, saved with the new debt
  photoViewerDebtId: null,
  book: 'customer', // 'customer' (piutang) | 'supplier' (hutang)
  attachQris: false // reminder screen: "+ lampirkan QRIS" toggle
};

// ---- Pro+ encrypted cloud backup (client side; passphrase lives only in memory for this session)
let cloudPassphrase = null;

function cloudErrorText(lang, err) {
  const code = err && err.code;
  if (code === 'WRONG_PASSPHRASE') return t(lang, 'cloud_err_wrong_pass');
  if (code === 'NOT_FOUND') return t(lang, 'cloud_err_not_found');
  if (code === 'TOO_LARGE') return t(lang, 'cloud_err_too_large');
  if (code === 'NOT_CONFIGURED') return t(lang, 'settings_cloud_unavailable');
  return t(lang, 'cloud_err_network');
}

function askPassphrase(lang) {
  if (cloudPassphrase) return cloudPassphrase;
  const p = window.prompt(t(lang, 'cloud_prompt_passphrase')) || '';
  if (!validatePassphrase(p).ok) return null;
  cloudPassphrase = p;
  return p;
}

/** Encrypt the full backup (all books, no photos) and PUT it to the vault. */
async function runCloudBackup(lang, { silent = false } = {}) {
  const cloud = appState.settings.cloud;
  if (!isCloudConfigured() || !appState.settings.isPro || !cloud.vaultId) return false;
  const passphrase = silent ? cloudPassphrase : askPassphrase(lang);
  if (!passphrase) return false;
  uiState.cloudBusy = true;
  uiState.cloudError = '';
  if (!silent) renderApp();
  try {
    const payload = await encryptBackup(exportBackupJson(appState), passphrase);
    await uploadVault(cloud.vaultId, payload);
    appState = updateSettings(appState, { cloud: { ...cloud, lastBackupAt: payload.updatedAt } });
    uiState.cloudNotice = t(lang, 'cloud_backup_done');
    return true;
  } catch (err) {
    console.error('Cloud backup failed:', err);
    uiState.cloudError = cloudErrorText(lang, err);
    return false;
  } finally {
    uiState.cloudBusy = false;
    if (!silent || uiState.screen === 'settings') renderApp();
  }
}

// Auto-backup: any saved change schedules one upload 30 s later (only when the toggle is on and
// the passphrase was entered this session). Deliberately never prompts on its own.
const scheduleAutoBackup = createDebouncer(() => {
  if (!appState || !appState.settings.cloud.autoBackup || !cloudPassphrase) return;
  runCloudBackup(appState.settings.lang, { silent: true });
}, 30_000);

/** The active warung's QRIS image (dataURL) or null. Lives in IndexedDB, mirrored in uiState.photos. */
function qrisDataUrl() {
  return uiState.photos[qrisKey(appState.activeBookId)] || null;
}

// Two books, one engine: the active book decides which store functions and arrays the screens use.
const BOOK_FNS = {
  customer: { addParty: addCustomer, addDebt, addPayment, deleteParty: deleteCustomer },
  supplier: { addParty: addSupplier, addDebt: addSupplierDebt, addPayment: addSupplierPayment, deleteParty: deleteSupplier }
};
/** The active warung book (multi-warung, v3): every screen reads ledgers through this. */
function wb() {
  return activeBook(appState);
}
function isSupplierBook() {
  return uiState.book === 'supplier';
}
function bookFns() {
  return BOOK_FNS[uiState.book] || BOOK_FNS.customer;
}
function parties() {
  return isSupplierBook() ? wb().suppliers : wb().customers;
}
function bookDebts() {
  return isSupplierBook() ? wb().supplierDebts : wb().debts;
}
function bookPayments() {
  return isSupplierBook() ? wb().supplierPayments : wb().payments;
}
function bookReminders() {
  return wb().reminders.filter((r) => r.book === uiState.book);
}
function ledgerFor(book = uiState.book) {
  return computeWarungLedger(appState, new Date(), { book });
}
/** i18n key with a supplier variant when the active book is hutang (falls back to the base key). */
function bk(lang, key) {
  if (isSupplierBook()) {
    try {
      return t(lang, `${key}_supplier`);
    } catch {
      /* no supplier variant: use the base key */
    }
  }
  return t(lang, key);
}

async function removePhotosForDebts(debtIds) {
  for (const id of debtIds) {
    if (!uiState.photos[id]) continue;
    delete uiState.photos[id];
    try { await deletePhoto(id); } catch { /* ignore */ }
  }
}

function formatDateTimeShort(iso) {
  const s = String(iso || '');
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return formatDateId(s);
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDateId(localIsoDate(d))} ${hh}:${mm}`;
}

function riskLabel(lang, risk) {
  const key = risk === 'Tinggi' ? 'risk_high' : risk === 'Sedang' ? 'risk_medium' : 'risk_low';
  return t(lang, key);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatWaBoldHtml(str) {
  const escaped = escapeHtml(str);
  return escaped.replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
}

function showUndoToast(message) {
  if (undoTimer) clearTimeout(undoTimer);
  uiState.toastMessage = message;
  undoTimer = setTimeout(() => {
    uiState.toastMessage = null;
    clearUndo();
    if (uiState.pendingPhotoPurge && uiState.pendingPhotoPurge.length) {
      removePhotosForDebts(uiState.pendingPhotoPurge);
      uiState.pendingPhotoPurge = null;
    }
    renderApp();
  }, 5000);
}

function triggerFileDownload(content, filename, mimeType = 'application/json') {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function loadDictionaries() {
  const [idRes, enRes] = await Promise.all([
    fetch('./i18n/id.json'),
    fetch('./i18n/en.json')
  ]);
  const [idDict, enDict] = await Promise.all([idRes.json(), enRes.json()]);
  registerTranslations('id', idDict);
  registerTranslations('en', enDict);
}

function applyTheme() {
  if (!appState) return;
  if (appState.settings.darkMode) {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function renderSetupScreen(lang) {
  const w = wb().warung;
  const previewName = escapeHtml(w.name || 'Warung Anda');
  return `
    <div class="screen-body" data-screen="setup">
      <header class="hero-header">
        <div class="step-badge">${escapeHtml(t(lang, 'setup_step_badge'))}</div>
        <h1 class="hero-title">${escapeHtml(t(lang, 'setup_title'))}</h1>
        <p class="hero-subtitle">${escapeHtml(t(lang, 'setup_subtitle'))}</p>
      </header>
      <form id="setup-form" style="padding:18px 16px; display:flex; flex-direction:column; gap:14px; flex:1;">
        <div class="field-group">
          <label class="field-label" for="setup-warung-name">${escapeHtml(t(lang, 'setup_warung_name_label'))}</label>
          <input id="setup-warung-name" name="name" class="field-input" type="text" required
            placeholder="${escapeHtml(t(lang, 'setup_warung_name_placeholder'))}"
            value="${escapeHtml(w.name)}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="setup-owner-name">${escapeHtml(t(lang, 'setup_owner_name_label'))}</label>
          <input id="setup-owner-name" name="ownerName" class="field-input" type="text"
            placeholder="${escapeHtml(t(lang, 'setup_owner_name_placeholder'))}"
            value="${escapeHtml(w.ownerName)}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="setup-phone">${escapeHtml(t(lang, 'setup_phone_label'))}</label>
          <input id="setup-phone" name="phone" class="field-input" type="tel"
            placeholder="${escapeHtml(t(lang, 'setup_phone_placeholder'))}"
            value="${escapeHtml(w.phone)}" />
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div class="field-group">
            <label class="field-label" for="setup-currency">${escapeHtml(t(lang, 'setup_currency_label'))}</label>
            <select id="setup-currency" name="currency" class="field-input">
              <option value="IDR" selected>Rp (Rupiah)</option>
            </select>
          </div>
          <div class="field-group">
            <label class="field-label" for="setup-due-days">${escapeHtml(t(lang, 'setup_due_days_label'))}</label>
            <select id="setup-due-days" name="dueDays" class="field-input">
              ${[7, 14, 30]
                .map(
                  (d) =>
                    `<option value="${d}" ${Number(w.dueDays) === d ? 'selected' : ''}>${d} ${escapeHtml(t(lang, 'setup_due_days_suffix'))}</option>`
                )
                .join('')}
            </select>
          </div>
        </div>

        <div style="background:var(--primary-light); border-radius:var(--radius-sm); padding:14px 16px; border:1px solid oklch(80% 0.1 175);">
          <div style="font-size:11px; font-weight:700; color:var(--primary-dark); margin-bottom:6px; letter-spacing:0.4px;">
            ${escapeHtml(t(lang, 'setup_preview_label'))}
          </div>
          <div id="setup-preview-text" style="font-size:13px; color:var(--text2); line-height:1.55;">
            "Assalamualaikum Pak Budi, mengingatkan catatan belanja di <strong style="color:var(--primary-dark);">${previewName}</strong> sebesar <strong>Rp 350.000</strong>. Terima kasih 🙏"
          </div>
        </div>

        <div style="margin-top:auto; padding-top:8px;">
          <button type="submit" class="btn-primary" id="setup-save-btn">
            <span>✓</span>
            <span>${escapeHtml(t(lang, 'setup_save_cta'))}</span>
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderCustomerListScreen(lang, ledger) {
  const w = wb().warung;
  const filtered = filterCustomers(ledger.customers, {
    search: uiState.searchQuery,
    riskFilter: uiState.riskFilter
  });

  const broadcastCount = isSupplierBook() ? 0 : buildBroadcastQueue(ledger.customers, bookReminders()).length;
  const bookSwitch = `
    <div role="tablist" aria-label="${escapeHtml(t(lang, 'book_switch_aria'))}" style="display:grid; grid-template-columns:1fr 1fr; gap:4px; background:rgba(0,0,0,0.18); border-radius:12px; padding:4px; margin-bottom:12px;">
      ${['customer', 'supplier']
        .map((b) => {
          const active = uiState.book === b;
          return `<button type="button" role="tab" aria-selected="${active}" class="book-switch-btn" data-book="${b}"
            style="min-height:44px; border:none; border-radius:9px; font-size:13px; font-weight:700; background:${active ? '#fff' : 'transparent'}; color:${active ? 'var(--primary-dark)' : 'rgba(255,255,255,0.85)'};">
            ${escapeHtml(t(lang, b === 'customer' ? 'book_switch_customers' : 'book_switch_suppliers'))}
          </button>`;
        })
        .join('')}
    </div>`;

  const filterChips = [
    { id: 'Semua', label: t(lang, 'filter_all') },
    { id: 'Tinggi', label: t(lang, 'filter_high') },
    { id: 'Sedang', label: t(lang, 'filter_medium') },
    { id: 'Rendah', label: t(lang, 'filter_low') }
  ];

  return `
    <div class="screen-body" data-screen="list">
      <div style="background:var(--primary); padding:16px 16px 14px; color:#fff;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:12px;">
          <div>
            <button type="button" id="btn-open-book-switcher" aria-label="${escapeHtml(t(lang, 'books_switcher_title'))}"
              style="background:none; border:none; padding:0; min-height:44px; margin:-10px 0 -8px; color:rgba(255,255,255,0.85); font-size:12px; font-weight:600; display:inline-flex; align-items:center; gap:4px; text-align:left;">
              🏪 ${escapeHtml(w.name)} ▾${appState.books.length > 1 ? ` <span style="opacity:0.7;">(${appState.books.length})</span>` : ''}
            </button>
            <h1 style="font-family:var(--font-display); font-size:21px; color:#fff; margin-top:2px;">
              ${escapeHtml(bk(lang, 'list_subtitle'))}
            </h1>
          </div>
          <div style="display:flex; gap:6px;">
            <button type="button" id="btn-open-stats" aria-label="${escapeHtml(t(lang, 'stats_title'))}" title="${escapeHtml(t(lang, 'stats_title'))}"
              style="background:rgba(255,255,255,0.2); border:1px solid rgba(255,255,255,0.35); border-radius:10px; color:#fff; font-size:16px; min-width:44px; min-height:44px; padding:0 10px;">
              📊
            </button>
            <button type="button" id="btn-open-add-customer"
              style="background:rgba(255,255,255,0.2); border:1px solid rgba(255,255,255,0.35); border-radius:10px; color:#fff; font-weight:700; font-size:13px; padding:8px 12px; min-height:44px;">
              ${escapeHtml(t(lang, 'list_add_customer'))}
            </button>
          </div>
        </div>

        ${bookSwitch}

        <div style="background:rgba(0,0,0,0.18); border-radius:12px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div>
            <div style="font-size:11px; color:rgba(255,255,255,0.75);">${escapeHtml(bk(lang, 'list_total_piutang'))}</div>
            <div id="total-piutang-value" style="font-family:var(--font-display); font-size:22px; color:#fff;">
              ${escapeHtml(rp(ledger.totalPiutang, { spaced: true }))}
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:11px; color:rgba(255,255,255,0.75);">${escapeHtml(bk(lang, 'list_need_followup'))}</div>
            <div style="font-size:17px; font-weight:700; color:#FCD34D;">
              ${isSupplierBook() ? ledger.dueCount : ledger.needFollowupCount} ${escapeHtml(bk(lang, 'list_people_suffix'))}
            </div>
          </div>
        </div>
      </div>

      <div style="padding:12px 16px 8px; display:flex; flex-direction:column; gap:8px; background:var(--card); border-bottom:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:8px; background:var(--bg); border-radius:10px; padding:0 12px; border:1.5px solid var(--border);">
          <span aria-hidden="true" style="font-size:15px;">🔍</span>
          <input id="customer-search-input" type="search"
            aria-label="${escapeHtml(t(lang, 'search_aria_label'))}"
            placeholder="${escapeHtml(t(lang, 'list_search_placeholder'))}"
            value="${escapeHtml(uiState.searchQuery)}"
            style="border:none; background:none; outline:none; font-size:14px; color:var(--text); width:100%; min-height:44px;" />
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;" role="tablist">
          ${filterChips
            .map((chip) => {
              const active = uiState.riskFilter === chip.id;
              return `<button type="button" class="risk-filter-chip" data-risk="${chip.id}"
                style="padding:6px 12px; border-radius:99px; font-size:12px; font-weight:600; min-height:44px; border:1.5px solid ${active ? 'var(--primary)' : 'var(--border)'}; background:${active ? 'var(--primary-light)' : 'transparent'}; color:${active ? 'var(--primary-dark)' : 'var(--text2)'};">
                ${escapeHtml(chip.label)}
              </button>`;
            })
            .join('')}
        </div>
      </div>

      ${
        broadcastCount > 0 && !uiState.searchQuery && uiState.riskFilter === 'Semua'
          ? `<div style="padding:12px 16px 0;">
               <button type="button" id="btn-open-broadcast" class="btn-primary btn-wa" style="font-size:14px;">
                 📣 ${escapeHtml(t(lang, 'list_broadcast_btn', { count: broadcastCount }))}
               </button>
             </div>`
          : ''
      }
      ${renderDueTodaySection(lang, ledger)}

      <div style="flex:1; padding:10px 16px 18px; display:flex; flex-direction:column; gap:8px;">
        ${
          filtered.length === 0
            ? `<div style="text-align:center; padding:32px 16px; color:var(--text3);">
                 <p style="font-size:14px; margin-bottom:12px;">${escapeHtml(bk(lang, 'empty_customers'))}</p>
                 ${
                   !isSupplierBook() && wb().customers.length === 0
                     ? `<button type="button" id="btn-seed-demo-empty" class="btn-secondary">${escapeHtml(t(lang, 'empty_customers_cta'))}</button>`
                     : ''
                 }
               </div>`
            : filtered.map((c) => renderCustomerRow(lang, c)).join('')
        }
      </div>
    </div>
  `;
}

function dueLabel(lang, c) {
  if (!c || !c.nextDueDate || c.isPaid) return '';
  if (c.dueStatus === 'today') return t(lang, 'due_today_label');
  if (c.dueStatus === 'overdue') return t(lang, 'due_overdue_label', { hari: Math.abs(c.daysToDue) });
  return t(lang, 'due_upcoming_label', { tanggal: formatDateId(c.nextDueDate) });
}

function renderCustomerRow(lang, c, opts = {}) {
  const avatarStyles = {
    Tinggi: 'background:var(--red-light); color:var(--red);',
    Sedang: 'background:var(--amber-light); color:var(--amber);',
    Rendah: 'background:var(--primary-light); color:var(--primary-dark);'
  };
  const initials = avatarInitials(c.name);
  const avStyle = avatarStyles[c.risk] || avatarStyles.Rendah;
  const badgeClass = c.isPaid ? 'risk-Lunas' : `risk-${c.risk}`;
  const badgeLabel = c.isPaid ? t(lang, 'risk_paid') : riskLabel(lang, c.risk);
  const amountColor =
    c.risk === 'Tinggi' ? 'var(--red)' : c.risk === 'Sedang' ? 'var(--amber)' : 'var(--text)';
  const sub = opts.showDue
    ? `<span style="color:${c.dueStatus === 'overdue' ? 'var(--red)' : 'var(--amber)'}; font-weight:600;">${escapeHtml(dueLabel(lang, c))}</span>`
    : escapeHtml(c.note || c.phoneRaw);
  return `
    <button type="button" class="customer-row-card" data-customer-id="${escapeHtml(c.id)}"
      style="background:var(--card); border:1.5px solid ${opts.showDue ? 'var(--amber)' : 'var(--border)'}; border-radius:var(--radius-sm); padding:12px 14px; display:flex; align-items:center; gap:12px; text-align:left; width:100%; min-height:68px;">
      <div style="width:42px; height:42px; border-radius:50%; ${avStyle} display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; flex-shrink:0;">
        ${escapeHtml(initials)}
      </div>
      <div style="flex:1; min-width:0;">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <span style="font-weight:700; font-size:14px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${escapeHtml(c.name)}
          </span>
          <span class="risk-badge ${badgeClass}">
            <span class="risk-dot"></span>${escapeHtml(badgeLabel)}
          </span>
        </div>
        <div style="font-size:12px; color:var(--text3); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${sub}
        </div>
      </div>
      <div style="text-align:right; flex-shrink:0;">
        <div style="font-weight:700; font-size:14px; color:${amountColor};">
          ${escapeHtml(rp(c.balance, { spaced: true }))}
        </div>
        <div style="font-size:11px; color:var(--text3); margin-top:2px;">
          ${c.isPaid ? escapeHtml(t(lang, 'risk_paid')) : `${c.daysOverdue} ${escapeHtml(t(lang, 'days_overdue_suffix'))}`}
        </div>
      </div>
      <span style="color:var(--text3); font-size:16px;" aria-hidden="true">›</span>
    </button>
  `;
}

function renderDueTodaySection(lang, ledger) {
  const due = [...ledger.dueOverdue, ...ledger.dueToday];
  if (due.length === 0 || uiState.searchQuery || uiState.riskFilter !== 'Semua') return '';
  return `
    <section aria-label="${escapeHtml(t(lang, 'list_due_today_title'))}" style="padding:12px 16px 4px; display:flex; flex-direction:column; gap:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div style="font-size:13px; font-weight:700; color:var(--text2);">📅 ${escapeHtml(t(lang, 'list_due_today_title'))}</div>
        <div style="font-size:12px; color:var(--text3);">${escapeHtml(t(lang, 'list_due_count', { count: due.length }))}</div>
      </div>
      ${due.map((c) => renderCustomerRow(lang, c, { showDue: true })).join('')}
    </section>
  `;
}

function renderCustomerDetailScreen(lang, customer) {
  if (!customer) {
    return renderCustomerListScreen(lang, ledgerFor());
  }
  const badgeClass = customer.isPaid ? 'risk-Lunas' : `risk-${customer.risk}`;
  const badgeLabel = customer.isPaid ? t(lang, 'risk_paid') : riskLabel(lang, customer.risk);
  const amountColor =
    customer.risk === 'Tinggi'
      ? 'var(--red)'
      : customer.risk === 'Sedang'
        ? 'var(--amber)'
        : 'var(--primary-dark)';
  const lastReminded = latestReminderByCustomer(bookReminders())[customer.id] || null;
  const justPaid = uiState.lastPaymentId && !isSupplierBook()
    ? wb().payments.find((p) => p.id === uiState.lastPaymentId && p.customerId === customer.id) || null
    : null;
  const supplierPlan = isSupplierBook() && customer.payPlan ? customer.payPlan : null;

  return `
    <div class="screen-body" data-screen="detail">
      <div class="topbar">
        <button type="button" class="back-btn" id="btn-back-to-list" aria-label="${escapeHtml(t(lang, 'back_aria_label'))}">←</button>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:700; font-size:16px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${escapeHtml(customer.name)}
          </div>
          <div style="font-size:12px; color:var(--text3);">
            ${escapeHtml(fmtPhone(customer.phone62 || customer.phoneRaw))}
          </div>
        </div>
        <span class="risk-badge ${badgeClass}">
          <span class="risk-dot"></span>${escapeHtml(badgeLabel)}
        </span>
      </div>

      <div style="padding:16px; display:flex; flex-direction:column; gap:14px; flex:1;">
        ${
          justPaid
            ? `<div style="background:var(--primary-light); border:1.5px solid var(--primary); border-radius:var(--radius-sm); padding:12px 14px; display:flex; flex-direction:column; gap:8px;">
                 <div style="font-size:13px; font-weight:700; color:var(--primary-dark);">${escapeHtml(t(lang, 'receipt_banner_title'))}</div>
                 <button type="button" class="btn-primary btn-open-receipt" data-payment-id="${escapeHtml(justPaid.id)}" style="font-size:14px;">
                   ${escapeHtml(t(lang, 'receipt_banner_cta', { nama: customer.name.split(' ')[0] || customer.name }))}
                 </button>
               </div>`
            : ''
        }
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius); padding:16px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div>
              <div style="font-size:12px; font-weight:600; color:var(--text2); text-transform:uppercase; letter-spacing:0.3px;">
                ${escapeHtml(bk(lang, 'customer_balance_label'))}
              </div>
              <div id="detail-balance-value" style="font-family:var(--font-display); font-size:28px; color:${amountColor}; margin-top:4px;">
                ${escapeHtml(rp(customer.balance, { spaced: true }))}
              </div>
            </div>
            ${
              !customer.isPaid
                ? `<div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
                     <div style="font-size:12px; font-weight:600; color:var(--text2); background:var(--bg2); padding:5px 10px; border-radius:99px;">
                       ${escapeHtml(t(lang, 'reminder_overdue_days', { hari: customer.daysOverdue }))}
                     </div>
                     ${
                       customer.nextDueDate
                         ? `<div style="font-size:11px; font-weight:600; color:${customer.dueStatus === 'overdue' ? 'var(--red)' : customer.dueStatus === 'today' ? 'var(--amber)' : 'var(--text3)'};">📅 ${escapeHtml(dueLabel(lang, customer))}</div>`
                         : ''
                     }
                   </div>`
                : ''
            }
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:14px; padding-top:12px; border-top:1px solid var(--border);">
            <div>
              <div style="font-size:11px; color:var(--text3);">${escapeHtml(t(lang, 'customer_total_debt_label'))}</div>
              <div style="font-size:14px; font-weight:700; color:var(--text); margin-top:2px;">
                ${escapeHtml(rp(customer.totalDebt, { spaced: true }))}
              </div>
            </div>
            <div>
              <div style="font-size:11px; color:var(--text3);">${escapeHtml(t(lang, 'customer_total_paid_label'))}</div>
              <div style="font-size:14px; font-weight:700; color:var(--primary-dark); margin-top:2px;">
                ${escapeHtml(rp(customer.totalPaid, { spaced: true }))}
              </div>
            </div>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:14px;">
            <button type="button" id="btn-open-add-debt" class="btn-secondary" style="border-color:var(--amber); color:var(--text);">
              ${escapeHtml(bk(lang, 'customer_add_debt_btn'))}
            </button>
            <button type="button" id="btn-open-record-pay" class="btn-primary">
              ${escapeHtml(t(lang, 'customer_record_pay_btn'))}
            </button>
          </div>

          ${
            isSupplierBook()
              ? `<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px;">
                   <button type="button" id="btn-open-pay-plan" class="btn-secondary">${escapeHtml(t(lang, 'supplier_remind_me_btn'))}</button>
                   <button type="button" id="btn-go-reminder" class="btn-primary btn-wa">${escapeHtml(t(lang, 'supplier_notify_btn'))}</button>
                 </div>
                 <div style="margin-top:10px; background:var(--bg); border:1px dashed var(--border); border-radius:var(--radius-sm); padding:10px 12px; font-size:13px; color:var(--text2);">
                   <div style="font-size:11px; font-weight:700; color:var(--text3); text-transform:uppercase; letter-spacing:0.3px;">${escapeHtml(t(lang, 'supplier_plan_title'))}</div>
                   ${
                     supplierPlan
                       ? `<div style="margin-top:4px;">${supplierPlan.date ? `📅 <strong>${escapeHtml(formatDateId(supplierPlan.date))}</strong>` : ''} ${escapeHtml(supplierPlan.note || '')}</div>`
                       : `<div style="margin-top:4px; color:var(--text3);">${escapeHtml(t(lang, 'supplier_plan_none'))}</div>`
                   }
                 </div>`
              : `<div style="margin-top:10px;">
                   <button type="button" id="btn-go-reminder" class="btn-primary btn-wa">
                     ${escapeHtml(t(lang, 'customer_send_wa_btn'))}
                   </button>
                 </div>`
          }
          <div style="font-size:12px; color:var(--text3); margin-top:8px; text-align:center;">
            ${escapeHtml(
              lastReminded
                ? bk(lang, 'detail_last_reminded').replace('{waktu}', formatDateTimeShort(lastReminded.sentAt))
                : bk(lang, 'detail_never_reminded')
            )}
          </div>
        </div>

        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius); padding:14px 16px; flex:1;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); margin-bottom:10px;">
            ${escapeHtml(t(lang, 'customer_ledger_title'))}
          </div>
          ${
            customer.history.length === 0
              ? `<p style="font-size:13px; color:var(--text3); padding:16px 0; text-align:center;">
                   ${escapeHtml(t(lang, 'customer_ledger_empty'))}
                 </p>`
              : `<div style="display:flex; flex-direction:column; gap:8px;">
                   ${customer.history
                     .map((entry) => {
                       const isDebt = entry.type === 'debt';
                       const typeLabel = isDebt ? bk(lang, 'entry_type_debt') : t(lang, 'entry_type_payment');
                       const badgeStyle = isDebt
                         ? 'background:var(--amber-light); color:var(--amber);'
                         : 'background:var(--primary-light); color:var(--primary-dark);';
                       const amtColor = isDebt ? 'var(--red)' : 'var(--primary-dark)';
                       const sign = isDebt ? '+' : '−';
                       return `
                         <div class="ledger-entry-row" style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:var(--bg); border-radius:var(--radius-sm); border:1px solid var(--border);">
                           <div style="min-width:0; flex:1;">
                             <div style="display:flex; align-items:center; gap:6px;">
                               <span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:99px; ${badgeStyle}">
                                 ${escapeHtml(typeLabel)}
                               </span>
                               <span style="font-size:12px; color:var(--text3);">
                                 ${escapeHtml(formatDateId(entry.date))}
                               </span>
                             </div>
                             <div style="font-size:13px; color:var(--text); margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                               ${escapeHtml(entry.note || typeLabel)}
                             </div>
                             ${
                               isDebt && entry.dueDate
                                 ? `<div style="font-size:11px; color:var(--text3); margin-top:2px;">${escapeHtml(t(lang, 'ledger_due_prefix'))} ${escapeHtml(formatDateId(entry.dueDate))}</div>`
                                 : ''
                             }
                           </div>
                           <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0; margin-left:10px;">
                             <div style="font-weight:700; font-size:14px; color:${amtColor};">
                               ${sign} ${escapeHtml(rp(entry.amountIdr, { spaced: true }))}
                             </div>
                             ${
                               isDebt
                                 ? uiState.photos[entry.id]
                                   ? `<button type="button" class="photo-thumb btn-view-photo" data-debt-id="${escapeHtml(entry.id)}" aria-label="${escapeHtml(t(lang, 'photo_thumb_aria'))}">
                                        <img src="${uiState.photos[entry.id]}" alt="" />
                                      </button>`
                                   : `<button type="button" class="btn-attach-photo" data-debt-id="${escapeHtml(entry.id)}"
                                        style="background:var(--bg2); border:1px solid var(--border); border-radius:8px; font-size:11px; font-weight:600; color:var(--text2); padding:0 10px; min-height:44px;">
                                        ${escapeHtml(t(lang, 'photo_attach_btn'))}
                                      </button>`
                                 : ''
                             }
                             ${
                               !isDebt && !isSupplierBook()
                                 ? `<button type="button" class="btn-open-receipt" data-payment-id="${escapeHtml(entry.id)}"
                                      style="background:var(--bg2); border:1px solid var(--border); border-radius:8px; font-size:11px; font-weight:600; color:var(--text2); padding:0 10px; min-height:44px;">
                                      ${escapeHtml(t(lang, 'receipt_row_btn'))}
                                    </button>`
                                 : ''
                             }
                           </div>
                         </div>
                       `;
                     })
                     .join('')}
                 </div>`
          }
        </div>

        <input id="photo-attach-input" type="file" accept="image/*" capture="environment" style="display:none;" data-debt-id="" />

        <div style="display:grid; grid-template-columns:${isSupplierBook() ? '1fr' : '1fr 1fr'}; gap:10px;">
          ${
            isSupplierBook()
              ? ''
              : `<button type="button" id="btn-open-merge" class="btn-secondary" style="font-size:13px;">
                   ${escapeHtml(t(lang, 'customer_merge_btn'))}
                 </button>`
          }
          <button type="button" id="btn-delete-customer" class="btn-secondary" style="font-size:13px; color:var(--red); border-color:var(--red);">
            ${escapeHtml(bk(lang, 'customer_delete_btn'))}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderMergeSheet(lang, customer) {
  const others = wb().customers.filter((c) => c.id !== customer.id);
  return `
    <div class="sheet-backdrop" id="sheet-backdrop">
      <form class="sheet-panel" id="form-merge-customer">
        <h2 style="font-family:var(--font-display); font-size:20px; color:var(--text);">
          ${escapeHtml(t(lang, 'sheet_merge_title'))}
        </h2>
        <p style="font-size:13px; color:var(--text2); line-height:1.5;">
          ${escapeHtml(t(lang, 'sheet_merge_desc', { nama: customer.name }))}
        </p>
        ${
          others.length === 0
            ? `<p style="font-size:13px; color:var(--text3);">${escapeHtml(t(lang, 'sheet_merge_none'))}</p>`
            : `<div class="field-group">
                 <label class="field-label" for="merge-target">${escapeHtml(t(lang, 'sheet_merge_target_label'))}</label>
                 <select id="merge-target" name="targetId" class="field-input" required>
                   ${others
                     .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} · ${escapeHtml(fmtPhone(c.phone62 || c.phoneRaw))}</option>`)
                     .join('')}
                 </select>
               </div>`
        }
        <div style="display:flex; gap:10px; margin-top:6px;">
          <button type="button" id="btn-cancel-sheet" class="btn-secondary" style="flex:1;">
            ${escapeHtml(t(lang, 'sheet_cancel_btn'))}
          </button>
          ${
            others.length === 0
              ? ''
              : `<button type="submit" class="btn-primary" style="flex:1;">${escapeHtml(t(lang, 'sheet_merge_confirm_btn'))}</button>`
          }
        </div>
      </form>
    </div>
  `;
}

function renderReminderScreen(lang, customer) {
  if (!customer) {
    return renderCustomerListScreen(lang, ledgerFor());
  }
  const w = wb().warung;
  const activeTone = uiState.reminderTone || appState.settings.tone || 'sopan';
  const generatedMsg = isSupplierBook()
    ? buildSupplierMessage({
        nama: customer.name,
        jumlah: customer.balance,
        warung: w.name,
        tanggal: (customer.payPlan && customer.payPlan.date) || customer.nextDueDate || ''
      })
    : composeReminder(customer, activeTone);

  const currentMsg = uiState.messageEdited ? ensureShareLine(uiState.customMessage) : generatedMsg;
  const qris = !isSupplierBook() ? qrisDataUrl() : null;
  const qrisOn = Boolean(qris && uiState.attachQris);
  const shownMsg = qrisOn ? withQrisLine(currentMsg) : currentMsg;
  const waHref = buildWaLink(customer.phone62 || customer.phoneRaw, shownMsg);
  const firstName = customer.name.split(' ')[0] || customer.name;

  const pillBg =
    customer.risk === 'Tinggi'
      ? 'var(--red-light)'
      : customer.risk === 'Sedang'
        ? 'var(--amber-light)'
        : 'var(--primary-light)';
  const pillBorder =
    customer.risk === 'Tinggi'
      ? 'var(--red)'
      : customer.risk === 'Sedang'
        ? 'var(--amber)'
        : 'var(--primary)';
  const pillColor =
    customer.risk === 'Tinggi'
      ? 'var(--red)'
      : customer.risk === 'Sedang'
        ? 'var(--amber)'
        : 'var(--primary-dark)';

  return `
    <div class="screen-body" data-screen="reminder">
      <div class="topbar">
        <button type="button" class="back-btn" id="btn-back-to-detail" aria-label="${escapeHtml(t(lang, 'back_aria_label'))}">←</button>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:700; font-size:15px; color:var(--text);">
            ${escapeHtml(bk(lang, 'reminder_title'))}
          </div>
          <div style="font-size:12px; color:var(--text3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${escapeHtml(customer.name)} · ${escapeHtml(rp(customer.balance, { spaced: true }))}
          </div>
        </div>
        <span class="risk-badge risk-${customer.risk}">
          <span class="risk-dot"></span>${escapeHtml(customer.risk)}
        </span>
      </div>

      <div style="padding:16px; display:flex; flex-direction:column; gap:14px; flex:1;">
        <div style="background:${pillBg}; border:1.5px solid ${pillBorder}; border-radius:var(--radius-sm); padding:12px 16px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div>
            <div style="font-size:12px; color:var(--text2);">
              ${escapeHtml(t(lang, 'reminder_overdue_days', { hari: customer.daysOverdue }))}
            </div>
            <div style="font-size:13px; color:var(--text2); margin-top:2px;">
              ${escapeHtml(customer.note || w.name)}
            </div>
          </div>
          <div style="font-family:var(--font-display); font-size:22px; color:${pillColor}; flex-shrink:0;">
            ${escapeHtml(rp(customer.balance, { spaced: true }))}
          </div>
        </div>

        ${
          isSupplierBook()
            ? `<div style="background:var(--bg2); border-radius:var(--radius-sm); padding:10px 12px; font-size:12px; color:var(--text2); line-height:1.5;">
                 ${escapeHtml(t(lang, 'supplier_reminder_note'))}
               </div>`
            : `<div>
                 <div style="font-size:12px; font-weight:600; color:var(--text2); margin-bottom:8px; text-transform:uppercase; letter-spacing:0.3px;">
                   ${escapeHtml(t(lang, 'reminder_tone_label'))}
                 </div>
                 ${renderTonePicker(lang, activeTone)}
               </div>`
        }

        ${renderWaBubble(lang, fmtPhone(customer.phone62 || customer.phoneRaw), shownMsg)}
        ${
          qris
            ? `<div style="display:flex; align-items:center; gap:10px; background:var(--card); border:1.5px solid ${qrisOn ? 'var(--primary)' : 'var(--border)'}; border-radius:var(--radius-sm); padding:8px 10px;">
                 <span class="photo-thumb" aria-hidden="true"><img src="${qris}" alt="" /></span>
                 <div style="flex:1; min-width:0; font-size:12px; color:var(--text3); line-height:1.4;">${escapeHtml(t(lang, 'reminder_qris_note'))}</div>
                 <button type="button" id="btn-toggle-qris" aria-pressed="${qrisOn}" class="btn-secondary" style="width:auto; font-size:12px; white-space:nowrap; ${qrisOn ? 'border-color:var(--primary); color:var(--primary-dark); background:var(--primary-light);' : ''}">
                   ${escapeHtml(qrisOn ? t(lang, 'reminder_attach_qris_on') : t(lang, 'reminder_attach_qris_toggle'))}
                 </button>
               </div>`
            : ''
        }

        <div class="field-group">
          <label class="field-label" for="reminder-custom-textarea">
            ${escapeHtml(t(lang, 'reminder_edit_label'))}
          </label>
          <textarea id="reminder-custom-textarea" class="field-input" rows="4"
            style="resize:vertical; font-size:13px; line-height:1.5;">${escapeHtml(currentMsg)}</textarea>
        </div>

        <div style="display:flex; flex-direction:column; gap:8px; margin-top:auto;">
          ${
            qrisOn
              ? `<button type="button" id="btn-send-wa-qris" data-wa-href="${escapeHtml(waHref)}" class="btn-primary btn-wa">
                   <span>${uiState.sentFeedback ? '✓' : '💬'}</span>
                   <span>${escapeHtml(uiState.sentFeedback ? t(lang, 'reminder_Sent_wa_cta') : t(lang, 'reminder_send_wa_qris_cta', { nama: firstName }))}</span>
                 </button>
                 ${uiState.qrisFallbackHint ? `<div style="font-size:12px; color:var(--text2); background:var(--amber-light); border-radius:var(--radius-sm); padding:8px 10px; line-height:1.5;">${escapeHtml(t(lang, 'reminder_qris_fallback_hint'))}</div>` : ''}`
              : `<a id="btn-send-wa-link" href="${escapeHtml(waHref)}" target="_blank" rel="noopener noreferrer"
                   class="btn-primary btn-wa tap-target">
                   <span>${uiState.sentFeedback ? '✓' : '💬'}</span>
                   <span>${escapeHtml(uiState.sentFeedback ? t(lang, 'reminder_Sent_wa_cta') : t(lang, 'reminder_send_wa_cta', { nama: firstName }))}</span>
                 </a>`
          }
          ${
            isSupplierBook()
              ? ''
              : `<button type="button" id="btn-show-card" class="btn-secondary">
                   ${escapeHtml(t(lang, 'reminder_share_card_btn'))}
                 </button>`
          }
        </div>
      </div>
    </div>
  `;
}

function hasCustomTemplate() {
  return Boolean(appState.settings.isPro && String(appState.settings.customTemplate || '').trim());
}

function toneOptions(lang) {
  const base = [
    { id: 'sopan', label: t(lang, 'tone_sopan_label'), desc: t(lang, 'tone_sopan_desc') },
    { id: 'singkat', label: t(lang, 'tone_singkat_label'), desc: t(lang, 'tone_singkat_desc') },
    { id: 'tegas', label: t(lang, 'tone_tegas_label'), desc: t(lang, 'tone_tegas_desc') }
  ];
  if (hasCustomTemplate()) {
    base.push({ id: 'custom', label: t(lang, 'tone_custom_label'), desc: t(lang, 'tone_custom_desc') });
  }
  return base;
}

/** Build the WhatsApp reminder for a customer summary in a given tone ('custom' = Pro template). */
function composeReminder(customer, tone) {
  const useCustom = tone === 'custom' && hasCustomTemplate();
  return buildReminderMessage({
    tone: useCustom ? 'sopan' : tone,
    nama: customer.name,
    jumlah: customer.balance,
    hari: customer.daysOverdue,
    warung: wb().warung.name,
    tanggal: customer.nextDueDate || '',
    customTemplate: useCustom ? appState.settings.customTemplate : ''
  });
}

function renderTonePicker(lang, activeTone, options = toneOptions(lang)) {
  const cols = options.length === 4 ? 2 : options.length;
  return `
    <div style="display:grid; grid-template-columns:repeat(${cols}, 1fr); gap:8px;">
      ${options
        .map((tn) => {
          const active = activeTone === tn.id;
          return `
            <button type="button" class="tone-picker-btn" data-tone="${tn.id}"
              style="padding:10px 6px; border-radius:var(--radius-sm); border:2px solid ${active ? 'var(--primary)' : 'var(--border)'}; background:${active ? 'var(--primary-light)' : 'var(--card)'}; display:flex; flex-direction:column; align-items:center; gap:3px; min-height:56px;">
              <span style="font-size:13px; font-weight:700; color:${active ? 'var(--primary-dark)' : 'var(--text)'};">${escapeHtml(tn.label)}</span>
              <span style="font-size:11px; color:var(--text3);">${escapeHtml(tn.desc)}</span>
            </button>`;
        })
        .join('')}
    </div>`;
}

function renderWaBubble(lang, phoneLabel, message) {
  return `
    <div style="background:#E5DDD5; border-radius:var(--radius-sm); overflow:hidden; border:1px solid var(--border);">
      <div style="background:#075E54; padding:10px 14px; display:flex; align-items:center; gap:10px;">
        <div style="width:32px; height:32px; border-radius:50%; background:#25D366; display:flex; align-items:center; justify-content:center; font-size:15px;">💬</div>
        <div>
          <div style="font-size:13px; font-weight:700; color:#fff;">${escapeHtml(t(lang, 'reminder_wa_preview_header'))}</div>
          <div style="font-size:11px; color:rgba(255,255,255,0.78);">${escapeHtml(phoneLabel)}</div>
        </div>
      </div>
      <div style="padding:12px;">
        <div style="background:#DCF8C6; border-radius:8px 8px 2px 8px; padding:10px 12px; box-shadow:0 1px 2px rgba(0,0,0,0.12);">
          <div id="wa-bubble-preview-text" style="font-size:13px; color:#111; line-height:1.6; white-space:pre-wrap; word-break:break-word;">${formatWaBoldHtml(message)}</div>
          <div style="text-align:right; margin-top:4px; font-size:10px; color:#667781;">09:41 ✓✓</div>
        </div>
      </div>
    </div>`;
}

function renderBroadcastScreen(lang, ledger) {
  const w = wb().warung;
  const queue = buildBroadcastQueue(ledger.customers, wb().reminders);
  const b = uiState.broadcast;
  const sent = new Set(b.sentIds);
  const progress = queueProgress(queue, b.index, sent);
  const current = queue[b.index] || null;

  let body = '';
  if (queue.length === 0) {
    body = `<div style="text-align:center; padding:40px 16px; color:var(--text3); font-size:14px;">${escapeHtml(t(lang, 'broadcast_empty'))}</div>`;
  } else if (progress.done || !current) {
    body = `
      <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius); padding:24px 16px; text-align:center; display:flex; flex-direction:column; gap:10px;">
        <div style="font-size:36px;">✅</div>
        <div style="font-family:var(--font-display); font-size:20px; color:var(--text);">${escapeHtml(t(lang, 'broadcast_done_title'))}</div>
        <div style="font-size:14px; color:var(--text2);">${escapeHtml(t(lang, 'broadcast_done_summary', { sent: progress.sentCount, skipped: progress.skippedCount }))}</div>
        <button type="button" id="btn-broadcast-finish" class="btn-primary" style="margin-top:8px;">${escapeHtml(t(lang, 'broadcast_back_btn'))}</button>
      </div>`;
  } else {
    const msg = composeReminder(current, b.tone);
    const waHref = buildWaLink(current.phone62 || current.phoneRaw, msg);
    const isSent = sent.has(current.id);
    body = `
      <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius); padding:14px 16px; display:flex; justify-content:space-between; align-items:center; gap:10px;">
        <div style="min-width:0;">
          <div style="font-weight:700; font-size:16px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(current.name)}</div>
          <div style="font-size:12px; color:var(--text3); margin-top:2px;">
            ${escapeHtml(t(lang, 'reminder_overdue_days', { hari: current.daysOverdue }))} ·
            ${escapeHtml(current.lastRemindedAt ? t(lang, 'broadcast_last_reminded', { waktu: formatDateTimeShort(current.lastRemindedAt) }) : t(lang, 'detail_never_reminded'))}
          </div>
        </div>
        <div style="text-align:right; flex-shrink:0;">
          <div style="font-family:var(--font-display); font-size:20px; color:${current.risk === 'Tinggi' ? 'var(--red)' : 'var(--amber)'};">${escapeHtml(rp(current.balance, { spaced: true }))}</div>
          <span class="risk-badge risk-${current.risk}"><span class="risk-dot"></span>${escapeHtml(riskLabel(lang, current.risk))}</span>
        </div>
      </div>
      ${renderTonePicker(lang, b.tone)}
      ${renderWaBubble(lang, fmtPhone(current.phone62 || current.phoneRaw), msg)}
      <div style="display:flex; flex-direction:column; gap:8px; margin-top:auto;">
        <a id="btn-broadcast-send" href="${escapeHtml(waHref)}" target="_blank" rel="noopener noreferrer" data-customer-id="${escapeHtml(current.id)}"
          class="btn-primary btn-wa tap-target" style="${isSent ? 'opacity:0.85;' : ''}">
          <span>${isSent ? '✓' : '💬'}</span>
          <span>${escapeHtml(isSent ? t(lang, 'broadcast_sent_btn') : t(lang, 'broadcast_send_btn'))}</span>
        </a>
        <button type="button" id="btn-broadcast-next" class="btn-secondary">
          ${escapeHtml(isSent ? t(lang, 'broadcast_next_btn') : t(lang, 'broadcast_skip_btn'))} →
        </button>
      </div>`;
  }

  return `
    <div class="screen-body" data-screen="broadcast">
      <div class="topbar">
        <button type="button" class="back-btn" id="btn-back-to-list" aria-label="${escapeHtml(t(lang, 'back_aria_label'))}">←</button>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:700; font-size:15px; color:var(--text);">${escapeHtml(t(lang, 'broadcast_title'))}</div>
          <div style="font-size:12px; color:var(--text3);">${escapeHtml(t(lang, 'broadcast_progress', { n: progress.position, m: progress.total }))}</div>
        </div>
        <div style="font-size:13px; font-weight:700; color:var(--primary-dark); background:var(--primary-light); padding:6px 10px; border-radius:99px;">
          ${progress.position}/${progress.total}
        </div>
      </div>
      <div style="height:4px; background:var(--bg2);">
        <div style="height:4px; width:${progress.total ? Math.round((Math.min(b.index, progress.total) / progress.total) * 100) : 0}%; background:var(--primary); transition:width 0.2s;"></div>
      </div>
      <div style="padding:16px; display:flex; flex-direction:column; gap:14px; flex:1;">
        ${body}
      </div>
    </div>`;
}

function renderShareCardScreen(lang) {
  const model = buildShareCardModel(appState);
  return `
    <div class="screen-body" data-screen="card">
      <div class="topbar">
        <button type="button" class="back-btn" id="btn-back-from-card" aria-label="${escapeHtml(t(lang, 'back_aria_label'))}">←</button>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:700; font-size:15px; color:var(--text);">
            ${escapeHtml(t(lang, 'card_title'))}
          </div>
          <div style="font-size:12px; color:var(--text3);">
            ${escapeHtml(t(lang, 'card_subtitle'))}
          </div>
        </div>
      </div>

      <div style="padding:16px; display:flex; flex-direction:column; gap:14px; flex:1;">
        <div style="background:linear-gradient(145deg, #092228 0%, #10353E 100%); border-radius:20px; padding:20px 18px; color:#fff; box-shadow:0 8px 28px rgba(0,0,0,0.22); position:relative; overflow:hidden;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:14px;">
            <div>
              <div style="font-size:11px; color:rgba(255,255,255,0.55); font-weight:600; text-transform:uppercase; letter-spacing:0.6px;">
                ${escapeHtml(model.dateLabel)}
              </div>
              <div style="font-family:var(--font-display); font-size:20px; color:#fff; margin-top:2px;">
                ${escapeHtml(model.warungName)}
              </div>
            </div>
            <div style="background:rgba(45,212,191,0.18); border:1px solid rgba(45,212,191,0.35); border-radius:99px; padding:4px 10px; font-size:10px; font-weight:700; color:#5EEAD4;">
              ⚡ ${escapeHtml(t(lang, 'card_report_badge'))}
            </div>
          </div>

          <div style="background:rgba(255,255,255,0.08); border-radius:12px; padding:12px 14px; margin-bottom:14px;">
            <div style="font-size:11px; color:rgba(255,255,255,0.65);">
              ${escapeHtml(t(lang, 'card_total_label'))}
            </div>
            <div style="font-family:var(--font-display); font-size:26px; color:#5EEAD4; margin-top:2px;">
              ${escapeHtml(model.totalFormatted)}
            </div>
            <div style="display:flex; gap:14px; margin-top:6px;">
              <span style="font-size:11px; color:rgba(255,255,255,0.65);">
                ${escapeHtml(t(lang, 'card_active_debtors', { count: model.activeCount }))}
              </span>
              <span style="font-size:11px; color:#FCD34D;">
                🔴 ${escapeHtml(t(lang, 'card_overdue_30', { count: model.highRiskCount }))}
              </span>
            </div>
          </div>

          <div style="display:flex; flex-direction:column; gap:7px; margin-bottom:14px;">
            ${model.topDebtors
              .map(
                (c) => `
                  <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.06); border-radius:9px; padding:8px 11px;">
                    <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                      <span style="width:20px; height:20px; border-radius:50%; background:rgba(255,255,255,0.14); display:inline-flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; color:rgba(255,255,255,0.85); flex-shrink:0;">
                        ${c.rank}
                      </span>
                      <span style="font-size:13px; font-weight:600; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                        ${escapeHtml(c.name)}
                      </span>
                    </div>
                    <span style="font-size:13px; font-weight:700; color:${c.risk === 'Tinggi' ? '#FCA5A5' : '#FCD34D'}; flex-shrink:0; margin-left:8px;">
                      ${escapeHtml(c.balanceFormatted)}
                    </span>
                  </div>
                `
              )
              .join('')}
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; padding-top:10px; border-top:1px solid rgba(255,255,255,0.12); font-size:11px; color:rgba(255,255,255,0.5);">
            <span id="card-watermark-line">
              ${escapeHtml(model.showWatermark ? model.watermarkText : `Laporan Resmi ${model.warungName}`)}
            </span>
          </div>
        </div>

        <canvas id="share-card-canvas" width="1080" height="1350" style="display:none;"></canvas>

        <div style="background:var(--card); border-radius:var(--radius-sm); border:1px solid var(--border); padding:14px; display:flex; flex-direction:column; gap:6px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2);">
            ${escapeHtml(t(lang, 'card_how_to_share'))}
          </div>
          <div style="font-size:13px; color:var(--text3);">${escapeHtml(t(lang, 'card_step_1'))}</div>
          <div style="font-size:13px; color:var(--text3);">${escapeHtml(t(lang, 'card_step_2'))}</div>
          <div style="font-size:13px; color:var(--text3);">${escapeHtml(t(lang, 'card_step_3'))}</div>
        </div>

        <div style="display:flex; flex-direction:column; gap:8px; margin-top:auto;">
          <button type="button" id="btn-share-card-native" class="btn-primary btn-wa">
            <span>📤</span>
            <span>${escapeHtml(t(lang, 'card_share_wa_cta'))}</span>
          </button>
          <button type="button" id="btn-download-card-png" class="btn-secondary">
            <span>⬇️</span>
            <span>${escapeHtml(t(lang, 'card_download_cta'))}</span>
          </button>
          <button type="button" id="btn-back-from-card-bottom" class="btn-secondary">
            ${escapeHtml(t(lang, 'card_back_btn'))}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderReceiptScreen(lang, customer) {
  let model;
  try {
    model = buildReceiptModel(appState, { customerId: customer.id, paymentId: uiState.receiptPaymentId });
  } catch {
    return renderCustomerDetailScreen(lang, customer);
  }
  const firstName = customer.name.split(' ')[0] || customer.name;
  const waHref = buildWaLink(customer.phone62 || customer.phoneRaw, model.shareText);
  const accent = model.isLunas ? 'var(--primary)' : 'var(--amber)';
  return `
    <div class="screen-body" data-screen="receipt">
      <div class="topbar">
        <button type="button" class="back-btn" id="btn-back-to-detail" aria-label="${escapeHtml(t(lang, 'back_aria_label'))}">←</button>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:700; font-size:15px; color:var(--text);">${escapeHtml(t(lang, 'receipt_title'))}</div>
          <div style="font-size:12px; color:var(--text3);">${escapeHtml(t(lang, 'receipt_subtitle'))}</div>
        </div>
      </div>

      <div style="padding:16px; display:flex; flex-direction:column; gap:14px; flex:1;">
        <div style="background:var(--card); border-radius:20px; overflow:hidden; border:1.5px solid var(--border); box-shadow:0 8px 28px rgba(0,0,0,0.12);">
          <div style="background:${accent}; padding:16px 18px; color:#fff;">
            <div style="font-size:11px; font-weight:700; letter-spacing:0.6px; opacity:0.85;">${escapeHtml(t(lang, 'receipt_title')).toUpperCase()}</div>
            <div style="font-family:var(--font-display); font-size:20px; margin-top:2px;">${escapeHtml(model.warungName)}</div>
          </div>
          <div style="padding:16px 18px; display:flex; flex-direction:column; gap:10px;">
            <div style="display:flex; justify-content:space-between; gap:8px; font-size:13px; color:var(--text2);">
              <span>${escapeHtml(model.customerName)}</span><span>${escapeHtml(model.dateLabel)}</span>
            </div>
            <div>
              <div style="font-size:12px; color:var(--text3);">${escapeHtml(t(lang, 'receipt_paid_label'))}</div>
              <div style="font-family:var(--font-display); font-size:30px; color:var(--primary-dark);">${escapeHtml(model.amountPaidFormatted)}</div>
              ${model.note ? `<div style="font-size:12px; color:var(--text3);">${escapeHtml(model.note)}</div>` : ''}
            </div>
            <div style="background:${model.isLunas ? 'var(--primary-light)' : 'var(--amber-light)'}; border-radius:var(--radius-sm); padding:10px 12px; display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:12px; font-weight:700; color:${model.isLunas ? 'var(--primary-dark)' : 'var(--amber)'};">
                ${escapeHtml(model.isLunas ? t(lang, 'receipt_lunas_label') : t(lang, 'receipt_remaining_label'))}
              </span>
              <span style="font-family:var(--font-display); font-size:18px; color:${model.isLunas ? 'var(--primary-dark)' : 'var(--amber)'};">
                ${model.isLunas ? '✅' : escapeHtml(model.remainingFormatted)}
              </span>
            </div>
            <div style="font-size:11px; color:var(--text3); line-height:1.5;">${escapeHtml(t(lang, 'receipt_honesty_line'))}</div>
          </div>
        </div>

        <canvas id="receipt-canvas" width="1080" height="1350" style="display:none;"></canvas>

        <div style="display:flex; flex-direction:column; gap:8px; margin-top:auto;">
          <button type="button" id="btn-share-receipt" class="btn-primary btn-wa">
            <span>🧾</span><span>${escapeHtml(t(lang, 'receipt_share_cta'))}</span>
          </button>
          <a id="btn-receipt-text-wa" href="${escapeHtml(waHref)}" target="_blank" rel="noopener noreferrer" class="btn-secondary tap-target">
            💬 ${escapeHtml(t(lang, 'receipt_text_cta', { nama: firstName }))}
          </a>
          <button type="button" id="btn-download-receipt" class="btn-secondary">
            ⬇️ ${escapeHtml(t(lang, 'receipt_download_cta'))}
          </button>
          <div style="font-size:12px; color:var(--text3); text-align:center;">${escapeHtml(t(lang, 'receipt_fallback_hint'))}</div>
          <button type="button" id="btn-back-to-detail-bottom" class="btn-secondary">
            ${escapeHtml(t(lang, 'receipt_back_btn'))}
          </button>
        </div>
      </div>
    </div>`;
}

function renderStatsScreen(lang) {
  const st = computeStats(appState);
  const monthLabel = (key) => {
    const [y, m] = key.split('-');
    return formatDateId(`${y}-${m}-01`).slice(2); // "Okt 2026"
  };
  const delta = st.collectedDeltaPct;
  const deltaHtml = delta === null
    ? ''
    : `<span style="font-size:12px; font-weight:700; color:${delta >= 0 ? 'var(--primary-dark)' : 'var(--red)'};">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}%</span>`;
  const weekShort = (iso) => formatDateId(iso).replace(/\s\d{4}$/, '');

  return `
    <div class="screen-body" data-screen="stats">
      <div class="topbar">
        <button type="button" class="back-btn" id="btn-back-from-stats" aria-label="${escapeHtml(t(lang, 'back_aria_label'))}">←</button>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:700; font-size:15px; color:var(--text);">${escapeHtml(t(lang, 'stats_title'))}</div>
          <div style="font-size:12px; color:var(--text3);">${escapeHtml(t(lang, 'stats_subtitle'))}</div>
        </div>
      </div>

      <div style="padding:16px; display:flex; flex-direction:column; gap:14px; flex:1;">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:12px 14px;">
            <div style="font-size:11px; color:var(--text3);">${escapeHtml(t(lang, 'stats_outstanding_now'))}</div>
            <div style="font-family:var(--font-display); font-size:19px; color:var(--text); margin-top:2px; overflow-wrap:anywhere;">${escapeHtml(rp(st.totalOutstanding, { spaced: true }))}</div>
            <div style="font-size:11px; color:var(--text3);">${escapeHtml(t(lang, 'card_active_debtors', { count: st.activeCount }))}</div>
          </div>
          <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:12px 14px;">
            <div style="font-size:11px; color:var(--text3);">${escapeHtml(t(lang, 'stats_reminders_month'))}</div>
            <div style="font-family:var(--font-display); font-size:19px; color:var(--text); margin-top:2px;">${st.remindersThisMonth}</div>
            <div style="font-size:11px; color:var(--text3);">${escapeHtml(monthLabel(st.thisMonth))}</div>
          </div>
        </div>

        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius); padding:14px 16px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); margin-bottom:10px;">${escapeHtml(t(lang, 'stats_weekly_title'))}</div>
          <div class="stats-bars" role="img" aria-label="${escapeHtml(t(lang, 'stats_weekly_title'))}">
            ${st.weekly
              .map(
                (w) => `
                  <div class="stats-bar-col" title="${escapeHtml(formatDateId(w.weekStart))} – ${escapeHtml(formatDateId(w.weekEnd))}: ${escapeHtml(rp(w.outstanding, { spaced: true }))}">
                    <div class="stats-bar-track">
                      <div class="stats-bar-fill ${w.isCurrent ? 'current' : ''}" style="height:${Math.max(w.outstanding > 0 ? 4 : 0, Math.round(w.ratio * 100))}%;"></div>
                    </div>
                    <div class="stats-bar-label">${escapeHtml(weekShort(w.weekStart))}</div>
                  </div>`
              )
              .join('')}
          </div>
          <div style="font-size:11px; color:var(--text3); margin-top:8px; text-align:right;">${escapeHtml(t(lang, 'stats_weekly_max', { jumlah: rp(st.maxWeekly, { spaced: true }) }))}</div>
        </div>

        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius); padding:14px 16px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); margin-bottom:10px;">${escapeHtml(t(lang, 'stats_collected_title'))}</div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
            <div>
              <div style="font-size:11px; color:var(--text3);">${escapeHtml(t(lang, 'stats_collected_this_month'))} · ${escapeHtml(monthLabel(st.thisMonth))}</div>
              <div style="font-size:16px; font-weight:700; color:var(--primary-dark); margin-top:2px;">${escapeHtml(rp(st.collectedThisMonth, { spaced: true }))} ${deltaHtml}</div>
            </div>
            <div>
              <div style="font-size:11px; color:var(--text3);">${escapeHtml(t(lang, 'stats_collected_last_month'))} · ${escapeHtml(monthLabel(st.lastMonth))}</div>
              <div style="font-size:16px; font-weight:700; color:var(--text); margin-top:2px;">${escapeHtml(rp(st.collectedLastMonth, { spaced: true }))}</div>
            </div>
          </div>
        </div>

        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius); padding:14px 16px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); margin-bottom:10px;">${escapeHtml(t(lang, 'stats_top_title'))}</div>
          ${
            st.topDebtors.length === 0
              ? `<p style="font-size:13px; color:var(--text3); text-align:center; padding:8px 0;">${escapeHtml(t(lang, 'stats_empty'))}</p>`
              : `<div style="display:flex; flex-direction:column; gap:6px;">
                   ${st.topDebtors
                     .map(
                       (c) => `
                         <button type="button" class="customer-row-card" data-customer-id="${escapeHtml(c.id)}"
                           style="display:flex; align-items:center; gap:10px; background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-sm); padding:8px 12px; text-align:left; width:100%; min-height:48px;">
                           <span style="width:24px; height:24px; border-radius:50%; background:var(--bg2); display:inline-flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:var(--text2); flex-shrink:0;">${c.rank}</span>
                           <span style="flex:1; min-width:0; font-size:14px; font-weight:600; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(c.name)}</span>
                           <span style="font-size:11px; color:var(--text3); flex-shrink:0;">${c.daysOverdue} ${escapeHtml(t(lang, 'days_overdue_suffix'))}</span>
                           <span style="font-size:14px; font-weight:700; color:${c.risk === 'Tinggi' ? 'var(--red)' : c.risk === 'Sedang' ? 'var(--amber)' : 'var(--text)'}; flex-shrink:0;">${escapeHtml(rp(c.balance, { spaced: true }))}</span>
                         </button>`
                     )
                     .join('')}
                 </div>`
          }
        </div>
      </div>
    </div>`;
}

/** Sample rendering of a custom template (or the default sopan tone when empty). */
function templatePreview(template) {
  return buildReminderMessage({
    tone: 'sopan',
    nama: 'Pak Budi',
    jumlah: 350000,
    hari: 21,
    warung: wb().warung.name,
    tanggal: addDaysIsoDate(localIsoDate(new Date()), -7),
    customTemplate: String(template || '')
  });
}

function renderSettingsScreen(lang) {
  const s = appState.settings;
  return `
    <div class="screen-body" data-screen="settings">
      <header class="hero-header">
        <h1 class="hero-title">${escapeHtml(t(lang, 'settings_title'))}</h1>
        <p class="hero-subtitle">${escapeHtml(t(lang, 'app_tagline'))}</p>
      </header>

      <div style="padding:16px; display:flex; flex-direction:column; gap:14px; flex:1;">
        <!-- Default Tone & Dark Mode -->
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:14px; display:flex; flex-direction:column; gap:12px;">
          <div class="field-group">
            <label class="field-label" for="settings-default-tone">${escapeHtml(t(lang, 'settings_default_tone'))}</label>
            <select id="settings-default-tone" class="field-input">
              <option value="sopan" ${s.tone === 'sopan' ? 'selected' : ''}>${escapeHtml(t(lang, 'tone_sopan_label'))}</option>
              <option value="singkat" ${s.tone === 'singkat' ? 'selected' : ''}>${escapeHtml(t(lang, 'tone_singkat_label'))}</option>
              <option value="tegas" ${s.tone === 'tegas' ? 'selected' : ''}>${escapeHtml(t(lang, 'tone_tegas_label'))}</option>
            </select>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:14px; font-weight:600; color:var(--text);">${escapeHtml(t(lang, 'settings_language'))}</span>
            <button type="button" id="btn-toggle-lang" class="btn-secondary" style="width:auto; min-width:96px;" aria-label="${escapeHtml(t(lang, 'settings_language'))}">
              ${lang === 'en' ? '🇮🇩 Bahasa' : '🇬🇧 English'}
            </button>
          </div>
          <div style="font-size:12px; color:var(--text3); margin-top:-4px;">${escapeHtml(t(lang, 'settings_language_note'))}</div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:14px; font-weight:600; color:var(--text);">${escapeHtml(t(lang, 'settings_dark_mode'))}</span>
            <button type="button" id="btn-toggle-dark" class="btn-secondary" style="width:auto; min-width:96px;" aria-pressed="${s.darkMode ? 'true' : 'false'}">
              ${escapeHtml(s.darkMode ? t(lang, 'settings_dark_on') : t(lang, 'settings_dark_off'))}
            </button>
          </div>
        </div>

        <!-- Kilat Pro Status -->
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:14px; display:flex; flex-direction:column; gap:10px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); text-transform:uppercase;">
            ${escapeHtml(t(lang, 'settings_pro_title'))}
          </div>
          <div style="font-size:13px; color:var(--text);">
            ${escapeHtml(s.isPro ? t(lang, 'settings_pro_status_active') : t(lang, 'settings_pro_status_free'))}
          </div>
          ${
            s.isPro
              ? ''
              : `<div style="font-size:13px; color:var(--text3);">${escapeHtml(t(lang, uiState.billingAvailable ? 'pro_gate_desc_buy' : 'pro_gate_desc'))}</div>
                 <button type="button" id="btn-open-pro-gate" class="btn-primary">⚡ ${escapeHtml(
                   uiState.billingAvailable ? t(lang, 'pro_buy_btn', { price: uiState.proPrice }) : t(lang, 'pro_gate_coming_soon')
                 )}</button>`
          }
        </div>

        <!-- Pro+: encrypted cloud backup (opt-in, off by default) -->
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:14px; display:flex; flex-direction:column; gap:10px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); text-transform:uppercase;">
            ${escapeHtml(t(lang, 'settings_cloud_title'))}
          </div>
          <div style="font-size:13px; color:var(--text3); line-height:1.5;">${escapeHtml(t(lang, 'settings_cloud_desc'))}</div>
          ${
            !isCloudConfigured()
              ? `<div style="font-size:13px; font-weight:600; color:var(--text2); background:var(--bg2); border-radius:var(--radius-sm); padding:10px 12px;">${escapeHtml(t(lang, 'settings_cloud_unavailable'))}</div>`
              : !s.isPro
                ? `<button type="button" id="btn-cloud-pro-gate" class="btn-secondary">⚡ ${escapeHtml(t(lang, 'settings_cloud_pro_hint'))}</button>`
                : s.cloud.vaultId
                  ? `
                    <div style="font-size:12px; color:var(--text3);">${escapeHtml(t(lang, 'settings_cloud_vault_code'))}</div>
                    <div style="display:flex; gap:8px; align-items:center;">
                      <code id="cloud-vault-code-display" style="flex:1; font-size:13px; word-break:break-all; background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:8px 10px;">${escapeHtml(s.cloud.vaultId)}</code>
                      <button type="button" id="btn-cloud-copy" class="btn-secondary" style="width:auto; white-space:nowrap;">${escapeHtml(uiState.cloudCopied ? t(lang, 'settings_cloud_copied') : t(lang, 'settings_cloud_copy_btn'))}</button>
                    </div>
                    <div style="font-size:12px; color:var(--text3); line-height:1.5;">${escapeHtml(t(lang, 'settings_cloud_vault_hint'))}</div>
                    <div style="font-size:13px; color:var(--text);">${escapeHtml(s.cloud.lastBackupAt ? t(lang, 'settings_cloud_last_backup', { waktu: formatDateTimeShort(s.cloud.lastBackupAt) }) : t(lang, 'settings_cloud_never'))}</div>
                    ${uiState.cloudNotice ? `<div style="font-size:13px; font-weight:600; color:var(--primary-dark);">${escapeHtml(uiState.cloudNotice)}</div>` : ''}
                    ${uiState.cloudError ? `<div role="alert" style="font-size:13px; color:var(--red);">${escapeHtml(uiState.cloudError)}</div>` : ''}
                    <button type="button" id="btn-cloud-backup-now" class="btn-primary" ${uiState.cloudBusy ? 'disabled' : ''}>${escapeHtml(t(lang, 'settings_cloud_backup_now_btn'))}</button>
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                      <span style="font-size:13px; font-weight:600; color:var(--text); flex:1;">${escapeHtml(t(lang, 'settings_cloud_auto_label'))}</span>
                      <button type="button" id="btn-cloud-auto" class="btn-secondary" style="width:auto; min-width:80px;" aria-pressed="${s.cloud.autoBackup}">
                        ${escapeHtml(s.cloud.autoBackup ? t(lang, 'settings_cloud_auto_on') : t(lang, 'settings_cloud_auto_off'))}
                      </button>
                    </div>
                    <div style="font-size:12px; color:var(--text3);">${escapeHtml(t(lang, 'settings_cloud_auto_needs_pass'))}</div>
                    <button type="button" id="btn-cloud-forget" class="btn-secondary">${escapeHtml(t(lang, 'settings_cloud_forget_btn'))}</button>
                    <button type="button" id="btn-cloud-delete-remote" class="btn-secondary" style="color:var(--red); border-color:var(--red);">${escapeHtml(t(lang, 'settings_cloud_delete_remote_btn'))}</button>`
                  : `
                    ${uiState.cloudNotice ? `<div style="font-size:13px; font-weight:600; color:var(--primary-dark);">${escapeHtml(uiState.cloudNotice)}</div>` : ''}
                    <button type="button" id="btn-cloud-create" class="btn-primary">${escapeHtml(t(lang, 'settings_cloud_create_btn'))}</button>
                    <button type="button" id="btn-cloud-restore" class="btn-secondary">${escapeHtml(t(lang, 'settings_cloud_restore_btn'))}</button>`
          }
        </div>

        <!-- QRIS image (stays on device; attached to reminders on demand) -->
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:14px; display:flex; flex-direction:column; gap:10px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); text-transform:uppercase;">
            ${escapeHtml(t(lang, 'settings_qris_title'))}
          </div>
          <div style="font-size:13px; color:var(--text3); line-height:1.5;">${escapeHtml(t(lang, 'settings_qris_desc'))}</div>
          <div style="display:flex; align-items:center; gap:12px;">
            ${
              qrisDataUrl()
                ? `<button type="button" class="photo-thumb btn-view-photo" data-debt-id="${escapeHtml(qrisKey(appState.activeBookId))}" aria-label="QRIS" style="width:72px; height:72px;"><img src="${qrisDataUrl()}" alt="QRIS" /></button>`
                : ''
            }
            <div style="font-size:12px; color:var(--text3); flex:1;">${escapeHtml(qrisDataUrl() ? t(lang, 'settings_qris_ready') : t(lang, 'settings_qris_none'))}</div>
          </div>
          <label for="input-qris-file" class="btn-secondary tap-target" style="cursor:pointer;">
            ${escapeHtml(qrisDataUrl() ? t(lang, 'settings_qris_replace_btn') : t(lang, 'settings_qris_upload_btn'))}
          </label>
          <input id="input-qris-file" type="file" accept="image/*" style="display:none;" />
          ${qrisDataUrl() ? `<button type="button" id="btn-delete-qris" class="btn-secondary" style="color:var(--red); border-color:var(--red);">${escapeHtml(t(lang, 'settings_qris_delete_btn'))}</button>` : ''}
        </div>

        <!-- Multi-warung -->
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:14px; display:flex; flex-direction:column; gap:8px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); text-transform:uppercase;">
            ${escapeHtml(t(lang, 'settings_books_title'))}
          </div>
          <div style="font-size:13px; color:var(--text);">${escapeHtml(t(lang, 'books_active_label', { nama: wb().warung.name }))} · ${appState.books.length}/${bookLimit(appState)}</div>
          <div style="font-size:13px; color:var(--text3);">${escapeHtml(t(lang, 'settings_books_desc'))}</div>
          <button type="button" id="btn-settings-books" class="btn-secondary">🏪 ${escapeHtml(t(lang, 'settings_books_open_btn'))}</button>
        </div>

        <!-- Statistik -->
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:14px; display:flex; flex-direction:column; gap:8px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); text-transform:uppercase;">
            ${escapeHtml(t(lang, 'stats_title'))}
          </div>
          <div style="font-size:13px; color:var(--text3);">${escapeHtml(t(lang, 'stats_subtitle'))}</div>
          <button type="button" id="btn-open-stats" class="btn-secondary">📊 ${escapeHtml(t(lang, 'settings_stats_btn'))}</button>
        </div>

        <!-- Pro: custom reminder template -->
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:14px; display:flex; flex-direction:column; gap:10px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); text-transform:uppercase;">
            ${escapeHtml(t(lang, 'settings_template_title'))}
          </div>
          <div style="font-size:13px; color:var(--text3); line-height:1.5;">${escapeHtml(t(lang, 'settings_template_desc'))}</div>
          ${
            s.isPro
              ? `
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                  ${['{nama}', '{jumlah}', '{hari}', '{warung}', '{tanggal}']
                    .map((v) => `<button type="button" class="tpl-var-chip" data-var="${escapeHtml(v)}" style="padding:6px 10px; border-radius:99px; border:1px solid var(--border); background:var(--bg); font-size:12px; font-weight:600; color:var(--primary-dark); min-height:44px;">${escapeHtml(v)}</button>`)
                    .join('')}
                </div>
                <div class="field-group">
                  <label class="field-label" for="settings-template-textarea">${escapeHtml(t(lang, 'settings_template_label'))}</label>
                  <textarea id="settings-template-textarea" class="field-input" rows="5" style="resize:vertical; font-size:13px; line-height:1.5;"
                    placeholder="${escapeHtml(t(lang, 'settings_template_placeholder'))}">${escapeHtml(s.customTemplate || '')}</textarea>
                </div>
                <div style="font-size:12px; font-weight:600; color:var(--text2); text-transform:uppercase; letter-spacing:0.3px;">${escapeHtml(t(lang, 'settings_template_preview_label'))}</div>
                <div style="background:#DCF8C6; border-radius:8px 8px 2px 8px; padding:10px 12px; border:1px solid var(--border);">
                  <div id="settings-template-preview" style="font-size:13px; color:#111; line-height:1.6; white-space:pre-wrap; word-break:break-word;">${formatWaBoldHtml(templatePreview(s.customTemplate))}</div>
                </div>
                <div style="display:flex; gap:10px;">
                  <button type="button" id="btn-template-reset" class="btn-secondary" style="flex:1;">${escapeHtml(t(lang, 'settings_template_reset'))}</button>
                  <button type="button" id="btn-template-save" class="btn-primary" style="flex:1;">${escapeHtml(t(lang, 'settings_template_save'))}</button>
                </div>
                <div id="settings-template-status" style="font-size:12px; color:var(--text3); min-height:16px;">${escapeHtml(s.customTemplate ? t(lang, 'settings_template_active') : t(lang, 'settings_template_empty_hint'))}</div>`
              : `<button type="button" id="btn-template-pro-gate" class="btn-secondary">⚡ ${escapeHtml(t(lang, 'settings_template_pro_hint'))}</button>`
          }
        </div>

        <!-- Demo Data Loader -->
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:14px; display:flex; flex-direction:column; gap:8px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); text-transform:uppercase;">
            ${escapeHtml(t(lang, 'settings_demo_title'))}
          </div>
          <button type="button" id="btn-load-demo-6" class="btn-secondary">
            ${escapeHtml(t(lang, 'settings_demo_load_6'))}
          </button>
          <button type="button" id="btn-load-demo-12" class="btn-secondary">
            ${escapeHtml(t(lang, 'settings_demo_load_12'))}
          </button>
        </div>

        <!-- Backup JSON & CSV Export -->
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:14px; display:flex; flex-direction:column; gap:8px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); text-transform:uppercase;">
            ${escapeHtml(t(lang, 'settings_backup_title'))}
          </div>
          <button type="button" id="btn-export-json" class="btn-secondary">
            ⬇️ ${escapeHtml(t(lang, 'settings_export_json'))}
          </button>
          <label for="input-import-json" class="btn-secondary tap-target" style="cursor:pointer;">
            ⬆️ ${escapeHtml(t(lang, 'settings_import_json'))}
          </label>
          <input id="input-import-json" type="file" accept="application/json,.json" style="display:none;" />

          <div style="font-size:13px; font-weight:700; color:var(--text2); text-transform:uppercase; margin-top:6px;">
            ${escapeHtml(t(lang, 'settings_csv_title'))}
          </div>
          <button type="button" id="btn-export-csv" class="btn-secondary">
            📊 ${escapeHtml(t(lang, 'settings_export_csv'))}
          </button>
        </div>

        <!-- Wipe All Data -->
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:14px; display:flex; flex-direction:column; gap:8px;">
          <div style="font-size:13px; font-weight:700; color:var(--text2); text-transform:uppercase;">
            ${escapeHtml(t(lang, 'settings_wipe_title'))}
          </div>
          <p style="font-size:13px; color:var(--text3); line-height:1.5;">${escapeHtml(t(lang, 'settings_wipe_hint'))}</p>
          <button type="button" id="btn-wipe-all" class="btn-secondary" style="color:var(--red); border-color:var(--red);">
            ${escapeHtml(t(lang, 'settings_wipe_btn'))}
          </button>
        </div>

        <!-- Privacy Footer -->
        <div style="padding:12px; text-align:center; font-size:12px; color:var(--text3); line-height:1.5;">
          <p>${escapeHtml(t(lang, 'privacy_notice'))}</p>
          <a href="./privacy.html" class="tap-target" style="display:inline-flex; align-items:center; justify-content:center; color:var(--primary-dark); font-weight:600; margin-top:4px; text-decoration:underline;">
            ${escapeHtml(t(lang, 'settings_privacy_link'))}
          </a>
        </div>
      </div>
    </div>
  `;
}

function renderAddCustomerSheet(lang) {
  return `
    <div class="sheet-backdrop" id="sheet-backdrop">
      <form class="sheet-panel" id="form-add-customer">
        <h2 style="font-family:var(--font-display); font-size:20px; color:var(--text);">
          ${escapeHtml(bk(lang, 'sheet_add_customer_title'))}
        </h2>
        <div class="field-group">
          <label class="field-label" for="add-cust-name">${escapeHtml(bk(lang, 'sheet_customer_name_label'))}</label>
          <input id="add-cust-name" name="name" class="field-input" type="text" required
            placeholder="${escapeHtml(bk(lang, 'sheet_customer_name_placeholder'))}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="add-cust-phone">${escapeHtml(t(lang, 'sheet_customer_phone_label'))}</label>
          <input id="add-cust-phone" name="phone" class="field-input" type="tel" required
            placeholder="${escapeHtml(t(lang, 'sheet_customer_phone_placeholder'))}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="add-cust-note">${escapeHtml(t(lang, 'sheet_customer_note_label'))}</label>
          <input id="add-cust-note" name="note" class="field-input" type="text"
            placeholder="${escapeHtml(t(lang, 'sheet_customer_note_placeholder'))}" />
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div class="field-group">
            <label class="field-label" for="add-cust-debt">${escapeHtml(bk(lang, 'sheet_initial_debt_label'))}</label>
            <input id="add-cust-debt" name="initialDebtIdr" class="field-input" type="number" min="0" step="1" inputmode="numeric"
              placeholder="${escapeHtml(t(lang, 'sheet_initial_debt_placeholder'))}" />
          </div>
          <div class="field-group">
            <label class="field-label" for="add-cust-days">${escapeHtml(t(lang, 'sheet_initial_days_label'))}</label>
            <input id="add-cust-days" name="daysAgo" class="field-input" type="number" min="0" max="365" value="0" />
          </div>
        </div>
        <div style="display:flex; gap:10px; margin-top:6px;">
          <button type="button" id="btn-cancel-sheet" class="btn-secondary" style="flex:1;">
            ${escapeHtml(t(lang, 'sheet_cancel_btn'))}
          </button>
          <button type="submit" class="btn-primary" style="flex:1;">
            ${escapeHtml(t(lang, 'sheet_save_btn'))}
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderAddDebtSheet(lang, customer) {
  const today = localIsoDate(new Date());
  const defaultDue = addDaysIsoDate(today, wb().warung.dueDays);
  const quickAmounts = [25000, 50000, 100000, 200000];
  return `
    <div class="sheet-backdrop" id="sheet-backdrop">
      <form class="sheet-panel" id="form-add-debt">
        <h2 style="font-family:var(--font-display); font-size:20px; color:var(--text);">
          ${escapeHtml(bk(lang, 'sheet_add_debt_title'))} — ${escapeHtml(customer?.name || '')}
        </h2>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${quickAmounts
            .map(
              (amt) =>
                `<button type="button" class="quick-amt-btn" data-amt="${amt}"
                  style="padding:6px 10px; border-radius:8px; border:1px solid var(--border); background:var(--bg); font-size:12px; font-weight:600; color:var(--text2); min-height:44px;">
                  +${escapeHtml(rp(amt))}
                </button>`
            )
            .join('')}
        </div>
        <div class="field-group">
          <label class="field-label" for="debt-amount">${escapeHtml(t(lang, 'sheet_amount_label'))}</label>
          <input id="debt-amount" name="amountIdr" class="field-input" type="number" min="1" step="1" inputmode="numeric" required
            placeholder="${escapeHtml(t(lang, 'sheet_amount_placeholder'))}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="debt-note">${escapeHtml(t(lang, 'sheet_note_label'))}</label>
          <input id="debt-note" name="note" class="field-input" type="text"
            placeholder="${escapeHtml(t(lang, 'sheet_note_debt_placeholder'))}" />
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div class="field-group">
            <label class="field-label" for="debt-date">${escapeHtml(t(lang, 'sheet_date_label'))}</label>
            <input id="debt-date" name="date" class="field-input" type="date" value="${today}" required />
          </div>
          <div class="field-group">
            <label class="field-label" for="debt-due-date">${escapeHtml(t(lang, 'sheet_due_date_label'))}</label>
            <input id="debt-due-date" name="dueDate" class="field-input" type="date" value="${defaultDue}" />
          </div>
        </div>
        <div style="font-size:12px; color:var(--text3); margin-top:-6px;">${escapeHtml(t(lang, 'sheet_due_date_hint', { days: wb().warung.dueDays }))}</div>
        <div class="field-group">
          <span class="field-label">${escapeHtml(t(lang, 'sheet_photo_label'))}</span>
          <div style="display:flex; align-items:center; gap:10px;">
            <label for="debt-photo-input" class="btn-secondary tap-target" style="cursor:pointer; width:auto; flex:1;">
              ${escapeHtml(t(lang, 'sheet_photo_pick_btn'))}
            </label>
            ${
              uiState.pendingPhotoDataUrl
                ? `<span class="photo-thumb" aria-hidden="true"><img src="${uiState.pendingPhotoDataUrl}" alt="" /></span>`
                : ''
            }
          </div>
          <input id="debt-photo-input" type="file" accept="image/*" capture="environment" style="display:none;" />
          <div id="debt-photo-status" style="font-size:12px; color:var(--text3);">
            ${escapeHtml(uiState.pendingPhotoDataUrl ? t(lang, 'sheet_photo_chosen') : t(lang, 'sheet_photo_hint'))}
          </div>
        </div>
        <div style="display:flex; gap:10px; margin-top:6px;">
          <button type="button" id="btn-cancel-sheet" class="btn-secondary" style="flex:1;">
            ${escapeHtml(t(lang, 'sheet_cancel_btn'))}
          </button>
          <button type="submit" class="btn-primary" style="flex:1;">
            ${escapeHtml(t(lang, 'sheet_save_btn'))}
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderPhotoViewer(lang) {
  const id = uiState.photoViewerDebtId;
  const src = id ? uiState.photos[id] : null;
  if (!id || !src) return '';
  return `
    <div class="photo-viewer" id="photo-viewer" role="dialog" aria-label="${escapeHtml(t(lang, 'photo_viewer_title'))}">
      <img src="${src}" alt="${escapeHtml(t(lang, 'photo_viewer_title'))}" />
      <div class="photo-viewer-actions">
        <button type="button" id="btn-photo-delete" class="btn-secondary" style="color:var(--red); border-color:var(--red); background:#fff;">
          ${escapeHtml(t(lang, 'photo_delete_btn'))}
        </button>
        <button type="button" id="btn-photo-close" class="btn-primary">
          ${escapeHtml(t(lang, 'photo_close_btn'))}
        </button>
      </div>
    </div>`;
}

function renderBookSwitcherSheet(lang) {
  const limit = bookLimit(appState);
  const canAdd = canAddBook(appState);
  return `
    <div class="sheet-backdrop" id="sheet-backdrop">
      <div class="sheet-panel">
        <h2 style="font-family:var(--font-display); font-size:20px; color:var(--text);">${escapeHtml(t(lang, 'books_switcher_title'))}</h2>
        <p style="font-size:13px; color:var(--text2); line-height:1.5;">${escapeHtml(t(lang, 'books_switch_hint'))}</p>
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${appState.books
            .map((b) => {
              const active = b.id === appState.activeBookId;
              return `
                <div style="display:flex; gap:8px; align-items:stretch;">
                  <button type="button" class="btn-switch-book" data-book-id="${escapeHtml(b.id)}"
                    style="flex:1; display:flex; align-items:center; justify-content:space-between; gap:8px; text-align:left; padding:10px 14px; min-height:56px; border-radius:var(--radius-sm); border:2px solid ${active ? 'var(--primary)' : 'var(--border)'}; background:${active ? 'var(--primary-light)' : 'var(--card)'};">
                    <span style="min-width:0;">
                      <span style="display:block; font-weight:700; font-size:14px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${active ? '✓ ' : ''}${escapeHtml(b.warung.name)}</span>
                      <span style="display:block; font-size:12px; color:var(--text3);">${escapeHtml(t(lang, 'books_count_customers', { count: b.customers.length, suppliers: b.suppliers.length }))}</span>
                    </span>
                  </button>
                  ${
                    appState.books.length > 1
                      ? `<button type="button" class="btn-delete-book" data-book-id="${escapeHtml(b.id)}" aria-label="${escapeHtml(t(lang, 'books_delete_btn'))}"
                           style="min-width:44px; min-height:44px; border-radius:var(--radius-sm); border:1.5px solid var(--border); background:var(--card); color:var(--red); font-size:16px;">🗑️</button>`
                      : ''
                  }
                </div>`;
            })
            .join('')}
        </div>
        ${
          canAdd
            ? `<form id="form-add-book" style="display:flex; flex-direction:column; gap:8px; border-top:1px solid var(--border); padding-top:12px;">
                 <label class="field-label" for="add-book-name">${escapeHtml(t(lang, 'books_add_name_label'))}</label>
                 <div style="display:flex; gap:8px;">
                   <input id="add-book-name" name="name" class="field-input" type="text" required maxlength="40"
                     placeholder="${escapeHtml(t(lang, 'books_add_name_placeholder'))}" />
                   <button type="submit" class="btn-primary" style="width:auto; white-space:nowrap;">${escapeHtml(t(lang, 'books_add_submit'))}</button>
                 </div>
               </form>`
            : `<div style="border-top:1px solid var(--border); padding-top:12px; font-size:13px; color:var(--text3); line-height:1.5;">
                 ${escapeHtml(appState.settings.isPro ? t(lang, 'books_limit_pro', { limit }) : t(lang, 'books_limit_free'))}
               </div>
               ${appState.settings.isPro ? '' : `<button type="button" id="btn-books-pro-gate" class="btn-secondary">⚡ ${escapeHtml(t(lang, 'settings_template_pro_hint'))}</button>`}`
        }
        <button type="button" id="btn-cancel-sheet" class="btn-secondary">${escapeHtml(t(lang, 'pro_gate_close_btn'))}</button>
      </div>
    </div>`;
}

function renderCloudSheet(lang, mode) {
  const isCreate = mode === 'cloudCreate';
  const err = uiState.cloudError ? `<div role="alert" style="font-size:13px; color:var(--red); background:var(--red-light); border-radius:var(--radius-sm); padding:8px 10px;">${escapeHtml(uiState.cloudError)}</div>` : '';
  return `
    <div class="sheet-backdrop" id="sheet-backdrop">
      <form class="sheet-panel" id="form-cloud" data-mode="${mode}">
        <h2 style="font-family:var(--font-display); font-size:20px; color:var(--text);">
          ${escapeHtml(t(lang, isCreate ? 'cloud_sheet_create_title' : 'cloud_sheet_restore_title'))}
        </h2>
        <p style="font-size:13px; color:var(--text2); line-height:1.5;">${escapeHtml(t(lang, isCreate ? 'cloud_sheet_create_desc' : 'cloud_sheet_restore_desc'))}</p>
        ${
          isCreate
            ? ''
            : `<div class="field-group">
                 <label class="field-label" for="cloud-vault-code">${escapeHtml(t(lang, 'cloud_vault_code_label'))}</label>
                 <input id="cloud-vault-code" name="vaultId" class="field-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" required
                   style="font-family:monospace; letter-spacing:1px;" />
               </div>`
        }
        <div class="field-group">
          <label class="field-label" for="cloud-passphrase">${escapeHtml(t(lang, 'cloud_passphrase_label'))}</label>
          <input id="cloud-passphrase" name="passphrase" class="field-input" type="password" autocomplete="${isCreate ? 'new-password' : 'current-password'}" required minlength="8" />
        </div>
        ${
          isCreate
            ? `<div class="field-group">
                 <label class="field-label" for="cloud-passphrase-2">${escapeHtml(t(lang, 'cloud_passphrase_confirm_label'))}</label>
                 <input id="cloud-passphrase-2" name="passphrase2" class="field-input" type="password" autocomplete="new-password" required minlength="8" />
               </div>`
            : ''
        }
        ${err}
        <div style="display:flex; gap:10px; margin-top:6px;">
          <button type="button" id="btn-cancel-sheet" class="btn-secondary" style="flex:1;">${escapeHtml(t(lang, 'sheet_cancel_btn'))}</button>
          <button type="submit" class="btn-primary" style="flex:1;" ${uiState.cloudBusy ? 'disabled' : ''}>
            ${escapeHtml(uiState.cloudBusy ? '…' : t(lang, isCreate ? 'cloud_submit_create' : 'cloud_submit_restore'))}
          </button>
        </div>
      </form>
    </div>`;
}

function renderPayPlanSheet(lang, supplier) {
  const plan = supplier.payPlan || { date: null, note: '' };
  return `
    <div class="sheet-backdrop" id="sheet-backdrop">
      <form class="sheet-panel" id="form-pay-plan">
        <h2 style="font-family:var(--font-display); font-size:20px; color:var(--text);">
          ${escapeHtml(t(lang, 'supplier_plan_sheet_title'))} — ${escapeHtml(supplier.name)}
        </h2>
        <p style="font-size:13px; color:var(--text2); line-height:1.5;">${escapeHtml(t(lang, 'supplier_plan_sheet_desc'))}</p>
        <div class="field-group">
          <label class="field-label" for="plan-date">${escapeHtml(t(lang, 'supplier_plan_date_label'))}</label>
          <input id="plan-date" name="date" class="field-input" type="date" value="${escapeHtml(plan.date || '')}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="plan-note">${escapeHtml(t(lang, 'supplier_plan_note_label'))}</label>
          <input id="plan-note" name="note" class="field-input" type="text" value="${escapeHtml(plan.note || '')}"
            placeholder="${escapeHtml(t(lang, 'supplier_plan_note_placeholder'))}" />
        </div>
        <div style="display:flex; gap:10px; margin-top:6px;">
          <button type="button" id="btn-cancel-sheet" class="btn-secondary" style="flex:1;">${escapeHtml(t(lang, 'sheet_cancel_btn'))}</button>
          ${supplier.payPlan ? `<button type="button" id="btn-plan-clear" class="btn-secondary" style="flex:1; color:var(--red); border-color:var(--red);">${escapeHtml(t(lang, 'supplier_plan_clear'))}</button>` : ''}
          <button type="submit" class="btn-primary" style="flex:1;">${escapeHtml(t(lang, 'sheet_save_btn'))}</button>
        </div>
      </form>
    </div>`;
}

function renderRecordPaySheet(lang, customer) {
  const today = localIsoDate(new Date());
  const currentBalance = customer?.balance || 0;
  return `
    <div class="sheet-backdrop" id="sheet-backdrop">
      <form class="sheet-panel" id="form-record-pay">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <h2 style="font-family:var(--font-display); font-size:20px; color:var(--text);">
            ${escapeHtml(t(lang, 'sheet_record_pay_title'))}
          </h2>
          ${
            currentBalance > 0
              ? `<button type="button" id="btn-fill-full-balance" data-balance="${currentBalance}"
                   style="padding:6px 12px; border-radius:8px; border:1px solid var(--primary); background:var(--primary-light); color:var(--primary-dark); font-size:12px; font-weight:700; min-height:44px;">
                   ${escapeHtml(t(lang, 'sheet_full_pay_btn'))} (${escapeHtml(rp(currentBalance))})
                 </button>`
              : ''
          }
        </div>
        <div class="field-group">
          <label class="field-label" for="pay-amount">${escapeHtml(t(lang, 'sheet_amount_label'))}</label>
          <input id="pay-amount" name="amountIdr" class="field-input" type="number" min="1" step="1" inputmode="numeric" required
            value="${currentBalance > 0 ? currentBalance : ''}"
            placeholder="${escapeHtml(t(lang, 'sheet_amount_placeholder'))}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="pay-note">${escapeHtml(t(lang, 'sheet_note_label'))}</label>
          <input id="pay-note" name="note" class="field-input" type="text"
            placeholder="${escapeHtml(t(lang, 'sheet_note_pay_placeholder'))}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="pay-date">${escapeHtml(t(lang, 'sheet_date_label'))}</label>
          <input id="pay-date" name="date" class="field-input" type="date" value="${today}" required />
        </div>
        <div style="display:flex; gap:10px; margin-top:6px;">
          <button type="button" id="btn-cancel-sheet" class="btn-secondary" style="flex:1;">
            ${escapeHtml(t(lang, 'sheet_cancel_btn'))}
          </button>
          <button type="submit" class="btn-primary" style="flex:1;">
            ${escapeHtml(t(lang, 'sheet_save_btn'))}
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderProGateSheet(lang) {
  return `
    <div class="sheet-backdrop" id="sheet-backdrop">
      <div class="sheet-panel">
        <div style="font-size:28px;">⚡</div>
        <h2 style="font-family:var(--font-display); font-size:21px; color:var(--text);">
          ${escapeHtml(t(lang, uiState.billingAvailable ? 'pro_gate_title_buy' : 'pro_gate_title'))}
        </h2>
        <p style="font-size:14px; color:var(--text2); line-height:1.55;">
          ${escapeHtml(t(lang, uiState.billingAvailable ? 'pro_gate_desc_buy' : 'pro_gate_desc'))}
        </p>
        ${uiState.billingNotice ? `<p style="font-size:14px; font-weight:700; color:var(--text);">${escapeHtml(uiState.billingNotice)}</p>` : ''}
        <div style="display:flex; flex-direction:column; gap:8px; margin-top:6px;">
          ${
            appState.settings.isPro
              ? ''
              : uiState.billingAvailable
                ? `<button type="button" id="btn-buy-pro" class="btn-primary" ${uiState.billingBusy ? 'disabled' : ''}>⚡ ${escapeHtml(t(lang, 'pro_buy_btn', { price: uiState.proPrice }))}</button>
                   <button type="button" id="btn-restore-pro" class="btn-secondary" ${uiState.billingBusy ? 'disabled' : ''}>${escapeHtml(t(lang, 'pro_restore_btn'))}</button>`
                : `<div class="btn-secondary" aria-disabled="true" style="opacity:0.7; cursor:default;">⚡ ${escapeHtml(t(lang, 'pro_gate_coming_soon'))}</div>`
          }
          <button type="button" id="btn-cancel-sheet" class="${appState.settings.isPro || uiState.billingAvailable ? 'btn-secondary' : 'btn-primary'}">
            ${escapeHtml(t(lang, 'pro_gate_close_btn'))}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderUndoToast(lang) {
  if (!uiState.toastMessage || !getUndoMeta()) return '';
  return `
    <div class="undo-toast" role="status" aria-live="polite">
      <span style="font-size:13px; font-weight:500;">${escapeHtml(uiState.toastMessage)}</span>
      <button type="button" id="btn-undo-action" class="undo-toast-btn">
        ${escapeHtml(t(lang, 'undo_btn'))}
      </button>
    </div>
  `;
}

function renderBottomNav(lang) {
  const items = [
    { id: 'setup', icon: '🏪', label: t(lang, 'nav_warung') },
    { id: 'list', icon: '👥', label: t(lang, 'nav_customers') },
    { id: 'settings', icon: '⚙️', label: t(lang, 'nav_settings') }
  ];
  return `
    <nav class="bottom-nav" aria-label="Menu Utama">
      ${items
        .map((item) => {
          const active =
            uiState.screen === item.id ||
            (['detail', 'reminder', 'card', 'broadcast', 'receipt', 'stats'].includes(uiState.screen) && item.id === 'list');
          return `
            <button type="button" class="bottom-nav-btn ${active ? 'active' : ''}" data-nav="${item.id}">
              <span class="bottom-nav-icon" aria-hidden="true">${item.icon}</span>
              <span class="bottom-nav-label">${escapeHtml(item.label)}</span>
              ${active ? '<span class="bottom-nav-dot"></span>' : ''}
            </button>
          `;
        })
        .join('')}
    </nav>
  `;
}

export function renderApp() {
  const root = document.getElementById('app');
  if (!root || !appState) return;
  applyTheme();

  const lang = appState.settings.lang;
  const ledger = ledgerFor();
  const selectedCustomer = ledger.customers.find((c) => c.id === uiState.selectedCustomerId) || null;

  let screenHtml = '';
  if (uiState.screen === 'setup') {
    screenHtml = renderSetupScreen(lang);
  } else if (uiState.screen === 'detail' && selectedCustomer) {
    screenHtml = renderCustomerDetailScreen(lang, selectedCustomer);
  } else if (uiState.screen === 'reminder' && selectedCustomer) {
    screenHtml = renderReminderScreen(lang, selectedCustomer);
  } else if (uiState.screen === 'receipt' && selectedCustomer) {
    screenHtml = renderReceiptScreen(lang, selectedCustomer);
  } else if (uiState.screen === 'card') {
    screenHtml = renderShareCardScreen(lang);
  } else if (uiState.screen === 'broadcast') {
    screenHtml = renderBroadcastScreen(lang, ledger);
  } else if (uiState.screen === 'stats') {
    screenHtml = renderStatsScreen(lang);
  } else if (uiState.screen === 'settings') {
    screenHtml = renderSettingsScreen(lang);
  } else {
    screenHtml = renderCustomerListScreen(lang, ledger);
  }

  let sheetHtml = '';
  if (uiState.activeSheet === 'addCustomer') {
    sheetHtml = renderAddCustomerSheet(lang);
  } else if (uiState.activeSheet === 'addDebt' && selectedCustomer) {
    sheetHtml = renderAddDebtSheet(lang, selectedCustomer);
  } else if (uiState.activeSheet === 'recordPay' && selectedCustomer) {
    sheetHtml = renderRecordPaySheet(lang, selectedCustomer);
  } else if (uiState.activeSheet === 'merge' && selectedCustomer) {
    sheetHtml = renderMergeSheet(lang, selectedCustomer);
  } else if (uiState.activeSheet === 'payPlan' && selectedCustomer && isSupplierBook()) {
    sheetHtml = renderPayPlanSheet(lang, selectedCustomer);
  } else if (uiState.activeSheet === 'books') {
    sheetHtml = renderBookSwitcherSheet(lang);
  } else if (uiState.activeSheet === 'cloudCreate' || uiState.activeSheet === 'cloudRestore') {
    sheetHtml = renderCloudSheet(lang, uiState.activeSheet);
  } else if (uiState.activeSheet === 'proGate') {
    sheetHtml = renderProGateSheet(lang);
  }

  root.innerHTML = `
    ${screenHtml}
    ${renderUndoToast(lang)}
    ${renderBottomNav(lang)}
    ${sheetHtml}
    ${renderPhotoViewer(lang)}
  `;

  if (uiState.screen === 'card') {
    const canvas = root.querySelector('#share-card-canvas');
    if (canvas) {
      drawShareCardToCanvas(canvas, buildShareCardModel(appState));
    }
  }
  if (uiState.screen === 'receipt' && selectedCustomer) {
    const canvas = root.querySelector('#receipt-canvas');
    if (canvas) {
      try {
        drawReceiptToCanvas(canvas, buildReceiptModel(appState, { customerId: selectedCustomer.id, paymentId: uiState.receiptPaymentId }));
      } catch { /* model invalid: screen already fell back to detail */ }
    }
  }

  bindEvents(selectedCustomer, lang);
}

function bindEvents(selectedCustomer, lang) {
  const root = document.getElementById('app');
  if (!root) return;

  // Bottom navigation
  root.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.screen = btn.getAttribute('data-nav');
      uiState.activeSheet = null;
      renderApp();
    });
  });

  // Setup form live preview & submit
  const setupForm = root.querySelector('#setup-form');
  if (setupForm) {
    const nameInput = setupForm.querySelector('#setup-warung-name');
    const previewEl = setupForm.querySelector('#setup-preview-text');
    if (nameInput && previewEl) {
      nameInput.addEventListener('input', () => {
        const val = escapeHtml(nameInput.value.trim() || 'Warung Anda');
        previewEl.innerHTML = `"Assalamualaikum Pak Budi, mengingatkan catatan belanja di <strong style="color:var(--primary-dark);">${val}</strong> sebesar <strong>Rp 350.000</strong>. Terima kasih 🙏"`;
      });
    }
    setupForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(setupForm);
      appState = updateWarung(appState, {
        name: String(fd.get('name') || '').trim() || 'Warung Bu Siti',
        ownerName: String(fd.get('ownerName') || '').trim(),
        phone: String(fd.get('phone') || '').trim(),
        dueDays: Number(fd.get('dueDays') || 14),
        hasCompletedSetup: true
      });
      uiState.screen = 'list';
      renderApp();
    });
  }

  // Search input
  const searchInput = root.querySelector('#customer-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      uiState.searchQuery = e.target.value;
      const pos = e.target.selectionStart;
      renderApp();
      const nextInput = document.getElementById('customer-search-input');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(pos, pos);
      }
    });
  }

  // Risk filter chips
  root.querySelectorAll('.risk-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      uiState.riskFilter = chip.getAttribute('data-risk') || 'Semua';
      renderApp();
    });
  });

  // Customer row cards -> open detail screen
  root.querySelectorAll('.customer-row-card').forEach((card) => {
    card.addEventListener('click', () => {
      uiState.selectedCustomerId = card.getAttribute('data-customer-id');
      uiState.screen = 'detail';
      renderApp();
    });
  });

  // Back to list from detail
  const backToListBtn = root.querySelector('#btn-back-to-list');
  if (backToListBtn) {
    backToListBtn.addEventListener('click', () => {
      uiState.screen = 'list';
      renderApp();
    });
  }

  // Detail action buttons
  const openAddDebtBtn = root.querySelector('#btn-open-add-debt');
  if (openAddDebtBtn) {
    openAddDebtBtn.addEventListener('click', () => {
      uiState.activeSheet = 'addDebt';
      renderApp();
    });
  }

  const openRecordPayBtn = root.querySelector('#btn-open-record-pay');
  if (openRecordPayBtn) {
    openRecordPayBtn.addEventListener('click', () => {
      uiState.activeSheet = 'recordPay';
      renderApp();
    });
  }

  // Multi-warung: switcher sheet, switch / add / delete book
  root.querySelectorAll('#btn-open-book-switcher, #btn-settings-books').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.activeSheet = 'books';
      renderApp();
    });
  });
  root.querySelectorAll('.btn-switch-book').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-book-id');
      if (id && id !== appState.activeBookId) {
        appState = switchBook(appState, id);
        uiState.selectedCustomerId = null;
        uiState.searchQuery = '';
        uiState.riskFilter = 'Semua';
      }
      uiState.activeSheet = null;
      uiState.screen = 'list';
      renderApp();
    });
  });
  root.querySelectorAll('.btn-delete-book').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-book-id');
      const target = appState.books.find((b) => b.id === id);
      if (!target) return;
      if (!window.confirm(t(lang, 'books_delete_confirm', { nama: target.warung.name }))) return;
      try {
        appState = deleteBook(appState, id);
      } catch {
        return;
      }
      uiState.selectedCustomerId = null;
      uiState.activeSheet = null;
      uiState.screen = 'list';
      showUndoToast(t(lang, 'undo_toast_book'));
      renderApp();
    });
  });
  const addBookForm = root.querySelector('#form-add-book');
  if (addBookForm) {
    addBookForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = String(new FormData(addBookForm).get('name') || '').trim();
      if (!name) return;
      try {
        appState = addBook(appState, { name });
      } catch (err) {
        if (err && err.code === 'PRO_LIMIT_REACHED') {
          uiState.activeSheet = 'proGate';
          renderApp();
        }
        return;
      }
      uiState.selectedCustomerId = null;
      uiState.searchQuery = '';
      uiState.riskFilter = 'Semua';
      uiState.activeSheet = null;
      uiState.screen = 'setup'; // fill in owner / phone / due days for the new warung
      renderApp();
    });
  }
  const booksProGateBtn = root.querySelector('#btn-books-pro-gate');
  if (booksProGateBtn) {
    booksProGateBtn.addEventListener('click', () => {
      uiState.billingNotice = '';
      uiState.activeSheet = 'proGate';
      renderApp();
    });
  }

  // Book switch: Piutang (pelanggan) | Hutang (supplier)
  root.querySelectorAll('.book-switch-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-book') === 'supplier' ? 'supplier' : 'customer';
      if (next === uiState.book) return;
      uiState.book = next;
      uiState.selectedCustomerId = null;
      uiState.searchQuery = '';
      uiState.riskFilter = 'Semua';
      uiState.activeSheet = null;
      renderApp();
    });
  });

  // Supplier "ingatkan saya" plan
  const openPayPlanBtn = root.querySelector('#btn-open-pay-plan');
  if (openPayPlanBtn) {
    openPayPlanBtn.addEventListener('click', () => {
      uiState.activeSheet = 'payPlan';
      renderApp();
    });
  }
  const payPlanForm = root.querySelector('#form-pay-plan');
  if (payPlanForm && selectedCustomer && isSupplierBook()) {
    payPlanForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(payPlanForm);
      const date = String(fd.get('date') || '');
      const note = String(fd.get('note') || '').trim();
      appState = setSupplierPayPlan(appState, selectedCustomer.id, date || note ? { date: date || null, note } : null);
      uiState.activeSheet = null;
      renderApp();
    });
    const clearPlanBtn = payPlanForm.querySelector('#btn-plan-clear');
    if (clearPlanBtn) {
      clearPlanBtn.addEventListener('click', () => {
        appState = setSupplierPayPlan(appState, selectedCustomer.id, null);
        uiState.activeSheet = null;
        renderApp();
      });
    }
  }

  // Statistik screen
  const openStatsBtn = root.querySelector('#btn-open-stats');
  if (openStatsBtn) {
    openStatsBtn.addEventListener('click', () => {
      uiState.statsReturnScreen = uiState.screen === 'settings' ? 'settings' : 'list';
      uiState.screen = 'stats';
      renderApp();
    });
  }
  const backFromStatsBtn = root.querySelector('#btn-back-from-stats');
  if (backFromStatsBtn) {
    backFromStatsBtn.addEventListener('click', () => {
      uiState.screen = uiState.statsReturnScreen || 'list';
      renderApp();
    });
  }

  // Broadcast reminders (Chanda "next pending" loop): send opens wa.me + logs, next advances
  const openBroadcastBtn = root.querySelector('#btn-open-broadcast');
  if (openBroadcastBtn) {
    openBroadcastBtn.addEventListener('click', () => {
      uiState.broadcast = { index: 0, sentIds: [], tone: appState.settings.tone || 'sopan' };
      uiState.screen = 'broadcast';
      renderApp();
    });
  }

  const broadcastSendEl = root.querySelector('#btn-broadcast-send');
  if (broadcastSendEl) {
    broadcastSendEl.addEventListener('click', () => {
      const customerId = broadcastSendEl.getAttribute('data-customer-id');
      if (customerId && !uiState.broadcast.sentIds.includes(customerId)) {
        uiState.broadcast.sentIds.push(customerId);
        try {
          appState = logReminder(appState, { customerId, tone: uiState.broadcast.tone });
        } catch { /* customer vanished mid-queue */ }
      }
      setTimeout(() => renderApp(), 200);
    });
  }

  const broadcastNextBtn = root.querySelector('#btn-broadcast-next');
  if (broadcastNextBtn) {
    broadcastNextBtn.addEventListener('click', () => {
      uiState.broadcast.index += 1;
      renderApp();
    });
  }

  const broadcastFinishBtn = root.querySelector('#btn-broadcast-finish');
  if (broadcastFinishBtn) {
    broadcastFinishBtn.addEventListener('click', () => {
      uiState.screen = 'list';
      renderApp();
    });
  }

  if (uiState.screen === 'broadcast') {
    root.querySelectorAll('.tone-picker-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.broadcast.tone = btn.getAttribute('data-tone') || 'sopan';
        renderApp();
      });
    });
  }

  // Per-customer delete: confirm, then 5-second undo via the store snapshot
  const deleteCustomerBtn = root.querySelector('#btn-delete-customer');
  if (deleteCustomerBtn && selectedCustomer) {
    deleteCustomerBtn.addEventListener('click', () => {
      if (!window.confirm(bk(lang, 'customer_delete_confirm').replace('{nama}', selectedCustomer.name))) return;
      // Photos of this party's debts are purged once the 5 s undo window closes
      uiState.pendingPhotoPurge = bookDebts().filter((d) => d.customerId === selectedCustomer.id).map((d) => d.id);
      appState = bookFns().deleteParty(appState, selectedCustomer.id);
      uiState.selectedCustomerId = null;
      uiState.activeSheet = null;
      uiState.screen = 'list';
      showUndoToast(bk(lang, 'undo_toast_customer'));
      renderApp();
    });
  }

  const openMergeBtn = root.querySelector('#btn-open-merge');
  if (openMergeBtn) {
    openMergeBtn.addEventListener('click', () => {
      uiState.activeSheet = 'merge';
      renderApp();
    });
  }

  const mergeForm = root.querySelector('#form-merge-customer');
  if (mergeForm && selectedCustomer) {
    mergeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const targetId = String(new FormData(mergeForm).get('targetId') || '');
      const target = wb().customers.find((c) => c.id === targetId);
      if (!target) return;
      if (!window.confirm(t(lang, 'sheet_merge_confirm', { sumber: selectedCustomer.name, tujuan: target.name }))) return;
      appState = mergeCustomers(appState, selectedCustomer.id, targetId);
      uiState.selectedCustomerId = targetId;
      uiState.activeSheet = null;
      showUndoToast(t(lang, 'undo_toast_merge'));
      renderApp();
    });
  }

  const goReminderBtn = root.querySelector('#btn-go-reminder');
  if (goReminderBtn) {
    goReminderBtn.addEventListener('click', () => {
      uiState.reminderTone = appState.settings.tone || 'sopan';
      uiState.messageEdited = false;
      uiState.sentFeedback = false;
      uiState.attachQris = false;
      uiState.qrisFallbackHint = false;
      uiState.screen = 'reminder';
      renderApp();
    });
  }

  // Reminder / receipt screen events
  root.querySelectorAll('#btn-back-to-detail, #btn-back-to-detail-bottom').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.screen = 'detail';
      renderApp();
    });
  });

  // Photo notes: view, attach to an existing utang, pick one in the add-debt sheet
  root.querySelectorAll('.btn-view-photo').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.photoViewerDebtId = btn.getAttribute('data-debt-id');
      renderApp();
    });
  });

  const photoAttachInput = root.querySelector('#photo-attach-input');
  root.querySelectorAll('.btn-attach-photo').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!photoAttachInput) return;
      photoAttachInput.dataset.debtId = btn.getAttribute('data-debt-id') || '';
      photoAttachInput.click();
    });
  });
  if (photoAttachInput) {
    photoAttachInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      const debtId = photoAttachInput.dataset.debtId;
      if (!file || !debtId) return;
      try {
        const dataUrl = await resizeImageFile(file, PHOTO_MAX_PX);
        await putPhoto(debtId, dataUrl);
        uiState.photos[debtId] = dataUrl;
        renderApp();
      } catch (err) {
        console.error('Photo attach failed:', err);
        window.alert(t(lang, 'photo_failed'));
      }
    });
  }

  const debtPhotoInput = root.querySelector('#debt-photo-input');
  if (debtPhotoInput) {
    debtPhotoInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        uiState.pendingPhotoDataUrl = await resizeImageFile(file, PHOTO_MAX_PX);
        renderApp();
      } catch (err) {
        console.error('Photo read failed:', err);
        const status = root.querySelector('#debt-photo-status');
        if (status) status.textContent = t(lang, 'photo_failed');
      }
    });
  }

  const photoCloseBtn = root.querySelector('#btn-photo-close');
  if (photoCloseBtn) {
    photoCloseBtn.addEventListener('click', () => {
      uiState.photoViewerDebtId = null;
      renderApp();
    });
  }
  const photoDeleteBtn = root.querySelector('#btn-photo-delete');
  if (photoDeleteBtn) {
    photoDeleteBtn.addEventListener('click', async () => {
      const id = uiState.photoViewerDebtId;
      if (!id || !window.confirm(t(lang, 'photo_delete_confirm'))) return;
      await removePhotosForDebts([id]);
      uiState.photoViewerDebtId = null;
      renderApp();
    });
  }

  // Pro+ cloud backup: create vault, restore, back up now, auto toggle, forget, delete remote
  const cloudProGateBtn = root.querySelector('#btn-cloud-pro-gate');
  if (cloudProGateBtn) {
    cloudProGateBtn.addEventListener('click', () => {
      uiState.billingNotice = '';
      uiState.activeSheet = 'proGate';
      renderApp();
    });
  }
  root.querySelectorAll('#btn-cloud-create, #btn-cloud-restore').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.cloudError = '';
      uiState.cloudNotice = '';
      uiState.activeSheet = btn.id === 'btn-cloud-create' ? 'cloudCreate' : 'cloudRestore';
      renderApp();
    });
  });
  const cloudForm = root.querySelector('#form-cloud');
  if (cloudForm) {
    cloudForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (uiState.cloudBusy) return;
      const fd = new FormData(cloudForm);
      const passphrase = String(fd.get('passphrase') || '');
      const mode = cloudForm.dataset.mode;
      if (!validatePassphrase(passphrase).ok) {
        uiState.cloudError = t(lang, 'cloud_err_short');
        renderApp();
        return;
      }
      if (mode === 'cloudCreate' && passphrase !== String(fd.get('passphrase2') || '')) {
        uiState.cloudError = t(lang, 'cloud_err_mismatch');
        renderApp();
        return;
      }
      const vaultId = mode === 'cloudCreate' ? newVaultId() : normalizeVaultId(fd.get('vaultId'));
      if (!isValidVaultId(vaultId)) {
        uiState.cloudError = t(lang, 'cloud_err_code');
        renderApp();
        return;
      }
      uiState.cloudBusy = true;
      uiState.cloudError = '';
      renderApp();
      try {
        if (mode === 'cloudCreate') {
          const payload = await encryptBackup(exportBackupJson(appState), passphrase);
          await uploadVault(vaultId, payload);
          cloudPassphrase = passphrase;
          appState = updateSettings(appState, { cloud: { vaultId, autoBackup: false, lastBackupAt: payload.updatedAt } });
          uiState.cloudNotice = t(lang, 'cloud_backup_done');
        } else {
          const payload = await downloadVault(vaultId);
          const json = await decryptBackup(payload, passphrase);
          const { state } = parseBackup(json);
          if (!window.confirm(t(lang, 'cloud_restore_confirm'))) {
            uiState.cloudBusy = false;
            renderApp();
            return;
          }
          cloudPassphrase = passphrase;
          appState = saveState({
            ...state,
            settings: { ...state.settings, cloud: { vaultId, autoBackup: false, lastBackupAt: payload.updatedAt || null } }
          });
          uiState.selectedCustomerId = null;
          uiState.cloudNotice = t(lang, 'cloud_restore_done');
        }
        uiState.activeSheet = null;
      } catch (err) {
        console.error('Cloud vault failed:', err);
        uiState.cloudError = cloudErrorText(lang, err);
      }
      uiState.cloudBusy = false;
      renderApp();
    });
  }
  const cloudBackupNowBtn = root.querySelector('#btn-cloud-backup-now');
  if (cloudBackupNowBtn) {
    cloudBackupNowBtn.addEventListener('click', () => {
      uiState.cloudNotice = '';
      runCloudBackup(lang);
    });
  }
  const cloudAutoBtn = root.querySelector('#btn-cloud-auto');
  if (cloudAutoBtn) {
    cloudAutoBtn.addEventListener('click', () => {
      const cloud = appState.settings.cloud;
      const next = !cloud.autoBackup;
      if (next && !askPassphrase(lang)) return;
      appState = updateSettings(appState, { cloud: { ...cloud, autoBackup: next } });
      if (!next) scheduleAutoBackup.cancel();
      renderApp();
    });
  }
  const cloudCopyBtn = root.querySelector('#btn-cloud-copy');
  if (cloudCopyBtn) {
    cloudCopyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(appState.settings.cloud.vaultId);
        uiState.cloudCopied = true;
        renderApp();
        setTimeout(() => { uiState.cloudCopied = false; renderApp(); }, 1500);
      } catch { /* clipboard unavailable: the code is visible on screen */ }
    });
  }
  const cloudForgetBtn = root.querySelector('#btn-cloud-forget');
  if (cloudForgetBtn) {
    cloudForgetBtn.addEventListener('click', () => {
      if (!window.confirm(t(lang, 'settings_cloud_forget_confirm'))) return;
      cloudPassphrase = null;
      scheduleAutoBackup.cancel();
      appState = updateSettings(appState, { cloud: { vaultId: '', autoBackup: false, lastBackupAt: null } });
      uiState.cloudNotice = '';
      renderApp();
    });
  }
  const cloudDeleteRemoteBtn = root.querySelector('#btn-cloud-delete-remote');
  if (cloudDeleteRemoteBtn) {
    cloudDeleteRemoteBtn.addEventListener('click', async () => {
      if (!window.confirm(t(lang, 'settings_cloud_delete_remote_confirm'))) return;
      const { vaultId } = appState.settings.cloud;
      try {
        await deleteVault(vaultId);
      } catch (err) {
        uiState.cloudError = cloudErrorText(lang, err);
        renderApp();
        return;
      }
      cloudPassphrase = null;
      scheduleAutoBackup.cancel();
      appState = updateSettings(appState, { cloud: { vaultId: '', autoBackup: false, lastBackupAt: null } });
      uiState.cloudNotice = '';
      renderApp();
    });
  }

  // QRIS: upload / delete in Settings, toggle + send on the reminder screen
  const qrisInput = root.querySelector('#input-qris-file');
  if (qrisInput) {
    qrisInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const key = qrisKey(appState.activeBookId);
        const dataUrl = await resizeImageFile(file, QRIS_MAX_PX, 0.9);
        await putPhoto(key, dataUrl);
        uiState.photos[key] = dataUrl;
        renderApp();
      } catch (err) {
        console.error('QRIS upload failed:', err);
        window.alert(t(lang, 'photo_failed'));
      }
    });
  }
  const deleteQrisBtn = root.querySelector('#btn-delete-qris');
  if (deleteQrisBtn) {
    deleteQrisBtn.addEventListener('click', async () => {
      if (!window.confirm(t(lang, 'settings_qris_delete_confirm'))) return;
      await removePhotosForDebts([qrisKey(appState.activeBookId)]);
      uiState.attachQris = false;
      renderApp();
    });
  }
  const toggleQrisBtn = root.querySelector('#btn-toggle-qris');
  if (toggleQrisBtn) {
    toggleQrisBtn.addEventListener('click', () => {
      uiState.attachQris = !uiState.attachQris;
      uiState.qrisFallbackHint = false;
      uiState.sentFeedback = false;
      renderApp();
    });
  }
  const sendWaQrisBtn = root.querySelector('#btn-send-wa-qris');
  if (sendWaQrisBtn && selectedCustomer) {
    sendWaQrisBtn.addEventListener('click', async () => {
      const qris = qrisDataUrl();
      if (!qris) return;
      const waHref = sendWaQrisBtn.getAttribute('data-wa-href') || '';
      const baseMsg = uiState.messageEdited ? ensureShareLine(uiState.customMessage) : composeReminder(selectedCustomer, uiState.reminderTone || 'sopan');
      try {
        const payload = buildQrisSharePayload({ message: baseMsg, qrisDataUrl: qris, warungName: wb().warung.name });
        const res = await shareReminderWithQris(payload, { waHref });
        if (res.method === 'cancelled') return;
        uiState.qrisFallbackHint = res.method === 'fallback';
        if (!uiState.sentFeedback) {
          appState = logReminder(appState, { customerId: selectedCustomer.id, tone: uiState.reminderTone || 'sopan', book: 'customer' });
        }
        uiState.sentFeedback = true;
      } catch (err) {
        console.error('QRIS share failed:', err);
      }
      renderApp();
    });
  }

  // Receipt card: open from the post-payment banner or any payment row
  root.querySelectorAll('.btn-open-receipt').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.receiptPaymentId = btn.getAttribute('data-payment-id');
      uiState.lastPaymentId = null;
      uiState.screen = 'receipt';
      renderApp();
    });
  });

  const shareReceiptBtn = root.querySelector('#btn-share-receipt');
  const downloadReceiptBtn = root.querySelector('#btn-download-receipt');
  const receiptAction = async (forceDownload) => {
    const canvas = root.querySelector('#receipt-canvas');
    if (!canvas || !selectedCustomer) return;
    try {
      const model = buildReceiptModel(appState, { customerId: selectedCustomer.id, paymentId: uiState.receiptPaymentId });
      await shareOrDownloadReceipt(canvas, model, { forceDownload });
    } catch (err) {
      console.error('Receipt share failed:', err);
    }
  };
  if (shareReceiptBtn) shareReceiptBtn.addEventListener('click', () => receiptAction(false));
  if (downloadReceiptBtn) downloadReceiptBtn.addEventListener('click', () => receiptAction(true));

  if (uiState.screen === 'reminder') {
    root.querySelectorAll('.tone-picker-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.reminderTone = btn.getAttribute('data-tone') || 'sopan';
        uiState.messageEdited = false;
        uiState.sentFeedback = false;
        renderApp();
      });
    });
  }

  const reminderTextarea = root.querySelector('#reminder-custom-textarea');
  if (reminderTextarea && selectedCustomer) {
    reminderTextarea.addEventListener('input', (e) => {
      uiState.customMessage = e.target.value;
      uiState.messageEdited = true;
      const fullMsg = ensureShareLine(uiState.customMessage);
      const previewBubble = root.querySelector('#wa-bubble-preview-text');
      if (previewBubble) {
        previewBubble.innerHTML = formatWaBoldHtml(fullMsg);
      }
      const waLinkEl = root.querySelector('#btn-send-wa-link');
      if (waLinkEl) {
        waLinkEl.setAttribute('href', buildWaLink(selectedCustomer.phone62 || selectedCustomer.phoneRaw, fullMsg));
      }
    });
  }

  const sendWaLinkEl = root.querySelector('#btn-send-wa-link');
  if (sendWaLinkEl && selectedCustomer) {
    sendWaLinkEl.addEventListener('click', () => {
      if (!uiState.sentFeedback) {
        try {
          appState = logReminder(appState, {
            customerId: selectedCustomer.id,
            tone: isSupplierBook() ? 'sopan' : uiState.reminderTone || 'sopan',
            book: uiState.book
          });
        } catch { /* ignore */ }
      }
      uiState.sentFeedback = true;
      setTimeout(() => renderApp(), 200);
    });
  }

  const showCardBtn = root.querySelector('#btn-show-card');
  if (showCardBtn) {
    showCardBtn.addEventListener('click', () => {
      uiState.screen = 'card';
      renderApp();
    });
  }

  // Share Card screen events
  const backFromCardBtn = root.querySelector('#btn-back-from-card');
  if (backFromCardBtn) {
    backFromCardBtn.addEventListener('click', () => {
      uiState.screen = selectedCustomer ? 'reminder' : 'list';
      renderApp();
    });
  }

  const backFromCardBottomBtn = root.querySelector('#btn-back-from-card-bottom');
  if (backFromCardBottomBtn) {
    backFromCardBottomBtn.addEventListener('click', () => {
      uiState.screen = selectedCustomer ? 'reminder' : 'list';
      renderApp();
    });
  }

  const shareCardNativeBtn = root.querySelector('#btn-share-card-native');
  if (shareCardNativeBtn) {
    shareCardNativeBtn.addEventListener('click', async () => {
      const canvas = root.querySelector('#share-card-canvas');
      if (canvas) {
        await shareOrDownloadCard(canvas, buildShareCardModel(appState), { forceDownload: false });
      }
    });
  }

  const downloadCardPngBtn = root.querySelector('#btn-download-card-png');
  if (downloadCardPngBtn) {
    downloadCardPngBtn.addEventListener('click', async () => {
      const canvas = root.querySelector('#share-card-canvas');
      if (canvas) {
        await shareOrDownloadCard(canvas, buildShareCardModel(appState), { forceDownload: true });
      }
    });
  }

  // Settings screen events
  const defaultToneSelect = root.querySelector('#settings-default-tone');
  if (defaultToneSelect) {
    defaultToneSelect.addEventListener('change', (e) => {
      appState = updateSettings(appState, { tone: e.target.value });
      renderApp();
    });
  }

  const toggleLangBtn = root.querySelector('#btn-toggle-lang');
  if (toggleLangBtn) {
    toggleLangBtn.addEventListener('click', () => {
      appState = updateSettings(appState, { lang: appState.settings.lang === 'en' ? 'id' : 'en' });
      renderApp();
    });
  }

  const toggleDarkBtn = root.querySelector('#btn-toggle-dark');
  if (toggleDarkBtn) {
    toggleDarkBtn.addEventListener('click', () => {
      appState = updateSettings(appState, { darkMode: !appState.settings.darkMode });
      renderApp();
    });
  }

  // Pro custom template editor: live preview, variable chips, save, reset
  const templateTextarea = root.querySelector('#settings-template-textarea');
  const templatePreviewEl = root.querySelector('#settings-template-preview');
  const templateStatusEl = root.querySelector('#settings-template-status');
  if (templateTextarea && templatePreviewEl) {
    templateTextarea.addEventListener('input', () => {
      templatePreviewEl.innerHTML = formatWaBoldHtml(templatePreview(templateTextarea.value));
    });
    root.querySelectorAll('.tpl-var-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const v = chip.getAttribute('data-var') || '';
        const start = templateTextarea.selectionStart ?? templateTextarea.value.length;
        const end = templateTextarea.selectionEnd ?? start;
        templateTextarea.value = templateTextarea.value.slice(0, start) + v + templateTextarea.value.slice(end);
        templateTextarea.focus();
        templateTextarea.setSelectionRange(start + v.length, start + v.length);
        templatePreviewEl.innerHTML = formatWaBoldHtml(templatePreview(templateTextarea.value));
      });
    });
    const saveTplBtn = root.querySelector('#btn-template-save');
    if (saveTplBtn) {
      saveTplBtn.addEventListener('click', () => {
        appState = updateSettings(appState, { customTemplate: templateTextarea.value.trim() });
        if (templateStatusEl) templateStatusEl.textContent = t(lang, 'settings_template_saved');
      });
    }
    const resetTplBtn = root.querySelector('#btn-template-reset');
    if (resetTplBtn) {
      resetTplBtn.addEventListener('click', () => {
        if (appState.settings.customTemplate && !window.confirm(t(lang, 'settings_template_reset_confirm'))) return;
        appState = updateSettings(appState, { customTemplate: '' });
        if (uiState.reminderTone === 'custom') uiState.reminderTone = 'sopan';
        renderApp();
      });
    }
  }
  const templateProGateBtn = root.querySelector('#btn-template-pro-gate');
  if (templateProGateBtn) {
    templateProGateBtn.addEventListener('click', () => {
      uiState.billingNotice = '';
      uiState.activeSheet = 'proGate';
      renderApp();
    });
  }

  // Demo data replaces every customer/debt/payment, so ask first when real data exists
  const confirmDemoLoad = () =>
    wb().customers.length === 0 || window.confirm(t(lang, 'settings_demo_confirm'));

  const loadDemo6Btn = root.querySelector('#btn-load-demo-6');
  if (loadDemo6Btn) {
    loadDemo6Btn.addEventListener('click', () => {
      if (!confirmDemoLoad()) return;
      appState = seedDemoData(appState, globalThis.localStorage, { count: 6 });
      uiState.screen = 'list';
      renderApp();
    });
  }

  const loadDemo12Btn = root.querySelector('#btn-load-demo-12');
  if (loadDemo12Btn) {
    loadDemo12Btn.addEventListener('click', () => {
      if (!confirmDemoLoad()) return;
      appState = seedDemoData(appState, globalThis.localStorage, { count: 12 });
      uiState.screen = 'list';
      renderApp();
    });
  }

  const wipeAllBtn = root.querySelector('#btn-wipe-all');
  if (wipeAllBtn) {
    wipeAllBtn.addEventListener('click', () => {
      if (!window.confirm(t(lang, 'settings_wipe_confirm'))) return;
      if (undoTimer) clearTimeout(undoTimer);
      clearUndo();
      uiState.toastMessage = null;
      uiState.selectedCustomerId = null;
      uiState.searchQuery = '';
      uiState.riskFilter = 'Semua';
      uiState.photos = {};
      uiState.photoViewerDebtId = null;
      clearPhotos().catch(() => {});
      appState = saveState(createInitialState());
      uiState.screen = 'setup';
      renderApp();
    });
  }

  const exportJsonBtn = root.querySelector('#btn-export-json');
  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', () => {
      const json = exportBackupJson(appState, { photos: uiState.photos });
      triggerFileDownload(json, 'kilat-cadangan.json', 'application/json');
    });
  }

  const importJsonInput = root.querySelector('#input-import-json');
  if (importJsonInput) {
    importJsonInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (wb().customers.length > 0 && !window.confirm(t(lang, 'settings_import_confirm'))) {
        e.target.value = '';
        return;
      }
      try {
        const text = await file.text();
        const { state, photos } = parseBackup(text);
        appState = saveState(state);
        if (Object.keys(photos).length > 0) {
          await importPhotos(photos);
          uiState.photos = { ...uiState.photos, ...photos };
        }
        uiState.selectedCustomerId = null;
        uiState.screen = 'list';
        renderApp();
      } catch (err) {
        console.error('Import JSON failed:', err);
        window.alert(t(lang, 'settings_import_failed'));
        e.target.value = '';
      }
    });
  }

  const exportCsvBtn = root.querySelector('#btn-export-csv');
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => {
      try {
        const csv = exportCsv(appState);
        triggerFileDownload(csv, 'kilat-laporan-piutang.csv', 'text/csv;charset=utf-8');
      } catch (err) {
        if (err && err.code === 'PRO_REQUIRED') {
          uiState.activeSheet = 'proGate';
          renderApp();
        }
      }
    });
  }

  // Quick amount chips in Add Debt sheet
  root.querySelectorAll('.quick-amt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const amtInput = root.querySelector('#debt-amount');
      if (amtInput) {
        amtInput.value = btn.getAttribute('data-amt') || '';
      }
    });
  });

  // Fill full balance button in Record Pay sheet
  const fullPayBtn = root.querySelector('#btn-fill-full-balance');
  if (fullPayBtn) {
    fullPayBtn.addEventListener('click', () => {
      const payInput = root.querySelector('#pay-amount');
      if (payInput) {
        payInput.value = fullPayBtn.getAttribute('data-balance') || '';
      }
    });
  }

  // Submit Add Debt sheet
  const addDebtForm = root.querySelector('#form-add-debt');
  if (addDebtForm && selectedCustomer) {
    addDebtForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(addDebtForm);
      appState = bookFns().addDebt(appState, {
        customerId: selectedCustomer.id,
        amountIdr: fd.get('amountIdr'),
        note: fd.get('note'),
        date: fd.get('date'),
        dueDate: String(fd.get('dueDate') || '') || null
      });
      uiState.activeSheet = null;
      const allDebts = bookDebts();
      const newestDebt = allDebts[allDebts.length - 1];
      if (uiState.pendingPhotoDataUrl && newestDebt) {
        const dataUrl = uiState.pendingPhotoDataUrl;
        uiState.photos[newestDebt.id] = dataUrl;
        putPhoto(newestDebt.id, dataUrl).catch((err) => console.error('Photo save failed:', err));
      }
      uiState.pendingPhotoDataUrl = null;
      showUndoToast(bk(lang, 'undo_toast_debt'));
      renderApp();
    });
  }

  // Submit Record Payment sheet
  const recordPayForm = root.querySelector('#form-record-pay');
  if (recordPayForm && selectedCustomer) {
    recordPayForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(recordPayForm);
      appState = bookFns().addPayment(appState, {
        customerId: selectedCustomer.id,
        amountIdr: fd.get('amountIdr'),
        note: fd.get('note'),
        date: fd.get('date')
      });
      uiState.activeSheet = null;
      const newest = isSupplierBook() ? null : wb().payments[wb().payments.length - 1];
      uiState.lastPaymentId = newest ? newest.id : null;
      showUndoToast(t(lang, 'undo_toast_payment'));
      renderApp();
    });
  }

  // Undo toast button
  const undoBtn = root.querySelector('#btn-undo-action');
  if (undoBtn) {
    undoBtn.addEventListener('click', () => {
      const meta = getUndoMeta();
      const restored = undoLastAction();
      if (restored) {
        appState = restored;
        uiState.pendingPhotoPurge = null; // customer restored: keep their photos
        if (meta && meta.type === 'debt' && meta.entryId) removePhotosForDebts([meta.entryId]);
      }
      if (undoTimer) clearTimeout(undoTimer);
      uiState.toastMessage = null;
      renderApp();
    });
  }

  // Seed demo data button when empty
  const seedBtn = root.querySelector('#btn-seed-demo-empty');
  if (seedBtn) {
    seedBtn.addEventListener('click', () => {
      appState = seedDemoData(appState, globalThis.localStorage, { count: 6 });
      renderApp();
    });
  }

  // Open add customer sheet (check 25-customer free tier limit first)
  const addCustBtn = root.querySelector('#btn-open-add-customer');
  if (addCustBtn) {
    addCustBtn.addEventListener('click', () => {
      if (!isSupplierBook() && !canAddCustomer(appState)) {
        uiState.activeSheet = 'proGate';
      } else {
        uiState.activeSheet = 'addCustomer';
      }
      renderApp();
    });
  }

  // Cancel sheet
  const cancelBtn = root.querySelector('#btn-cancel-sheet');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      uiState.activeSheet = null;
      uiState.pendingPhotoDataUrl = null;
      renderApp();
    });
  }

  const openProGateBtn = root.querySelector('#btn-open-pro-gate');
  if (openProGateBtn) {
    openProGateBtn.addEventListener('click', () => {
      uiState.billingNotice = '';
      uiState.activeSheet = 'proGate';
      renderApp();
    });
  }

  const buyProBtn = root.querySelector('#btn-buy-pro');
  if (buyProBtn) {
    buyProBtn.addEventListener('click', async () => {
      if (uiState.billingBusy) return;
      uiState.billingBusy = true;
      uiState.billingNotice = '';
      renderApp();
      try {
        await buyPro();
        appState = updateSettings(appState, { isPro: true });
        uiState.billingNotice = t(lang, 'pro_active');
      } catch (err) {
        uiState.billingNotice = t(lang, err && err.code === 'cancelled' ? 'purchase_cancelled' : 'purchase_failed');
      }
      uiState.billingBusy = false;
      renderApp();
    });
  }

  const restoreProBtn = root.querySelector('#btn-restore-pro');
  if (restoreProBtn) {
    restoreProBtn.addEventListener('click', async () => {
      if (uiState.billingBusy) return;
      uiState.billingBusy = true;
      renderApp();
      const owned = await hasProPurchase();
      if (owned) {
        appState = updateSettings(appState, { isPro: true });
        uiState.billingNotice = t(lang, 'pro_active');
      } else {
        uiState.billingNotice = t(lang, 'no_purchase_found');
      }
      uiState.billingBusy = false;
      renderApp();
    });
  }

  // Add customer submit
  const addCustForm = root.querySelector('#form-add-customer');
  if (addCustForm) {
    addCustForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(addCustForm);

      // Duplicate-phone detection: warn once, offer to open the existing customer, or save anyway
      const dup = findCustomerByPhone(appState, fd.get('phone'), { book: uiState.book });
      if (dup && addCustForm.dataset.dupAck !== dup.id) {
        let warn = addCustForm.querySelector('#dup-phone-warning');
        if (!warn) {
          warn = document.createElement('div');
          warn.id = 'dup-phone-warning';
          warn.setAttribute('role', 'alert');
          warn.style.cssText = 'background:var(--amber-light); border:1.5px solid var(--amber); border-radius:var(--radius-sm); padding:12px 14px; display:flex; flex-direction:column; gap:8px;';
          addCustForm.insertBefore(warn, addCustForm.lastElementChild);
        }
        warn.innerHTML = `
          <div style="font-size:13px; color:var(--text); line-height:1.5;">${escapeHtml(t(lang, 'dup_phone_warning', { nama: dup.name }))}</div>
          <div style="display:flex; gap:8px;">
            <button type="button" id="btn-dup-open" class="btn-secondary" style="flex:1; font-size:13px;">${escapeHtml(t(lang, 'dup_phone_open_btn'))}</button>
            <button type="button" id="btn-dup-save-anyway" class="btn-secondary" style="flex:1; font-size:13px;">${escapeHtml(t(lang, 'dup_phone_save_anyway_btn'))}</button>
          </div>`;
        warn.querySelector('#btn-dup-open').addEventListener('click', () => {
          uiState.selectedCustomerId = dup.id;
          uiState.screen = 'detail';
          uiState.activeSheet = null;
          renderApp();
        });
        warn.querySelector('#btn-dup-save-anyway').addEventListener('click', () => {
          addCustForm.dataset.dupAck = dup.id;
          addCustForm.requestSubmit();
        });
        return;
      }

      try {
        appState = bookFns().addParty(appState, {
          name: fd.get('name'),
          phone: fd.get('phone'),
          note: fd.get('note'),
          initialDebtIdr: fd.get('initialDebtIdr'),
          daysAgo: fd.get('daysAgo')
        });
        uiState.activeSheet = null;
        renderApp();
      } catch (err) {
        if (err && err.code === 'PRO_LIMIT_REACHED') {
          uiState.activeSheet = 'proGate';
          renderApp();
        }
      }
    });
  }

}

export async function initApp() {
  await loadDictionaries();
  appState = loadState();
  // First run: show setup with an empty ledger. Demo data is opt-in (empty-list CTA / Settings),
  // never auto-seeded, so a real warung never starts with fake customers it cannot remove.
  uiState.screen = appState.settings.hasCompletedSetup ? 'list' : 'setup';
  saveState(appState);
  renderApp();

  // Pro+ auto cloud backup: every saved change schedules one encrypted upload 30 s later
  onStateSaved(() => {
    if (appState && appState.settings.cloud.autoBackup && appState.settings.cloud.vaultId) scheduleAutoBackup();
  });

  // Photo notes live in IndexedDB; mirror them into memory for thumbnails (optional, never blocks)
  try {
    uiState.photos = (await getAllPhotos()) || {};
    renderApp();
  } catch {
    uiState.photos = {};
  }

  // Play Billing: only inside the Play-installed app. Restores Pro on reinstall / new phone.
  try {
    uiState.billingAvailable = await isPlayBillingAvailable();
    if (uiState.billingAvailable) {
      const [price, owned] = await Promise.all([getProPrice(), hasProPurchase()]);
      uiState.proPrice = price;
      if (owned && !appState.settings.isPro) appState = updateSettings(appState, { isPro: true });
      renderApp();
    }
  } catch {
    /* billing is optional */
  }

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initApp().catch((err) => console.error('Kilat init failed:', err));
  });
}
