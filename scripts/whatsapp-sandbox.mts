// Local WhatsApp sandbox: the REAL fastify server + REAL engine, with a MOCK
// WhatsApp adapter — no Meta account, token or tunnel needed. POST a sample
// webhook and watch the bot's would-be WhatsApp replies print to this console.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/whatsapp-sandbox.mts
//   PORT=3210 npx tsx scripts/whatsapp-sandbox.mts     (default port: 3210)
//   npx tsx scripts/whatsapp-sandbox.mts --help
//
// Then, from another terminal (this is byte-for-byte what Meta would POST):
//   curl -s -X POST http://127.0.0.1:3210/webhooks/whatsapp \
//     -H 'Content-Type: application/json' \
//     -d '{"object":"whatsapp_business_account","entry":[{"id":"e1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"77770000000","phone_number_id":"111000001"},"contacts":[{"wa_id":"77012345678"}],"messages":[{"from":"77012345678","id":"wamid.demo1","timestamp":"1720000000","type":"text","text":{"body":"Здравствуйте! Есть свободные номера на завтра?"}}]}}]}]}'
//
// Deliberately dotenv-free: reads process.env directly, so what you export is
// exactly what runs. No network to Meta is ever attempted (the mock adapter's
// fetch throws), Anthropic is the only outbound call.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutboundPart } from '../src/channels/types';
import {
  WhatsAppAdapter,
  decodeSenderId,
  type ParsedWhatsAppInbound,
} from '../src/channels/whatsapp';
import { BookingService } from '../src/core/booking';
import { Engine } from '../src/core/engine';
import { RateLimiter } from '../src/core/rateLimit';
import { StubAmoCrm } from '../src/integrations/amocrm';
import { createAvailabilityProvider } from '../src/integrations/exely';
import { createTranscriber } from '../src/integrations/transcribe';
import { StubPaymentGateway } from '../src/integrations/payments';
import { properties } from '../src/knowledge';
import { buildServer } from '../src/server';
import { Store } from '../src/store';

const PORT = Number(process.env.PORT ?? 3210);

// Fake-but-stable phone_number_ids (overridable via the same env vars prod uses).
const phoneNumberIds: Record<string, string> = {
  almaty: process.env.WHATSAPP_PHONE_ID_ALMATY ?? '111000001',
  astana: process.env.WHATSAPP_PHONE_ID_ASTANA ?? '111000002',
  park_almaty: process.env.WHATSAPP_PHONE_ID_PARK_ALMATY ?? '111000003',
};
const propertyByPhoneId: Record<string, string> = Object.fromEntries(
  Object.entries(phoneNumberIds).map(([property, id]) => [id, property]),
);

function sampleBody(phoneNumberId: string, text: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'e1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '77770000000', phone_number_id: phoneNumberId },
              contacts: [{ wa_id: '77012345678' }],
              messages: [
                {
                  from: '77012345678',
                  id: `wamid.demo${Date.now()}`,
                  timestamp: '1720000000',
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

function sampleCurl(phoneNumberId: string, text: string): string {
  return (
    `curl -s -X POST http://127.0.0.1:${PORT}/webhooks/whatsapp \\\n` +
    `  -H 'Content-Type: application/json' \\\n` +
    `  -d '${sampleBody(phoneNumberId, text).replaceAll("'", "'\\''")}'`
  );
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    [
      'WhatsApp sandbox — real server + real engine, mocked WhatsApp adapter.',
      '',
      'Env:',
      '  ANTHROPIC_API_KEY   required — the model behind the bot',
      '  ANTHROPIC_MODEL     optional model override',
      '  PORT                optional, default 3210',
      '  EXELY_CLIENT_ID/_SECRET   optional — live availability instead of the stub',
      '  OPENAI_API_KEY      optional — real voice transcription',
      '  WHATSAPP_PHONE_ID_ALMATY / _ASTANA / _PARK_ALMATY   optional id overrides',
      '',
      'Run:  npx tsx scripts/whatsapp-sandbox.mts',
      '',
      'Hotel numbers in this sandbox:',
      ...Object.entries(phoneNumberIds).map(([p, id]) => `  ${p.padEnd(12)} phone_number_id=${id}`),
      '',
      'Sample webhook (Almaty):',
      sampleCurl(phoneNumberIds.almaty, 'Здравствуйте! Есть свободные номера на завтра?'),
    ].join('\n'),
  );
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    'ANTHROPIC_API_KEY is not set — the sandbox boots the real engine and needs it.\n' +
      'Run:  ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/whatsapp-sandbox.mts',
  );
  process.exit(1);
}

/**
 * The mock adapter: parses webhooks exactly like production (inherited code),
 * but every outbound Graph call becomes a console line instead of a Meta HTTP
 * request. The fetch passed to super() throws, guaranteeing nothing ever
 * reaches the network through inherited paths.
 */
class MockWhatsAppAdapter extends WhatsAppAdapter {
  constructor() {
    super({ accessToken: 'sandbox-token-never-sent', phoneNumberIds }, async () => {
      throw new Error('sandbox: outbound call to Meta blocked');
    });
  }

  private label(senderId: string): string {
    const { phoneNumberId, waId } = decodeSenderId(senderId);
    return `${waId} @ ${propertyByPhoneId[phoneNumberId] ?? phoneNumberId}`;
  }

  override parseWebhook(body: unknown): ParsedWhatsAppInbound[] {
    const parsed = super.parseWebhook(body);
    for (const item of parsed) {
      console.log(
        `\n[guest → ${this.label(item.inbound.senderId)}] ` +
          (item.inbound.text ?? `<voice message, media_id=${item.audioMediaId}>`),
      );
    }
    if (parsed.length === 0) console.log('\n[webhook] no guest messages in payload (statuses?)');
    return parsed;
  }

  override async typing(senderId: string, inboundId?: string): Promise<void> {
    if (inboundId) console.log(`[bot → ${this.label(senderId)}] ✓✓ read + typing…`);
  }

  override async send(senderId: string, parts: OutboundPart[]): Promise<void> {
    for (const part of parts) {
      console.log(`[bot → ${this.label(senderId)}] (pause ${part.delayMs}ms) ${part.text}`);
    }
  }

  override async downloadMedia(mediaId: string): Promise<Buffer | null> {
    console.log(`[media] would download ${mediaId} from Meta — skipped in sandbox`);
    return null; // → engine answers with the polite voice fallback
  }
}

function loadStyleGuide(): string | undefined {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    return readFileSync(join(root, 'docs', 'STYLE-GUIDE.md'), 'utf8');
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const store = new Store(':memory:');
  const propertyIdResolver = (key: string): string | undefined =>
    properties[key]?.exelyPropertyId;
  const availabilityProvider = createAvailabilityProvider(
    {
      clientId: process.env.EXELY_CLIENT_ID,
      clientSecret: process.env.EXELY_CLIENT_SECRET,
      authUrl: process.env.EXELY_AUTH_URL ?? 'https://connect.hopenapi.com/auth/token',
      baseUrl: process.env.EXELY_BASE_URL ?? 'https://connect.hopenapi.com',
    },
    propertyIdResolver,
  );

  const engine = new Engine({
    store,
    client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    availabilityProvider,
    bookingService: new BookingService({
      store,
      provider: availabilityProvider,
      bookingEnabled: false,
      propertyIdResolver,
    }),
    paymentGateway: new StubPaymentGateway(),
    crm: new StubAmoCrm((type, data) => store.recordEvent(type, { payload: data })),
    transcriber: createTranscriber(process.env.OPENAI_API_KEY),
    staffNotifier: { notify: (text) => console.log(`[staff-alert] ${text}`) },
    rateLimiter: new RateLimiter(),
    phoneNumberIdToProperty: propertyByPhoneId,
    styleGuide: loadStyleGuide(),
  });

  const app = await buildServer({
    engine,
    adapters: { whatsapp: new MockWhatsAppAdapter() },
    store,
    config: {
      whatsapp: {
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? 'sandbox-verify',
        // Unsigned by default so plain curl works; export WHATSAPP_APP_SECRET
        // to exercise the production HMAC check (then sign your POSTs).
        appSecret: process.env.WHATSAPP_APP_SECRET,
        phoneNumberIds,
      },
    },
  });
  await app.listen({ port: PORT, host: '127.0.0.1' });

  console.log(
    [
      '',
      `WhatsApp sandbox listening on http://127.0.0.1:${PORT}`,
      'Hotel numbers:',
      ...Object.entries(phoneNumberIds).map(([p, id]) => `  ${p.padEnd(12)} phone_number_id=${id}`),
      '',
      'Try it (Almaty):',
      sampleCurl(phoneNumberIds.almaty, 'Здравствуйте! Есть свободные номера на завтра?'),
      '',
      'Replies the bot WOULD send over WhatsApp appear below. Ctrl+C to stop.',
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error('sandbox boot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
