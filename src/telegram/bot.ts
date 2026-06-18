import { Telegraf } from 'telegraf';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { Store } from '../store';
import { buildSystemPrompt } from '../ai/systemPrompt';
import { astanaKnowledge } from '../knowledge/astana';
import { generateReply } from '../ai/orchestrator';
import type { BookingLeadArgs } from '../ai/tools';

export function createBot(): Telegraf {
  const bot = new Telegraf(config.telegramBotToken);
  const store = new Store(config.dbPath);
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const systemPrompt = buildSystemPrompt(astanaKnowledge);

  bot.start((ctx) =>
    ctx.reply(
      'Сәлеметсіз бе! Здравствуйте! Hello! Я виртуальный консьерж отеля Kazzhol Astana. Чем могу помочь?',
    ),
  );

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    const convo = store.getOrCreateConversation(chatId, 'astana');
    // If a human already took over this thread, stay silent.
    if (convo.status === 'handed_off') return;

    store.appendMessage(chatId, { role: 'user', content: text });
    const updated = store.getOrCreateConversation(chatId, 'astana');

    await ctx.sendChatAction('typing');

    const { reply, handedOff } = await generateReply(updated.history, {
      client: anthropic,
      model: config.anthropicModel,
      systemPrompt,
      onBookingLead: (args: BookingLeadArgs) => {
        store.saveLead({ chatId, createdAt: new Date().toISOString(), ...args });
        notifyStaff(
          bot,
          `📋 New booking lead from chat ${chatId}:\n` +
            `${args.contactName} (${args.contactPhone})\n` +
            `${args.checkIn} → ${args.checkOut}, ${args.guests} guest(s), ${args.roomType}`,
        );
      },
      onEscalate: (reason, summary) => {
        const transcript = updated.history.map((m) => `${m.role}: ${m.content}`).join('\n');
        notifyStaff(
          bot,
          `🚨 Handoff needed (chat ${chatId})\nReason: ${reason}\n${summary}\n\n` +
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

function notifyStaff(bot: Telegraf, message: string): void {
  bot.telegram.sendMessage(config.staffGroupChatId, message).catch((err) => {
    console.error('Failed to notify staff group:', err);
  });
}
