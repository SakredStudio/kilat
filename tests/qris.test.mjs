import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQrisSharePayload, withQrisLine, dataUrlToBytes, qrisKey, QRIS_LINE, shareReminderWithQris } from '../lib/qris.js';
import { buildReminderMessage, SHARE_LINE } from '../lib/wa.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('qris: withQrisLine puts the QRIS line before the share line, once, and never drops the share line', () => {
  const msg = buildReminderMessage({ nama: 'Pak Budi', jumlah: 50000, hari: 3, warung: 'Warung Bu Siti' });
  const out = withQrisLine(msg);
  assert.ok(out.endsWith(SHARE_LINE));
  assert.ok(out.includes(QRIS_LINE));
  assert.ok(out.indexOf(QRIS_LINE) < out.indexOf(SHARE_LINE));
  assert.equal(withQrisLine(out), out, 'idempotent');
  assert.equal(out.split(QRIS_LINE).length - 1, 1);
  assert.equal(withQrisLine('Halo'), `Halo\n\n${QRIS_LINE}\n\n${SHARE_LINE}`);
  assert.ok(/langsung ke warung/.test(QRIS_LINE), 'copy says the customer pays the shop directly');
});

test('qris: payload builder decodes the dataURL, names the file after the warung and keeps the text honest', () => {
  const p = buildQrisSharePayload({ message: 'Halo Pak Budi', qrisDataUrl: PNG, warungName: 'Warung Bu Siti' });
  assert.equal(p.mime, 'image/png');
  assert.equal(p.filename, 'qris-warung-bu-siti.png');
  assert.equal(p.title, 'QRIS Warung Bu Siti');
  assert.ok(p.bytes instanceof Uint8Array);
  assert.equal(p.size, p.bytes.length);
  assert.deepEqual(Array.from(p.bytes.slice(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG magic bytes');
  assert.ok(p.text.endsWith(SHARE_LINE));
  assert.ok(p.text.includes(QRIS_LINE));
  assert.ok(!/Kilat (menerima|memproses|mentransfer)/i.test(p.text));
  assert.throws(() => buildQrisSharePayload({ message: 'x', qrisDataUrl: '' }), /missing/);
  assert.throws(() => dataUrlToBytes('data:text/plain,hi'), /dataURL/);
  assert.equal(dataUrlToBytes('data:image/jpeg;base64,/9j/').mime, 'image/jpeg');
  assert.equal(qrisKey('book_7'), 'qris:book_7');
});

test('qris: without Web Share the fallback opens the wa.me text link and reports fallback', async () => {
  const p = buildQrisSharePayload({ message: 'Halo', qrisDataUrl: PNG, warungName: 'W' });
  const opened = [];
  const res = await shareReminderWithQris(p, { waHref: 'https://wa.me/62?text=x', openLink: (h) => opened.push(h) });
  assert.equal(res.method, 'fallback');
  assert.deepEqual(opened, ['https://wa.me/62?text=x']);
});
