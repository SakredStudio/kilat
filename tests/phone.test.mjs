import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parsePhone, formatLocalPhone } from '../lib/phone.js';

test('phone: normalizes Indonesian phone numbers to 62XXXXXXXXXX', () => {
  assert.equal(normalize('0812-3456-7890'), '6281234567890');
  assert.equal(normalize('+62 812 3456 7890'), '6281234567890');
  assert.equal(normalize('6281234567890'), '6281234567890');
  assert.equal(normalize('81234567890'), '6281234567890');
  assert.equal(normalize('+62081234567890'), '6281234567890');
  assert.equal(normalize('006281234567890'), '6281234567890');
  assert.equal(normalize('08111222333'), '628111222333');
});

test('phone: parsePhone preserves phoneRaw alongside phone62', () => {
  const res = parsePhone('0812-3456-7890');
  assert.deepEqual(res, {
    phone62: '6281234567890',
    phoneRaw: '0812-3456-7890'
  });
});

test('phone: formatLocalPhone formats 62 numbers back to 08XX-XXXX-XXXX', () => {
  assert.equal(formatLocalPhone('6281234567890'), '0812-3456-7890');
});
