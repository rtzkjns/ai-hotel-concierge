// Fastify server: WhatsApp/Instagram webhooks, health check, and extension
// points for the web widget and staff console (registered via extraRoutes).
import Fastify, { type FastifyInstance } from 'fastify';
import type { InstagramAdapter } from '../channels/instagram';
import type { InboundMessage, OutboundPart } from '../channels/types';
import { verifySignature, type WhatsAppAdapter } from '../channels/whatsapp';
import { track, type EventData } from '../core/events';
import { maskPII } from '../core/pii';
import { registerLegalRoutes } from './legal';

export interface EngineLike {
  handle(msg: InboundMessage): Promise<OutboundPart[] | null>;
}

export interface ServerDeps {
  engine: EngineLike;
  adapters: { whatsapp?: WhatsAppAdapter; instagram?: InstagramAdapter };
  store: {
    recordEvent(type: string, data?: EventData): void;
    /** Optional (tests pass a minimal stub): needed to mute the bot on a WhatsApp staff takeover. */
    getConversation?(id: string): { status: string } | null;
    appendMessage?(id: string, message: { role: 'user' | 'assistant'; content: string }): void;
    setStatus?(id: string, status: 'active' | 'handed_off' | 'closed'): void;
  };
  config: {
    whatsapp: {
      verifyToken?: string;
      appSecret?: string;
      /** Shared secret sent by 360dialog as a custom webhook header (d360 does not HMAC-sign). */
      webhookSecret?: string;
      phoneNumberIds: Record<string, string>;
    };
  };
  /** Extra route registrars (web widget WS, staff console) plugged in by the caller. */
  extraRoutes?: Array<(app: FastifyInstance) => void | Promise<void>>;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

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
      const appSecret = deps.config.whatsapp.appSecret;
      if (appSecret) {
        const header = req.headers['x-hub-signature-256'];
        if (!verifySignature(rawBody, typeof header === 'string' ? header : undefined, appSecret)) {
          return reply.code(401).send('invalid signature');
        }
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
      const appSecret = deps.config.whatsapp.appSecret;
      if (appSecret) {
        const header = req.headers['x-hub-signature-256'];
        if (!verifySignature(rawBody, typeof header === 'string' ? header : undefined, appSecret)) {
          return reply.code(401).send('invalid signature');
        }
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
    try {
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
      if (parts && parts.length > 0) await adapter.send(msg.senderId, parts);
    } catch (err) {
      console.error('whatsapp message handling failed:', maskPII(errorMessage(err)));
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
  for (const msg of adapter.parseWebhook(body)) {
    try {
      await adapter.typing?.(msg.senderId).catch(() => {});
      const parts = await deps.engine.handle(msg);
      if (parts && parts.length > 0) await adapter.send(msg.senderId, parts);
    } catch (err) {
      console.error('instagram message handling failed:', maskPII(errorMessage(err)));
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
