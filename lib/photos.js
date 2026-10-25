// Kilat photo notes: one picture per utang (the handwritten bon), stored as a resized JPEG
// dataURL in IndexedDB (never localStorage, which stays lean). Keys are strings: a debt id, or
// 'qris' for the shop's static QRIS image (v3). Falls back to an in-memory store when IndexedDB is
// unavailable (tests, private mode) so the app never breaks.

export const PHOTO_DB_NAME = 'kilat-photos';
export const PHOTO_STORE = 'photos';
export const PHOTO_MAX_PX = 800;
export const QRIS_KEY = 'qris';
export const QRIS_MAX_PX = 1000;

/**
 * Pure resize math: fit (width x height) inside a maxPx square, never upscaling.
 * @returns {{ width:number, height:number, scale:number }}
 */
export function fitWithin(width, height, maxPx = PHOTO_MAX_PX) {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const longest = Math.max(w, h);
  if (longest <= maxPx) return { width: w, height: h, scale: 1 };
  const scale = maxPx / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale
  };
}

/** Approximate decoded byte size of a base64 dataURL (for size hints). */
export function estimateDataUrlBytes(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  if (comma === -1) return 0;
  const b64 = s.slice(comma + 1);
  const padding = (b64.match(/=+$/) || [''])[0].length;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

export function isImageDataUrl(dataUrl) {
  return /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(String(dataUrl || ''));
}

/** In-memory store with the same async surface as the IndexedDB store. */
export function createMemoryPhotoStore() {
  const map = new Map();
  return {
    kind: 'memory',
    async get(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    async put(key, dataUrl) {
      if (!isImageDataUrl(dataUrl)) throw new Error('Photo must be an image dataURL');
      map.set(String(key), String(dataUrl));
      return String(key);
    },
    async delete(key) { map.delete(String(key)); },
    async getAll() { return Object.fromEntries(map.entries()); },
    async clear() { map.clear(); },
    async importMany(photos) {
      let n = 0;
      for (const [k, v] of Object.entries(photos || {})) {
        if (isImageDataUrl(v)) { map.set(String(k), String(v)); n++; }
      }
      return n;
    }
  };
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

/** IndexedDB-backed store (object store with out-of-line string keys). */
export function createIdbPhotoStore(idb = globalThis.indexedDB) {
  let dbPromise = null;
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = idb.open(PHOTO_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Cannot open photo database'));
    });
    return dbPromise;
  }
  async function tx(mode, fn) {
    const db = await open();
    const t = db.transaction(PHOTO_STORE, mode);
    const store = t.objectStore(PHOTO_STORE);
    const result = await fn(store);
    await new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error || new Error('Transaction failed'));
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    });
    return result;
  }
  return {
    kind: 'idb',
    get: (key) => tx('readonly', (s) => reqToPromise(s.get(String(key)))).then((v) => v ?? null),
    put: (key, dataUrl) => {
      if (!isImageDataUrl(dataUrl)) return Promise.reject(new Error('Photo must be an image dataURL'));
      return tx('readwrite', (s) => reqToPromise(s.put(String(dataUrl), String(key))));
    },
    delete: (key) => tx('readwrite', (s) => reqToPromise(s.delete(String(key)))),
    getAll: () =>
      tx('readonly', async (s) => {
        const [keys, values] = await Promise.all([reqToPromise(s.getAllKeys()), reqToPromise(s.getAll())]);
        const out = {};
        keys.forEach((k, i) => { out[String(k)] = values[i]; });
        return out;
      }),
    clear: () => tx('readwrite', (s) => reqToPromise(s.clear())),
    importMany: (photos) =>
      tx('readwrite', async (s) => {
        let n = 0;
        for (const [k, v] of Object.entries(photos || {})) {
          if (isImageDataUrl(v)) { await reqToPromise(s.put(String(v), String(k))); n++; }
        }
        return n;
      })
  };
}

let activeStore = null;
/** The app-wide photo store: IndexedDB when available, memory otherwise. */
export function photoStore() {
  if (activeStore) return activeStore;
  activeStore = globalThis.indexedDB ? createIdbPhotoStore(globalThis.indexedDB) : createMemoryPhotoStore();
  return activeStore;
}
/** Test hook. */
export function setPhotoStore(store) {
  activeStore = store || null;
}

export const putPhoto = (key, dataUrl) => photoStore().put(key, dataUrl);
export const getPhoto = (key) => photoStore().get(key);
export const deletePhoto = (key) => photoStore().delete(key);
export const getAllPhotos = () => photoStore().getAll();
export const clearPhotos = () => photoStore().clear();
export const importPhotos = (photos) => photoStore().importMany(photos);

/**
 * Browser-only: read an image File, downscale to maxPx on the longest side, return a JPEG dataURL.
 * Uses createImageBitmap when available, <img> otherwise.
 */
export async function resizeImageFile(file, maxPx = PHOTO_MAX_PX, quality = 0.82) {
  if (typeof document === 'undefined') throw new Error('resizeImageFile needs a DOM');
  let bitmap;
  if (typeof createImageBitmap === 'function') {
    bitmap = await createImageBitmap(file);
  } else {
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Cannot decode image')); };
      img.src = url;
    });
  }
  const srcW = bitmap.width || bitmap.naturalWidth;
  const srcH = bitmap.height || bitmap.naturalHeight;
  const { width, height } = fitWithin(srcW, srcH, maxPx);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === 'function') bitmap.close();
  return canvas.toDataURL('image/jpeg', quality);
}
