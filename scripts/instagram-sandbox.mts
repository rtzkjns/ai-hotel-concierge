// Local Instagram sandbox: the REAL fastify server + REAL engine, with a MOCK
// Instagram adapter — no Meta account, token or tunnel needed. POST a sample
// webhook and watch the bot's would-be Instagram DM replies print to console.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/instagram-sandbox.mts
//   PORT=3211 npx tsx scripts/instagram-sandbox.mts     (default port: 3211)
//   npx tsx scripts/instagram-sandbox.mts --help
//
// Then, from another terminal (byte-for-byte what Meta would POST):
//   curl -s -X POST http://127.0.0.1:3211/webhooks/instagram \
//     -H 'Content-Type: application/json' \
//     -d '{"object":"instagram","entry":[{"id":"ig-hotel-1","messaging":[{"sender":{"id":"55667788"},"recipient":{"id":"ig-hotel-1"},"message":{"mid":"ig.demo1","text":"Сәлеметсіз бе! Бос бөлме бар ма?"}}]}]}'
//
// Deliberately dotenv-free: reads process.env directly. No network to Meta is
// ever attempted (the mock adapter's fetch throws); Anthropic is the only
// outbound call.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutboundPart } from '../src/channels/types';
import { InstagramAdapter } from '../src/channels/instagram';
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

const PORT = Number(process.env.PORT ?? 3211);
const IG_ID = process.env.INSTAGRAM_IG_ID ?? 'ig-hotel-1';

function sampleBody(text: string): string {
  return JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: IG_ID,
        messaging: [
          {
            sender: { id: '55667788' },
            recipient: { id: IG_ID },
            message: { mid: `ig.demo${Date.now()}`, text },
          },
        ],
      },
    ],
  });
}

function sampleCurl(text: string): string {
  return (
    `curl -s -X POST http://127.0.0.1:${PORT}/webhooks/instagram \\\n` +
    `  -H 'Content-Type: application/json' \\\n` +
    `  -d '${sampleBody(text).replaceAll("'", "'\\''")}'`
  );
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    [
      'Instagram sandbox — real server + real engine, mocked Instagram adapter.',
      '',
      'Env:',
      '  ANTHROPIC_API_KEY   required — the model behind the bot',
      '  ANTHROPIC_MODEL     optional model override',
      '  PORT                optional, default 3211',
      '  INSTAGRAM_IG_ID     optional IG account id (default ig-hotel-1)',
      '  EXELY_CLIENT_ID/_SECRET   optional — live availability instead of the stub',
      '',
      'Run:  npx tsx scripts/instagram-sandbox.mts',
      '',
      'Sample DM webhook:',
      sampleCurl('Сәлеметсіз бе! Бос бөлме бар ма?'),
    ].join('\n'),
  );
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    'ANTHROPIC_API_KEY is not set — the sandbox boots the real engine and needs it.\n' +
      'Run:  ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/instagram-sandbox.mts',
  );
  process.exit(1);
}

/**
 * The mock adapter parses webhooks exactly like production (inherited code), but
 * every outbound Graph call becomes a console line. The fetch passed to super()
 * throws, so nothing ever reaches Meta through inherited paths.
 */
class MockInstagramAdapter extends InstagramAdapter {
  constructor() {
    super({ accessToken: 'sandbox-token-never-sent', igIds: { almaty: IG_ID } }, async () => {
      throw new Error('sandbox: outbound call to Meta blocked');
    });
  }

  override async typing(senderId: string): Promise<void> {
    console.log(`[bot → ig:${senderId}] typing…`);
  }

  override async send(senderId: string, parts: OutboundPart[]): Promise<void> {
    for (const part of parts) {
      console.log(`[bot → ig:${senderId}] (pause ${part.delayMs}ms) ${part.text}`);
    }
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
  const propertyIdResolver = (key: string): string | undefined => properties[key]?.exelyPropertyId;
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
    styleGuide: loadStyleGuide(),
  });

  // The IG DM selector: the sandbox pins one hotel so the demo needs no picker.
  // Instagram has no phone_number_id → property routing yet (single account),
  // so the guest is treated as Almaty for the demo.
  const app = await buildServer({
    engine,
    adapters: { instagram: new MockInstagramAdapter() },
    store,
    config: {
      whatsapp: {
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? 'sandbox-verify',
        appSecret: process.env.WHATSAPP_APP_SECRET,
        phoneNumberIds: {},
      },
    },
  });
  await app.listen({ port: PORT, host: '127.0.0.1' });

  console.log(
    [
      '',
      `Instagram sandbox listening on http://127.0.0.1:${PORT}  (IG account: ${IG_ID})`,
      '',
      'Try it:',
      sampleCurl('Сәлеметсіз бе! Бос бөлме бар ма?'),
      '',
      'Replies the bot WOULD send over Instagram DM appear below. Ctrl+C to stop.',
      'Note: a guest must pick a hotel first (the engine returns the hotel selector),',
      'so the first reply is the trilingual picker — send the hotel number next.',
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error('sandbox boot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
