import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReminderMessage, SHARE_LINE, TEMPLATE_VARIABLES, link } from '../lib/wa.js';
import { createInitialState, updateSettings, migrate } from '../lib/store.js';

const st = { getItem: () => null, setItem() {} };

test('custom-template: renders every variable and always ends with exactly one share line', () => {
  const tpl = 'Halo {nama}! Dari {warung}: {jumlah}, sudah {hari} hari, jatuh tempo {tanggal}. 🙏';
  const msg = buildReminderMessage({
    tone: 'tegas',
    nama: 'Pak Budi',
    jumlah: 125000,
    hari: 9,
    warung: 'Warung Bu Siti',
    tanggal: '2026-10-20',
    customTemplate: tpl
  });
  assert.equal(
    msg,
    `Halo Pak Budi! Dari Warung Bu Siti: Rp 125.000, sudah 9 hari, jatuh tempo 20 Okt 2026. 🙏\n\n${SHARE_LINE}`
  );
  assert.deepEqual(TEMPLATE_VARIABLES, ['{nama}', '{jumlah}', '{hari}', '{warung}', '{tanggal}']);

  // A template that tries to drop or move the share line still gets it appended once at the end
  const sneaky = buildReminderMessage({ nama: 'A', jumlah: 1, hari: 1, warung: 'W', customTemplate: `${SHARE_LINE}\nHalo {nama}` });
  assert.ok(sneaky.endsWith(SHARE_LINE));
  assert.equal(sneaky.split(SHARE_LINE).length - 1, 2, 'owner text kept; one trailing share line enforced');
  const alreadyThere = buildReminderMessage({ nama: 'A', jumlah: 1, hari: 1, warung: 'W', customTemplate: `Halo {nama}\n\n${SHARE_LINE}` });
  assert.equal(alreadyThere.split(SHARE_LINE).length - 1, 1, 'not duplicated when already last');

  // The wa.me link enforces it as well, independent of the template
  const url = link('0812', 'Halo tanpa baris kilat');
  assert.ok(decodeURIComponent(url.split('?text=')[1]).endsWith(SHARE_LINE));

  // Unknown placeholders are left alone, {tanggal} without a date becomes '-'
  const partial = buildReminderMessage({ nama: 'A', jumlah: 1000, hari: 2, warung: 'W', customTemplate: '{nama} {foo} {tanggal}' });
  assert.ok(partial.startsWith('A {foo} -'));

  // Empty / whitespace template falls back to the built-in tone
  const fallback = buildReminderMessage({ tone: 'singkat', nama: 'A', jumlah: 1000, hari: 2, warung: 'W', customTemplate: '   ' });
  assert.ok(fallback.includes('pengingat ramah'));
});

test('custom-template: settings.customTemplate persists through migrate, is capped, defaults to empty', () => {
  const s0 = createInitialState();
  assert.equal(s0.settings.customTemplate, '');
  const s1 = updateSettings(s0, { customTemplate: 'Halo {nama}, {jumlah} ya 🙏' }, st);
  assert.equal(s1.settings.customTemplate, 'Halo {nama}, {jumlah} ya 🙏');
  assert.equal(migrate(JSON.parse(JSON.stringify(s1))).settings.customTemplate, 'Halo {nama}, {jumlah} ya 🙏');
  assert.equal(migrate({ settings: { customTemplate: 42 } }).settings.customTemplate, '');
  assert.equal(migrate({ settings: { customTemplate: 'x'.repeat(5000) } }).settings.customTemplate.length, 2000);
});
