// tests/exely.token.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ExelyTokenManager } from '../src/integrations/exely/token';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('ExelyTokenManager', () => {
  const cfg = { clientId: 'id', clientSecret: 'secret', authUrl: 'https://connect.hopenapi.com/auth/token' };

  it('fetches a token with client_credentials and caches it', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ access_token: 'JWT123', expires_in: 900 }));
    let t = 0;
    const mgr = new ExelyTokenManager(cfg, { fetchFn: fetchFn as unknown as typeof fetch, now: () => t });

    expect(await mgr.getToken()).toBe('JWT123');
    expect(await mgr.getToken()).toBe('JWT123'); // cached
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [url, init] = (fetchFn.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toBe(cfg.authUrl);
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('grant_type=client_credentials');
    expect(String(init.body)).toContain('client_id=id');
  });

  it('refetches after the token nears expiry', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'A', expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'B', expires_in: 900 }));
    let t = 0;
    const mgr = new ExelyTokenManager(cfg, { fetchFn: fetchFn as unknown as typeof fetch, now: () => t });

    expect(await mgr.getToken()).toBe('A');
    t += 900_000; // 15 min later → expired
    expect(await mgr.getToken()).toBe('B');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error on a non-OK response', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 401 }));
    const mgr = new ExelyTokenManager(cfg, { fetchFn: fetchFn as unknown as typeof fetch, now: () => 0 });
    await expect(mgr.getToken()).rejects.toThrow(/exely auth failed/i);
  });
});
