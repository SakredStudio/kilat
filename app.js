// Kilat — Main Application Controller (P0 shell, wired through P1–P5)
import { registerTranslations, t } from './lib/i18n.js';
import { loadState, saveState } from './lib/store.js';

async function loadDictionaries() {
  const [idRes, enRes] = await Promise.all([
    fetch('./i18n/id.json'),
    fetch('./i18n/en.json')
  ]);
  const [idDict, enDict] = await Promise.all([idRes.json(), enRes.json()]);
  registerTranslations('id', idDict);
  registerTranslations('en', enDict);
}

export async function initApp() {
  await loadDictionaries();
  const state = loadState();
  saveState(state);
  const root = document.getElementById('app');
  if (root) {
    const lang = state.settings.lang;
    root.innerHTML = `<div class="hero-header"><h1 class="hero-title">${t(lang, 'app_name')}</h1><p class="hero-subtitle">${t(lang, 'app_tagline')}</p></div>`;
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initApp().catch((err) => console.error('Kilat init failed:', err));
  });
}
