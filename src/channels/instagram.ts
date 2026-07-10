// Instagram Messaging (Graph API v23.0) skeleton adapter. Fully constructed,
// but only wired into the webhook route once INSTAGRAM_* creds exist.
import type { ChannelAdapter, InboundMessage, OutboundPart } from './types';

const GRAPH_BASE = 'https://graph.facebook.com/v23.0';

export interface InstagramConfig {
  accessToken: string;
  /** The hotel's Instagram professional account id. */
  igId: string;
}

interface RawIgMessaging {
  sender?: { id?: unknown };
  message?: { mid?: unknown; text?: unknown };
}

export class InstagramAdapter implements ChannelAdapter {
  readonly channel = 'instagram' as const;

  constructor(
    private readonly cfg: InstagramConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Defensive parse: only text messages with a sender id become InboundMessages. */
  parseWebhook(body: unknown): InboundMessage[] {
    const out: InboundMessage[] = [];
    const entries = (body as { entry?: unknown } | null)?.entry;
    if (!Array.isArray(entries)) return out;
    for (const entry of entries) {
      const messaging = (entry as { messaging?: unknown } | null)?.messaging;
      if (!Array.isArray(messaging)) continue;
      for (const m of messaging as RawIgMessaging[]) {
        const senderId = m?.sender?.id;
        const text = m?.message?.text;
        if (typeof senderId !== 'string' || typeof text !== 'string') continue;
        const inbound: InboundMessage = { channel: 'instagram', senderId, text };
        if (typeof m.message?.mid === 'string') inbound.inboundId = m.message.mid;
        out.push(inbound);
      }
    }
    return out;
  }

  async send(senderId: string, parts: OutboundPart[]): Promise<void> {
    for (const part of parts) {
      if (part.delayMs > 0) await new Promise((r) => setTimeout(r, part.delayMs));
      const res = await this.fetchFn(
        `${GRAPH_BASE}/${encodeURIComponent(this.cfg.igId)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.cfg.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ recipient: { id: senderId }, message: { text: part.text } }),
        },
      );
      if (!res.ok) {
        // Status only — never the token, never the guest id.
        throw new Error(`Instagram send failed: HTTP ${res.status}`);
      }
    }
  }
}
