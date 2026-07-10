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
import { BookingService } from './core/booking';
import { Engine } from './core/engine';
import { RateLimiter } from './core/rateLimit';
import { startRetention } from './core/retention';
import { StubAmoCrm } from './integrations/amocrm';
import { createAvailabilityProvider } from './integrations/exely';
import { ExelyHttp } from './integrations/exely/http';
import { ExelyReservation } from './integrations/exely/reservation';
import { ExelyTokenManager } from './integrations/exely/token';
import { StubPaymentGateway } from './integrations/payments';
import { createTranscriber } from './integrations/transcribe';
import { properties } from './knowledge';
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
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  const propertyIdResolver = (key: string): string | undefined =>
    properties[key]?.exelyPropertyId;
  const availabilityProvider = createAvailabilityProvider(config.exely, propertyIdResolver);

  // Reservation shares the same OAuth credentials as Search; it stays undefined
  // (→ bookingFormLink fallback) until Exely creds exist.
  let reservation: ExelyReservation | undefined;
  if (config.exely.clientId && config.exely.clientSecret) {
    const tokens = new ExelyTokenManager({
      clientId: config.exely.clientId,
      clientSecret: config.exely.clientSecret,
      authUrl: config.exely.authUrl,
    });
    reservation = new ExelyReservation(new ExelyHttp({ baseUrl: config.exely.baseUrl }, tokens));
  }
  const bookingService = new BookingService({
    store,
    provider: availabilityProvider,
    reservation,
    bookingEnabled: config.exely.bookingEnabled,
    propertyIdResolver,
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
  const app = await buildServer({
    engine,
    adapters,
    store,
    config,
    extraRoutes: [(a) => widget.register(a)],
  });
  await app.listen({ port: config.server.port, host: '0.0.0.0' });
  startRetention(store);

  if (channels.includes('telegram') && config.telegram.botToken) {
    const telegram = new TelegramChannel({
      botToken: config.telegram.botToken,
      engine,
      store,
    });
    telegram.launch();
    console.log('Telegram channel: running');
    process.once('SIGINT', () => telegram.stop('SIGINT'));
    process.once('SIGTERM', () => telegram.stop('SIGTERM'));
  }

  console.log(
    `Kazzhol AI server listening on :${config.server.port} — channels: ${channels.join(', ')}`,
  );
}

main().catch((err) => {
  console.error('boot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
