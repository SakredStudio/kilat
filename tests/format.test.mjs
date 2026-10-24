import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rp, formatIdr, parseIdr, avatarColor, avatarInitials, formatDateId } from '../lib/format.js';

test('format: rp() formats integer IDR with Indonesian dot thousands separator and no decimals', () => {
  assert.equal(rp(0), 'Rp0');
  assert.equal(rp(60000), 'Rp60.000');
  assert.equal(rp(350000), 'Rp350.000');
  assert.equal(rp(1250000), 'Rp1.250.000');
  assert.equal(rp(1250000, { spaced: true }), 'Rp 1.250.000');
  assert.equal(rp(1250000, { withPrefix: false }), '1.250.000');
  assert.equal(formatIdr(780000), 'Rp780.000');
});

test('format: parseIdr() parses formatted IDR strings and numbers cleanly', () => {
  assert.equal(parseIdr(350000), 350000);
  assert.equal(parseIdr('350.000'), 350000);
  assert.equal(parseIdr('Rp 1.250.000'), 1250000);
  assert.equal(parseIdr('Rp60.000'), 60000);
  assert.throws(() => parseIdr('abc'), RangeError);
  assert.throws(() => parseIdr(-100), RangeError);
});

test('format: avatarInitials, avatarColor, and formatDateId work deterministically', () => {
  assert.equal(avatarInitials('Pak Budi Santoso'), 'PB');
  assert.equal(avatarInitials('Siti'), 'S');
  assert.equal(avatarColor('Pak Budi Santoso'), avatarColor('Pak Budi Santoso'));
  assert.equal(formatDateId('2026-10-24'), '24 Okt 2026');
});
