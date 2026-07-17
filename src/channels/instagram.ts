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
  message?: { mid?: unknown; text?: unknown; is_echo?: unknown; attachments?: unknown };
  read?: unknown;
  delivery?: unknown;
}

/** Shown for attachment-only messages so the engine's canned fallback fires. */
const UNSUPPORTED_PLACEHOLDER = '[unsupported message type: instagram attachment]';

export class InstagramAdapter implements ChannelAdapter {
  readonly channel = 'instagram' as const;

  constructor(
    private readonly cfg: InstagramConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

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
        const senderId = m?.sender?.id;
        if (typeof senderId !== 'string') continue;
        const text = m?.message?.text;
        let content: string | undefined;
        if (typeof text === 'string' && text.trim() !== '') {
          content = text;
        } else if (Array.isArray(m?.message?.attachments) && m.message.attachments.length > 0) {
          content = UNSUPPORTED_PLACEHOLDER;
        }
        if (content === undefined) continue;
        const inbound: InboundMessage = { channel: 'instagram', senderId, text: content };
        if (typeof m.message?.mid === 'string') inbound.inboundId = m.message.mid;
        out.push(inbound);
      }
    }
    return out;
  }

  /** Show the human-style "typing…" bubble before replying (best-effort). */
  async typing(senderId: string): Promise<void> {
    try {
      await this.post({ recipient: { id: senderId }, sender_action: 'typing_on' });
    } catch {
      // Typing is cosmetic — never let it block or fail the actual reply.
    }
  }

  async send(senderId: string, parts: OutboundPart[]): Promise<void> {
    for (const part of parts) {
      if (part.delayMs > 0) await new Promise((r) => setTimeout(r, part.delayMs));
      // Instagram caps a single message at 1000 chars; split defensively.
      for (const chunk of chunkText(part.text, 1000)) {
        await this.post({ recipient: { id: senderId }, message: { text: chunk } });
      }
    }
  }

  /** One POST to the IG messages endpoint. Errors carry status only — no token, no guest id. */
  private async post(body: unknown): Promise<void> {
    const res = await this.fetchFn(`${GRAPH_BASE}/${encodeURIComponent(this.cfg.igId)}/messages`, {
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
