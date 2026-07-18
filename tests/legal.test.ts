import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../src/server';
import type { InboundMessage, OutboundPart } from '../src/channels/types';

function makeServer() {
  const engine = { handle: vi.fn(async (_m: InboundMessage): Promise<OutboundPart[] | null> => null) };
  const store = { events: [] as string[], recordEvent: vi.fn() };
  return buildServer({
    engine,
    adapters: {},
    store,
    config: { whatsapp: { verifyToken: 'v', phoneNumberIds: {} } },
  });
}

describe('legal pages', () => {
  it('serves a privacy policy at /privacy', async () => {
    const app = await makeServer();
    const res = await app.inject({ method: 'GET', url: '/privacy' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Политика конфиденциальности');
    expect(res.body.toLowerCase()).toContain('90');
    await app.close();
  });

  it('serves terms at /terms', async () => {
    const app = await makeServer();
    const res = await app.inject({ method: 'GET', url: '/terms' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Условия использования');
    await app.close();
  });
});
