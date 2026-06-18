import { Telegraf, Markup, type Context } from 'telegraf';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { Store } from '../store';
import { buildSystemPrompt } from '../ai/systemPrompt';
import { properties, propertyList } from '../knowledge';
import { generateReply } from '../ai/orchestrator';
import type { BookingLeadArgs } from '../ai/tools';

const CHOOSE_HOTEL_MESSAGE =
  'Сәлеметсіз бе! Здравствуйте! Hello!\n' +
  'Выберите отель / Қонақ үйді таңдаңыз / Choose a hotel:';

export function createBot(): Telegraf {
  const bot = new Telegraf(config.telegramBotToken);
  const store = new Store(config.dbPath);
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  // Precompute one system prompt per property.
  const systemPrompts: Record<string, string> = Object.fromEntries(
    propertyList.map((p) => [p.key, buildSystemPrompt(p.name, p.knowledge)]),
  );

  const hotelKeyboard = Markup.inlineKeyboard(
    propertyList.map((p) => [Markup.button.callback(p.name, `property:${p.key}`)]),
  );

  bot.start((ctx) => ctx.reply(CHOOSE_HOTEL_MESSAGE, hotelKeyboard));

  // Guest picked a hotel from the inline keyboard.
  bot.action(/^property:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const prop = properties[key];
    const chatId = ctx.chat?.id;
    if (!prop || chatId === undefined) {
      await ctx.answerCbQuery();
      return;
    }
    store.setProperty(chatId, key);
    await ctx.answerCbQuery();
    await ctx.reply(
      `${prop.name} — я виртуальный консьерж этого отеля. Чем могу помочь? / How can I help you?`,
    );
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    const convo = store.getOrCreateConversation(chatId);
    // If a human already took over this thread, stay silent.
    if (convo.status === 'handed_off') return;
    // No hotel chosen yet — ask first.
    if (!convo.property || !properties[convo.property]) {
      await ctx.reply(CHOOSE_HOTEL_MESSAGE, hotelKeyboard);
      return;
    }

    const prop = properties[convo.property];
    store.appendMessage(chatId, { role: 'user', content: text });
    const updated = store.getOrCreateConversation(chatId);

    await ctx.sendChatAction('typing');

    const { reply, handedOff } = await generateReply(updated.history, {
      client: anthropic,
      model: config.anthropicModel,
      systemPrompt: systemPrompts[prop.key],
      onBookingLead: (args: BookingLeadArgs) => {
        store.saveLead({ chatId, createdAt: new Date().toISOString(), ...args });
        notifyStaff(
          bot,
          `📋 New booking lead — ${prop.name} (chat ${chatId}):\n` +
            `${args.contactName} (${args.contactPhone})\n` +
            `${args.checkIn} → ${args.checkOut}, ${args.guests} guest(s), ${args.roomType}`,
        );
      },
      onEscalate: (reason, summary) => {
        const transcript = updated.history.map((m) => `${m.role}: ${m.content}`).join('\n');
        notifyStaff(
          bot,
          `🚨 Handoff needed — ${prop.name} (chat ${chatId})\nReason: ${reason}\n${summary}\n\n` +
            `--- Conversation ---\n${transcript}`,
        );
      },
    });

    if (reply) {
      store.appendMessage(chatId, { role: 'assistant', content: reply });
      await ctx.reply(reply);
    }
    if (handedOff) store.setStatus(chatId, 'handed_off');
  });

  return bot;
}

function notifyStaff(bot: Telegraf<Context>, message: string): void {
  bot.telegram.sendMessage(config.staffGroupChatId, message).catch((err) => {
    console.error('Failed to notify staff group:', err);
  });
}
