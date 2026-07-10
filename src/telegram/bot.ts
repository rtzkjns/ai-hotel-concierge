import { Telegraf, Markup, type Context } from 'telegraf';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { Store } from '../store';
import { buildSystemPrompt } from '../ai/systemPrompt';
import { properties, propertyList } from '../knowledge';
import { generateReply, type ToolHandlers } from '../ai/orchestrator';
import type { CaptureLeadInput, CheckAvailabilityInput, EscalateInput } from '../ai/tools';
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

  // Precompute one system prompt per property (each knows its sister hotels).
  const systemPrompts: Record<string, string> = Object.fromEntries(
    propertyList.map((p) => [
      p.key,
      buildSystemPrompt(p, { sisterHotels: propertyList.filter((s) => s.key !== p.key) }),
    ]),
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

    // Minimal handler set for the current Telegram bot; the full set (booking,
    // MICE, payments, ...) is wired by the channel engine in a later batch.
    const tools: ToolHandlers = {
      check_availability: async (input) => {
        const args = input as CheckAvailabilityInput;
        return availabilityProvider.checkAvailability({
          checkIn: args.checkIn,
          checkOut: args.checkOut,
          guests: args.guests,
          property: args.property ?? prop.key,
        });
      },
      capture_lead: async (input) => {
        const args = input as CaptureLeadInput;
        store.saveLead({
          conversationId: convo.id,
          kind: 'generic',
          contactName: args.contactName,
          contactPhone: args.contactPhone,
          specialRequests: args.summary,
          createdAt: new Date().toISOString(),
        });
        notifyStaff(
          bot,
          maskPII(
            `📋 New lead — ${prop.name} (chat ${chatId}):\n${args.summary}` +
              (args.contactName ? `\nName: ${args.contactName}` : '') +
              (args.contactPhone ? `\nPhone: ${args.contactPhone}` : ''),
          ),
        );
        return { ok: true };
      },
      escalate_to_human: async (input) => {
        const args = input as EscalateInput;
        const transcript = updated.history.map((m) => `${m.role}: ${m.content}`).join('\n');
        notifyStaff(
          bot,
          maskPII(
            `🚨 Handoff needed — ${prop.name} (chat ${chatId})\n` +
              `Type: ${args.type}\nReason: ${args.reason}\n${args.summary}\n\n` +
              `--- Conversation ---\n${transcript}`,
          ),
        );
        return { ok: true };
      },
    };

    const { reply, handedOff } = await generateReply(updated.history, {
      client: anthropic,
      model: config.anthropicModel,
      systemPrompt: systemPrompts[prop.key],
      tools,
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
