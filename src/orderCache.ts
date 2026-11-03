import { hashIdentity } from './identity';
import type { OrderSummary } from './lbv/orders';
import { getSessionStore } from './session';

/**
 * La Belle Vie only serves the order history as a server-rendered page, which
 * can take over a minute for a long history — longer than a serverless call
 * may last. We keep the last list per identity: a fresh copy is served at
 * once, a stale one is served at once while a refresh runs in the background,
 * and a call that times out still finishes and fills the cache for the next.
 */
export const ORDER_CACHE_FRESH_MS = 10 * 60 * 1000;
const ORDER_CACHE_TTL_SECONDS = 7 * 24 * 3600;

interface CachedOrders {
  orders: OrderSummary[];
  at: number;
}

const inflight = new Map<string, Promise<OrderSummary[]>>();

function cacheKey(identity: string): string {
  return `lbv:orders:${hashIdentity(identity)}`;
}

async function loadCached(identity: string): Promise<CachedOrders | null> {
  const value = (await getSessionStore().load(cacheKey(identity)).catch(() => null)) as CachedOrders | null;
  return value && Array.isArray(value.orders) && typeof value.at === 'number' ? value : null;
}

/** One live fetch per identity at a time; the result is cached even if nobody waits for it any more. */
function refresh(identity: string, fetchLive: () => Promise<OrderSummary[]>): Promise<OrderSummary[]> {
  const running = inflight.get(identity);
  if (running) return running;
  const p = fetchLive()
    .then(async (orders) => {
      await getSessionStore()
        .save(cacheKey(identity), { orders, at: Date.now() } satisfies CachedOrders, ORDER_CACHE_TTL_SECONDS)
        .catch(() => undefined);
      return orders;
    })
    .finally(() => inflight.delete(identity));
  inflight.set(identity, p);
  return p;
}

export async function cachedRecentOrders(
  identity: string,
  fetchLive: () => Promise<OrderSummary[]>,
  now = Date.now(),
): Promise<{ orders: OrderSummary[]; cachedAt: number | null }> {
  const cached = await loadCached(identity);
  if (cached) {
    if (now - cached.at > ORDER_CACHE_FRESH_MS) refresh(identity, fetchLive).catch(() => undefined);
    return { orders: cached.orders, cachedAt: cached.at };
  }
  return { orders: await refresh(identity, fetchLive), cachedAt: null };
}

export async function clearOrderCache(identity: string): Promise<void> {
  await getSessionStore().clear(cacheKey(identity)).catch(() => undefined);
}
