import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionRecord } from '../../src/connections';
import { saveConnection } from '../../src/connections';
import { resetCredKeyCacheForTests } from '../../src/crypto';
import { setSessionStore } from '../../src/session';

const { calls } = vi.hoisted(() => ({ calls: { identities: [] as string[] } }));

// Only the La Belle Vie transport is faked; connections/links/session are real (in-memory store).
vi.mock('../../src/runtime', () => ({
  withClient: async (identity: string, fn: (c: unknown) => Promise<unknown>) => {
    calls.identities.push(identity);
    return fn({
      listRecentOrders: async () => [],
      getCart: async () => ({ itemCount: 2, lines: [], subtotal: 5, priceToPay: 5, finalPriceToPay: 5 }),
    });
  },
}));

const { crocOptions, crocPost } = await import('../../src/croc');

const SUPA = 'https://proj.supabase.co';
const APP = 'https://croc-eat.vercel.app';
const HH = '11111111-2222-4333-8444-555555555555';
const USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENV = ['CROC_SUPABASE_URL', 'CROC_SUPABASE_ANON_KEY', 'CROC_EAT_ORIGIN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'LBV_CRED_KEY'];

/** Fake Supabase: token "good" is user USER, member of HH only. */
function fakeSupabase() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== 'Bearer good') return new Response('{}', { status: 401 });
    if (url === `${SUPA}/auth/v1/user`) return Response.json({ id: USER });
    if (url.startsWith(`${SUPA}/rest/v1/household_members`)) {
      const member = url.includes(`household_id=eq.${HH}`) && url.includes(`user_id=eq.${USER}`);
      return Response.json(member ? [{ household_id: HH }] : []);
    }
    return new Response('not found', { status: 404 });
  });
}

function post(body: unknown, { token = 'good', origin = APP }: { token?: string | null; origin?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin };
  if (token) headers.authorization = `Bearer ${token}`;
  return crocPost(new Request(`https://lbv.example/api/croc`, { method: 'POST', headers, body: JSON.stringify(body) }));
}

function record(): ConnectionRecord {
  return { lbvEmail: 'a@b.c', creds: { iv: 'aa', tag: 'bb', ciphertext: 'cc' }, jar: { cookies: [] }, connectedAt: 1, lastUsedAt: 1 };
}

describe('Croc Eat REST bridge', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.CROC_SUPABASE_URL = SUPA + '/';
    process.env.CROC_SUPABASE_ANON_KEY = 'anon';
    process.env.CROC_EAT_ORIGIN = `${APP}, http://localhost:5173`;
    resetCredKeyCacheForTests();
    setSessionStore(null);
    calls.identities = [];
    vi.stubGlobal('fetch', fakeSupabase());
  });
  afterEach(() => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.unstubAllGlobals();
    setSessionStore(null);
  });

  it('answers the CORS preflight for the allowed origin only', () => {
    const ok = crocOptions(new Request('https://lbv.example/api/croc', { method: 'OPTIONS', headers: { origin: APP } }));
    expect(ok.headers.get('access-control-allow-origin')).toBe(APP);
    const other = crocOptions(new Request('https://lbv.example/api/croc', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('is unavailable until configured', async () => {
    delete process.env.CROC_SUPABASE_URL;
    expect((await post({ tool: 'view_cart', householdId: HH })).status).toBe(503);
  });

  it('rejects other origins, missing or invalid tokens, and non-members', async () => {
    expect((await post({ tool: 'view_cart', householdId: HH }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ tool: 'view_cart', householdId: HH }, { token: null })).status).toBe(401);
    expect((await post({ tool: 'view_cart', householdId: HH }, { token: 'forged' })).status).toBe(401);
    const otherHh = '99999999-2222-4333-8444-555555555555';
    expect((await post({ tool: 'view_cart', householdId: otherHh })).status).toBe(403);
    expect(calls.identities).toEqual([]);
  });

  it('rejects unknown tools, missing household and invalid arguments', async () => {
    expect((await post({ tool: 'place_order', householdId: HH })).status).toBe(404);
    expect((await post({ tool: 'view_cart' })).status).toBe(400);
    expect((await post({ tool: 'search_products', householdId: HH, arguments: { query: '' } })).status).toBe(400);
  });

  it('runs the tool under the household identity and returns its structured payload', async () => {
    const res = await post({ tool: 'view_cart', householdId: HH });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    const body = await res.json();
    expect(body).toMatchObject({ isError: false, payload: { itemCount: 2 } });
    expect(calls.identities).toEqual([`croc-household:${HH}`]);
  });

  it('shares one La Belle Vie connection per household', async () => {
    let body = await (await post({ tool: 'list_recent_orders', householdId: HH })).json();
    expect(body.payload).toMatch(/not connected yet/i);
    await saveConnection(`croc-household:${HH}`, record());
    body = await (await post({ tool: 'list_recent_orders', householdId: HH })).json();
    expect(body.isError).toBe(false);
    expect(JSON.stringify(body.payload)).not.toMatch(/not connected/i);
  });

  it('connect_account returns a one-time link on this server', async () => {
    process.env.LBV_CRED_KEY = 'a'.repeat(64);
    resetCredKeyCacheForTests();
    const body = await (await post({ tool: 'connect_account', householdId: HH })).json();
    expect(body.isError).toBe(false);
    expect(body.payload.url).toMatch(/^https:\/\/lbv\.example\/connect\/[A-Za-z0-9_-]{20,}$/);
  });
});

describe('Croc Eat bridge failure modes', () => {
  it('answers a slow tool with a CORS-enabled 504 instead of letting Vercel time out', async () => {
    const { crocPost: post2 } = await import('../../src/croc');
    process.env.CROC_SUPABASE_URL = SUPA;
    process.env.CROC_SUPABASE_ANON_KEY = 'anon';
    process.env.CROC_EAT_ORIGIN = APP;
    // Supabase answers, then never resolves the membership check: the budget must fire.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/auth/v1/user') ? Response.json({ id: USER }) : new Promise<Response>(() => {})));
    const res = await post2(new Request('https://lbv.example/api/croc', {
      method: 'POST',
      headers: { origin: APP, authorization: 'Bearer good', 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'view_cart', householdId: HH }),
    }), 30);
    expect(res.status).toBe(504);
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect((await res.json()).error).toBe('timeout');
    vi.unstubAllGlobals();
  });
});
