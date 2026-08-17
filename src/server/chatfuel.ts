// Chatfuel bridge — a temporary, legitimate "tenant" path to answer Instagram DMs from ALL guests
// while our own Meta app's App Review is pending. Chatfuel is a Meta-approved platform; our IG
// accounts connect under ITS app, and our OWN engine writes the replies verbatim (Fuely AI is
// bypassed). When App Review lands we disconnect Chatfuel and go direct on graph.instagram.com.
//
// Flow (SINGLE synchronous JSON-API block — no Broadcasting API needed):
//   guest DM → Chatfuel → POST /chatfuel/inbound/:property → we run the engine and return its
//   verbatim reply in the SAME response → Chatfuel sends it. Bounded by inboundTimeoutMs so
//   Chatfuel's ~10s block timeout never hangs; a slow reply falls back to a short holding line.
import type { FastifyInstance } from 'fastify';
import type { InboundMessage, OutboundPart } from '../channels/types';

const IG_TEXT_MAX_BYTES = 1000; // Instagram caps a single DM at 1000 BYTES
const DEDUP_TTL_MS = 60_000;
const REPLY_TTL_MS = 5 * 60_000;

export interface ChatfuelBot {
  botId: string;
  token: string;
}

export interface ChatfuelBridgeDeps {
  engine: { handle(msg: InboundMessage): Promise<OutboundPart[] | null> };
  /** property key → that hotel's Chatfuel bot id + token. */
  bots: Record<string, ChatfuelBot>;
  /** Cap the synchronous wait so Chatfuel's ~10s JSON-API block timeout never hangs. */
  inboundTimeoutMs?: number;
}

/** Split on the byte boundary Instagram enforces, without cutting a multi-byte char. */
export function chunkByBytes(text: string, max = IG_TEXT_MAX_BYTES): string[] {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (enc.encode(cur + ch).length > max) {
      if (cur) out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Pull a field from JSON body or query under any of several likely Chatfuel attribute names. */
function pick(src: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** Shape the response so Chatfuel delivers it whether it auto-renders `messages` (legacy JSON API)
 *  or only captures a response field into an attribute (then the flow sends {{reply}}). */
function replyBody(chunks: string[]): {
  messages: Array<{ text: string }>;
  set_attributes: { reply: string };
  reply: string;
  text: string;
} {
  const full = chunks.join('\n');
  return {
    messages: chunks.map((text) => ({ text })),
    set_attributes: { reply: full },
    reply: full,
    text: full,
  };
}

export function registerChatfuelBridge(app: FastifyInstance, deps: ChatfuelBridgeDeps): void {
  const inboundTimeoutMs = deps.inboundTimeoutMs ?? 9500;
  // Optional async-delivery store (kept for a future Broadcasting path), keyed by `${property}:${userId}`.
  const pending = new Map<string, { parts: string[]; at: number }>();
  // Recently-seen inbound (property:user:text) → drop Chatfuel retries, keyed to a timestamp.
  const seen = new Map<string, number>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > REPLY_TTL_MS) pending.delete(k);
    for (const [k, t] of seen) if (now - t > DEDUP_TTL_MS) seen.delete(k);
  };

  const fields = (req: { body?: unknown; query?: unknown }): Record<string, unknown> => ({
    ...(typeof req.query === 'object' && req.query ? (req.query as Record<string, unknown>) : {}),
    ...(typeof req.body === 'object' && req.body ? (req.body as Record<string, unknown>) : {}),
  });

  // 1) Inbound: run the engine and return its reply IN THE SAME RESPONSE (single JSON-API block,
  // no Broadcasting API needed). Bounded so Chatfuel's ~10s block timeout never hangs — if the
  // engine is slow, return a short holding line (the guest's next message picks up the context).
  app.post('/chatfuel/inbound/:property', async (req, reply) => {
    sweep();
    const property = (req.params as { property?: string })?.property ?? '';
    const bot = deps.bots[property];
    const f = fields(req);
    // Accept BOTH clean keys and Chatfuel's default "All properties" keys (which use spaces).
    const userId = pick(f, [
      'user_id',
      'chatfuel_user_id',
      'chatfuel user id',
      'messenger_user_id',
      'instagram user id',
      'contact id',
      'id',
      'psid',
    ]);
    const text = pick(f, [
      'last_user_freeform_input',
      'last user freeform input',
      'last_user_input',
      'message',
      'text',
    ]);

    console.log(
      `[chatfuel] inbound ${property} bot=${bot ? 'ok' : 'MISSING'} user=${userId ?? '?'} text=${text ? JSON.stringify(text.slice(0, 60)) : '?'} | RAWKEYS=${JSON.stringify(Object.keys(f))} | RAW=${JSON.stringify(f).slice(0, 800)}`,
    );
    if (!bot || !userId || !text) {
      return reply.code(200).send(replyBody([]));
    }
    const dedupKey = `${property}:${userId}:${text}`;
    if (seen.has(dedupKey)) return reply.code(200).send(replyBody([]));
    seen.set(dedupKey, Date.now());

    let parts: OutboundPart[] | null = null;
    try {
      parts = await Promise.race([
        deps.engine.handle({
          channel: 'instagram',
          senderId: `${bot.botId}|${userId}`,
          propertyHint: property,
          text,
        }),
        new Promise<null>((r) => setTimeout(() => r(null), inboundTimeoutMs)),
      ]);
    } catch (err) {
      console.error('chatfuel engine failed:', err instanceof Error ? err.message : err);
    }
    const chunks = (parts ?? [])
      .map((p) => p.text)
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      .flatMap((t) => chunkByBytes(t));
    if (chunks.length > 0) {
      return reply.code(200).send(replyBody(chunks));
    }
    // Engine too slow or empty — never leave the guest hanging.
    return reply.code(200).send(replyBody(['секунду, уточняю по вашему запросу…']));
  });

  // 2) Deliver: Chatfuel's Deliver block asks us for the finished reply → return it verbatim.
  app.post('/chatfuel/deliver/:property', async (req, reply) => {
    const property = (req.params as { property?: string })?.property ?? '';
    const f = fields(req);
    const userId = pick(f, ['chatfuel_user_id', 'messenger_user_id', 'user_id', 'id', 'psid']);
    const key = `${property}:${userId}`;
    const entry = userId ? pending.get(key) : undefined;
    if (!entry) return reply.code(200).send({ messages: [] });
    pending.delete(key);
    return reply.code(200).send({ messages: entry.parts.map((text) => ({ text })) });
  });

  // 3) Health: lets us confirm the bridge is wired without touching Chatfuel.
  app.get('/chatfuel/health', async () => ({
    ok: true,
    bots: Object.keys(deps.bots),
    pending: pending.size,
  }));
}
