// Pure ES module for i18n dictionary management and translation lookup (no DOM)

export const SUPPORTED_LANGS = ['id', 'en'];
export const DEFAULT_LANG = 'id';

const dictionaries = {
  id: {},
  en: {}
};

export function isValidLang(lang) {
  return SUPPORTED_LANGS.includes(lang);
}

export function normalizeLang(lang) {
  return isValidLang(lang) ? lang : DEFAULT_LANG;
}

export function registerTranslations(lang, dict) {
  if (!isValidLang(lang)) {
    throw new Error(`Unsupported language: ${lang}`);
  }
  if (!dict || typeof dict !== 'object') {
    throw new Error(`Invalid dictionary for language: ${lang}`);
  }
  dictionaries[lang] = { ...dict };
}

export function getDictionary(lang) {
  const norm = normalizeLang(lang);
  return dictionaries[norm] || {};
}

export function t(lang, key, vars = {}) {
  const norm = normalizeLang(lang);
  const dict = dictionaries[norm] || {};
  const fallback = dictionaries.id || dictionaries.en || {};
  const raw = key in dict ? dict[key] : fallback[key];
  if (raw === undefined) {
    throw new Error(`Missing translation key "${key}" for language "${norm}"`);
  }
  return interpolate(raw, vars);
}

export function interpolate(template, vars = {}) {
  if (typeof template !== 'string') return String(template ?? '');
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    return vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : `{${k}}`;
  });
}

export function validateTranslationTables(tables) {
  for (const lang of SUPPORTED_LANGS) {
    if (!tables[lang] || typeof tables[lang] !== 'object') {
      throw new Error(`Missing translation table for "${lang}"`);
    }
  }
  const baseKeys = Object.keys(tables.id).sort();
  if (baseKeys.length === 0) {
    throw new Error('Translation tables cannot be empty');
  }
  for (const lang of SUPPORTED_LANGS) {
    const keys = Object.keys(tables[lang]).sort();
    for (const k of baseKeys) {
      if (!(k in tables[lang])) {
        throw new Error(`Missing key "${k}" in "${lang}" translation table`);
      }
      if (typeof tables[lang][k] !== 'string' || tables[lang][k].trim() === '') {
        throw new Error(`Empty or non-string value for key "${k}" in "${lang}"`);
      }
    }
    for (const k of keys) {
      if (!(k in tables.id)) {
        throw new Error(`Extra key "${k}" in "${lang}" not present in "id"`);
      }
    }
  }
  return { valid: true, keyCount: baseKeys.length };
}
