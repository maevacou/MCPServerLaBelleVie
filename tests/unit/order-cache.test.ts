import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORDER_CACHE_FRESH_MS, cachedRecentOrders, clearOrderCache } from '../../src/orderCache';
import { setSessionStore } from '../../src/session';
import type { OrderSummary } from '../../src/lbv/orders';

const order = (id: string) => ({ id, date: '2026-10-01', itemCount: 3, total: 42 }) as unknown as OrderSummary;
const ENV = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];

describe('order list cache', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } setSessionStore(null); });
  afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } setSessionStore(null); });

  it('fetches live the first time, then serves the cached list without calling La Belle Vie', async () => {
    const live = vi.fn(async () => [order('1')]);
    expect(await cachedRecentOrders('id-a', live)).toMatchObject({ orders: [order('1')], cachedAt: null });
    const again = await cachedRecentOrders('id-a', live);
    expect(again.orders).toEqual([order('1')]);
    expect(again.cachedAt).not.toBeNull();
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('serves a stale list at once and refreshes it in the background', async () => {
    await cachedRecentOrders('id-b', async () => [order('old')]);
    let release!: (v: OrderSummary[]) => void;
    const slow = vi.fn(() => new Promise<OrderSummary[]>((r) => { release = r; }));
    const stale = await cachedRecentOrders('id-b', slow, Date.now() + ORDER_CACHE_FRESH_MS + 1);
    expect(stale.orders).toEqual([order('old')]);
    expect(slow).toHaveBeenCalledTimes(1);
    release([order('new')]);
    await new Promise((r) => setTimeout(r, 0));
    expect((await cachedRecentOrders('id-b', slow)).orders).toEqual([order('new')]);
  });

  it('a slow first fetch still fills the cache after the caller gave up', async () => {
    let release!: (v: OrderSummary[]) => void;
    const slow = () => new Promise<OrderSummary[]>((r) => { release = r; });
    const first = cachedRecentOrders('id-c', slow);
    const gaveUp = await Promise.race([first, new Promise((r) => setTimeout(() => r('timeout'), 10))]);
    expect(gaveUp).toBe('timeout');
    release([order('9')]);
    await first;
    const live = vi.fn(async () => [order('x')]);
    expect((await cachedRecentOrders('id-c', live)).orders).toEqual([order('9')]);
    expect(live).not.toHaveBeenCalled();
  });

  it('is cleared on disconnect and kept separate per identity', async () => {
    await cachedRecentOrders('id-d', async () => [order('d')]);
    await clearOrderCache('id-d');
    const live = vi.fn(async () => [order('d2')]);
    expect((await cachedRecentOrders('id-d', live)).orders).toEqual([order('d2')]);
    expect((await cachedRecentOrders('id-e', async () => [order('e')])).orders).toEqual([order('e')]);
  });
});

describe('cart cache', () => {
  beforeEach(() => setSessionStore(null));

  it('reads live, but a slow read that finished late is served to the retry', async () => {
    const { cartCache, CART_CACHE_FRESH_MS } = await import('../../src/orderCache');
    let release!: (v: never) => void;
    const gate = new Promise<never>((r) => { release = r; });
    const first = cartCache.get('id-cart', () => gate);
    release({ itemCount: 3 } as never);
    await first;
    const live = vi.fn(async () => ({ itemCount: 9 }) as never);
    expect((await cartCache.get('id-cart', live)).value).toEqual({ itemCount: 3 });
    expect(live).not.toHaveBeenCalled();
    // Older than the fresh window: never served stale, read live again.
    expect((await cartCache.get('id-cart', live, Date.now() + CART_CACHE_FRESH_MS + 1)).value).toEqual({ itemCount: 9 });
  });

  it('a change made through the tools replaces the cached cart', async () => {
    const { cartCache } = await import('../../src/orderCache');
    await cartCache.get('id-cart2', async () => ({ itemCount: 1 }) as never);
    await cartCache.put('id-cart2', { itemCount: 2 } as never);
    expect((await cartCache.get('id-cart2', async () => ({ itemCount: 5 }) as never)).value).toEqual({ itemCount: 2 });
  });
});
