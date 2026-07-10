// Fastify server: WhatsApp/Instagram webhooks, health check, and extension
// points for the web widget and staff console (registered via extraRoutes).
import Fastify, { type FastifyInstance } from 'fastify';
import type { InstagramAdapter } from '../channels/instagram';
import type { InboundMessage, OutboundPart } from '../channels/types';
import { verifySignature, type WhatsAppAdapter } from '../channels/whatsapp';
import { track, type EventData } from '../core/events';
import { maskPII } from '../core/pii';

export interface EngineLike {
  handle(msg: InboundMessage): Promise<OutboundPart[] | null>;
}

export interface ServerDeps {
  engine: EngineLike;
  adapters: { whatsapp?: WhatsAppAdapter; instagram?: InstagramAdapter };
  store: { recordEvent(type: string, data?: EventData): void };
  config: {
    whatsapp: {
      verifyToken?: string;
      appSecret?: string;
      phoneNumberIds: Record<string, string>;
    };
  };
  /** Extra route registrars (web widget WS, staff console) plugged in by the caller. */
  extraRoutes?: Array<(app: FastifyInstance) => void | Promise<void>>;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // phone_number_id → property key (config maps the other way around).
  const propertyByPhoneId: Record<string, string> = Object.fromEntries(
    Object.entries(deps.config.whatsapp.phoneNumberIds).map(([property, id]) => [id, property]),
  );

  app.get('/healthz', async () => ({ ok: true }));

  // Meta webhook verification handshake.
  app.get('/webhooks/whatsapp', async (req, reply) => {
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

    // Instagram: acknowledge and count always; full processing only with Meta creds.
    scope.post('/webhooks/instagram', async (req, reply) => {
      track(deps.store, 'ig_received', { channel: 'instagram' });
      await reply.code(200).send('');
      if (!deps.adapters.instagram) return;
      processInstagram(deps, typeof req.body === 'string' ? req.body : '').catch((err) => {
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
        if (data) msg.audio = { data, mime: item.audioMime ?? 'audio/ogg' };
      }
      // Read receipt + typing must never block the actual reply.
      await adapter.typing(msg.senderId, msg.inboundId).catch(() => {});
      const parts = await deps.engine.handle(msg);
      if (parts && parts.length > 0) await adapter.send(msg.senderId, parts);
    } catch (err) {
      console.error('whatsapp message handling failed:', maskPII(errorMessage(err)));
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
