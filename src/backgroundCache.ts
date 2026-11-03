import { hashIdentity } from './identity';
import { getSessionStore } from './session';

/**
 * Per-identity cache for La Belle Vie calls that can outlast a serverless
 * request (the order page took 68 s, the cart 50 s+). A live fetch runs once
 * per identity at a time and saves its result even when the caller has given
 * up, so the next call — the app retries after a pause — gets it at once.
 *
 * - fresh copies (younger than `freshMs`) are served without calling La Belle Vie;
 * - with `serveStale`, an older copy is served at once while a refresh runs in
 *   the background; without it, an older copy is ignored and the call waits.
 */
export interface BackgroundCache<T> {
  get(identity: string, fetchLive: () => Promise<T>, now?: number): Promise<{ value: T; cachedAt: number | null }>;
  put(identity: string, value: T): Promise<void>;
  clear(identity: string): Promise<void>;
}

interface Entry<T> {
  value: T;
  at: number;
}

export function makeBackgroundCache<T>(opts: {
  prefix: string;
  freshMs: number;
  ttlSeconds: number;
  serveStale: boolean;
}): BackgroundCache<T> {
  const inflight = new Map<string, Promise<T>>();
  const key = (identity: string) => `${opts.prefix}:${hashIdentity(identity)}`;

  async function load(identity: string): Promise<Entry<T> | null> {
    const v = (await getSessionStore().load(key(identity)).catch(() => null)) as Entry<T> | null;
    return v && typeof v === 'object' && 'value' in v && typeof v.at === 'number' ? v : null;
  }

  async function put(identity: string, value: T): Promise<void> {
    await getSessionStore()
      .save(key(identity), { value, at: Date.now() } satisfies Entry<T>, opts.ttlSeconds)
      .catch(() => undefined);
  }

  function refresh(identity: string, fetchLive: () => Promise<T>): Promise<T> {
    const running = inflight.get(identity);
    if (running) return running;
    const p = fetchLive()
      .then(async (value) => {
        await put(identity, value);
        return value;
      })
      .finally(() => inflight.delete(identity));
    inflight.set(identity, p);
    return p;
  }

  return {
    async get(identity, fetchLive, now = Date.now()) {
      const cached = await load(identity);
      if (cached && now - cached.at <= opts.freshMs) return { value: cached.value, cachedAt: cached.at };
      if (cached && opts.serveStale) {
        refresh(identity, fetchLive).catch(() => undefined);
        return { value: cached.value, cachedAt: cached.at };
      }
      return { value: await refresh(identity, fetchLive), cachedAt: null };
    },
    put,
    async clear(identity) {
      await getSessionStore().clear(key(identity)).catch(() => undefined);
    },
  };
}
