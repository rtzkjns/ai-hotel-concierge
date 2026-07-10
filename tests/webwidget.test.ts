import { describe, it, expect, vi } from 'vitest';
import { WebWidgetChannel } from '../src/channels/webwidget';
import { TelegramChannel, CHOOSE_HOTEL_MESSAGE } from '../src/channels/telegram';
import { InstagramAdapter } from '../src/channels/instagram';
import { HOTEL_SELECTOR_MESSAGE } from '../src/core/engine';
import { buildServer } from '../src/server';
import type { InboundMessage, OutboundPart } from '../src/channels/types';
import type { Channel, Conversation } from '../src/types';

// --- Fakes -------------------------------------------------------------------

function fakeEngine(parts: OutboundPart[] | null = [{ text: 'ok', delayMs: 0 }]) {
  return { handle: vi.fn(async (_msg: InboundMessage) => parts) };
}

function fakeWidgetStore() {
  const conversations = new Map<string, Conversation>();
  return {
    conversations,
    setProperty: vi.fn((id: string, property: string) => {
      const c = conversations.get(id);
      if (c) c.property = property;
    }),
    getOrCreateConversation(channel: Channel, senderId: string): Conversation {
      const id = `${channel}:${senderId}`;
      let c = conversations.get(id);
      if (!c) {
        c = {
          id,
          channel,
          senderId,
          property: '',
          status: 'active',
          language: null,
          history: [],
          updatedAt: new Date().toISOString(),
        };
        conversations.set(id, c);
      }
      return c;
    },
  };
}

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const closes: Array<{ code?: number }> = [];
  return {
    sent,
    closes,
    send(data: string) {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
    close(code?: number) {
      closes.push({ code });
    },
  };
}

function makeWidget(opts: { engine?: ReturnType<typeof fakeEngine>; now?: () => number } = {}) {
  const engine = opts.engine ?? fakeEngine();
  const store = fakeWidgetStore();
  const channel = new WebWidgetChannel({ engine, store, now: opts.now });
  return { channel, engine, store };
}

// --- Web widget protocol ---------------------------------------------------------

describe('WebWidgetChannel protocol', () => {
  it('closes with 4001 on a hello with an invalid token', async () => {
    const { channel } = makeWidget();
    const socket = fakeSocket();
    const session = channel.newSession();

    await channel.onMessage(session, JSON.stringify({ type: 'hello', token: 'garbage' }), socket);

    expect(socket.closes).toEqual([{ code: 4001 }]);
    expect(socket.sent).toEqual([]);
  });

  it('closes with 4001 when a message arrives before hello', async () => {
    const { channel, engine } = makeWidget();
    const socket = fakeSocket();
    const session = channel.newSession();

    await channel.onMessage(session, JSON.stringify({ type: 'msg', text: 'привет' }), socket);

    expect(socket.closes).toEqual([{ code: 4001 }]);
    expect(engine.handle).not.toHaveBeenCalled();
  });

  it('rejects an expired token', async () => {
    let t = 1_000_000;
    const { channel } = makeWidget({ now: () => t });
    const token = channel.issueToken();
    t += 61 * 60 * 1000; // past the 1h TTL

    const socket = fakeSocket();
    await channel.onMessage(
      channel.newSession(),
      JSON.stringify({ type: 'hello', token }),
      socket,
    );

    expect(socket.closes).toEqual([{ code: 4001 }]);
  });

  it('hello with a valid token opens a session and returns a senderId', async () => {
    const { channel, store } = makeWidget();
    const token = channel.issueToken();
    const socket = fakeSocket();
    const session = channel.newSession();

    await channel.onMessage(session, JSON.stringify({ type: 'hello', token }), socket);

    expect(socket.closes).toEqual([]);
    expect(socket.sent.length).toBe(1);
    const msg = socket.sent[0] as { type: string; senderId: string };
    expect(msg.type).toBe('session');
    expect(typeof msg.senderId).toBe('string');
    expect(msg.senderId.length).toBeGreaterThanOrEqual(8);
    expect(store.conversations.has(`webwidget:${msg.senderId}`)).toBe(true);
  });

  it('hello keeps a previously issued senderId (localStorage persistence)', async () => {
    const { channel } = makeWidget();
    const token = channel.issueToken();
    const socket = fakeSocket();

    await channel.onMessage(
      channel.newSession(),
      JSON.stringify({ type: 'hello', token, senderId: 'returning-guest-123' }),
      socket,
    );

    expect((socket.sent[0] as { senderId: string }).senderId).toBe('returning-guest-123');
  });

  it('a used token cannot mint a second senderId (rate-limit bypass guard)', async () => {
    const { channel } = makeWidget();
    const token = channel.issueToken();

    // First hello binds the token to the fresh senderId.
    const first = fakeSocket();
    await channel.onMessage(channel.newSession(), JSON.stringify({ type: 'hello', token }), first);
    const boundSenderId = (first.sent[0] as { senderId: string }).senderId;

    // Same token + same senderId = legit reconnect.
    const reconnect = fakeSocket();
    await channel.onMessage(
      channel.newSession(),
      JSON.stringify({ type: 'hello', token, senderId: boundSenderId }),
      reconnect,
    );
    expect(reconnect.closes).toEqual([]);

    // Same token without the bound senderId (would mint a fresh one) → rejected.
    const thief = fakeSocket();
    await channel.onMessage(channel.newSession(), JSON.stringify({ type: 'hello', token }), thief);
    expect(thief.closes).toEqual([{ code: 4001 }]);
  });

  it('pick_hotel → msg round trip: property set, typing then paced replies', async () => {
    const engine = fakeEngine([
      { text: 'добрый день!', delayMs: 0 },
      { text: 'секунду, гляну', delayMs: 1 },
    ]);
    const { channel, store } = makeWidget({ engine });
    const token = channel.issueToken();
    const socket = fakeSocket();
    const session = channel.newSession();

    await channel.onMessage(session, JSON.stringify({ type: 'hello', token }), socket);
    const senderId = (socket.sent[0] as { senderId: string }).senderId;
    await channel.onMessage(
      session,
      JSON.stringify({ type: 'pick_hotel', property: 'almaty' }),
      socket,
    );
    await channel.onMessage(session, JSON.stringify({ type: 'msg', text: 'привет' }), socket);

    expect(store.setProperty).toHaveBeenCalledWith(`webwidget:${senderId}`, 'almaty');
    expect(engine.handle).toHaveBeenCalledWith({
      channel: 'webwidget',
      senderId,
      text: 'привет',
    });
    const types = socket.sent.map((m) => m.type);
    expect(types).toEqual(['session', 'hotel', 'typing', 'reply', 'reply', 'idle']);
    const replies = socket.sent.filter((m) => m.type === 'reply').map((m) => m.text);
    expect(replies).toEqual(['добрый день!', 'секунду, гляну']);
  });

  it('ignores malformed JSON and unknown hotel keys after auth without crashing', async () => {
    const { channel, store } = makeWidget();
    const token = channel.issueToken();
    const socket = fakeSocket();
    const session = channel.newSession();
    await channel.onMessage(session, JSON.stringify({ type: 'hello', token }), socket);

    await channel.onMessage(session, 'this is {not json', socket);
    await channel.onMessage(
      session,
      JSON.stringify({ type: 'pick_hotel', property: 'ritz_paris' }),
      socket,
    );

    expect(socket.closes).toEqual([]);
    expect(store.setProperty).not.toHaveBeenCalled();
  });

  it('GET /widget serves the self-contained page with a real token injected', async () => {
    const { channel } = makeWidget();
    const app = await buildServer({
      engine: fakeEngine(),
      adapters: {},
      store: { recordEvent: vi.fn() },
      config: { whatsapp: { phoneNumberIds: {} } },
      extraRoutes: [(a) => channel.register(a)],
    });

    const res = await app.inject({ method: 'GET', url: '/widget' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).not.toContain('%%TOKEN%%');
    expect(res.body).toContain('Kazzhol');
    expect(res.body).toContain('/ws/widget');
    // No external resources: a strict self-contained page.
    expect(res.body).not.toMatch(/src\s*=\s*["']https?:/);
    expect(res.body).not.toMatch(/href\s*=\s*["']https?:/);
    await app.close();
  });
});

// --- Telegram channel -----------------------------------------------------------

describe('TelegramChannel', () => {
  function makeTelegram(engine = fakeEngine()) {
    const store = fakeWidgetStore();
    const channel = new TelegramChannel({
      botToken: '123:test-token',
      engine,
      store: { ...store, resetConversation: vi.fn() },
    });
    return { channel, engine };
  }

  function fakeCtx() {
    const replies: string[] = [];
    let typingCount = 0;
    let selectorShown = 0;
    return {
      replies,
      typing: async () => {
        typingCount++;
      },
      getTyping: () => typingCount,
      reply: async (text: string) => {
        replies.push(text);
      },
      showSelector: async () => {
        selectorShown++;
      },
      getSelectorShown: () => selectorShown,
    };
  }

  it('maps a text update to a telegram InboundMessage and paces the parts out', async () => {
    const engine = fakeEngine([
      { text: 'сәлем!', delayMs: 0 },
      { text: 'қазір қараймын', delayMs: 1 },
    ]);
    const { channel } = makeTelegram(engine);
    const ctx = fakeCtx();

    await channel.onText({
      chatId: 42,
      text: 'сәлем, бос бөлме бар ма?',
      reply: ctx.reply,
      typing: ctx.typing,
      showSelector: ctx.showSelector,
    });

    expect(engine.handle).toHaveBeenCalledWith({
      channel: 'telegram',
      senderId: '42',
      text: 'сәлем, бос бөлме бар ма?',
    });
    expect(ctx.replies).toEqual(['сәлем!', 'қазір қараймын']);
    expect(ctx.getTyping()).toBe(2);
  });

  it('renders the hotel selector with buttons instead of the plain selector text', async () => {
    const engine = fakeEngine([{ text: HOTEL_SELECTOR_MESSAGE, delayMs: 0 }]);
    const { channel } = makeTelegram(engine);
    const ctx = fakeCtx();

    await channel.onText({
      chatId: 42,
      text: 'привет',
      reply: ctx.reply,
      typing: ctx.typing,
      showSelector: ctx.showSelector,
    });

    expect(ctx.getSelectorShown()).toBe(1);
    expect(ctx.replies).toEqual([]);
    expect(CHOOSE_HOTEL_MESSAGE).toContain('Выберите отель');
  });

  it('stays silent when the engine returns null (handed off / limited)', async () => {
    const engine = fakeEngine(null);
    const { channel } = makeTelegram(engine);
    const ctx = fakeCtx();

    await channel.onText({
      chatId: 42,
      text: 'ало',
      reply: ctx.reply,
      typing: ctx.typing,
      showSelector: ctx.showSelector,
    });

    expect(ctx.replies).toEqual([]);
    expect(ctx.getSelectorShown()).toBe(0);
  });
});

// --- Instagram skeleton -----------------------------------------------------------

describe('InstagramAdapter', () => {
  it('parses messaging webhooks into instagram InboundMessages', () => {
    const adapter = new InstagramAdapter({ accessToken: 'ig-token', igId: '17840000' });
    const parsed = adapter.parseWebhook({
      object: 'instagram',
      entry: [
        {
          id: '17840000',
          messaging: [
            {
              sender: { id: 'guest-9' },
              recipient: { id: '17840000' },
              message: { mid: 'mid.1', text: 'hi, any rooms?' },
            },
          ],
        },
      ],
    });

    expect(parsed).toEqual([
      { channel: 'instagram', senderId: 'guest-9', text: 'hi, any rooms?', inboundId: 'mid.1' },
    ]);
    expect(adapter.parseWebhook(null)).toEqual([]);
    expect(adapter.parseWebhook({ entry: [{ messaging: [{ sender: {} }] }] })).toEqual([]);
  });

  it('sends parts via the Graph API with the ig id and bearer token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new InstagramAdapter({ accessToken: 'ig-token', igId: '17840000' }, fetchFn);

    await adapter.send('guest-9', [{ text: 'hello!', delayMs: 0 }]);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://graph.facebook.com/v23.0/17840000/messages');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer ig-token',
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      recipient: { id: 'guest-9' },
      message: { text: 'hello!' },
    });
  });
});
