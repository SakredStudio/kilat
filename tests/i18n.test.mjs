import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  registerTranslations,
  t,
  interpolate,
  validateTranslationTables
} from '../lib/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const idJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../i18n/id.json'), 'utf8'));
const enJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../i18n/en.json'), 'utf8'));

test('i18n: id.json and en.json have identical non-empty key sets', () => {
  const res = validateTranslationTables({ id: idJson, en: enJson });
  assert.equal(res.valid, true);
  assert.ok(res.keyCount >= 80, `Expected at least 80 keys, got ${res.keyCount}`);
});

test('i18n: registerTranslations and t() interpolate variables in Bahasa Indonesia and English', () => {
  registerTranslations('id', idJson);
  registerTranslations('en', enJson);
  assert.equal(DEFAULT_LANG, 'id');
  assert.deepEqual(SUPPORTED_LANGS, ['id', 'en']);
  assert.equal(t('id', 'app_name'), 'Kilat');
  assert.equal(t('id', 'reminder_overdue_days', { hari: 21 }), 'Menunggak 21 hari');
  assert.equal(t('en', 'reminder_overdue_days', { hari: 21 }), 'Overdue 21 days');
  assert.equal(interpolate('Halo {nama}, tagihan {jumlah}', { nama: 'Pak Budi', jumlah: 'Rp350.000' }), 'Halo Pak Budi, tagihan Rp350.000');
});

test('i18n: throws on missing translation key', () => {
  registerTranslations('id', idJson);
  assert.throws(() => t('id', 'non_existent_key_xyz'), /Missing translation key/);
});
