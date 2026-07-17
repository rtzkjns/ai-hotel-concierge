import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { InstagramAdapter } from '../src/channels/instagram';
import { buildServer } from '../src/server';
import type { InboundMessage, OutboundPart } from '../src/channels/types';

// --- Fixtures ------------------------------------------------------------------

const IG_ID = 'ig-hotel-1';
const PSID = '55667788'; // guest's page-scoped id

function igPayload(messaging: unknown[]): unknown {
  return {
    object: 'instagram',
    entry: [{ id: IG_ID, time: 1720000000, messaging }],
  };
}

const textMsg = (text: string, mid = 'ig.mid.1') => ({
  sender: { id: PSID },
  recipient: { id: IG_ID },
  timestamp: 1720000000,
  message: { mid, text },
});

function fakeFetch(routes: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    return routes(u, init) ?? new Response('{}', { status: 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const SENDER = `${IG_ID}|${PSID}`; // composite senderId the adapter now uses

function makeAdapter() {
  const { fn, calls } = fakeFetch(() => undefined);
  return {
    adapter: new InstagramAdapter({ accessToken: 'ig-token', igIds: { almaty: IG_ID } }, fn),
    calls,
  };
}

const sign = (body: string, secret: string): string =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

// --- Adapter unit tests -----------------------------------------------------------

describe('InstagramAdapter', () => {
  it('send: posts each part to the IG messages endpoint with the Bearer token', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.send(SENDER, [
      { text: 'первая', delayMs: 0 },
      { text: 'вторая', delayMs: 0 },
    ]);
    expect(calls.length).toBe(2);
    for (const call of calls) {
      // The reply goes back from the SAME IG account the guest wrote to.
      expect(call.url).toBe(`https://graph.facebook.com/v23.0/${IG_ID}/messages`);
      expect((call.init?.headers as Record<string, string>).Authorization).toBe('Bearer ig-token');
    }
    const bodies = calls.map((c) => JSON.parse(String(c.init?.body)));
    expect(bodies[0]).toEqual({ recipient: { id: PSID }, message: { text: 'первая' } });
    expect(bodies[1].message.text).toBe('вторая');
  });

  it('typing: posts a typing_on sender action', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.typing(SENDER);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`https://graph.facebook.com/v23.0/${IG_ID}/messages`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      recipient: { id: PSID },
      sender_action: 'typing_on',
    });
  });

  it('parseWebhook: a text message becomes an InboundMessage tagged with its hotel', () => {
    const { adapter } = makeAdapter();
    const parsed = adapter.parseWebhook(igPayload([textMsg('есть номера?')]));
    expect(parsed).toEqual([
      {
        channel: 'instagram',
        senderId: SENDER,
        text: 'есть номера?',
        inboundId: 'ig.mid.1',
        propertyHint: 'almaty',
      },
    ]);
  });

  it('parseWebhook: echoes, read and delivery events are ignored', () => {
    const { adapter } = makeAdapter();
    const echo = { sender: { id: IG_ID }, message: { mid: 'x', text: ' our reply', is_echo: true } };
    const read = { sender: { id: PSID }, read: { mid: 'ig.mid.1' } };
    const delivery = { sender: { id: PSID }, delivery: { mids: ['ig.mid.1'] } };
    expect(adapter.parseWebhook(igPayload([echo, read, delivery]))).toEqual([]);
  });

  it('parseWebhook: an attachment-only message becomes the unsupported placeholder', () => {
    const { adapter } = makeAdapter();
    const att = {
      sender: { id: PSID },
      message: { mid: 'ig.mid.9', attachments: [{ type: 'image', payload: { url: 'http://x' } }] },
    };
    const parsed = adapter.parseWebhook(igPayload([att]));
    expect(parsed.length).toBe(1);
    expect(parsed[0].text).toContain('unsupported message type');
  });

  it('parseWebhook: malformed bodies yield no messages and never throw', () => {
    const { adapter } = makeAdapter();
    expect(adapter.parseWebhook(null)).toEqual([]);
    expect(adapter.parseWebhook({ entry: 'garbage' })).toEqual([]);
    expect(adapter.parseWebhook({ entry: [{ messaging: 'nope' }] })).toEqual([]);
    expect(adapter.parseWebhook({ entry: [{ messaging: [{}] }] })).toEqual([]);
  });

  it('send: splits a >1000-char message into multiple posts', async () => {
    const { adapter, calls } = makeAdapter();
    const long = 'а'.repeat(1500);
    await adapter.send(SENDER, [{ text: long, delayMs: 0 }]);
    expect(calls.length).toBe(2);
    const total = calls
      .map((c) => JSON.parse(String(c.init?.body)).message.text.length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(1500 - 4); // minus trimmed spaces at the split
  });
});

// --- Server round-trip ------------------------------------------------------------

function fakeEngine(parts: OutboundPart[] | null = [{ text: 'привет)', delayMs: 0 }]) {
  return { handle: vi.fn(async (_msg: InboundMessage) => parts) };
}

function fakeStore() {
  const events: string[] = [];
  return { events, recordEvent: vi.fn((type: string) => events.push(type)) };
}

async function makeServer(opts: { appSecret?: string } = {}) {
  const engine = fakeEngine();
  const store = fakeStore();
  const { fn, calls } = fakeFetch(() => undefined);
  const adapter = new InstagramAdapter({ accessToken: 'ig-token', igIds: { almaty: IG_ID } }, fn);
  const app = await buildServer({
    engine,
    adapters: { instagram: adapter },
    store,
    config: {
      whatsapp: { verifyToken: 'verify-me', appSecret: opts.appSecret, phoneNumberIds: {} },
    },
  });
  return { app, engine, store, calls };
}

describe('Instagram webhook round-trip', () => {
  it('GET /webhooks/instagram echoes the challenge for the right verify token', async () => {
    const { app } = await makeServer();
    const ok = await app.inject({
      method: 'GET',
      url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=ig99',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('ig99');
    await app.close();
  });

  it('signed POST → engine gets the exact InboundMessage, reply posts to Graph in order', async () => {
    const { app, engine, calls } = await makeServer({ appSecret: 's3cret' });
    const body = JSON.stringify(igPayload([textMsg('здравствуйте')]));
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 's3cret') },
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(engine.handle).toHaveBeenCalledTimes(1));
    expect(engine.handle.mock.calls[0][0]).toEqual({
      channel: 'instagram',
      senderId: SENDER,
      text: 'здравствуйте',
      inboundId: 'ig.mid.1',
      propertyHint: 'almaty',
    });
    await vi.waitFor(() => {
      const bodies = calls.map((c) => JSON.parse(String(c.init?.body)));
      expect(bodies.some((b) => b.sender_action === 'typing_on')).toBe(true);
      expect(bodies.some((b) => b.message?.text === 'привет)')).toBe(true);
    });
    await app.close();
  });

  it('wrong signature → 401 and the engine is never called', async () => {
    const { app, engine } = await makeServer({ appSecret: 's3cret' });
    const body = JSON.stringify(igPayload([textMsg('привет')]));
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 'wrong') },
    });
    expect(res.statusCode).toBe(401);
    expect(engine.handle).not.toHaveBeenCalled();
    await app.close();
  });

  it('malformed JSON → 200 and no crash', async () => {
    const { app, engine } = await makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      payload: 'not json {',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(engine.handle).not.toHaveBeenCalled();
    await app.close();
  });
});
