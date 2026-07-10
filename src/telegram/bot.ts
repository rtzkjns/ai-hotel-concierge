import { Telegraf, Markup, type Context } from 'telegraf';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { Store } from '../store';
import { buildSystemPrompt } from '../ai/systemPrompt';
import { properties, propertyList } from '../knowledge';
import { generateReply } from '../ai/orchestrator';
import type { BookingLeadArgs } from '../ai/tools';
import { createAvailabilityProvider } from '../integrations/exely';
import { maskPII } from '../core/pii';

const CHOOSE_HOTEL_MESSAGE =
  'Сәлеметсіз бе! Здравствуйте! Hello!\n' +
  'Выберите отель / Қонақ үйді таңдаңыз / Choose a hotel:';

export function createBot(): Telegraf {
  if (!config.telegram.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN must be set to run the Telegram bot.');
  }
  const bot = new Telegraf(config.telegram.botToken);
  const store = new Store(config.dbPath);
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const availabilityProvider = createAvailabilityProvider(
    config.exely,
    (key) => properties[key]?.exelyPropertyId,
  );

  // Precompute one system prompt per property.
  const systemPrompts: Record<string, string> = Object.fromEntries(
    propertyList.map((p) => [p.key, buildSystemPrompt(p.name, p.knowledge)]),
  );

  const hotelKeyboard = Markup.inlineKeyboard(
    propertyList.map((p) => [Markup.button.callback(p.name, `property:${p.key}`)]),
  );

  // /start always begins a fresh session and re-asks which hotel.
  bot.start((ctx) => {
    const convo = store.getOrCreateConversation('telegram', String(ctx.chat.id));
    store.resetConversation(convo.id);
    return ctx.reply(CHOOSE_HOTEL_MESSAGE, hotelKeyboard);
  });

  // Guest picked a hotel from the inline keyboard.
  bot.action(/^property:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const prop = properties[key];
    const chatId = ctx.chat?.id;
    if (!prop || chatId === undefined) {
      await ctx.answerCbQuery();
      return;
    }
    const convo = store.getOrCreateConversation('telegram', String(chatId));
    store.setProperty(convo.id, key);
    await ctx.answerCbQuery();
    await ctx.reply(
      `${prop.name} — я виртуальный консьерж этого отеля. Чем могу помочь? / How can I help you?`,
    );
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    const convo = store.getOrCreateConversation('telegram', String(chatId));
    // If a human already took over this thread, stay silent.
    if (convo.status === 'handed_off') return;
    // No hotel chosen yet — ask first.
    if (!convo.property || !properties[convo.property]) {
      await ctx.reply(CHOOSE_HOTEL_MESSAGE, hotelKeyboard);
      return;
    }

    const prop = properties[convo.property];
    store.appendMessage(convo.id, { role: 'user', content: text });
    const updated = store.getOrCreateConversation('telegram', String(chatId));

    await ctx.sendChatAction('typing');

    const { reply, handedOff } = await generateReply(updated.history, {
      client: anthropic,
      model: config.anthropicModel,
      systemPrompt: systemPrompts[prop.key],
      onBookingLead: (args: BookingLeadArgs) => {
        store.saveLead({
          conversationId: convo.id,
          kind: 'booking',
          createdAt: new Date().toISOString(),
          ...args,
        });
        notifyStaff(
          bot,
          maskPII(
            `📋 New booking lead — ${prop.name} (chat ${chatId}):\n` +
              `${args.contactName} (${args.contactPhone})\n` +
              `${args.checkIn} → ${args.checkOut}, ${args.guests} guest(s), ${args.roomType}` +
              (args.specialRequests ? `\nNotes: ${args.specialRequests}` : ''),
          ),
        );
      },
      onEscalate: (reason, summary) => {
        const transcript = updated.history.map((m) => `${m.role}: ${m.content}`).join('\n');
        notifyStaff(
          bot,
          maskPII(
            `🚨 Handoff needed — ${prop.name} (chat ${chatId})\nReason: ${reason}\n${summary}\n\n` +
              `--- Conversation ---\n${transcript}`,
          ),
        );
      },
      checkAvailability: (args) =>
        availabilityProvider.checkAvailability({ ...args, property: prop.key }),
    });

    if (reply) {
      store.appendMessage(convo.id, { role: 'assistant', content: reply });
      await ctx.reply(reply);
    }
    if (handedOff) store.setStatus(convo.id, 'handed_off');
  });

  return bot;
}

function notifyStaff(bot: Telegraf<Context>, message: string): void {
  const staffChatId = config.telegram.staffGroupChatId;
  if (!staffChatId) {
    console.warn('STAFF_GROUP_CHAT_ID is not set — staff notification skipped.');
    return;
  }
  bot.telegram.sendMessage(staffChatId, message).catch((err) => {
    console.error('Failed to notify staff group:', err);
  });
}
