// Instagram Messaging (Graph API v23.0) adapter. One adapter serves all hotel
// IG accounts: senderId = `${igAccountId}|${psid}`, so replies go back from the
// same account the guest wrote to (mirrors the WhatsApp multi-number design).
import type { ChannelAdapter, InboundMessage, OutboundPart } from './types';

const GRAPH_BASE = 'https://graph.facebook.com/v23.0';

export interface InstagramConfig {
  accessToken: string;
  /** property key → the hotel's Instagram professional account id. */
  igIds: Record<string, string>;
}

interface RawIgMessaging {
  sender?: { id?: unknown };
  recipient?: { id?: unknown };
  message?: { mid?: unknown; text?: unknown; is_echo?: unknown; attachments?: unknown };
  read?: unknown;
  delivery?: unknown;
}

/** Shown for attachment-only messages so the engine's canned fallback fires. */
const UNSUPPORTED_PLACEHOLDER = '[unsupported message type: instagram attachment]';

export function encodeIgSenderId(igId: string, psid: string): string {
  return `${igId}|${psid}`;
}

export function decodeIgSenderId(senderId: string): { igId: string; psid: string } {
  const sep = senderId.indexOf('|');
  if (sep === -1) return { igId: '', psid: senderId };
  return { igId: senderId.slice(0, sep), psid: senderId.slice(sep + 1) };
}

export class InstagramAdapter implements ChannelAdapter {
  readonly channel = 'instagram' as const;
  /** igAccountId → property key, to tag inbound messages with their hotel. */
  private readonly propertyByIgId: Record<string, string>;

  constructor(
    private readonly cfg: InstagramConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.propertyByIgId = Object.fromEntries(
      Object.entries(cfg.igIds).map(([property, id]) => [id, property]),
    );
  }

  /**
   * Defensive parse. Real guest messages become InboundMessages; echoes (our own
   * sent messages mirrored back), read/delivery receipts, and empty events are
   * ignored. Attachment-only messages become a placeholder so the engine replies
   * politely instead of going silent.
   */
  parseWebhook(body: unknown): InboundMessage[] {
    const out: InboundMessage[] = [];
    const entries = (body as { entry?: unknown } | null)?.entry;
    if (!Array.isArray(entries)) return out;
    for (const entry of entries) {
      const messaging = (entry as { messaging?: unknown } | null)?.messaging;
      if (!Array.isArray(messaging)) continue;
      for (const m of messaging as RawIgMessaging[]) {
        // Skip read/delivery receipts and echoes of our own outbound messages.
        if (m?.read !== undefined || m?.delivery !== undefined) continue;
        if (m?.message?.is_echo === true) continue;
        const psid = m?.sender?.id;
        if (typeof psid !== 'string') continue;
        // recipient.id = the hotel's IG account that received the DM → property.
        const igId = typeof m?.recipient?.id === 'string' ? m.recipient.id : '';
        const text = m?.message?.text;
        let content: string | undefined;
        if (typeof text === 'string' && text.trim() !== '') {
          content = text;
        } else if (Array.isArray(m?.message?.attachments) && m.message.attachments.length > 0) {
          content = UNSUPPORTED_PLACEHOLDER;
        }
        if (content === undefined) continue;
        const inbound: InboundMessage = {
          channel: 'instagram',
          senderId: encodeIgSenderId(igId, psid),
          text: content,
        };
        const property = this.propertyByIgId[igId];
        if (property) inbound.propertyHint = property;
        if (typeof m.message?.mid === 'string') inbound.inboundId = m.message.mid;
        out.push(inbound);
      }
    }
    return out;
  }

  /** Show the human-style "typing…" bubble before replying (best-effort). */
  async typing(senderId: string): Promise<void> {
    const { igId, psid } = decodeIgSenderId(senderId);
    try {
      await this.post(igId, { recipient: { id: psid }, sender_action: 'typing_on' });
    } catch {
      // Typing is cosmetic — never let it block or fail the actual reply.
    }
  }

  async send(senderId: string, parts: OutboundPart[]): Promise<void> {
    const { igId, psid } = decodeIgSenderId(senderId);
    for (const part of parts) {
      if (part.delayMs > 0) await new Promise((r) => setTimeout(r, part.delayMs));
      // Instagram caps a single message at 1000 chars; split defensively.
      for (const chunk of chunkText(part.text, 1000)) {
        await this.post(igId, { recipient: { id: psid }, message: { text: chunk } });
      }
    }
  }

  /** One POST to a specific IG account's messages endpoint. Errors carry status only. */
  private async post(igId: string, body: unknown): Promise<void> {
    const account = igId || Object.values(this.cfg.igIds)[0] || '';
    const res = await this.fetchFn(`${GRAPH_BASE}/${encodeURIComponent(account)}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Instagram send failed: HTTP ${res.status}`);
    }
  }
}

/** Split on the last space before the limit so words aren't cut mid-token. */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const sp = window.lastIndexOf(' ');
    const cut = sp > limit * 0.6 ? sp : limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
