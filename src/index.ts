// Boot: store → integrations → engine → channel adapters → fastify server.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { InstagramAdapter } from './channels/instagram';
import { TelegramChannel } from './channels/telegram';
import type { StaffNotifier } from './channels/types';
import { WebWidgetChannel } from './channels/webwidget';
import { WhatsAppAdapter } from './channels/whatsapp';
import { config, enabledChannels } from './config';
import { hashPassword } from './console/auth';
import { registerConsoleRoutes, type SendToConversation } from './console/routes';
import { BookingService } from './core/booking';
import { metricsSummary } from './core/events';
import { Engine } from './core/engine';
import { RateLimiter } from './core/rateLimit';
import { startRetention } from './core/retention';
import { StubAmoCrm } from './integrations/amocrm';
import { createCabinetProviders } from './integrations/exely';
import { StubPaymentGateway } from './integrations/payments';
import { createTranscriber } from './integrations/transcribe';
import { buildServer } from './server';
import { Store } from './store';

/** Staff alerts: Telegram staff chat via raw Bot API when configured, console otherwise. */
function createStaffNotifier(): StaffNotifier {
  const token = config.telegram.botToken;
  const chatId = config.telegram.staffGroupChatId;
  if (!token || !chatId) {
    return { notify: (text) => console.log('[staff]', text) };
  }
  return {
    async notify(text) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
        if (!res.ok) console.error(`staff notify failed: Telegram HTTP ${res.status}`);
      } catch (err) {
        console.error('staff notify failed:', err instanceof Error ? err.message : 'unknown error');
      }
    },
  };
}

/** The research-backed texting style guide, embedded into every system prompt. */
function loadStyleGuide(): string | undefined {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    return readFileSync(join(root, 'docs', 'STYLE-GUIDE.md'), 'utf8');
  } catch {
    console.warn('docs/STYLE-GUIDE.md not found — running on the prompt-embedded style rules only.');
    return undefined;
  }
}

async function main(): Promise<void> {
  const store = new Store(config.dbPath);

  // First boot: seed the console admin account from env, if configured.
  if (store.countStaff() === 0 && config.console.adminPassword) {
    store.createStaff(config.console.adminLogin, hashPassword(config.console.adminPassword), 'admin');
    console.log('console admin seeded');
  }

  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  // Each hotel routes to its OWN Exely cabinet (Astana & Park Almaty are separate
  // accounts). A hotel with no cabinet configured falls back to stub availability.
  const cabinets = createCabinetProviders(config.exelyByProperty);
  const availabilityProvider = cabinets.availability;
  const bookingService = new BookingService({
    store,
    provider: availabilityProvider,
    reservationFor: cabinets.reservationFor,
    bookingEnabledFor: cabinets.bookingEnabledFor,
    propertyIdResolver: cabinets.propertyIdResolver,
  });

  const phoneNumberIdToProperty: Record<string, string> = Object.fromEntries(
    Object.entries(config.whatsapp.phoneNumberIds).map(([property, id]) => [id, property]),
  );

  const engine = new Engine({
    store,
    client: anthropic,
    model: config.anthropicModel,
    availabilityProvider,
    bookingService,
    paymentGateway: new StubPaymentGateway(),
    crm: new StubAmoCrm((type, data) => store.recordEvent(type, { payload: data })),
    transcriber: createTranscriber(config.openaiApiKey),
    staffNotifier: createStaffNotifier(),
    rateLimiter: new RateLimiter(),
    phoneNumberIdToProperty,
    styleGuide: loadStyleGuide(),
  });

  const channels = enabledChannels();

  const adapters: { whatsapp?: WhatsAppAdapter; instagram?: InstagramAdapter } = {};
  if (channels.includes('whatsapp') && config.whatsapp.accessToken) {
    adapters.whatsapp = new WhatsAppAdapter({
      accessToken: config.whatsapp.accessToken,
      phoneNumberIds: config.whatsapp.phoneNumberIds,
    });
  }
  if (channels.includes('instagram') && config.instagram.accessToken && config.instagram.igId) {
    adapters.instagram = new InstagramAdapter({
      accessToken: config.instagram.accessToken,
      igId: config.instagram.igId,
    });
  }

  const widget = new WebWidgetChannel({ engine, store });

  // Staff replies from the console go out through whatever channel the
  // conversation lives on; assigned below once the Telegram channel exists.
  let telegram: TelegramChannel | undefined;
  const sendToConversation: SendToConversation = async (convo, text) => {
    const parts = [{ text, delayMs: 0 }];
    switch (convo.channel) {
      case 'whatsapp':
        if (!adapters.whatsapp) return { ok: false, error: 'WhatsApp is not configured' };
        await adapters.whatsapp.send(convo.senderId, parts);
        return { ok: true };
      case 'telegram':
        if (!telegram) return { ok: false, error: 'Telegram is not running' };
        await telegram.bot.telegram.sendMessage(Number(convo.senderId), text);
        return { ok: true };
      case 'webwidget':
        return widget.pushToGuest(convo.senderId, text)
          ? { ok: true }
          : { ok: false, error: 'guest offline (widget closed)' };
      case 'instagram':
        if (!adapters.instagram) return { ok: false, error: 'Instagram is not configured' };
        await adapters.instagram.send(convo.senderId, parts);
        return { ok: true };
      default:
        return { ok: false, error: 'unknown channel' };
    }
  };

  const app = await buildServer({
    engine,
    adapters,
    store,
    config,
    extraRoutes: [
      (a) => widget.register(a),
      (a) => registerConsoleRoutes(a, { store, metricsSummary, sendToConversation }),
    ],
  });
  await app.listen({ port: config.server.port, host: '0.0.0.0' });
  startRetention(store);

  if (channels.includes('telegram') && config.telegram.botToken) {
    const tg = new TelegramChannel({
      botToken: config.telegram.botToken,
      engine,
      store,
    });
    telegram = tg;
    tg.launch();
    console.log('Telegram channel: running');
    process.once('SIGINT', () => tg.stop('SIGINT'));
    process.once('SIGTERM', () => tg.stop('SIGTERM'));
  }

  console.log(
    `Kazzhol AI server listening on :${config.server.port} — channels: ${channels.join(', ')}`,
  );
}

main().catch((err) => {
  console.error('boot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
