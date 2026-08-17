// Telegram channel: a thin Telegraf adapter over the Engine. Hotel selection
// stays an inline keyboard; staff alerts flow through the Engine's StaffNotifier.
import { Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { HOTEL_SELECTOR_MESSAGE } from '../core/engine';
import { properties, propertyList } from '../knowledge';
import type { Channel, Conversation } from '../types';
import type { InboundMessage, OutboundPart } from './types';

export const CHOOSE_HOTEL_MESSAGE =
  'Сәлеметсіз бе! Здравствуйте! Hello!\n' +
  'Выберите отель / Қонақ үйді таңдаңыз / Choose a hotel:';

export interface TelegramEngine {
  handle(msg: InboundMessage): Promise<OutboundPart[] | null>;
}

export interface TelegramStore {
  /** Привязка группы менеджеров к отелю (команда /привязать в самой группе). */
  setStaffChat?(property: string, chatId: string): void;
  staffChatFor?(property: string): string | undefined;
  getOrCreateConversation(channel: Channel, senderId: string): Conversation;
  resetConversation(id: string): void;
  setProperty(id: string, property: string): void;
}

export interface TelegramChannelDeps {
  botToken: string;
  engine: TelegramEngine;
  store: TelegramStore;
  /** Действующий код привязки групп; владелец видит его в панели. */
  bindCode?: () => string | undefined;
  /** Вызывается при смене привязки — чтобы подмену было видно, а не молча. */
  onBindChanged?: (property: string, chatId: string, previous?: string) => void;
}

/** The pieces of a Telegraf ctx the text handler needs (structural, for unit tests). */
export interface TelegramTextCtx {
  chatId: number | string;
  text: string;
  reply(text: string): Promise<unknown>;
  typing(): Promise<unknown>;
  showSelector(): Promise<unknown>;
}

export class TelegramChannel {
  readonly bot: Telegraf;
  private readonly keyboard = Markup.inlineKeyboard(
    propertyList
      .filter((p) => p.bookable !== false)
      .map((p) => [Markup.button.callback(p.name, `property:${p.key}`)]),
  );

  constructor(private readonly deps: TelegramChannelDeps) {
    this.bot = new Telegraf(deps.botToken);

    // /start always begins a fresh session and re-asks which hotel.
    this.bot.start(async (ctx) => {
      const convo = deps.store.getOrCreateConversation('telegram', String(ctx.chat.id));
      deps.store.resetConversation(convo.id);
      await ctx.reply(CHOOSE_HOTEL_MESSAGE, this.keyboard);
    });

    // Guest picked a hotel from the inline keyboard.
    this.bot.action(/^property:(.+)$/, async (ctx) => {
      const key = ctx.match[1];
      const prop = properties[key];
      const chatId = ctx.chat?.id;
      await ctx.answerCbQuery();
      if (!prop || chatId === undefined) return;
      const convo = deps.store.getOrCreateConversation('telegram', String(chatId));
      deps.store.setProperty(convo.id, key);
      await ctx.reply(
        `${prop.name} — я виртуальный ассистент этого отеля. Чем могу помочь? / How can I help you?`,
      );
    });

    /**
     * Привязка группы менеджеров к отелю прямо из чата: «/привязать almaty <код>».
     *
     * Раньше команда не требовала ничего: любой, кто мог написать боту, перенаправлял
     * заявки чужого отеля себе, а прежняя группа замолкала молча. Теперь нужны три вещи
     * сразу — это групповой чат, отправитель в нём администратор, и у него есть код
     * привязки, который владелец берёт в панели.
     */
    this.bot.on(message('text'), async (ctx, next) => {
      const raw = ctx.message.text.trim();
      if (!/^\/(привязать|bind)\b/i.test(raw)) return next();
      const [, key = '', code = ''] = raw.split(/\s+/);
      const hotel = key.toLowerCase();
      const known = ['almaty', 'astana', 'park_almaty', 'seven'];

      if (!known.includes(hotel)) {
        await ctx.reply(
          'Укажите отель и код привязки:\n/привязать almaty КОД\n\n' +
            'Отели: almaty, astana, park_almaty, seven.\n' +
            'Код можно посмотреть в панели: раздел «Ещё» → «Профиль».',
        );
        return;
      }

      if (ctx.chat.type === 'private') {
        await ctx.reply(
          'Привязать можно только групповой чат: создайте группу для менеджеров отеля, ' +
            'добавьте меня туда и повторите команду там.',
        );
        return;
      }

      const expected = deps.bindCode?.();
      if (!expected || code !== expected) {
        await ctx.reply(
          'Нужен код привязки. Он есть в панели у владельца: раздел «Ещё» → «Профиль».\n' +
            'Команда целиком: /привязать ' + hotel + ' КОД',
        );
        return;
      }

      try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        if (member.status !== 'creator' && member.status !== 'administrator') {
          await ctx.reply('Привязать чат может только его администратор.');
          return;
        }
      } catch {
        await ctx.reply('Не удалось проверить права в этой группе. Попробуйте ещё раз.');
        return;
      }

      const previous = deps.store.staffChatFor?.(hotel);
      deps.store.setStaffChat?.(hotel, String(ctx.chat.id));
      await ctx.reply(
        `Готово. Эта группа привязана к отелю ${hotel}. Сюда будут приходить запросы на ` +
          'переключение на живого менеджера с кратким описанием проблемы.',
      );
      // Смена привязки — событие, о котором обязаны узнать и владелец, и прежняя группа.
      deps.onBindChanged?.(hotel, String(ctx.chat.id), previous);
    });

    this.bot.on(message('text'), async (ctx) => {
      await this.onText({
        chatId: ctx.chat.id,
        text: ctx.message.text,
        reply: (text) => ctx.reply(text),
        typing: () => ctx.sendChatAction('typing'),
        showSelector: () => ctx.reply(CHOOSE_HOTEL_MESSAGE, this.keyboard),
      });
    });
  }

  /** Testable core: engine round trip + human-paced delivery. */
  async onText(ctx: TelegramTextCtx): Promise<void> {
    const parts = await this.deps.engine.handle({
      channel: 'telegram',
      senderId: String(ctx.chatId),
      text: ctx.text,
    });
    if (!parts || parts.length === 0) return;

    // The engine's plain-text hotel selector becomes real inline buttons here.
    if (parts.length === 1 && parts[0].text === HOTEL_SELECTOR_MESSAGE) {
      await ctx.showSelector();
      return;
    }

    for (const part of parts) {
      await ctx.typing();
      if (part.delayMs > 0) await new Promise((r) => setTimeout(r, part.delayMs));
      await ctx.reply(part.text);
    }
  }

  launch(): void {
    // Telegraf's launch() promise only settles on stop; fire and monitor errors.
    void this.bot.launch().catch((err: unknown) => {
      console.error(
        'Telegram channel stopped:',
        err instanceof Error ? err.message : 'unknown error',
      );
    });
  }

  stop(reason: string): void {
    this.bot.stop(reason);
  }
}
