import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitWithin,
  estimateDataUrlBytes,
  isImageDataUrl,
  createMemoryPhotoStore,
  setPhotoStore,
  putPhoto,
  getPhoto,
  deletePhoto,
  getAllPhotos,
  clearPhotos,
  importPhotos,
  PHOTO_MAX_PX
} from '../lib/photos.js';
import { createInitialState, addCustomer, addDebt, exportBackupJson, parseBackup, importBackupJson } from '../lib/store.js';
import { activeBook } from '../lib/books.js';

// 1x1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('photos: fitWithin scales the longest side to max px and never upscales', () => {
  assert.equal(PHOTO_MAX_PX, 800);
  assert.deepEqual(fitWithin(4000, 3000, 800), { width: 800, height: 600, scale: 0.2 });
  assert.deepEqual(fitWithin(1200, 1600, 800), { width: 600, height: 800, scale: 0.5 });
  assert.deepEqual(fitWithin(640, 480, 800), { width: 640, height: 480, scale: 1 });
  assert.deepEqual(fitWithin(800, 800, 800), { width: 800, height: 800, scale: 1 });
  const tiny = fitWithin(10000, 1, 800);
  assert.equal(tiny.width, 800);
  assert.equal(tiny.height, 1, 'height never collapses below 1px');
  assert.ok(estimateDataUrlBytes(PNG) > 60 && estimateDataUrlBytes(PNG) < 90);
  assert.equal(estimateDataUrlBytes('nope'), 0);
  assert.equal(isImageDataUrl(PNG), true);
  assert.equal(isImageDataUrl('data:text/plain;base64,aGk='), false);
});

test('photos: store put/get/delete/getAll/clear/importMany through the module facade', async () => {
  setPhotoStore(createMemoryPhotoStore());
  assert.equal(await getPhoto('d1'), null);
  await putPhoto('d1', PNG);
  await putPhoto('d2', PNG);
  assert.equal(await getPhoto('d1'), PNG);
  assert.deepEqual(Object.keys(await getAllPhotos()).sort(), ['d1', 'd2']);
  await deletePhoto('d1');
  assert.equal(await getPhoto('d1'), null);
  await assert.rejects(() => putPhoto('bad', 'data:text/plain;base64,aGk='), /image dataURL/);
  assert.equal(await importPhotos({ d3: PNG, junk: 'not-an-image' }), 1);
  assert.deepEqual(Object.keys(await getAllPhotos()).sort(), ['d2', 'd3']);
  await clearPhotos();
  assert.deepEqual(await getAllPhotos(), {});
  setPhotoStore(null);
});

test('photos: JSON backup embeds photos keyed by debt id and parseBackup extracts them', () => {
  const st = { getItem: () => null, setItem() {} };
  let s = addCustomer(createInitialState(), { id: 'c1', name: 'A', phone: '0811' }, st);
  s = addDebt(s, { id: 'd1', customerId: 'c1', amountIdr: 1000, date: '2026-10-01' }, st);
  const plain = exportBackupJson(s);
  assert.ok(!JSON.parse(plain).photos, 'no photos key when none given');
  const withPhotos = exportBackupJson(s, { photos: { d1: PNG } });
  const parsed = parseBackup(withPhotos);
  assert.equal(activeBook(parsed.state).debts.length, 1);
  assert.deepEqual(parsed.photos, { d1: PNG });
  // importBackupJson ignores the photos key and still restores the ledger
  const restored = importBackupJson(withPhotos, st);
  assert.equal(activeBook(restored).debts[0].id, 'd1');
  assert.equal(restored.photos, undefined);
  // Junk values are dropped
  assert.deepEqual(parseBackup(JSON.stringify({ ...JSON.parse(plain), photos: { d1: 'x' } })).photos, {});
});
