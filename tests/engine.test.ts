import { describe, it, expect, vi } from 'vitest';
import { Engine, HOTEL_SELECTOR_MESSAGE, type EngineDeps, type EngineStore } from '../src/core/engine';
import type { InboundMessage, StaffNotifier } from '../src/channels/types';
import type { AnthropicLike } from '../src/ai/orchestrator';
import { NullTranscriber } from '../src/integrations/transcribe';
import { StubPaymentGateway } from '../src/integrations/payments';
import type { AmoCrmClient } from '../src/integrations/amocrm';
import type { BookingLead, ChatMessage, Channel, Conversation, MiceRequest } from '../src/types';

// --- Fakes -------------------------------------------------------------------

function fakeClient(responses: unknown[]): AnthropicLike {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        if (i >= responses.length) throw new Error('fake client ran out of scripted responses');
        return responses[i++] as never;
      }),
    },
  };
}

const finalText = (text: string): unknown => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
});

const toolUse = (name: string, input: unknown, id = 't1'): unknown => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input }],
});

interface FakeStore extends EngineStore {
  conversations: Map<string, Conversation>;
  events: Array<{ type: string; data?: { payload?: unknown; [k: string]: unknown } }>;
  leads: BookingLead[];
  mice: MiceRequest[];
}

function fakeStore(): FakeStore {
  const conversations = new Map<string, Conversation>();
  const store: FakeStore = {
    conversations,
    events: [],
    leads: [],
    mice: [],
    getOrCreateConversation(channel: Channel, senderId: string) {
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
          takenBy: null,
        };
        conversations.set(id, c);
      }
      return c;
    },
    setProperty(id, property) {
      conversations.get(id)!.property = property;
    },
    setStatus(id, status) {
      conversations.get(id)!.status = status;
    },
    setLanguage(id, language) {
      conversations.get(id)!.language = language;
    },
    appendMessage(id, message: ChatMessage) {
      conversations.get(id)!.history.push(message);
    },
    saveLead(lead) {
      store.leads.push(lead);
    },
    saveMice(m) {
      store.mice.push(m);
    },
    recordEvent(type, data) {
      store.events.push({ type, data: data as never });
    },
  };
  return store;
}

function fakeBookingService() {
  return {
    createBooking: vi.fn(async (_args: unknown) => ({
      mode: 'link' as const,
      bookingFormLink: 'https://book.example/x',
      reason: 'booking_disabled',
    })),
    cancelBooking: vi.fn(async () => ({ ok: true })),
    bookingStatus: vi.fn(async () => ({ source: 'local' as const, status: null })),
  };
}

function fakeNotifier(): StaffNotifier & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    notify(text: string) {
      texts.push(text);
    },
  };
}

const fakeCrm: AmoCrmClient = {
  createLead: vi.fn(async () => ({ ok: true })),
  updateStatus: vi.fn(async () => ({ ok: true })),
};

function makeEngine(overrides: Partial<EngineDeps> = {}) {
  const store = fakeStore();
  const notifier = fakeNotifier();
  const bookingService = fakeBookingService();
  const deps: EngineDeps = {
    store,
    client: fakeClient([finalText('привет! ||| чем могу помочь?')]),
    model: 'test-model',
    availabilityProvider: {
      checkAvailability: vi.fn(async (q: { property: string }) => ({
        property: q.property,
        checkIn: '2026-08-01',
        checkOut: '2026-08-02',
        offers: [],
        source: 'stub' as const,
      })),
    },
    bookingService,
    paymentGateway: new StubPaymentGateway(),
    crm: fakeCrm,
    transcriber: new NullTranscriber(),
    staffNotifier: notifier,
    rateLimiter: { allow: () => true },
    phoneNumberIdToProperty: { '111222333': 'almaty' },
    ...overrides,
  };
  return { engine: new Engine(deps), store, notifier, bookingService, deps };
}

function textMsg(text: string, channel: Channel = 'telegram', senderId = '1'): InboundMessage {
  return { channel, senderId, text };
}

function withProperty(store: FakeStore, channel: Channel, senderId: string, property: string) {
  const convo = store.getOrCreateConversation(channel, senderId);
  convo.property = property;
  return convo;
}

// --- Tests ---------------------------------------------------------------------

describe('Engine.handle', () => {
  it('happy path: text in → styled parts with human delays, history and events recorded', async () => {
    const { engine, store } = makeEngine();
    withProperty(store, 'telegram', '1', 'almaty');

    const parts = await engine.handle(textMsg('привет, есть номера?'));

    expect(parts).not.toBeNull();
    expect(parts!.length).toBe(2);
    expect(parts![0].text).toBe('привет!');
    expect(parts![1].text).toBe('чем могу помочь?');
    for (const p of parts!) expect(p.delayMs).toBeGreaterThanOrEqual(200);

    const convo = store.conversations.get('telegram:1')!;
    expect(convo.history).toEqual([
      { role: 'user', content: 'привет, есть номера?' },
      { role: 'assistant', content: 'привет! ||| чем могу помочь?' },
    ]);
    expect(convo.language).toBe('ru');

    const types = store.events.map((e) => e.type);
    expect(types).toContain('message_in');
    expect(types).toContain('message_out');
    expect(types).toContain('reply_timing');
    const messageIn = store.events.find((e) => e.type === 'message_in')!;
    expect((messageIn.data?.payload as { language?: string }).language).toBe('ru');
  });

  it('stays silent when the conversation is handed off to a human', async () => {
    const { engine, store, deps } = makeEngine();
    const convo = withProperty(store, 'telegram', '1', 'almaty');
    convo.status = 'handed_off';

    const parts = await engine.handle(textMsg('ало, вы тут?'));

    expect(parts).toBeNull();
    expect(deps.client.messages.create).not.toHaveBeenCalled();
  });

  it('still records the guest message in the transcript while handed off', async () => {
    const { engine, store } = makeEngine();
    const convo = withProperty(store, 'telegram', '1', 'almaty');
    convo.status = 'handed_off';

    await engine.handle(textMsg('ало, вы тут?'));

    const history = store.conversations.get('telegram:1')!.history;
    expect(history[history.length - 1]).toEqual({ role: 'user', content: 'ало, вы тут?' });
    expect(store.events.some((e) => e.type === 'message_in')).toBe(true);
  });

  it('drops rate-limited senders with a rate_limited event and no model call', async () => {
    const { engine, store, deps } = makeEngine({ rateLimiter: { allow: () => false } });
    withProperty(store, 'telegram', '1', 'almaty');

    const parts = await engine.handle(textMsg('спам'));

    expect(parts).toBeNull();
    expect(store.events.map((e) => e.type)).toContain('rate_limited');
    expect(deps.client.messages.create).not.toHaveBeenCalled();
  });

  it('drops repeated identical messages as spam', async () => {
    const { engine, store, deps } = makeEngine();
    const convo = withProperty(store, 'telegram', '1', 'almaty');
    convo.history = [
      { role: 'user', content: 'купи слона' },
      { role: 'user', content: 'купи слона' },
      { role: 'user', content: 'купи слона' },
    ];

    const parts = await engine.handle(textMsg('купи слона'));

    expect(parts).toBeNull();
    expect(store.events.map((e) => e.type)).toContain('spam_dropped');
    expect(deps.client.messages.create).not.toHaveBeenCalled();
  });

  it('returns the hotel selector without calling the model when no property is set', async () => {
    const { engine, deps } = makeEngine();

    const parts = await engine.handle(textMsg('привет'));

    expect(parts).not.toBeNull();
    const joined = parts!.map((p) => p.text).join('\n');
    expect(joined).toBe(HOTEL_SELECTOR_MESSAGE);
    expect(joined).toContain('Kazzhol Astana');
    expect(joined).toContain('Kazzhol Almaty');
    expect(joined).toContain('Kazzhol Park Almaty');
    expect(deps.client.messages.create).not.toHaveBeenCalled();
  });

  it('resolves the property from a WhatsApp phone_number_id hint', async () => {
    const { engine, store } = makeEngine();

    const parts = await engine.handle({
      channel: 'whatsapp',
      senderId: '111222333|77012345678',
      propertyHint: '111222333',
      text: 'здравствуйте',
    });

    expect(parts).not.toBeNull();
    expect(store.conversations.get('whatsapp:111222333|77012345678')!.property).toBe('almaty');
  });

  it('answers audio with a polite text fallback when transcription is unavailable', async () => {
    const { engine, store, deps } = makeEngine();
    withProperty(store, 'telegram', '1', 'almaty');

    const parts = await engine.handle({
      channel: 'telegram',
      senderId: '1',
      audio: { data: Buffer.from('fake-ogg'), mime: 'audio/ogg' },
    });

    expect(parts).not.toBeNull();
    expect(parts!.length).toBe(1);
    expect(parts![0].text).toContain('текстом');
    expect(deps.client.messages.create).not.toHaveBeenCalled();
  });

  it('escalation sets handed_off and notifies staff with masked PII', async () => {
    const { engine, store, notifier } = makeEngine({
      client: fakeClient([
        toolUse('escalate_to_human', {
          reason: 'guest demands a human',
          summary: 'call me at +7 776 412 6353',
          type: 'human_requested',
        }),
        finalText('передаю менеджеру, он ответит здесь же'),
      ]),
    });
    withProperty(store, 'telegram', '1', 'almaty');

    const parts = await engine.handle(textMsg('позовите человека, мой номер +7 776 412 6353'));

    expect(parts).not.toBeNull();
    expect(store.conversations.get('telegram:1')!.status).toBe('handed_off');
    expect(store.events.map((e) => e.type)).toContain('escalation');
    expect(notifier.texts.length).toBe(1);
    expect(notifier.texts[0]).toContain('•');
    expect(notifier.texts[0]).not.toContain('412 63');
  });

  it('create_booking receives the conversationId and the conversation property', async () => {
    const { engine, store, bookingService } = makeEngine({
      client: fakeClient([
        toolUse('create_booking', {
          checkIn: '2026-08-10',
          checkOut: '2026-08-12',
          guests: 2,
          roomTypeId: '42',
          ratePlanId: '7',
          guestFirstName: 'Aibek',
          guestLastName: 'S',
          guestPhone: '+77012345678',
        }),
        finalText('готово, вот ссылка'),
      ]),
    });
    withProperty(store, 'telegram', '9', 'park_almaty');

    await engine.handle(textMsg('да, бронируй', 'telegram', '9'));

    expect(bookingService.createBooking).toHaveBeenCalledTimes(1);
    const args = bookingService.createBooking.mock.calls[0][0] as {
      conversationId: string;
      property: string;
    };
    expect(args.conversationId).toBe('telegram:9');
    expect(args.property).toBe('park_almaty');
  });

  it('applies the 0.6 delay multiplier on the web widget channel', async () => {
    const reply = finalText('секунду, гляну по датам — сейчас всё расскажу подробно');
    const tg = makeEngine({ client: fakeClient([reply]) });
    withProperty(tg.store, 'telegram', '1', 'almaty');
    const ww = makeEngine({ client: fakeClient([reply]) });
    withProperty(ww.store, 'webwidget', '1', 'almaty');

    const tgParts = await tg.engine.handle(textMsg('цены?', 'telegram'));
    const wwParts = await ww.engine.handle(textMsg('цены?', 'webwidget'));

    expect(wwParts![0].delayMs).toBeLessThan(tgParts![0].delayMs);
  });

  it('never throws on a model error: tracks engine_error and answers gracefully', async () => {
    const { engine, store } = makeEngine({
      client: {
        messages: { create: vi.fn(async () => Promise.reject(new Error('api down'))) },
      } as unknown as AnthropicLike,
    });
    withProperty(store, 'telegram', '1', 'almaty');

    const parts = await engine.handle(textMsg('привет'));

    expect(parts).not.toBeNull();
    expect(parts!.length).toBe(1);
    expect(parts![0].text.length).toBeGreaterThan(0);
    expect(store.events.map((e) => e.type)).toContain('engine_error');
  });

  it('mice request saves to store, hits CRM, notifies staff and tracks mice_created', async () => {
    const crmCreate = vi.fn(async () => ({ ok: true }));
    const { engine, store, notifier } = makeEngine({
      crm: { createLead: crmCreate, updateStatus: vi.fn(async () => ({ ok: true })) },
      client: fakeClient([
        toolUse('submit_mice_request', {
          eventDate: '2026-09-01',
          peopleCount: 50,
          contactName: 'Dana',
          contactPhone: '+77770001122',
        }),
        finalText('заявку передал, коллеги свяжутся'),
      ]),
    });
    withProperty(store, 'telegram', '1', 'almaty');

    await engine.handle(textMsg('нужна конференция на 50 человек'));

    expect(store.mice.length).toBe(1);
    expect(store.mice[0].peopleCount).toBe(50);
    expect(crmCreate).toHaveBeenCalledWith('mice', expect.anything());
    expect(store.events.map((e) => e.type)).toContain('mice_created');
    expect(notifier.texts.length).toBe(1);
    expect(notifier.texts[0]).not.toContain('0001122');
  });
});
