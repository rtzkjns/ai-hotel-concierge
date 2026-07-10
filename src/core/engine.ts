// Channel-independent message pipeline: InboundMessage → guarded, tooled model
// reply → 1-3 human-paced OutboundParts. Every channel adapter feeds this one class.
import { generateReply, type AnthropicLike, type ToolHandlers } from '../ai/orchestrator';
import { buildSystemPrompt } from '../ai/systemPrompt';
import type {
  CancelBookingInput,
  CaptureLeadInput,
  CheckAvailabilityInput,
  CheckPromoCodeInput,
  CreateBookingInput,
  CreatePaymentInput,
  EscalateInput,
  GetBookingStatusInput,
  GetRoomInfoInput,
  SubmitMiceRequestInput,
} from '../ai/tools';
import type { InboundMessage, OutboundPart, StaffNotifier } from '../channels/types';
import type { AmoCrmClient } from '../integrations/amocrm';
import type { AvailabilityProvider } from '../integrations/exely/provider';
import type { PaymentGateway } from '../integrations/payments';
import type { Transcriber } from '../integrations/transcribe';
import { properties, propertyList } from '../knowledge';
import { humanDelays, styleSplit } from '../style/engine';
import type {
  BookingLead,
  Channel,
  ChatMessage,
  Conversation,
  ConversationStatus,
  Language,
  MiceRequest,
} from '../types';
import type {
  BookingStatusResult,
  CancelBookingResult,
  CreateBookingArgs,
  CreateBookingResult,
} from './booking';
import { track, type EventData } from './events';
import { detectLanguage } from './language';
import { maskPII } from './pii';
import { isSpam } from './rateLimit';

/** Widget guests watch the screen; pauses feel 40% shorter there. */
const WEBWIDGET_DELAY_MULTIPLIER = 0.6;

/** How many trailing messages the escalation transcript carries to staff. */
const ESCALATION_TRANSCRIPT_MESSAGES = 10;

export const HOTEL_SELECTOR_MESSAGE =
  'Сәлеметсіз бе! Здравствуйте! Hello! 您好!\n' +
  'Выберите отель / Қонақ үйді таңдаңыз / Choose a hotel / 请选择酒店:\n' +
  propertyList.map((p, i) => `${i + 1}. ${p.name}`).join('\n');

const AUDIO_FALLBACK: Record<Language, string> = {
  ru: 'не смог прослушать голосовое( напишите, пожалуйста, текстом — сразу отвечу',
  kk: 'дауыстық хабарламаны тыңдай алмадым( мәтінмен жазып жіберіңізші — бірден жауап беремін',
  en: "couldn't play your voice message — could you type it out, please?",
  zh: '抱歉，语音消息我听不了，麻烦您用文字发一下，我马上回复',
};

const UNSUPPORTED_FALLBACK: Record<Language, string> = {
  ru: 'такой тип сообщения пока не открывается у меня( напишите, пожалуйста, текстом',
  kk: 'бұндай хабарлама түрі менде ашылмайды( мәтінмен жазып жіберіңізші',
  en: "I can't open that type of message — could you send it as text, please?",
  zh: '这种消息类型我打不开，麻烦您用文字发一下',
};

const ERROR_FALLBACK: Record<Language, string> = {
  ru: 'что-то я подвис, дайте минутку — уже чиню',
  kk: 'сәл қатып қалдым, бір минут беріңізші — қазір реттеймін',
  en: 'sorry, I froze for a second — give me a minute, fixing it',
  zh: '抱歉，系统卡了一下，请稍等一分钟',
};

/** The subset of Store the engine needs (structural, for easy faking). */
export interface EngineStore {
  getOrCreateConversation(channel: Channel, senderId: string): Conversation;
  setProperty(id: string, property: string): void;
  setStatus(id: string, status: ConversationStatus): void;
  setLanguage(id: string, language: Language | null): void;
  appendMessage(id: string, message: ChatMessage): void;
  saveLead(lead: BookingLead): void;
  saveMice(m: MiceRequest): void;
  recordEvent(type: string, data?: EventData): void;
}

export interface BookingServiceLike {
  createBooking(args: CreateBookingArgs): Promise<CreateBookingResult>;
  cancelBooking(exelyNumber: string, reason?: string): Promise<CancelBookingResult>;
  bookingStatus(exelyNumber: string): Promise<BookingStatusResult>;
}

export interface RateLimiterLike {
  allow(key: string): boolean;
}

export interface EngineDeps {
  store: EngineStore;
  client: AnthropicLike;
  model: string;
  availabilityProvider: AvailabilityProvider;
  bookingService: BookingServiceLike;
  paymentGateway: PaymentGateway;
  crm: AmoCrmClient;
  transcriber: Transcriber;
  staffNotifier: StaffNotifier;
  rateLimiter: RateLimiterLike;
  /** Distilled human-style research rules for the system prompt. */
  styleGuide?: string;
  /** WhatsApp phone_number_id → property key, so hints can arrive as raw phone ids. */
  phoneNumberIdToProperty?: Record<string, string>;
}

export class Engine {
  private readonly systemPrompts: Record<string, string>;
  /** Per-conversation promise chain: messages from one sender never interleave. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: EngineDeps) {
    this.systemPrompts = Object.fromEntries(
      propertyList.map((p) => [
        p.key,
        buildSystemPrompt(p, {
          sisterHotels: propertyList.filter((s) => s.key !== p.key),
          styleGuide: deps.styleGuide,
        }),
      ]),
    );
  }

  /**
   * Full pipeline for one inbound message. Returns the parts to send,
   * or null when the bot must stay silent (limits, spam, human owns the chat).
   * Serialized per sender: a burst of messages is processed strictly in order
   * over a consistent history instead of racing.
   */
  handle(msg: InboundMessage): Promise<OutboundPart[] | null> {
    const key = `${msg.channel}:${msg.senderId}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.handleNow(msg));
    // Keep the chain alive on failure, and drop the map entry once idle.
    this.queues.set(
      key,
      run.catch(() => undefined).finally(() => {
        if (this.queues.get(key) === run) this.queues.delete(key);
      }),
    );
    return run;
  }

  private async handleNow(msg: InboundMessage): Promise<OutboundPart[] | null> {
    const start = Date.now();
    const { store, rateLimiter, transcriber } = this.deps;

    if (!rateLimiter.allow(`${msg.channel}:${msg.senderId}`)) {
      track(store, 'rate_limited', {
        conversationId: `${msg.channel}:${msg.senderId}`,
        channel: msg.channel,
      });
      return null;
    }

    const convo = store.getOrCreateConversation(msg.channel, msg.senderId);

    if (msg.text !== undefined) {
      const recentUserTexts = convo.history.filter((m) => m.role === 'user').map((m) => m.content);
      if (isSpam(recentUserTexts, msg.text)) {
        track(store, 'spam_dropped', { conversationId: convo.id, channel: msg.channel });
        return null;
      }
    }

    // A human took this chat over — the bot stays silent until it is handed back,
    // but the guest's words must still land in the transcript the manager reads.
    if (convo.status === 'handed_off') {
      if (msg.text !== undefined && msg.text.trim() !== '') {
        store.appendMessage(convo.id, { role: 'user', content: msg.text });
        track(store, 'message_in', {
          conversationId: convo.id,
          property: convo.property,
          channel: msg.channel,
          payload: { language: convo.language, handedOff: true },
        });
      }
      return null;
    }

    const hinted = this.resolveProperty(msg.propertyHint);
    if (hinted && hinted !== convo.property) {
      store.setProperty(convo.id, hinted);
      convo.property = hinted;
    }
    // No hotel yet (telegram/webwidget before selection) — ask, without burning a
    // model call. The message itself is kept so the bot answers it right after
    // the guest picks a hotel («есть номера на завтра?» is not lost).
    if (!convo.property || !properties[convo.property]) {
      if (msg.text !== undefined && msg.text.trim() !== '') {
        store.appendMessage(convo.id, { role: 'user', content: msg.text });
        track(store, 'message_in', {
          conversationId: convo.id,
          channel: msg.channel,
          payload: { language: convo.language, preSelection: true },
        });
      }
      return [{ text: HOTEL_SELECTOR_MESSAGE, delayMs: 0 }];
    }

    let text = msg.text;
    if (text === undefined && msg.audio) {
      const transcribed = await transcriber.transcribe(msg.audio.data, msg.audio.mime);
      if (transcribed === null) {
        return [{ text: AUDIO_FALLBACK[convo.language ?? 'ru'], delayMs: 0 }];
      }
      text = transcribed;
    }
    if (text === undefined || text.trim() === '') return null;
    // Media the parser could not represent (stickers, images, ...) gets a fixed
    // canned reply — deterministic and free, no model call.
    if (text.startsWith('[unsupported message type')) {
      return [{ text: UNSUPPORTED_FALLBACK[convo.language ?? 'ru'], delayMs: 0 }];
    }

    const language = detectLanguage(text);
    if (language) {
      store.setLanguage(convo.id, language);
      convo.language = language;
    }

    store.appendMessage(convo.id, { role: 'user', content: text });
    const history: ChatMessage[] = [...convo.history, { role: 'user', content: text }];
    track(store, 'message_in', {
      conversationId: convo.id,
      property: convo.property,
      channel: msg.channel,
      payload: { language: convo.language },
    });

    let reply: string;
    let handedOff: boolean;
    try {
      const result = await generateReply(history, {
        client: this.deps.client,
        model: this.deps.model,
        systemPrompt: this.systemPrompts[convo.property],
        tools: this.buildTools(convo, history),
      });
      reply = result.reply;
      handedOff = result.handedOff;
    } catch (err) {
      // The guest must never see a stack trace or dead silence.
      track(store, 'engine_error', {
        conversationId: convo.id,
        channel: msg.channel,
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
      return [{ text: ERROR_FALLBACK[convo.language ?? 'ru'], delayMs: 0 }];
    }

    if (reply) store.appendMessage(convo.id, { role: 'assistant', content: reply });
    if (handedOff) store.setStatus(convo.id, 'handed_off');

    const parts = humanDelays(styleSplit(reply), {
      guestMsgLength: text.length,
      multiplier: msg.channel === 'webwidget' ? WEBWIDGET_DELAY_MULTIPLIER : 1,
    });
    track(store, 'message_out', {
      conversationId: convo.id,
      property: convo.property,
      channel: msg.channel,
      payload: { parts: parts.length },
    });
    track(store, 'reply_timing', {
      conversationId: convo.id,
      channel: msg.channel,
      payload: { ms: Date.now() - start },
    });
    return parts;
  }

  /** A hint is either a property key or a WhatsApp phone_number_id from the injected map. */
  private resolveProperty(hint?: string): string | undefined {
    if (!hint) return undefined;
    if (properties[hint]) return hint;
    return this.deps.phoneNumberIdToProperty?.[hint];
  }

  /** Binds every tool to this conversation: ids, property defaults, notifications. */
  private buildTools(convo: Conversation, history: ChatMessage[]): ToolHandlers {
    const { store, availabilityProvider, bookingService, paymentGateway, crm, staffNotifier } =
      this.deps;
    const hotelName = properties[convo.property]?.name ?? convo.property;
    const propertyOf = (input: { property?: string } | undefined): string =>
      input?.property && properties[input.property] ? input.property : convo.property;

    return {
      check_availability: async (raw) => {
        const input = raw as CheckAvailabilityInput;
        return availabilityProvider.checkAvailability({
          property: propertyOf(input),
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          guests: input.guests,
        });
      },

      get_room_info: async (raw) => {
        const key = propertyOf(raw as GetRoomInfoInput);
        return {
          property: key,
          info: properties[key].knowledge,
          note:
            'Exact room categories, live prices and availability come from check_availability — ' +
            'call it before quoting anything specific.',
        };
      },

      create_booking: async (raw) => {
        const input = raw as CreateBookingInput;
        return bookingService.createBooking({
          conversationId: convo.id,
          property: propertyOf(input),
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          guests: input.guests,
          roomTypeId: input.roomTypeId,
          ratePlanId: input.ratePlanId,
          guestFirstName: input.guestFirstName,
          guestLastName: input.guestLastName,
          guestPhone: input.guestPhone,
          guestEmail: input.guestEmail,
          comment: input.comment,
          upsellAccepted: input.upsellAccepted,
        });
      },

      get_booking_status: async (raw) =>
        bookingService.bookingStatus((raw as GetBookingStatusInput).bookingNumber),

      cancel_booking: async (raw) => {
        const input = raw as CancelBookingInput;
        return bookingService.cancelBooking(input.bookingNumber, input.reason);
      },

      check_promo_code: async (raw) => {
        const input = raw as CheckPromoCodeInput;
        store.saveLead({
          conversationId: convo.id,
          kind: 'generic',
          specialRequests: `Promo code to verify with the team: ${input.code}`,
          createdAt: new Date().toISOString(),
        });
        await staffNotifier.notify(
          maskPII(`🏷️ Promo code check — ${hotelName} (${convo.id}): "${input.code}"`),
        );
        return {
          status: 'PROMO_CHECK_UNAVAILABLE',
          instruction:
            'tell the guest the team will confirm the code and come back to them shortly',
        };
      },

      create_payment: async (raw) => {
        const input = raw as CreatePaymentInput;
        return paymentGateway.createPayment(input.bookingNumber, input.amountKzt);
      },

      submit_mice_request: async (raw) => {
        const input = raw as SubmitMiceRequestInput;
        store.saveMice({
          conversationId: convo.id,
          property: convo.property,
          eventDate: input.eventDate,
          peopleCount: input.peopleCount,
          halls: input.halls,
          catering: input.catering,
          budget: input.budget,
          contactName: input.contactName,
          contactPhone: input.contactPhone,
          notes: input.notes,
          status: 'new',
          createdAt: new Date().toISOString(),
        });
        await crm.createLead('mice', { ...input, property: convo.property, conversationId: convo.id });
        await staffNotifier.notify(
          maskPII(
            `🎪 New MICE request — ${hotelName} (${convo.id})\n` +
              `Date: ${input.eventDate}, people: ${input.peopleCount}\n` +
              (input.halls ? `Halls: ${input.halls}\n` : '') +
              (input.catering ? `Catering: ${input.catering}\n` : '') +
              (input.budget ? `Budget: ${input.budget}\n` : '') +
              `Contact: ${input.contactName}, ${input.contactPhone}` +
              (input.notes ? `\nNotes: ${input.notes}` : ''),
          ),
        );
        track(store, 'mice_created', {
          conversationId: convo.id,
          property: convo.property,
          channel: convo.channel,
        });
        return { ok: true };
      },

      capture_lead: async (raw) => {
        const input = raw as CaptureLeadInput;
        store.saveLead({
          conversationId: convo.id,
          kind: 'generic',
          contactName: input.contactName,
          contactPhone: input.contactPhone,
          specialRequests: input.summary,
          createdAt: new Date().toISOString(),
        });
        await crm.createLead('generic', {
          ...input,
          property: convo.property,
          conversationId: convo.id,
        });
        await staffNotifier.notify(
          maskPII(
            `📋 New lead — ${hotelName} (${convo.id}):\n${input.summary}` +
              (input.contactName ? `\nName: ${input.contactName}` : '') +
              (input.contactPhone ? `\nPhone: ${input.contactPhone}` : ''),
          ),
        );
        track(store, 'lead_captured', {
          conversationId: convo.id,
          property: convo.property,
          channel: convo.channel,
        });
        return { ok: true };
      },

      escalate_to_human: async (raw) => {
        const input = raw as EscalateInput;
        const transcript = history
          .slice(-ESCALATION_TRANSCRIPT_MESSAGES)
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n');
        await staffNotifier.notify(
          maskPII(
            `🚨 Handoff needed — ${hotelName} (${convo.id})\n` +
              `Type: ${input.type}\nReason: ${input.reason}\n${input.summary}\n\n` +
              `--- Last messages ---\n${transcript}`,
          ),
        );
        track(store, 'escalation', {
          conversationId: convo.id,
          property: convo.property,
          channel: convo.channel,
          payload: { type: input.type },
        });
        return { ok: true, note: 'Staff notified; a human will continue in this same chat.' };
      },
    };
  }
}
