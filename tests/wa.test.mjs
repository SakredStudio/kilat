import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_LINK,
  SHARE_LINE,
  REMINDER_TEMPLATES,
  ensureShareLine,
  buildReminderMessage,
  link
} from '../lib/wa.js';

test('wa: builds all 3 tones (sopan, singkat, tegas) with variables and mandatory share line', () => {
  assert.equal(APP_LINK, 'https://sakredstudio.github.io/kilat');
  assert.equal(SHARE_LINE, '— Kilat · https://sakredstudio.github.io/kilat');
  assert.ok(REMINDER_TEMPLATES.sopan);
  assert.ok(REMINDER_TEMPLATES.singkat);
  assert.ok(REMINDER_TEMPLATES.tegas);

  for (const tone of ['sopan', 'singkat', 'tegas']) {
    const msg = buildReminderMessage({
      tone,
      nama: 'Pak Budi Santoso',
      jumlah: 350000,
      hari: 21,
      warung: 'Warung Bu Siti'
    });
    assert.ok(msg.includes('Pak Budi Santoso'), `${tone} should include customer name`);
    assert.ok(msg.includes('Rp 350.000'), `${tone} should include formatted IDR amount`);
    assert.ok(msg.includes('21'), `${tone} should include overdue days`);
    assert.ok(msg.includes('Warung Bu Siti'), `${tone} should include warung name`);
    assert.ok(msg.endsWith('— Kilat · https://sakredstudio.github.io/kilat'), `${tone} should end with share line`);
  }
});

test('wa: link() normalizes phone to 62XXXXXXXXXX and URL-encodes emojis, asterisks, and newlines', () => {
  const msg = buildReminderMessage({
    tone: 'sopan',
    nama: 'Pak Budi & Ibu',
    jumlah: 350000,
    hari: 21,
    warung: 'Warung Bu Siti'
  });
  const url = link('0812-3456-7890', msg);
  assert.ok(url.startsWith('https://wa.me/6281234567890?text='));
  const decoded = decodeURIComponent(url.split('?text=')[1]);
  assert.equal(decoded, msg);
  assert.ok(decoded.includes('🙏'));
  assert.ok(decoded.includes('*Warung Bu Siti*'));
  assert.ok(decoded.endsWith(SHARE_LINE));

  // Ensure share line is not duplicated if already present
  assert.equal(ensureShareLine(msg), msg);
});
