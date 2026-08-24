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
      expect(call.url).toBe(`https://graph.instagram.com/v26.0/${IG_ID}/messages`);
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
    expect(calls[0].url).toBe(`https://graph.instagram.com/v26.0/${IG_ID}/messages`);
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

  it('parseWebhook: an attachment-only message is described by kind, not rejected', () => {
    const { adapter } = makeAdapter();
    const att = {
      sender: { id: PSID },
      message: { mid: 'ig.mid.9', attachments: [{ type: 'image', payload: { url: 'http://x' } }] },
    };
    const parsed = adapter.parseWebhook(igPayload([att]));
    expect(parsed.length).toBe(1);
    expect(parsed[0].text).toContain('фотографию');
  });

  it('parseWebhook: malformed bodies yield no messages and never throw', () => {
    const { adapter } = makeAdapter();
    expect(adapter.parseWebhook(null)).toEqual([]);
    expect(adapter.parseWebhook({ entry: 'garbage' })).toEqual([]);
    expect(adapter.parseWebhook({ entry: [{ messaging: 'nope' }] })).toEqual([]);
    expect(adapter.parseWebhook({ entry: [{ messaging: [{}] }] })).toEqual([]);
  });

  it('send: splits a long message so each chunk is ≤1000 BYTES (multi-byte safe)', async () => {
    const { adapter, calls } = makeAdapter();
    const long = 'а'.repeat(1500); // Cyrillic 'а' = 2 bytes → 3000 bytes total
    await adapter.send(SENDER, [{ text: long, delayMs: 0 }]);
    expect(calls.length).toBeGreaterThanOrEqual(3); // 3000 bytes / 1000 → ≥3 posts
    const enc = new TextEncoder();
    for (const c of calls) {
      const txt = JSON.parse(String(c.init?.body)).message.text;
      expect(enc.encode(txt).length).toBeLessThanOrEqual(1000);
    }
    const total = calls
      .map((c) => JSON.parse(String(c.init?.body)).message.text.length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(1500 - 6); // minus trimmed spaces at the splits
  });

  it('send: honors a custom baseUrl (e.g. the Facebook-Login path)', async () => {
    const { fn, calls } = fakeFetch(() => undefined);
    const adapter = new InstagramAdapter(
      { accessToken: 't', igIds: { almaty: IG_ID }, baseUrl: 'https://graph.facebook.com/v26.0' },
      fn,
    );
    await adapter.send(SENDER, [{ text: 'hi', delayMs: 0 }]);
    expect(calls[0].url).toBe(`https://graph.facebook.com/v26.0/${IG_ID}/messages`);
  });

  it('send: uses the account-specific token (Instagram Login = one token per account)', async () => {
    const { fn, calls } = fakeFetch(() => undefined);
    const adapter = new InstagramAdapter(
      { accessToken: 'fallback', igIds: { almaty: IG_ID }, tokens: { almaty: 'per-account-token' } },
      fn,
    );
    await adapter.send(SENDER, [{ text: 'hi', delayMs: 0 }]);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer per-account-token',
    );
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
      // Вебхук Instagram проверяется СВОИМ секретом — фейсбучный ему не подходит.
      instagram: { appSecret: opts.appSecret },
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

/** Жалоба менеджеров 2026-08-16: гости кидают сторис с отзывами, бот отвечал «не могу открыть». */
describe('InstagramAdapter: сторис и вложения', () => {
  const adapter = new InstagramAdapter({ igIds: { almaty: '111' }, accessToken: 't' });
  const evt = (message: unknown) => ({
    entry: [{ messaging: [{ sender: { id: 'g1' }, recipient: { id: '111' }, message }] }],
  });

  it('упоминание отеля в сторис распознаётся как отзыв', () => {
    const [m] = adapter.parseWebhook(evt({ mid: 'm1', attachments: [{ type: 'story_mention' }] }));
    expect(m.text).toContain('упомянул отель в своей истории');
  });

  it('ответ на историю отеля помечается и сохраняет текст гостя', () => {
    const [m] = adapter.parseWebhook(
      evt({ mid: 'm2', text: 'а завтрак во сколько?', reply_to: { story: { id: 's1' } } }),
    );
    expect(m.text).toContain('ответил на историю');
    expect(m.text).toContain('завтрак');
  });

  it('reels и пересланная публикация различаются', () => {
    const [reel] = adapter.parseWebhook(evt({ mid: 'm3', attachments: [{ type: 'ig_reel' }] }));
    expect(reel.text).toContain('reels');
    const [share] = adapter.parseWebhook(evt({ mid: 'm4', attachments: [{ type: 'share' }] }));
    expect(share.text).toContain('переслал');
  });
});

describe('повторы при временном отказе Instagram', () => {
  /** Отвечает по списку: сначала отказы, потом успех. */
  function adapterWith(replies: Array<{ ok: boolean; status: number; body?: string }>) {
    let i = 0;
    const fetchFn = vi.fn(async () => {
      const r = replies[Math.min(i++, replies.length - 1)];
      return { ok: r.ok, status: r.status, text: async () => r.body ?? '' };
    }) as unknown as typeof fetch;
    const adapter = new InstagramAdapter(
      { igIds: { almaty: '1' }, tokens: { almaty: 't' } } as never,
      fetchFn,
      async () => undefined,
    );
    return { adapter, fetchFn };
  }

  const BLOCKED = {
    ok: false,
    status: 400,
    body: JSON.stringify({ error: { message: 'API access blocked.', code: 200 } }),
  };
  const OK = { ok: true, status: 200 };

  it('повторяет «API access blocked» и всё-таки доставляет', async () => {
    // Meta глушит всплески временно. Без повтора ответ гостю теряется навсегда, и он
    // сидит перед молчащим чатом — так мы уже потеряли два ответа подряд.
    const { adapter, fetchFn } = adapterWith([BLOCKED, BLOCKED, OK]);
    await adapter.send('1:psid', [{ text: 'привет', delayMs: 0 }]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('не повторяет отказ, который повтором не лечится', async () => {
    // Истёкшее окно переписки или протухший токен от повтора не пройдут — только
    // потратят время и добавят Meta поводов заблокировать нас снова.
    const expired = {
      ok: false,
      status: 400,
      body: JSON.stringify({
        error: { message: 'This message is sent outside of allowed window.', code: 10 },
      }),
    };
    const { adapter, fetchFn } = adapterWith([expired]);
    await expect(adapter.send('1:psid', [{ text: 'привет', delayMs: 0 }])).rejects.toThrow(
      /outside of allowed window/,
    );
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('сдаётся после нескольких попыток, а не бесконечно', async () => {
    const { adapter, fetchFn } = adapterWith([BLOCKED]);
    await expect(adapter.send('1:psid', [{ text: 'привет', delayMs: 0 }])).rejects.toThrow(
      /API access blocked/,
    );
    expect(vi.mocked(fetchFn).mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe('диагностика отказов Instagram', () => {
  it('доносит текст ошибки Meta, а не только код', async () => {
    // «HTTP 400» одинаково выглядит и при истёкшем 24-часовом окне, и при протухшем
    // токене. Без текста причину недоставленного подтверждения брони не найти.
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: { message: 'This message is sent outside of allowed window.', code: 10 },
        }),
    })) as unknown as typeof fetch;
    const adapter = new InstagramAdapter(
      { igIds: { almaty: '1' }, tokens: { almaty: 't' } } as never,
      fetchFn,
      async () => undefined,
    );
    await expect(adapter.send('1:psid', [{ text: 'привет', delayMs: 0 }])).rejects.toThrow(
      /outside of allowed window/,
    );
  });
});

describe('подпись вебхука', () => {
  const SECRET = 'app-secret';
  const sign = (body: string): string =>
    `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

  async function build(enforce: boolean) {
    const prev = process.env.WEBHOOK_OBSERVE_ONLY;
    if (enforce) delete process.env.WEBHOOK_OBSERVE_ONLY;
    else process.env.WEBHOOK_OBSERVE_ONLY = 'true';
    const handle = vi.fn(async () => null);
    const events: string[] = [];
    const app = await buildServer({
      engine: { handle },
      adapters: {},
      store: { recordEvent: (t: string) => events.push(t) },
      config: {
        whatsapp: { verifyToken: 'v', appSecret: SECRET, phoneNumberIds: {} },
        // У Instagram свой секрет подписи — фейсбучный ему не подходит.
        instagram: { igIds: {}, tokens: {}, appSecret: SECRET },
      },
    } as never);
    return {
      app,
      events,
      restore: () => {
        if (prev === undefined) delete process.env.WEBHOOK_OBSERVE_ONLY;
        else process.env.WEBHOOK_OBSERVE_ONLY = prev;
      },
    };
  }

  const payload = JSON.stringify({ object: 'instagram', entry: [] });

  it('верную подпись пропускает', async () => {
    const { app, restore } = await build(true);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) },
      payload,
    });
    expect(res.statusCode).toBe(200);
    restore();
  });

  it('по умолчанию (без флага) чужая подпись отвергается', async () => {
    // Строгий отказ — норма. Режим наблюдения включают руками и ненадолго.
    const { app, restore } = await build(true);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload,
    });
    expect(res.statusCode).toBe(401);
    restore();
  });

  it('в режиме наблюдения чужую подпись пропускает, но записывает', async () => {
    // Секрет приложения может оказаться от ДРУГОГО приложения Meta. Если сразу запрещать,
    // бот оглохнет на настоящих гостей и никому об этом не скажет.
    const { app, events, restore } = await build(false);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(events).toContain('webhook_signature_mismatch');
    restore();
  });

  it('когда запрет включён — чужую подпись отвергает', async () => {
    const { app, restore } = await build(true);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload,
    });
    expect(res.statusCode).toBe(401);
    restore();
  });
});

describe('менеджер отвечает из приложения Instagram', () => {
  const IG = 'ig-hotel-1';
  const GUEST = '55667788';
  const echo = (text: string) => ({
    object: 'instagram',
    entry: [
      {
        id: IG,
        messaging: [
          { sender: { id: IG }, recipient: { id: GUEST }, message: { mid: 'm1', text, is_echo: true } },
        ],
      },
    ],
  });

  function store(history: Array<{ role: string; content: string }>, status = 'active') {
    const calls = { appended: [] as string[], status: [] as string[], events: [] as string[] };
    return {
      calls,
      recordEvent: (t: string) => calls.events.push(t),
      getConversation: () => ({ status, history }),
      appendMessage: (_id: string, m: { content: string }) => calls.appended.push(m.content),
      setStatus: (_id: string, s: string) => calls.status.push(s),
    };
  }

  async function post(st: ReturnType<typeof store>, body: unknown) {
    const app = await buildServer({
      engine: { handle: vi.fn(async () => null) },
      adapters: { instagram: new InstagramAdapter({ igIds: { almaty: IG }, tokens: { almaty: 't' } } as never) },
      store: st,
      config: { whatsapp: { phoneNumberIds: {} }, instagram: { igIds: { almaty: IG }, tokens: { almaty: 't' } } },
    } as never);
    await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    await app.close();
  }

  it('чужое исходящее попадает в историю, но бота НЕ глушит', async () => {
    // Instagram помечает is_echo и ответ менеджера, и автоответ самого аккаунта — различить
    // нельзя. Раньше здесь стоял перевод в handed_off, и он выстрелил в живого гостя:
    // автоответ «перейдите на наш сайт» приняли за менеджера, бот замолчал, а гостья
    // спрашивала меню, даты и число человек в пустоту, пока не написала жалобу.
    const st = store([{ role: 'assistant', content: 'Здравствуйте! Чем могу помочь?' }]);
    await post(st, echo('Добрый день, для получения точной информации перейдите на наш сайт'));

    expect(st.calls.appended).toContain(
      'Добрый день, для получения точной информации перейдите на наш сайт',
    );
    expect(st.calls.status).toHaveLength(0);
    expect(st.calls.events).toContain('ig_staff_echo');
  });

  it('собственное эхо бота ничего не глушит', async () => {
    // Instagram помечает is_echo и наши отправки тоже: принять их за менеджера — значит
    // заглушить бота после каждой его же реплики.
    const st = store([{ role: 'assistant', content: 'Здравствуйте!|||Чем могу помочь?' }]);
    await post(st, echo('Чем могу помочь?'));

    expect(st.calls.appended).toHaveLength(0);
    expect(st.calls.status).toHaveLength(0);
  });
});

describe('подбор верного секрета по живой доставке', () => {
  const RIGHT = 'настоящий-секрет';
  const WRONG = 'тот-что-в-настройках';
  const payload = JSON.stringify({ object: 'instagram', entry: [] });
  const signWith = (secret: string) =>
    `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

  async function build(candidates?: string) {
    const prev = process.env.INSTAGRAM_APP_SECRET_CANDIDATES;
    if (candidates) process.env.INSTAGRAM_APP_SECRET_CANDIDATES = candidates;
    else delete process.env.INSTAGRAM_APP_SECRET_CANDIDATES;
    const events: string[] = [];
    const app = await buildServer({
      engine: { handle: vi.fn(async () => null) },
      adapters: {},
      store: { recordEvent: (t: string) => events.push(t) },
      config: {
        whatsapp: { verifyToken: 'v', phoneNumberIds: {} },
        instagram: { igIds: {}, tokens: {}, appSecret: WRONG },
      },
    } as never);
    return {
      app,
      events,
      restore: () => {
        if (prev === undefined) delete process.env.INSTAGRAM_APP_SECRET_CANDIDATES;
        else process.env.INSTAGRAM_APP_SECRET_CANDIDATES = prev;
      },
    };
  }

  const post = (app: Awaited<ReturnType<typeof build>>['app'], sig: string) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
      payload,
    });

  it('называет номер подошедшего кандидата, не раскрывая его', async () => {
    // Гадать, какой из секретов Meta верный, бессмысленно — пусть ответит сама доставка.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app, restore } = await build(`мимо,${RIGHT}`);
    await post(app, signWith(RIGHT));

    const line = warn.mock.calls.map((c) => String(c[0])).join(' ');
    expect(line).toContain('ПОДОШЁЛ КАНДИДАТ №2');
    expect(line).not.toContain(RIGHT);
    warn.mockRestore();
    restore();
    await app.close();
  });

  it('успешную проверку тоже записывает — тишина не значит «всё сошлось»', async () => {
    // Иначе пустой журнал одинаково означает «подпись верна» и «доставок не было»,
    // а различить это обязательно до снятия режима наблюдения.
    const { app, events, restore } = await build();
    await post(app, signWith(WRONG));
    expect(events).toContain('webhook_signature_ok');
    restore();
    await app.close();
  });

  it('без кандидатов ведёт себя как раньше', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app, events, restore } = await build();
    await post(app, 'sha256=deadbeef');
    expect(events).toContain('webhook_signature_mismatch');
    expect(warn.mock.calls.map((c) => String(c[0])).join(' ')).not.toContain('КАНДИДАТ');
    warn.mockRestore();
    restore();
    await app.close();
  });
});
