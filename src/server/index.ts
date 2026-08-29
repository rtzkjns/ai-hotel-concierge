// Fastify server: WhatsApp/Instagram webhooks, health check, and extension
// points for the web widget and staff console (registered via extraRoutes).
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { InstagramAdapter } from '../channels/instagram';
import type { InboundMessage, OutboundPart } from '../channels/types';
import { signatureDebug, verifySignature, type WhatsAppAdapter } from '../channels/whatsapp';
import { track, type EventData } from '../core/events';
import { maskPII } from '../core/pii';
import { registerLegalRoutes } from './legal';


/**
 * Проверяет подпись Meta и решает, пускать ли запрос.
 *
 * По умолчанию несовпадение подписи — отказ, и так и должно быть.
 *
 * Но секрет приложения задаётся отдельно от токенов и вполне может оказаться от ДРУГОГО
 * приложения Meta. Тогда строгая проверка отвергнет и настоящие сообщения гостей, а бот
 * оглохнет, никому об этом не сказав. Поэтому на время ввода секрета есть
 * WEBHOOK_OBSERVE_ONLY=true: несовпадение пишется в журнал и в события, запрос при этом
 * обрабатывается. Убедились по журналу, что настоящие вебхуки Meta проходят, — флаг снимают.
 *
 * Возвращает true, если запрос надо отклонить.
 */
/**
 * Подбирает ключ по живой доставке.
 *
 * У Instagram подпись не сходится, и какой секрет верный — неизвестно: документация Meta
 * называет App Secret из App settings → Basic, но на пути Instagram Login у приложения своя
 * идентичность со своим секретом, а на форуме Meta есть тред ровно с нашим симптомом, где не
 * подошёл ни один. Гадать бессмысленно — пусть ответит сама доставка.
 *
 * В INSTAGRAM_APP_SECRET_CANDIDATES кладутся секреты-кандидаты через запятую. В журнал идёт
 * ТОЛЬКО номер совпавшего — ни секретов, ни тела, ни текста гостя.
 */
function matchingCandidate(rawBody: string, header: unknown): number | null {
  const raw = process.env.INSTAGRAM_APP_SECRET_CANDIDATES ?? '';
  const list = raw.split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < list.length; i += 1) {
    if (verifySignature(rawBody, typeof header === 'string' ? header : undefined, list[i])) {
      return i + 1;
    }
  }
  return null;
}

function rejectBadSignature(
  deps: ServerDeps,
  rawBody: string,
  header: unknown,
  source: string,
  appSecret: string | undefined,
): boolean {
  if (!appSecret) return false;
  const ok = verifySignature(rawBody, typeof header === 'string' ? header : undefined, appSecret);
  if (ok) {
    // Успех тоже пишем: без этого тишина в журнале означает и «всё сошлось», и «доставок
    // вообще не было», а различить это критично перед снятием режима наблюдения.
    console.log(`${source}: подпись ок`);
    track(deps.store, 'webhook_signature_ok', { payload: { source } });
    return false;
  }
  const enforce = process.env.WEBHOOK_OBSERVE_ONLY !== 'true';
  const candidate = matchingCandidate(rawBody, header);
  console.warn(
    `${source}: подпись не совпала${enforce ? ' — запрос отклонён' : ' — пропускаем (режим наблюдения)'}` +
      ` · ${signatureDebug(rawBody, typeof header === 'string' ? header : undefined, appSecret)}` +
      (candidate ? ` · ПОДОШЁЛ КАНДИДАТ №${candidate}` : ''),
  );
  track(deps.store, 'webhook_signature_mismatch', { payload: { source, enforce } });
  return enforce;
}


/**
 * Отправляет ответ гостю и НЕ даёт ему пропасть молча.
 *
 * Раньше сбой отправки только писался в console.error. Ответ при этом уже лежал в истории
 * диалога, поэтому в панели переписка выглядела отвеченной, а гость сидел перед тишиной и
 * не знал об этом никто. Ровно так 21 августа потерялись два ответа подряд: Meta отвергла
 * отправку, а в панели всё выглядело благополучно.
 *
 * Теперь недоставка — это событие в журнале И заявка менеджерам с готовым текстом, который
 * можно отправить руками. Так же, как это давно сделано для подтверждения брони.
 */
async function deliver(
  deps: ServerDeps,
  send: (senderId: string, parts: OutboundPart[]) => Promise<void>,
  msg: InboundMessage,
  parts: OutboundPart[],
): Promise<void> {
  try {
    await send(msg.senderId, parts);
    track(deps.store, 'message_delivered', { channel: msg.channel });
  } catch (err) {
    const reason = errorMessage(err);
    console.error(`${msg.channel}: ответ гостю НЕ доставлен:`, maskPII(reason));
    track(deps.store, 'message_delivery_failed', {
      channel: msg.channel,
      payload: { reason },
    });
    await deps.notifyStaff
      ?.(
        `Гостю НЕ доставлен ответ (${msg.channel}): ${reason}\n` +
          `Диалог: ${msg.channel}:${msg.senderId}\n` +
          `Отправьте вручную:\n\n${parts.map((p) => p.text).join('\n')}`,
      )
      .catch(() => undefined);
  }
}

export interface EngineLike {
  handle(msg: InboundMessage): Promise<OutboundPart[] | null>;
}

export interface ServerDeps {
  engine: EngineLike;
  adapters: { whatsapp?: WhatsAppAdapter; instagram?: InstagramAdapter };
  /** Зовут людей, когда ответ гостю не удалось доставить. Необязателен: тесты его не ставят. */
  notifyStaff?: (text: string, property?: string) => Promise<void>;
  store: {
    recordEvent(type: string, data?: EventData): void;
    /** Optional (tests pass a minimal stub): needed to mute the bot on a WhatsApp staff takeover. */
    getConversation?(id: string): {
      status: string;
      history?: Array<{ role: string; content: string }>;
    } | null;
    appendMessage?(id: string, message: { role: 'user' | 'assistant'; content: string }): void;
    setStatus?(id: string, status: 'active' | 'handed_off' | 'closed'): void;
    // Durable intake (crash-safe). Optional so minimal test stubs still satisfy the type; when
    // absent the handlers fall back to direct in-memory processing (today's behaviour).
    enqueueInbound?(rec: { idemKey: string; channel: string; senderId: string; payload: unknown }): number | null;
    claimInbound?(id: number): boolean;
    markReplying?(id: number): boolean;
    markInboundDone?(id: number): void;
  };
  config: {
    whatsapp: {
      verifyToken?: string;
      appSecret?: string;
      /** Shared secret sent by 360dialog as a custom webhook header (d360 does not HMAC-sign). */
      webhookSecret?: string;
      /** 'd360' подписывает своим ключом — HMAC нашего приложения к нему неприменим. */
      provider?: string;
      phoneNumberIds: Record<string, string>;
    };
    /** У Instagram отдельное приложение Meta и отдельный секрет подписи. */
    instagram?: { appSecret?: string };
  };
  /** Extra route registrars (web widget WS, staff console) plugged in by the caller. */
  extraRoutes?: Array<(app: FastifyInstance) => void | Promise<void>>;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  // Снаружи мы всегда за Caddy, и без этого req.ip у ВСЕХ гостей одинаков — адрес самого
  // прокси. Тогда защита входа в панель, считающая попытки по паре «логин + адрес»,
  // вырождается в счёт по одному логину, и перебор снова запирает владельца.
  const app = Fastify({ logger: false, trustProxy: true });

  // A live WhatsApp channel without an app secret accepts unsigned (spoofable)
  // webhooks — loud warning so a prod misconfiguration can't stay silent.
  if (deps.adapters.whatsapp && !deps.config.whatsapp.appSecret) {
    console.warn(
      'WARNING: WhatsApp channel is live but WHATSAPP_APP_SECRET is not set — ' +
        'webhook signatures are NOT verified; set the app secret before production.',
    );
  }

  // phone_number_id → property key (config maps the other way around).
  const propertyByPhoneId: Record<string, string> = Object.fromEntries(
    Object.entries(deps.config.whatsapp.phoneNumberIds).map(([property, id]) => [id, property]),
  );

  app.get('/healthz', async () => ({ ok: true }));

  // Public privacy policy + terms (required for Meta App Review, self-hosted).
  registerLegalRoutes(app);

  // Meta webhook verification handshake.
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const verifyToken = deps.config.whatsapp.verifyToken;
    if (q['hub.mode'] === 'subscribe' && verifyToken && q['hub.verify_token'] === verifyToken) {
      return reply.code(200).type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send('forbidden');
  });

  // Instagram uses the same Meta-app verification handshake (needed to ever
  // subscribe the webhook; shares the WhatsApp verify token — one Meta app).
  app.get('/webhooks/instagram', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const verifyToken = deps.config.whatsapp.verifyToken;
    if (q['hub.mode'] === 'subscribe' && verifyToken && q['hub.verify_token'] === verifyToken) {
      return reply.code(200).type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send('forbidden');
  });

  // Webhook POSTs live in their own scope where JSON stays a raw string:
  // Meta's signature is an HMAC over the exact bytes, and a malformed body
  // must never crash the process (parse defensively, always answer 2xx).
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_req, payload, done) => done(null, payload),
    );

    scope.post('/webhooks/whatsapp', async (req, reply) => {
      const rawBody = typeof req.body === 'string' ? req.body : '';
      // 360dialog does NOT sign webhooks the way Meta does, so the signature check below is
      // inert on that provider and the endpoint would be open to the whole internet. 360dialog
      // can attach arbitrary headers to every delivery (`headers` in /v1/configs/webhook), so a
      // shared secret header is the equivalent guarantee. Meta path keeps the HMAC check.
      const sharedSecret = deps.config.whatsapp.webhookSecret;
      if (sharedSecret) {
        const provided = req.headers['x-kazzhol-webhook-secret'];
        if (typeof provided !== 'string' || provided !== sharedSecret) {
          return reply.code(401).send('invalid webhook secret');
        }
      }
      // 360dialog подписывает доставки СВОИМ ключом, а не секретом нашего приложения:
      // проверка ключом Meta там не может сойтись в принципе и за сутки дала 60 ложных
      // тревог, за которыми потерялись бы настоящие. Гарантией на этом провайдере служит
      // общий секрет в заголовке — он проверен выше и без него запрос сюда не доходит.
      const metaSigned = deps.config.whatsapp.provider !== 'd360';
      if (
        metaSigned &&
        rejectBadSignature(
          deps,
          rawBody,
          req.headers['x-hub-signature-256'],
          'whatsapp',
          deps.config.whatsapp.appSecret,
        )
      ) {
        return reply.code(401).send('invalid signature');
      }
      // Acknowledge immediately (Meta retries slow webhooks), then process async.
      await reply.code(200).send('');
      processWhatsApp(deps, propertyByPhoneId, rawBody).catch((err) => {
        console.error('whatsapp webhook processing failed:', maskPII(errorMessage(err)));
      });
    });

    // Instagram shares the same Meta app → same app secret. Verify the signature
    // (401 on mismatch) exactly like WhatsApp; then ack; then process only when
    // the channel is configured (anonymous unsigned POSTs must not grow events).
    scope.post('/webhooks/instagram', async (req, reply) => {
      const rawBody = typeof req.body === 'string' ? req.body : '';
      if (
        rejectBadSignature(
          deps,
          rawBody,
          req.headers['x-hub-signature-256'],
          'instagram',
          // У Instagram СВОЙ секрет; фейсбучный здесь не подходит — проверено на живых доставках.
          deps.config.instagram?.appSecret,
        )
      ) {
        return reply.code(401).send('invalid signature');
      }
      await reply.code(200).send('');
      if (!deps.adapters.instagram) return;
      track(deps.store, 'ig_received', { channel: 'instagram' });
      processInstagram(deps, rawBody).catch((err) => {
        console.error('instagram webhook processing failed:', maskPII(errorMessage(err)));
      });
    });
  });

  for (const register of deps.extraRoutes ?? []) {
    await register(app);
  }

  return app;
}

/** Idempotency fallback when a webhook carries no native message id (rare). Same message within a
 *  day → same key, so a retry still dedups. */
function hashInbound(channel: string, senderId: string, text: string | undefined): string {
  return createHash('sha256')
    .update(`${channel}|${senderId}|${text ?? ''}|${new Date().toISOString().slice(0, 10)}`)
    .digest('hex')
    .slice(0, 24);
}

/** Process ONE WhatsApp message (media, typing, engine, delivery). When queueId is set, the reply
 *  goes through the at-most-once gate and the row is marked done — so a boot replay never
 *  double-replies. Extracted so the live path and the boot sweep share identical logic. */
export async function handleWhatsAppItem(
  deps: ServerDeps,
  propertyByPhoneId: Record<string, string>,
  adapter: WhatsAppAdapter,
  item: ReturnType<WhatsAppAdapter['parseWebhook']>[number],
  queueId: number | null,
): Promise<void> {
  const msg = item.inbound;
  msg.propertyHint = propertyByPhoneId[item.phoneNumberId] ?? item.phoneNumberId;
  if (item.audioMediaId) {
    const data = await adapter.downloadMedia(item.audioMediaId);
    // Download failed/refused → keep the message voice-shaped with empty audio:
    // the transcriber returns null on it, so the guest gets the polite
    // "couldn't listen, please type" fallback instead of dead silence.
    msg.audio = { data: data ?? Buffer.alloc(0), mime: item.audioMime ?? 'audio/ogg' };
  }
  // Read receipt + typing must never block the actual reply.
  await adapter.typing(msg.senderId, msg.inboundId).catch(() => {});
  const parts = await deps.engine.handle(msg);
  if (parts && parts.length > 0) {
    // At-most-once: a replay after a crash-post-reply must not re-send. No queue (tests) → always send.
    const mayReply = queueId == null || (deps.store.markReplying?.(queueId) ?? true);
    if (mayReply) await deliver(deps, (id, p) => adapter.send(id, p), msg, parts);
  }
  if (queueId != null) deps.store.markInboundDone?.(queueId);
}

async function processWhatsApp(
  deps: ServerDeps,
  propertyByPhoneId: Record<string, string>,
  rawBody: string,
): Promise<void> {
  const adapter = deps.adapters.whatsapp;
  if (!adapter) return;

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.warn('whatsapp webhook: malformed JSON body dropped');
    return;
  }

  for (const item of adapter.parseWebhook(body)) {
    // Journal BEFORE the slow work so a deploy/crash mid-processing replays on boot. When the store
    // has no queue (minimal test stubs) queueId stays null → direct processing, today's behaviour.
    let queueId: number | null = null;
    if (deps.store.enqueueInbound) {
      const idemKey = `whatsapp:${
        item.inbound.inboundId || hashInbound('whatsapp', item.inbound.senderId, item.inbound.text)
      }`;
      const enq = deps.store.enqueueInbound({
        idemKey,
        channel: 'whatsapp',
        senderId: item.inbound.senderId,
        payload: {
          inbound: item.inbound,
          phoneNumberId: item.phoneNumberId,
          audioMediaId: item.audioMediaId,
          audioMime: item.audioMime,
        },
      });
      if (enq === null) continue; // duplicate delivery (Meta retry) — already enqueued/handled
      if (deps.store.claimInbound && !deps.store.claimInbound(enq)) continue;
      queueId = enq;
    }
    try {
      await handleWhatsAppItem(deps, propertyByPhoneId, adapter, item, queueId);
    } catch (err) {
      console.error('whatsapp message handling failed:', maskPII(errorMessage(err)));
      // row stays 'processing' → the boot sweep retries it
    }
  }

  // Coexistence: staff replied to a guest from the WhatsApp Business app (echoed to
  // us) — record it so analytics/console see the human turn; it is not a guest message.
  for (const echo of adapter.parseSmbEchoes(body)) {
    // Coexistence is a SHARED line: the reception answers the same guest from the phone. If we
    // only counted the echo, the bot would keep replying over the human — two voices in one chat.
    // Treat a staff reply as a takeover: record it in the history and mute the bot for this guest.
    // Conversation ids are `${channel}:${senderId}` and the WhatsApp senderId is
    // `${phone_number_id}|${wa_id}` (one adapter serves every hotel number) — verified live:
    // ids in production look like `whatsapp:1541962692809091|77010000001`.
    const conversationId = `whatsapp:${echo.phoneNumberId}|${echo.guestWaId}`;
    const convo = deps.store.getConversation?.(conversationId) ?? null;
    if (convo) {
      if (echo.text) {
        deps.store.appendMessage?.(conversationId, { role: 'assistant', content: echo.text });
      }
      if (convo.status !== 'handed_off') deps.store.setStatus?.(conversationId, 'handed_off');
    }
    track(deps.store, 'wa_staff_echo', {
      conversationId: convo ? conversationId : undefined,
      channel: 'whatsapp',
    });
  }
  // Account lifecycle: PARTNER_REMOVED means our app was offboarded from the number.
  for (const upd of adapter.parseAccountUpdates(body)) {
    track(deps.store, 'wa_account_update', { channel: 'whatsapp' });
    if (upd.event === 'PARTNER_REMOVED') {
      console.warn('WhatsApp account_update: PARTNER_REMOVED — our app was offboarded from a number');
    }
  }
}

async function processInstagram(deps: ServerDeps, rawBody: string): Promise<void> {
  const adapter = deps.adapters.instagram;
  if (!adapter) return;
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return; // acked already; malformed payloads are simply dropped
  }
  // Исходящее аккаунта — записываем в историю, но бота НЕ глушим.
  //
  // Instagram помечает как is_echo и наши собственные отправки, и ответ живого менеджера, и
  // автоответ, настроенный в самом аккаунте. Различить их нельзя. Раньше здесь стоял перевод
  // диалога в handed_off — и он выстрелил в живого гостя: автоответ «перейдите на наш сайт»
  // был принят за менеджера, бот замолчал, а гостья спрашивала меню, даты и число человек
  // в пустоту, пока не написала жалобу. Молчание перед гостем хуже, чем два голоса в чате,
  // и несравнимо хуже, чем лишняя строка в истории.
  //
  // Диалог теперь передаётся человеку только явно — когда менеджер берёт его в панели.
  for (const echo of adapter.parseEchoes?.(body) ?? []) {
    const conversationId = `instagram:${echo.igId}|${echo.psid}`;
    const convo = deps.store.getConversation?.(conversationId) ?? null;
    if (!convo) continue;
    const ours = [...(convo.history ?? [])]
      .reverse()
      .find((m) => m.role === 'assistant')?.content;
    if (ours && ours.includes(echo.text.trim())) continue; // это мы сами
    deps.store.appendMessage?.(conversationId, { role: 'assistant', content: echo.text });
    track(deps.store, 'ig_staff_echo', { conversationId, channel: 'instagram' });
  }

  for (const msg of adapter.parseWebhook(body)) {
    let queueId: number | null = null;
    if (deps.store.enqueueInbound) {
      const idemKey = `instagram:${msg.inboundId || hashInbound('instagram', msg.senderId, msg.text)}`;
      const enq = deps.store.enqueueInbound({
        idemKey,
        channel: 'instagram',
        senderId: msg.senderId,
        payload: { inbound: msg },
      });
      if (enq === null) continue; // duplicate delivery — already enqueued/handled
      if (deps.store.claimInbound && !deps.store.claimInbound(enq)) continue;
      queueId = enq;
    }
    try {
      await handleInstagramItem(deps, adapter, msg, queueId);
    } catch (err) {
      console.error('instagram message handling failed:', maskPII(errorMessage(err)));
    }
  }
}

/** Process ONE Instagram message with the same durable-queue semantics as WhatsApp. */
export async function handleInstagramItem(
  deps: ServerDeps,
  adapter: InstagramAdapter,
  msg: ReturnType<InstagramAdapter['parseWebhook']>[number],
  queueId: number | null,
): Promise<void> {
  await adapter.typing?.(msg.senderId).catch(() => {});
  const parts = await deps.engine.handle(msg);
  if (parts && parts.length > 0) {
    const mayReply = queueId == null || (deps.store.markReplying?.(queueId) ?? true);
    if (mayReply) await deliver(deps, (id, p) => adapter.send(id, p), msg, parts);
  }
  if (queueId != null) deps.store.markInboundDone?.(queueId);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
