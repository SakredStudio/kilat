import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_WIDTH,
  CARD_HEIGHT,
  WATERMARK_TEXT,
  buildShareCardModel,
  drawShareCardToCanvas
} from '../lib/share-card.js';
import { createInitialState, seedDemoData, updateSettings } from '../lib/store.js';

function createMockCanvas() {
  const calls = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    createLinearGradient: () => ({ addColorStop: () => {} }),
    fillRect: (...args) => calls.push({ fn: 'fillRect', args }),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    closePath: () => {},
    fill: () => {},
    stroke: () => {},
    arc: () => {},
    measureText: (t) => ({ width: String(t).length * 16 }),
    fillText: (text, x, y) => calls.push({ fn: 'fillText', text: String(text), x, y }),
    drawImage: (img, x, y, w, h) => calls.push({ fn: 'drawImage', img, x, y, w, h })
  };
  return {
    width: 0,
    height: 0,
    calls,
    getContext: (type) => (type === '2d' ? ctx : null)
  };
}

test('share-card: buildShareCardModel computes 1080x1350 model, top 3 debtors, and free vs Pro watermark', () => {
  let state = seedDemoData(createInitialState(), null, {
    count: 6,
    referenceDate: '2026-10-24T00:00:00.000Z'
  });

  const freeModel = buildShareCardModel(state, '2026-10-24');
  assert.equal(freeModel.width, 1080);
  assert.equal(freeModel.height, 1350);
  assert.equal(freeModel.totalPiutang, 2030000);
  assert.equal(freeModel.totalFormatted, 'Rp 2.030.000');
  assert.equal(freeModel.topDebtors.length, 3);
  assert.equal(freeModel.topDebtors[0].name, 'Mas Agus Wibowo');
  assert.equal(freeModel.showWatermark, true);
  assert.equal(freeModel.watermarkText, WATERMARK_TEXT);

  // Pro removes watermark
  state = updateSettings(state, { isPro: true }, null);
  const proModel = buildShareCardModel(state, '2026-10-24');
  assert.equal(proModel.showWatermark, false);
  assert.equal(proModel.watermarkText, '');
});

test('share-card: drawShareCardToCanvas renders 1080x1350 dimensions and draws warung name, total, and debtors', () => {
  const state = seedDemoData(createInitialState(), null, {
    count: 6,
    referenceDate: '2026-10-24T00:00:00.000Z'
  });
  const model = buildShareCardModel(state, '2026-10-24');
  const canvas = createMockCanvas();

  drawShareCardToCanvas(canvas, model);
  assert.equal(canvas.width, CARD_WIDTH);
  assert.equal(canvas.height, CARD_HEIGHT);

  const drawnTexts = canvas.calls.filter((c) => c.fn === 'fillText').map((c) => c.text);
  assert.ok(drawnTexts.includes('Warung Bu Siti'));
  assert.ok(drawnTexts.includes('Rp 2.030.000'));
  assert.ok(drawnTexts.includes('Mas Agus Wibowo'));
  assert.ok(drawnTexts.includes(WATERMARK_TEXT));
});

test('share-card: badge carries the Bonrapi mark (no lightning glyph) and the watermark names Bonrapi', () => {
  const state = seedDemoData(createInitialState(), null, { count: 6, referenceDate: '2026-10-24T00:00:00.000Z' });
  const model = buildShareCardModel(state, '2026-10-24');
  assert.equal(WATERMARK_TEXT, 'Dibuat dengan Bonrapi · kilat.sakredstudio.ca');

  // No mark loaded (Node, or the image failed): label only, nothing drawn as an image
  const plain = createMockCanvas();
  drawShareCardToCanvas(plain, model);
  const plainTexts = plain.calls.filter((c) => c.fn === 'fillText').map((c) => c.text);
  assert.ok(plainTexts.includes('LAPORAN PIUTANG'));
  assert.ok(!plainTexts.some((txt) => txt.includes('⚡')), 'no lightning bolt on the card');
  assert.equal(plain.calls.filter((c) => c.fn === 'drawImage').length, 0);

  // With the mark: drawn once, aspect ratio kept, label sits to its right inside the badge
  const mark = { width: 132, height: 192 };
  const withMark = createMockCanvas();
  drawShareCardToCanvas(withMark, model, { mark });
  const images = withMark.calls.filter((c) => c.fn === 'drawImage');
  assert.equal(images.length, 1);
  assert.equal(images[0].img, mark);
  assert.equal(images[0].h, 36);
  assert.equal(images[0].w, Math.round((132 / 192) * 36));
  const label = withMark.calls.find((c) => c.fn === 'fillText' && c.text === 'LAPORAN PIUTANG');
  assert.ok(label.x >= images[0].x + images[0].w);
  assert.ok(images[0].x >= CARD_WIDTH - 80 - 310, 'mark stays inside the badge');
});
