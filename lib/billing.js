// Google Play Billing for Kilat Pro, via the Digital Goods API + Payment Request.
// Only works inside the Play-installed TWA (androidbrowserhelper billing bridge); everywhere else
// every function reports "unavailable" and the app sells nothing (Play policy: no external paywall).
// No backend: a one-time, non-consumable product. Play acknowledges the purchase when
// PaymentResponse.complete('success') is called; entitlement is restored from listPurchases().

export const PLAY_BILLING_METHOD = 'https://play.google.com/billing';
export const PRO_SKU = 'kilat_pro';
export const PRO_PRICE_FALLBACK = 'Rp29.000';

export class PurchaseError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function getWindow(w) {
  return w !== undefined ? w : typeof window !== 'undefined' ? window : null;
}

const serviceCache = new WeakMap();

async function service(w) {
  const win = getWindow(w);
  if (!win || typeof win.getDigitalGoodsService !== 'function') return null;
  if (serviceCache.has(win)) return serviceCache.get(win);
  let svc = null;
  try {
    svc = await win.getDigitalGoodsService(PLAY_BILLING_METHOD);
  } catch {
    svc = null;
  }
  serviceCache.set(win, svc || null);
  return svc || null;
}

/** True only inside the Play TWA with the billing bridge. */
export async function isPlayBillingAvailable(w) {
  const win = getWindow(w);
  if (!win || typeof win.PaymentRequest !== 'function') return false;
  return (await service(w)) !== null;
}

/** Localised Play price for the Pro SKU, or the fallback when unavailable. */
export async function getProPrice(w) {
  const svc = await service(w);
  if (!svc) return PRO_PRICE_FALLBACK;
  try {
    const details = await svc.getDetails([PRO_SKU]);
    const d = Array.isArray(details) ? details.find((x) => x.itemId === PRO_SKU) : null;
    if (!d || !d.price) return PRO_PRICE_FALLBACK;
    return formatPrice(d.price);
  } catch {
    return PRO_PRICE_FALLBACK;
  }
}

/** IDR has no minor units in practice: "Rp29.000". Other currencies fall back to Intl. */
export function formatPrice(price) {
  try {
    const value = Number(price.value);
    if (price.currency === 'IDR') {
      return 'Rp' + new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(Math.round(value));
    }
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: price.currency, maximumFractionDigits: 2 })
      .format(value)
      .replace(/,00$/, '');
  } catch {
    return `${price.currency} ${price.value}`;
  }
}

/** Does this Google account already own Pro (reinstall / new phone)? */
export async function hasProPurchase(w) {
  const svc = await service(w);
  if (!svc) return false;
  try {
    const list = await svc.listPurchases();
    return Array.isArray(list) && list.some((p) => p.itemId === PRO_SKU);
  } catch {
    return false;
  }
}

/** Buy Pro inside the Play app. Resolves true once Play reports success. */
export async function buyPro(w) {
  const win = getWindow(w);
  if (!(await isPlayBillingAvailable(w))) throw new PurchaseError('unavailable');
  const request = new win.PaymentRequest(
    [{ supportedMethods: PLAY_BILLING_METHOD, data: { sku: PRO_SKU } }],
    // Play ignores this total and uses the Console price.
    { total: { label: PRO_SKU, amount: { currency: 'IDR', value: '0' } } }
  );
  let response;
  try {
    response = await request.show();
  } catch (e) {
    throw new PurchaseError(e && e.name === 'AbortError' ? 'cancelled' : 'show_failed', e && e.message);
  }
  const details = response.details || {};
  const token = details.purchaseToken || details.token;
  if (!token) {
    await response.complete('fail').catch(() => null);
    throw new PurchaseError('no_token');
  }
  // complete('success') acknowledges the (non-consumable) purchase with Play.
  await response.complete('success');
  return true;
}
