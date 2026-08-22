import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { WhatsAppAdapter, verifySignature } from '../src/channels/whatsapp';
import { buildServer } from '../src/server';
import type { InboundMessage, OutboundPart } from '../src/channels/types';

// --- Fixtures ------------------------------------------------------------------

const PHONE_ID = '111222333';
const ASTANA_PHONE_ID = '444555666';
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

  it('360dialog provider: posts to /messages with a D360-API-KEY header (no phone id in path)', async () => {
    const { fn, calls } = fakeFetch(() => undefined);
    const adapter = new WhatsAppAdapter(
      { accessToken: 'd360-key', phoneNumberIds: { almaty: PHONE_ID }, provider: 'd360' },
      fn,
    );
    await adapter.send(`${PHONE_ID}|${WA_ID}`, [{ text: 'привет', delayMs: 0 }]);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://waba-v2.360dialog.io/messages');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['D360-API-KEY']).toBe('d360-key');
    expect(headers.Authorization).toBeUndefined(); // key goes only in the D360 header
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      messaging_product: 'whatsapp',
      to: WA_ID,
      type: 'text',
      text: { body: 'привет' },
    });
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

async function makeServer(
  opts: {
    appSecret?: string;
    engineParts?: OutboundPart[] | null;
    phoneNumberIds?: Record<string, string>;
  } = {},
) {
  const engine = fakeEngine(opts.engineParts);
  const store = fakeStore();
  const phoneNumberIds = opts.phoneNumberIds ?? { almaty: PHONE_ID };
  const { fn, calls } = fakeFetch((url) => {
    if (url.endsWith('/media-42')) {
      return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/bin' }), { status: 200 });
    }
    if (url === 'https://lookaside.fbsbx.com/whatsapp_business/attachments/bin') {
      return new Response(new Uint8Array(Buffer.from('OGGDATA')), { status: 200 });
    }
    if (url.endsWith('/media-evil')) {
      // A (hypothetically compromised) Graph response pointing off Meta's CDN.
      return new Response(JSON.stringify({ url: 'https://evil.example.com/steal-the-token' }), { status: 200 });
    }
    return undefined;
  });
  const adapter = new WhatsAppAdapter({ accessToken: 'wa-token', phoneNumberIds }, fn);
  const app = await buildServer({
    engine,
    adapters: { whatsapp: adapter },
    store,
    config: {
      whatsapp: {
        verifyToken: 'verify-me',
        appSecret: opts.appSecret,
        phoneNumberIds,
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

  it('POST /webhooks/instagram answers 200 but records nothing while unconfigured (spam guard)', async () => {
    const { app, store } = await makeServer();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      payload: 'whatever {',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    // Anonymous unsigned POSTs must not grow the append-only events table.
    expect(store.events).not.toContain('ig_received');
    await app.close();
  });

  it('unknown message type flows through the server to the engine as the unsupported placeholder', async () => {
    const { app, engine } = await makeServer();
    const body = JSON.stringify(
      waPayload([{ from: WA_ID, id: 'wamid.stk1', type: 'sticker', sticker: { id: 'stk-9' } }]),
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
    expect(msg.text).toBe('[unsupported message type: sticker]');
    expect(msg.propertyHint).toBe('almaty');
    await app.close();
  });

  it('GET /webhooks/instagram performs the Meta verify handshake', async () => {
    const { app } = await makeServer();
    const ok = await app.inject({
      method: 'GET',
      url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=ig123',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('ig123');
    const bad = await app.inject({
      method: 'GET',
      url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=ig123',
    });
    expect(bad.statusCode).toBe(403);
    await app.close();
  });
});

// --- Full round-trip: signed webhook POST → engine → Graph API send -----------------
//
// These tests prove plug-and-play: the exact bytes Meta will POST (HMAC-signed)
// travel through signature check → parse → engine → typing/read → paced reply
// parts on the exact Graph URL with the Bearer token. When a real token arrives,
// only env vars change.

describe('WhatsApp round-trip integration', () => {
  it('signed inbound text → engine gets the parsed InboundMessage → typing/read first, then reply parts in order', async () => {
    const replyParts: OutboundPart[] = [
      { text: 'Здравствуйте! Да, номера есть.', delayMs: 0 },
      { text: 'Подсказать цены?', delayMs: 5 },
    ];
    const { app, engine, calls } = await makeServer({ appSecret: 's3cret', engineParts: replyParts });
    const body = JSON.stringify(waPayload([textMessage('есть номера на завтра?')]));

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 's3cret') },
    });

    // Meta requires a fast 2xx; processing continues async.
    expect(res.statusCode).toBe(200);

    // 1. The engine receives exactly the normalized InboundMessage — nothing more.
    await vi.waitFor(() => expect(engine.handle).toHaveBeenCalledTimes(1));
    expect(engine.handle.mock.calls[0][0]).toEqual({
      channel: 'whatsapp',
      senderId: `${PHONE_ID}|${WA_ID}`,
      propertyHint: 'almaty',
      text: 'есть номера на завтра?',
      inboundId: 'wamid.msg1',
    });

    // 2. Exactly three Graph calls: read/typing, then both parts, in order.
    await vi.waitFor(() => expect(calls.length).toBe(3));
    for (const call of calls) {
      expect(call.url).toBe(`https://graph.facebook.com/v23.0/${PHONE_ID}/messages`);
      expect(call.init?.method).toBe('POST');
      const headers = call.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer wa-token');
      expect(headers['Content-Type']).toBe('application/json');
    }
    const bodies = calls.map((c) => JSON.parse(String(c.init?.body)));
    expect(bodies[0]).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.msg1',
      typing_indicator: { type: 'text' },
    });
    expect(bodies[1]).toEqual({
      messaging_product: 'whatsapp',
      to: WA_ID,
      type: 'text',
      text: { body: 'Здравствуйте! Да, номера есть.' },
    });
    expect(bodies[2]).toEqual({
      messaging_product: 'whatsapp',
      to: WA_ID,
      type: 'text',
      text: { body: 'Подсказать цены?' },
    });
    await app.close();
  });

  it('routes each hotel number to its property: astana phone_number_id → astana, almaty → almaty', async () => {
    const { app, engine } = await makeServer({
      phoneNumberIds: { almaty: PHONE_ID, astana: ASTANA_PHONE_ID },
    });

    const post = async (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        payload: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      });

    const fromAstana = waPayload([textMessage('бар ма бос бөлмелер?', 'wamid.ast1')], {
      metadata: { display_phone_number: '77170000000', phone_number_id: ASTANA_PHONE_ID },
    });
    expect((await post(fromAstana)).statusCode).toBe(200);
    await vi.waitFor(() => expect(engine.handle).toHaveBeenCalledTimes(1));
    expect(engine.handle.mock.calls[0][0]).toMatchObject({
      propertyHint: 'astana',
      senderId: `${ASTANA_PHONE_ID}|${WA_ID}`,
      inboundId: 'wamid.ast1',
    });

    expect((await post(waPayload([textMessage('привет', 'wamid.alm1')]))).statusCode).toBe(200);
    await vi.waitFor(() => expect(engine.handle).toHaveBeenCalledTimes(2));
    expect(engine.handle.mock.calls[1][0]).toMatchObject({
      propertyHint: 'almaty',
      senderId: `${PHONE_ID}|${WA_ID}`,
      inboundId: 'wamid.alm1',
    });
    await app.close();
  });

  it('media URL off Meta hosts is refused — token never leaves Meta, guest still gets the voice fallback path', async () => {
    const { app, engine, calls } = await makeServer();
    const body = JSON.stringify(
      waPayload([
        {
          from: WA_ID,
          id: 'wamid.voiceEvil',
          type: 'audio',
          audio: { id: 'media-evil', mime_type: 'audio/ogg' },
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

    // The Bearer token was sent to Graph for metadata, but NEVER to the rogue host.
    expect(calls.some((c) => c.url.endsWith('/media-evil'))).toBe(true);
    expect(calls.some((c) => c.url.includes('evil.example.com'))).toBe(false);

    // The engine still sees a voice-shaped message (empty audio → transcriber
    // returns null → the polite "please type it out" fallback), never dead silence.
    const msg = engine.handle.mock.calls[0][0];
    expect(msg.text).toBeUndefined();
    expect(msg.audio).toBeDefined();
    expect(msg.audio!.data.length).toBe(0);
    expect(msg.audio!.mime).toBe('audio/ogg');
    await app.close();
  });
});

describe('подпись вебхука на разных провайдерах', () => {
  const SECRET = 'meta-app-secret';
  const SHARED = 'shared-header-secret';
  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  /** На Meta общего заголовка нет — там гарантией служит именно подпись. */
  async function build(provider: string) {
    const events: string[] = [];
    const app = await buildServer({
      engine: { handle: vi.fn(async () => null) },
      adapters: {},
      store: { recordEvent: (t: string) => events.push(t) },
      config: {
        whatsapp: {
          verifyToken: 'v',
          appSecret: SECRET,
          webhookSecret: provider === 'd360' ? SHARED : undefined,
          provider,
          phoneNumberIds: {},
        },
        instagram: { igIds: {}, tokens: {} },
      },
    } as never);
    return { app, events };
  }

  it('360dialog: чужая подпись Meta не считается ошибкой', async () => {
    // d360 подписывает своим ключом. Проверка ключом Meta там не сходится НИКОГДА и за
    // сутки дала 60 ложных тревог, за которыми потерялись бы настоящие. Гарантия здесь —
    // общий секрет в заголовке.
    const { app, events } = await build('d360');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-kazzhol-webhook-secret': SHARED,
        'x-hub-signature-256': 'sha256=подпись360dialog',
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(events).not.toContain('webhook_signature_mismatch');
    await app.close();
  });

  it('360dialog: без общего секрета в заголовке запрос всё равно отвергается', async () => {
    // Отключив проверку Meta, нельзя остаться совсем без защиты.
    const { app } = await build('d360');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('Meta: подпись по-прежнему проверяется', async () => {
    const { app, events } = await build('meta');
    await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload,
    });
    expect(events).toContain('webhook_signature_mismatch');
    await app.close();
  });
});
