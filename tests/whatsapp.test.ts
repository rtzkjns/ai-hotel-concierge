import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { WhatsAppAdapter, verifySignature } from '../src/channels/whatsapp';
import { buildServer } from '../src/server';
import type { InboundMessage, OutboundPart } from '../src/channels/types';

// --- Fixtures ------------------------------------------------------------------

const PHONE_ID = '111222333';
const WA_ID = '77012345678';

function waPayload(messages: unknown[], extraValue: Record<string, unknown> = {}): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '77770000000', phone_number_id: PHONE_ID },
              ...(messages.length > 0 ? { messages } : {}),
              ...extraValue,
            },
          },
        ],
      },
    ],
  };
}

const textMessage = (body: string, id = 'wamid.msg1') => ({
  from: WA_ID,
  id,
  timestamp: '1720000000',
  type: 'text',
  text: { body },
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

function makeAdapter(fetchImpl?: typeof fetch) {
  const { fn, calls } = fakeFetch(() => undefined);
  return {
    adapter: new WhatsAppAdapter(
      { accessToken: 'wa-token', phoneNumberIds: { almaty: PHONE_ID } },
      fetchImpl ?? fn,
    ),
    calls,
  };
}

const sign = (body: string, secret: string): string =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

// --- Adapter unit tests -----------------------------------------------------------

describe('WhatsAppAdapter', () => {
  it('send: decodes phoneNumberId|waId and posts parts sequentially in order', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.send(`${PHONE_ID}|${WA_ID}`, [
      { text: 'первая', delayMs: 0 },
      { text: 'вторая', delayMs: 1 },
    ]);

    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.url).toBe(`https://graph.facebook.com/v23.0/${PHONE_ID}/messages`);
      expect((call.init?.headers as Record<string, string>).Authorization).toBe('Bearer wa-token');
    }
    const bodies = calls.map((c) => JSON.parse(String(c.init?.body)));
    expect(bodies[0]).toEqual({
      messaging_product: 'whatsapp',
      to: WA_ID,
      type: 'text',
      text: { body: 'первая' },
    });
    expect(bodies[1].text.body).toBe('вторая');
  });

  it('typing: posts mark-read with a typing indicator for the inbound message', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.typing(`${PHONE_ID}|${WA_ID}`, 'wamid.msg1');

    expect(calls.length).toBe(1);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.msg1',
      typing_indicator: { type: 'text' },
    });
  });

  it('parseWebhook: text message → InboundMessage with composite senderId', () => {
    const { adapter } = makeAdapter();
    const parsed = adapter.parseWebhook(waPayload([textMessage('здравствуйте, есть номера?')]));

    expect(parsed.length).toBe(1);
    expect(parsed[0].phoneNumberId).toBe(PHONE_ID);
    expect(parsed[0].inbound).toMatchObject({
      channel: 'whatsapp',
      senderId: `${PHONE_ID}|${WA_ID}`,
      text: 'здравствуйте, есть номера?',
      inboundId: 'wamid.msg1',
    });
  });

  it('parseWebhook: statuses-only payloads and malformed bodies yield no messages', () => {
    const { adapter } = makeAdapter();
    const statuses = waPayload([], {
      statuses: [{ id: 'wamid.msg1', status: 'delivered', recipient_id: WA_ID }],
    });
    expect(adapter.parseWebhook(statuses)).toEqual([]);
    expect(adapter.parseWebhook(null)).toEqual([]);
    expect(adapter.parseWebhook({ entry: 'garbage' })).toEqual([]);
    expect(adapter.parseWebhook({ entry: [{ changes: [{ value: {} }] }] })).toEqual([]);
  });

  it('parseWebhook: audio message returns a media marker instead of text', () => {
    const { adapter } = makeAdapter();
    const parsed = adapter.parseWebhook(
      waPayload([
        {
          from: WA_ID,
          id: 'wamid.voice1',
          type: 'audio',
          audio: { id: 'media-42', mime_type: 'audio/ogg; codecs=opus' },
        },
      ]),
    );

    expect(parsed.length).toBe(1);
    expect(parsed[0].audioMediaId).toBe('media-42');
    expect(parsed[0].audioMime).toBe('audio/ogg; codecs=opus');
    expect(parsed[0].inbound.text).toBeUndefined();
  });

  it('parseWebhook: unsupported types become an explicit placeholder text', () => {
    const { adapter } = makeAdapter();
    const parsed = adapter.parseWebhook(
      waPayload([{ from: WA_ID, id: 'wamid.img1', type: 'image', image: { id: 'img-1' } }]),
    );

    expect(parsed.length).toBe(1);
    expect(parsed[0].inbound.text).toContain('unsupported message type');
  });
});

describe('verifySignature', () => {
  const body = '{"object":"whatsapp_business_account"}';

  it('accepts a correct HMAC-SHA256 signature', () => {
    expect(verifySignature(body, sign(body, 's3cret'), 's3cret')).toBe(true);
  });

  it('rejects wrong secrets, tampered bodies, and missing headers', () => {
    expect(verifySignature(body, sign(body, 'other'), 's3cret')).toBe(false);
    expect(verifySignature(body + ' ', sign(body, 's3cret'), 's3cret')).toBe(false);
    expect(verifySignature(body, undefined, 's3cret')).toBe(false);
    expect(verifySignature(body, 'sha256=zz', 's3cret')).toBe(false);
  });
});

// --- Server tests -----------------------------------------------------------------

function fakeEngine(parts: OutboundPart[] | null = [{ text: 'ok', delayMs: 0 }]) {
  return { handle: vi.fn(async (_msg: InboundMessage) => parts) };
}

function fakeStore() {
  const events: string[] = [];
  return { events, recordEvent: vi.fn((type: string) => events.push(type)) };
}

async function makeServer(opts: { appSecret?: string; engineParts?: OutboundPart[] | null } = {}) {
  const engine = fakeEngine(opts.engineParts);
  const store = fakeStore();
  const { fn, calls } = fakeFetch((url) => {
    if (url.endsWith('/media-42')) {
      return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/bin' }), { status: 200 });
    }
    if (url === 'https://lookaside.fbsbx.com/whatsapp_business/attachments/bin') {
      return new Response(new Uint8Array(Buffer.from('OGGDATA')), { status: 200 });
    }
    return undefined;
  });
  const adapter = new WhatsAppAdapter(
    { accessToken: 'wa-token', phoneNumberIds: { almaty: PHONE_ID } },
    fn,
  );
  const app = await buildServer({
    engine,
    adapters: { whatsapp: adapter },
    store,
    config: {
      whatsapp: {
        verifyToken: 'verify-me',
        appSecret: opts.appSecret,
        phoneNumberIds: { almaty: PHONE_ID },
      },
    },
  });
  return { app, engine, store, calls };
}

describe('buildServer', () => {
  it('GET /healthz responds ok', async () => {
    const { app } = await makeServer();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('GET /webhooks/whatsapp echoes the challenge for the right verify token', async () => {
    const { app } = await makeServer();
    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=ch42',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ch42');
    await app.close();
  });

  it('GET /webhooks/whatsapp rejects a wrong verify token with 403', async () => {
    const { app } = await makeServer();
    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=ch42',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('POST with a valid signature → 200 and the engine gets the parsed text', async () => {
    const { app, engine, calls } = await makeServer({ appSecret: 's3cret' });
    const body = JSON.stringify(waPayload([textMessage('привет')]));

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 's3cret') },
    });

    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(engine.handle).toHaveBeenCalledTimes(1));
    const msg = engine.handle.mock.calls[0][0];
    expect(msg).toMatchObject({
      channel: 'whatsapp',
      senderId: `${PHONE_ID}|${WA_ID}`,
      text: 'привет',
      propertyHint: 'almaty',
      inboundId: 'wamid.msg1',
    });
    // Typing/read first, then the reply part is sent back through the Graph API.
    await vi.waitFor(() => {
      const bodies = calls.map((c) => JSON.parse(String(c.init?.body)));
      expect(bodies.some((b) => b.status === 'read')).toBe(true);
      expect(bodies.some((b) => b.text?.body === 'ok')).toBe(true);
    });
    await app.close();
  });

  it('POST with a wrong signature → 401 and no processing', async () => {
    const { app, engine } = await makeServer({ appSecret: 's3cret' });
    const body = JSON.stringify(waPayload([textMessage('привет')]));

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 'wrong') },
    });

    expect(res.statusCode).toBe(401);
    await new Promise((r) => setImmediate(r));
    expect(engine.handle).not.toHaveBeenCalled();
    await app.close();
  });

  it('statuses-only payloads → 200 without engine calls; malformed JSON never crashes', async () => {
    const { app, engine } = await makeServer();
    const statuses = JSON.stringify(
      waPayload([], { statuses: [{ id: 'wamid.msg1', status: 'read' }] }),
    );
    const res1 = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      payload: statuses,
      headers: { 'content-type': 'application/json' },
    });
    const res2 = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      payload: 'this is {not json',
      headers: { 'content-type': 'application/json' },
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(engine.handle).not.toHaveBeenCalled();
    await app.close();
  });

  it('audio messages: media is downloaded (2-step, Bearer) and reaches the engine as a buffer', async () => {
    const { app, engine } = await makeServer();
    const body = JSON.stringify(
      waPayload([
        {
          from: WA_ID,
          id: 'wamid.voice1',
          type: 'audio',
          audio: { id: 'media-42', mime_type: 'audio/ogg' },
        },
      ]),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      payload: body,
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(engine.handle).toHaveBeenCalledTimes(1));
    const msg = engine.handle.mock.calls[0][0];
    expect(msg.audio).toBeDefined();
    expect(msg.audio!.data.toString()).toBe('OGGDATA');
    expect(msg.audio!.mime).toBe('audio/ogg');
    await app.close();
  });

  it('POST /webhooks/instagram always answers 200 and tracks ig_received', async () => {
    const { app, store } = await makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      payload: 'whatever {',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.events).toContain('ig_received');
    await app.close();
  });
});
