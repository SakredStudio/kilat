// Kilat — Main Application Controller (P0–P5)
import { registerTranslations, t } from './lib/i18n.js';
import { rp, avatarInitials, formatDateId } from './lib/format.js';
import { formatLocalPhone as fmtPhone } from './lib/phone.js';
import {
  loadState,
  saveState,
  updateWarung,
  updateSettings,
  canAddCustomer,
  addCustomer,
  addDebt,
  addPayment,
  undoLastAction,
  getUndoMeta,
  clearUndo,
  seedDemoData,
  exportBackupJson,
  importBackupJson,
  exportCsv
} from './lib/store.js';
import { computeWarungLedger, filterCustomers } from './lib/ledger.js';
import { buildReminderMessage, ensureShareLine, link as buildWaLink } from './lib/wa.js';
import {
  buildShareCardModel,
  drawShareCardToCanvas,
  shareOrDownloadCard
} from './lib/share-card.js';

let appState = null;
let undoTimer = null;
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
  sentFeedback: false
};

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
  const w = appState.warung;
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
  const w = appState.warung;
  const filtered = filterCustomers(ledger.customers, {
    search: uiState.searchQuery,
    riskFilter: uiState.riskFilter
  });

  const filterChips = [
    { id: 'Semua', label: t(lang, 'filter_all') },
    { id: 'Tinggi', label: t(lang, 'filter_high') },
    { id: 'Sedang', label: t(lang, 'filter_medium') },
    { id: 'Rendah', label: t(lang, 'filter_low') }
  ];

  const avatarStyles = {
    Tinggi: 'background:var(--red-light); color:var(--red);',
    Sedang: 'background:var(--amber-light); color:var(--amber);',
    Rendah: 'background:var(--primary-light); color:var(--primary-dark);'
  };

  return `
    <div class="screen-body" data-screen="list">
      <div style="background:var(--primary); padding:16px 16px 14px; color:#fff;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:12px;">
          <div>
            <div style="font-size:11px; color:rgba(255,255,255,0.75); font-weight:500;">${escapeHtml(w.name)}</div>
            <h1 style="font-family:var(--font-display); font-size:21px; color:#fff; margin-top:2px;">
              ${escapeHtml(t(lang, 'list_subtitle'))}
            </h1>
          </div>
          <div style="display:flex; gap:6px;">
            <button type="button" id="btn-open-add-customer"
              style="background:rgba(255,255,255,0.2); border:1px solid rgba(255,255,255,0.35); border-radius:10px; color:#fff; font-weight:700; font-size:13px; padding:8px 12px; min-height:44px;">
              ${escapeHtml(t(lang, 'list_add_customer'))}
            </button>
          </div>
        </div>

        <div style="background:rgba(0,0,0,0.18); border-radius:12px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div>
            <div style="font-size:11px; color:rgba(255,255,255,0.75);">${escapeHtml(t(lang, 'list_total_piutang'))}</div>
            <div id="total-piutang-value" style="font-family:var(--font-display); font-size:22px; color:#fff;">
              ${escapeHtml(rp(ledger.totalPiutang, { spaced: true }))}
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:11px; color:rgba(255,255,255,0.75);">${escapeHtml(t(lang, 'list_need_followup'))}</div>
            <div style="font-size:17px; font-weight:700; color:#FCD34D;">
              ${ledger.needFollowupCount} ${escapeHtml(t(lang, 'list_people_suffix'))}
            </div>
          </div>
        </div>
      </div>

      <div style="padding:12px 16px 8px; display:flex; flex-direction:column; gap:8px; background:var(--card); border-bottom:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:8px; background:var(--bg); border-radius:10px; padding:0 12px; border:1.5px solid var(--border);">
          <span aria-hidden="true" style="font-size:15px;">🔍</span>
          <input id="customer-search-input" type="search"
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

      <div style="flex:1; padding:10px 16px 18px; display:flex; flex-direction:column; gap:8px;">
        ${
          filtered.length === 0
            ? `<div style="text-align:center; padding:32px 16px; color:var(--text3);">
                 <p style="font-size:14px; margin-bottom:12px;">${escapeHtml(t(lang, 'empty_customers'))}</p>
                 ${
                   appState.customers.length === 0
                     ? `<button type="button" id="btn-seed-demo-empty" class="btn-secondary">${escapeHtml(t(lang, 'empty_customers_cta'))}</button>`
                     : ''
                 }
               </div>`
            : filtered
                .map((c) => {
                  const initials = avatarInitials(c.name);
                  const avStyle = avatarStyles[c.risk] || avatarStyles.Rendah;
                  const badgeClass = c.isPaid ? 'risk-Lunas' : `risk-${c.risk}`;
                  const badgeLabel = c.isPaid ? t(lang, 'risk_paid') : c.risk;
                  const amountColor =
                    c.risk === 'Tinggi'
                      ? 'var(--red)'
                      : c.risk === 'Sedang'
                        ? 'var(--amber)'
                        : 'var(--text)';
                  return `
                    <button type="button" class="customer-row-card" data-customer-id="${escapeHtml(c.id)}"
                      style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius-sm); padding:12px 14px; display:flex; align-items:center; gap:12px; text-align:left; width:100%; min-height:68px;">
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
                          ${escapeHtml(c.note || c.phoneRaw)}
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
                })
                .join('')
        }
      </div>
    </div>
  `;
}

function renderCustomerDetailScreen(lang, customer) {
  if (!customer) {
    return renderCustomerListScreen(lang, computeWarungLedger(appState));
  }
  const badgeClass = customer.isPaid ? 'risk-Lunas' : `risk-${customer.risk}`;
  const badgeLabel = customer.isPaid ? t(lang, 'risk_paid') : customer.risk;
  const amountColor =
    customer.risk === 'Tinggi'
      ? 'var(--red)'
      : customer.risk === 'Sedang'
        ? 'var(--amber)'
        : 'var(--primary-dark)';

  return `
    <div class="screen-body" data-screen="detail">
      <div class="topbar">
        <button type="button" class="back-btn" id="btn-back-to-list" aria-label="Kembali">←</button>
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
        <div style="background:var(--card); border:1.5px solid var(--border); border-radius:var(--radius); padding:16px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div>
              <div style="font-size:12px; font-weight:600; color:var(--text2); text-transform:uppercase; letter-spacing:0.3px;">
                ${escapeHtml(t(lang, 'customer_balance_label'))}
              </div>
              <div id="detail-balance-value" style="font-family:var(--font-display); font-size:28px; color:${amountColor}; margin-top:4px;">
                ${escapeHtml(rp(customer.balance, { spaced: true }))}
              </div>
            </div>
            ${
              !customer.isPaid
                ? `<div style="font-size:12px; font-weight:600; color:var(--text2); background:var(--bg2); padding:5px 10px; border-radius:99px;">
                     ${escapeHtml(t(lang, 'reminder_overdue_days', { hari: customer.daysOverdue }))}
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
              ${escapeHtml(t(lang, 'customer_add_debt_btn'))}
            </button>
            <button type="button" id="btn-open-record-pay" class="btn-primary">
              ${escapeHtml(t(lang, 'customer_record_pay_btn'))}
            </button>
          </div>

          <div style="margin-top:10px;">
            <button type="button" id="btn-go-reminder" class="btn-primary btn-wa">
              ${escapeHtml(t(lang, 'customer_send_wa_btn'))}
            </button>
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
                       const typeLabel = isDebt ? t(lang, 'entry_type_debt') : t(lang, 'entry_type_payment');
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
                           </div>
                           <div style="font-weight:700; font-size:14px; color:${amtColor}; flex-shrink:0; margin-left:10px;">
                             ${sign} ${escapeHtml(rp(entry.amountIdr, { spaced: true }))}
                           </div>
                         </div>
                       `;
                     })
                     .join('')}
                 </div>`
          }
        </div>
      </div>
    </div>
  `;
}

function renderReminderScreen(lang, customer) {
  if (!customer) {
    return renderCustomerListScreen(lang, computeWarungLedger(appState));
  }
  const w = appState.warung;
  const activeTone = uiState.reminderTone || appState.settings.tone || 'sopan';
  const generatedMsg = buildReminderMessage({
    tone: activeTone,
    nama: customer.name,
    jumlah: customer.balance,
    hari: customer.daysOverdue,
    warung: w.name
  });

  const currentMsg = uiState.messageEdited ? ensureShareLine(uiState.customMessage) : generatedMsg;
  const waHref = buildWaLink(customer.phone62 || customer.phoneRaw, currentMsg);
  const firstName = customer.name.split(' ')[0] || customer.name;

  const tones = [
    { id: 'sopan', label: t(lang, 'tone_sopan_label'), desc: t(lang, 'tone_sopan_desc') },
    { id: 'singkat', label: t(lang, 'tone_singkat_label'), desc: t(lang, 'tone_singkat_desc') },
    { id: 'tegas', label: t(lang, 'tone_tegas_label'), desc: t(lang, 'tone_tegas_desc') }
  ];

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
        <button type="button" class="back-btn" id="btn-back-to-detail" aria-label="Kembali">←</button>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:700; font-size:15px; color:var(--text);">
            ${escapeHtml(t(lang, 'reminder_title'))}
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

        <div>
          <div style="font-size:12px; font-weight:600; color:var(--text2); margin-bottom:8px; text-transform:uppercase; letter-spacing:0.3px;">
            ${escapeHtml(t(lang, 'reminder_tone_label'))}
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px;">
            ${tones
              .map((tn) => {
                const active = activeTone === tn.id;
                return `
                  <button type="button" class="tone-picker-btn" data-tone="${tn.id}"
                    style="padding:10px 6px; border-radius:var(--radius-sm); border:2px solid ${active ? 'var(--primary)' : 'var(--border)'}; background:${active ? 'var(--primary-light)' : 'var(--card)'}; display:flex; flex-direction:column; align-items:center; gap:3px; min-height:56px;">
                    <span style="font-size:13px; font-weight:700; color:${active ? 'var(--primary-dark)' : 'var(--text)'};">
                      ${escapeHtml(tn.label)}
                    </span>
                    <span style="font-size:11px; color:var(--text3);">
                      ${escapeHtml(tn.desc)}
                    </span>
                  </button>
                `;
              })
              .join('')}
          </div>
        </div>

        <div style="background:#E5DDD5; border-radius:var(--radius-sm); overflow:hidden; border:1px solid var(--border);">
          <div style="background:#075E54; padding:10px 14px; display:flex; align-items:center; gap:10px;">
            <div style="width:32px; height:32px; border-radius:50%; background:#25D366; display:flex; align-items:center; justify-content:center; font-size:15px;">
              💬
            </div>
            <div>
              <div style="font-size:13px; font-weight:700; color:#fff;">
                ${escapeHtml(t(lang, 'reminder_wa_preview_header'))}
              </div>
              <div style="font-size:11px; color:rgba(255,255,255,0.78);">
                ${escapeHtml(fmtPhone(customer.phone62 || customer.phoneRaw))}
              </div>
            </div>
          </div>

          <div style="padding:12px;">
            <div style="background:#DCF8C6; border-radius:8px 8px 2px 8px; padding:10px 12px; box-shadow:0 1px 2px rgba(0,0,0,0.12);">
              <div id="wa-bubble-preview-text" style="font-size:13px; color:#111; line-height:1.6; white-space:pre-wrap; word-break:break-word;">${formatWaBoldHtml(currentMsg)}</div>
              <div style="text-align:right; margin-top:4px; font-size:10px; color:#667781;">
                09:41 ✓✓
              </div>
            </div>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label" for="reminder-custom-textarea">
            ${escapeHtml(t(lang, 'reminder_edit_label'))}
          </label>
          <textarea id="reminder-custom-textarea" class="field-input" rows="4"
            style="resize:vertical; font-size:13px; line-height:1.5;">${escapeHtml(currentMsg)}</textarea>
        </div>

        <div style="display:flex; flex-direction:column; gap:8px; margin-top:auto;">
          <a id="btn-send-wa-link" href="${escapeHtml(waHref)}" target="_blank" rel="noopener noreferrer"
            class="btn-primary btn-wa tap-target">
            <span>${uiState.sentFeedback ? '✓' : '💬'}</span>
            <span>${escapeHtml(uiState.sentFeedback ? t(lang, 'reminder_Sent_wa_cta') : t(lang, 'reminder_send_wa_cta', { nama: firstName }))}</span>
          </a>
          <button type="button" id="btn-show-card" class="btn-secondary">
            ${escapeHtml(t(lang, 'reminder_share_card_btn'))}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderShareCardScreen(lang) {
  const model = buildShareCardModel(appState);
  return `
    <div class="screen-body" data-screen="card">
      <div class="topbar">
        <button type="button" class="back-btn" id="btn-back-from-card" aria-label="Kembali">←</button>
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
            <span style="font-size:14px; font-weight:600; color:var(--text);">${escapeHtml(t(lang, 'settings_dark_mode'))}</span>
            <button type="button" id="btn-toggle-dark" class="btn-secondary" style="width:auto; min-width:96px;">
              ${s.darkMode ? '🌙 Aktif' : '☀️ Terang'}
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
          <button type="button" id="btn-toggle-pro-mode" class="btn-secondary">
            ${escapeHtml(t(lang, 'settings_pro_toggle'))}: <strong>${s.isPro ? 'ON' : 'OFF'}</strong>
          </button>
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

        <!-- Privacy Footer -->
        <div style="padding:12px; text-align:center; font-size:12px; color:var(--text3); line-height:1.5;">
          <p>${escapeHtml(t(lang, 'privacy_notice'))}</p>
          <a href="./privacy.html" class="tap-target" style="display:inline-flex; align-items:center; justify-content:center; color:var(--primary-dark); font-weight:600; margin-top:4px; text-decoration:underline;">
            Kebijakan Privasi
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
          ${escapeHtml(t(lang, 'sheet_add_customer_title'))}
        </h2>
        <div class="field-group">
          <label class="field-label" for="add-cust-name">${escapeHtml(t(lang, 'sheet_customer_name_label'))}</label>
          <input id="add-cust-name" name="name" class="field-input" type="text" required
            placeholder="${escapeHtml(t(lang, 'sheet_customer_name_placeholder'))}" />
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
            <label class="field-label" for="add-cust-debt">${escapeHtml(t(lang, 'sheet_initial_debt_label'))}</label>
            <input id="add-cust-debt" name="initialDebtIdr" class="field-input" type="number" min="0" step="1000"
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
  const today = new Date().toISOString().slice(0, 10);
  const quickAmounts = [25000, 50000, 100000, 200000];
  return `
    <div class="sheet-backdrop" id="sheet-backdrop">
      <form class="sheet-panel" id="form-add-debt">
        <h2 style="font-family:var(--font-display); font-size:20px; color:var(--text);">
          ${escapeHtml(t(lang, 'sheet_add_debt_title'))} — ${escapeHtml(customer?.name || '')}
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
          <input id="debt-amount" name="amountIdr" class="field-input" type="number" min="100" step="500" required
            placeholder="${escapeHtml(t(lang, 'sheet_amount_placeholder'))}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="debt-note">${escapeHtml(t(lang, 'sheet_note_label'))}</label>
          <input id="debt-note" name="note" class="field-input" type="text"
            placeholder="${escapeHtml(t(lang, 'sheet_note_debt_placeholder'))}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="debt-date">${escapeHtml(t(lang, 'sheet_date_label'))}</label>
          <input id="debt-date" name="date" class="field-input" type="date" value="${today}" required />
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

function renderRecordPaySheet(lang, customer) {
  const today = new Date().toISOString().slice(0, 10);
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
          <input id="pay-amount" name="amountIdr" class="field-input" type="number" min="100" step="500" required
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
          ${escapeHtml(t(lang, 'pro_gate_title'))}
        </h2>
        <p style="font-size:14px; color:var(--text2); line-height:1.55;">
          ${escapeHtml(t(lang, 'pro_gate_desc'))}
        </p>
        <div style="display:flex; flex-direction:column; gap:8px; margin-top:6px;">
          <button type="button" id="btn-unlock-pro" class="btn-primary">
            ${escapeHtml(t(lang, 'pro_gate_unlock_btn'))}
          </button>
          <button type="button" id="btn-cancel-sheet" class="btn-secondary">
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
            (['detail', 'reminder', 'card'].includes(uiState.screen) && item.id === 'list');
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
  const ledger = computeWarungLedger(appState);
  const selectedCustomer = ledger.customers.find((c) => c.id === uiState.selectedCustomerId) || null;

  let screenHtml = '';
  if (uiState.screen === 'setup') {
    screenHtml = renderSetupScreen(lang);
  } else if (uiState.screen === 'detail' && selectedCustomer) {
    screenHtml = renderCustomerDetailScreen(lang, selectedCustomer);
  } else if (uiState.screen === 'reminder' && selectedCustomer) {
    screenHtml = renderReminderScreen(lang, selectedCustomer);
  } else if (uiState.screen === 'card') {
    screenHtml = renderShareCardScreen(lang);
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
  } else if (uiState.activeSheet === 'proGate') {
    sheetHtml = renderProGateSheet(lang);
  }

  root.innerHTML = `
    ${screenHtml}
    ${renderUndoToast(lang)}
    ${renderBottomNav(lang)}
    ${sheetHtml}
  `;

  if (uiState.screen === 'card') {
    const canvas = root.querySelector('#share-card-canvas');
    if (canvas) {
      drawShareCardToCanvas(canvas, buildShareCardModel(appState));
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

  const goReminderBtn = root.querySelector('#btn-go-reminder');
  if (goReminderBtn) {
    goReminderBtn.addEventListener('click', () => {
      uiState.reminderTone = appState.settings.tone || 'sopan';
      uiState.messageEdited = false;
      uiState.sentFeedback = false;
      uiState.screen = 'reminder';
      renderApp();
    });
  }

  // Reminder screen events
  const backToDetailBtn = root.querySelector('#btn-back-to-detail');
  if (backToDetailBtn) {
    backToDetailBtn.addEventListener('click', () => {
      uiState.screen = 'detail';
      renderApp();
    });
  }

  root.querySelectorAll('.tone-picker-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.reminderTone = btn.getAttribute('data-tone') || 'sopan';
      uiState.messageEdited = false;
      uiState.sentFeedback = false;
      renderApp();
    });
  });

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
  if (sendWaLinkEl) {
    sendWaLinkEl.addEventListener('click', () => {
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

  const toggleDarkBtn = root.querySelector('#btn-toggle-dark');
  if (toggleDarkBtn) {
    toggleDarkBtn.addEventListener('click', () => {
      appState = updateSettings(appState, { darkMode: !appState.settings.darkMode });
      renderApp();
    });
  }

  const toggleProBtn = root.querySelector('#btn-toggle-pro-mode');
  if (toggleProBtn) {
    toggleProBtn.addEventListener('click', () => {
      appState = updateSettings(appState, { isPro: !appState.settings.isPro });
      renderApp();
    });
  }

  const loadDemo6Btn = root.querySelector('#btn-load-demo-6');
  if (loadDemo6Btn) {
    loadDemo6Btn.addEventListener('click', () => {
      appState = seedDemoData(appState, globalThis.localStorage, { count: 6 });
      uiState.screen = 'list';
      renderApp();
    });
  }

  const loadDemo12Btn = root.querySelector('#btn-load-demo-12');
  if (loadDemo12Btn) {
    loadDemo12Btn.addEventListener('click', () => {
      appState = seedDemoData(appState, globalThis.localStorage, { count: 12 });
      uiState.screen = 'list';
      renderApp();
    });
  }

  const exportJsonBtn = root.querySelector('#btn-export-json');
  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', () => {
      const json = exportBackupJson(appState);
      triggerFileDownload(json, 'kilat-cadangan.json', 'application/json');
    });
  }

  const importJsonInput = root.querySelector('#input-import-json');
  if (importJsonInput) {
    importJsonInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        appState = importBackupJson(text);
        uiState.screen = 'list';
        renderApp();
      } catch (err) {
        console.error('Import JSON failed:', err);
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
      appState = addDebt(appState, {
        customerId: selectedCustomer.id,
        amountIdr: fd.get('amountIdr'),
        note: fd.get('note'),
        date: fd.get('date')
      });
      uiState.activeSheet = null;
      showUndoToast(t(lang, 'undo_toast_debt'));
      renderApp();
    });
  }

  // Submit Record Payment sheet
  const recordPayForm = root.querySelector('#form-record-pay');
  if (recordPayForm && selectedCustomer) {
    recordPayForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(recordPayForm);
      appState = addPayment(appState, {
        customerId: selectedCustomer.id,
        amountIdr: fd.get('amountIdr'),
        note: fd.get('note'),
        date: fd.get('date')
      });
      uiState.activeSheet = null;
      showUndoToast(t(lang, 'undo_toast_payment'));
      renderApp();
    });
  }

  // Undo toast button
  const undoBtn = root.querySelector('#btn-undo-action');
  if (undoBtn) {
    undoBtn.addEventListener('click', () => {
      const restored = undoLastAction();
      if (restored) {
        appState = restored;
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
      if (!canAddCustomer(appState)) {
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
      renderApp();
    });
  }

  // Add customer submit
  const addCustForm = root.querySelector('#form-add-customer');
  if (addCustForm) {
    addCustForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(addCustForm);
      try {
        appState = addCustomer(appState, {
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

  // Unlock Pro button
  const unlockProBtn = root.querySelector('#btn-unlock-pro');
  if (unlockProBtn) {
    unlockProBtn.addEventListener('click', () => {
      appState = updateSettings(appState, { isPro: true });
      uiState.activeSheet = null;
      renderApp();
    });
  }
}

export async function initApp() {
  await loadDictionaries();
  appState = loadState();
  if (appState.customers.length === 0 && !appState.settings.hasCompletedSetup) {
    appState = seedDemoData(appState, globalThis.localStorage, { count: 6 });
    uiState.screen = 'setup';
  } else {
    uiState.screen = appState.settings.hasCompletedSetup ? 'list' : 'setup';
  }
  saveState(appState);
  renderApp();

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initApp().catch((err) => console.error('Kilat init failed:', err));
  });
}
