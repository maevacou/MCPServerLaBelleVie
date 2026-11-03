import { makeBackgroundCache } from './backgroundCache';
import type { Cart } from './lbv/cart';
import type { OrderSummary } from './lbv/orders';

/** Order history: served at once (even stale) while La Belle Vie's slow page refreshes in the background. */
export const ORDER_CACHE_FRESH_MS = 10 * 60 * 1000;
const orders = makeBackgroundCache<OrderSummary[]>({
  prefix: 'lbv:orders',
  freshMs: ORDER_CACHE_FRESH_MS,
  ttlSeconds: 7 * 24 * 3600,
  serveStale: true,
});

export async function cachedRecentOrders(
  identity: string,
  fetchLive: () => Promise<OrderSummary[]>,
  now = Date.now(),
): Promise<{ orders: OrderSummary[]; cachedAt: number | null }> {
  const { value, cachedAt } = await orders.get(identity, fetchLive, now);
  return { orders: value, cachedAt };
}

export const clearOrderCache = (identity: string) => orders.clear(identity);

/**
 * Cart: always read live, except right after a read that outlasted its request
 * (the app retries ~20 s later) or a change made through these tools, which
 * already returned the new cart. Never served stale.
 */
export const CART_CACHE_FRESH_MS = 90 * 1000;
export const cartCache = makeBackgroundCache<Cart>({
  prefix: 'lbv:cart',
  freshMs: CART_CACHE_FRESH_MS,
  ttlSeconds: 600,
  serveStale: false,
});
