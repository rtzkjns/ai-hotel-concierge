// Live Instagram test WITHOUT deploying the webhook server: pulls the newest DM a
// hotel account received, runs it through the REAL engine (live Anthropic + Exely),
// and sends the bot's reply back via the real Instagram API. Proves the bot works
// end-to-end on a live account.
//
//   ANTHROPIC_MODEL=claude-sonnet-5 npx tsx scripts/ig-live-reply.mts almaty
//   (account ∈ almaty | astana | park_almaty | seven; default almaty)
//
// Ask someone to DM the hotel's Instagram first (opens the 24h window), then run this.
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstagramAdapter } from '../src/channels/instagram';
import { config } from '../src/config';
import { BookingService } from '../src/core/booking';
import { Engine } from '../src/core/engine';
import { RateLimiter } from '../src/core/rateLimit';
import { StubAmoCrm } from '../src/integrations/amocrm';
import { createCabinetProviders } from '../src/integrations/exely';
import { createTranscriber } from '../src/integrations/transcribe';
import { StubPaymentGateway } from '../src/integrations/payments';
import { Store } from '../src/store';

const target = process.argv[2] ?? 'almaty';
const igId = config.instagram.igIds[target];
const token = config.instagram.tokens[target];
if (!igId || !token) {
  console.error(`Нет igId/токена для "${target}". Есть: ${Object.keys(config.instagram.igIds).join(', ')}`);
  process.exit(1);
}
if (!config.anthropicApiKey) {
  console.error('ANTHROPIC_API_KEY не задан');
  process.exit(1);
}

// 1) newest conversation → the guest's latest message + their IGSID
const cr = await fetch(
  `https://graph.instagram.com/v23.0/${igId}/conversations?fields=id,messages.limit(8){message,from,created_time}&access_token=${encodeURIComponent(token)}`,
);
const cj = (await cr.json()) as { data?: Array<{ messages?: { data?: Array<{ message: string; from?: { id?: string; username?: string } }> } }>; error?: unknown };
if (cj.error) {
  console.error('conversations error:', JSON.stringify(cj.error).slice(0, 200));
  process.exit(1);
}
const convo = cj.data?.[0];
if (!convo) {
  console.log(`@${target}: пока нет ни одной переписки. Попроси кого-нибудь написать в DM этого аккаунта, потом запусти снова.`);
  process.exit(0);
}
const msgs = convo.messages?.data ?? [];
const guestMsg = msgs.find((m) => m.from?.id && m.from.id !== igId && m.message);
if (!guestMsg) {
  console.log('В последней переписке нет гостевого сообщения (только наши). Пусть гость напишет ещё раз.');
  process.exit(0);
}
const guestIgsid = guestMsg.from!.id!;
const text = guestMsg.message;
console.log(`[гость @${guestMsg.from?.username ?? guestIgsid}] ${text}\n`);

// 2) real engine (live Exely + live Anthropic)
function loadStyleGuide(): string | undefined {
  try {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'STYLE-GUIDE.md'), 'utf8');
  } catch {
    return undefined;
  }
}
const store = new Store(':memory:');
const cabinets = createCabinetProviders(config.exelyByProperty);
const engine = new Engine({
  store,
  client: new Anthropic({ apiKey: config.anthropicApiKey }),
  model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
  availabilityProvider: cabinets.availability,
  bookingService: new BookingService({
    store,
    provider: cabinets.availability,
    reservationFor: cabinets.reservationFor,
    bookingEnabledFor: cabinets.bookingEnabledFor,
    propertyIdResolver: cabinets.propertyIdResolver,
  }),
  paymentGateway: new StubPaymentGateway(),
  crm: new StubAmoCrm(() => {}),
  transcriber: createTranscriber(config.openaiApiKey),
  staffNotifier: { notify: (t) => console.log('[staff]', t) },
  rateLimiter: new RateLimiter(),
  styleGuide: loadStyleGuide(),
});

// 3) run the bot for this DM
const senderId = `${igId}|${guestIgsid}`;
const conv = store.getOrCreateConversation('instagram', senderId);
store.setProperty(conv.id, target);
const parts = await engine.handle({ channel: 'instagram', senderId, text, propertyHint: target });
console.log('[бот →]', parts?.map((p) => p.text).join('  |||  ') ?? '(silent)');

// 4) actually send the reply to the real Instagram DM
if (parts && parts.length > 0) {
  const adapter = new InstagramAdapter({ igIds: { [target]: igId }, tokens: { [target]: token } });
  await adapter.send(senderId, parts);
  console.log('\n✅ Ответ отправлен в реальный Instagram DM — проверь диалог с @' + target);
} else {
  console.log('\n(бот решил промолчать — ничего не отправлено)');
}
