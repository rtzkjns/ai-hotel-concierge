// WhatsApp Business Platform (Cloud API, Graph v23.0) adapter.
// One adapter serves all hotel numbers: senderId = `${phone_number_id}|${wa_id}`.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelAdapter, InboundMessage, OutboundPart } from './types';

const GRAPH_BASE = 'https://graph.facebook.com/v23.0';
const D360_BASE = 'https://waba-v2.360dialog.io';

/**
 * Provider behind the WhatsApp Cloud API:
 * - 'meta'    → direct Meta Cloud API: POST {base}/{phone_number_id}/messages, Bearer token.
 * - 'd360'    → 360dialog (used for zero-downtime Coexistence onboarding of an in-use number,
 *               since 360dialog is a Tech Provider so we skip App Review; the bot stays
 *               self-hosted — our own webhook). POST {base}/messages, D360-API-KEY header,
 *               number implicit per key. Payloads are Cloud-API-compatible.
 */
export type WhatsAppProvider = 'meta' | 'd360';

export interface WhatsAppAdapterConfig {
  /** Meta: system-user/Bearer token. 360dialog: the D360-API-KEY. */
  accessToken: string;
  /** property key → WhatsApp phone_number_id (Meta). For 360dialog the id is implicit per key. */
  phoneNumberIds: Record<string, string>;
  /** Defaults to 'meta'. Set to 'd360' for a 360dialog-hosted number (Coexistence). */
  provider?: WhatsAppProvider;
  /** Override the API base URL (else derived from provider). */
  baseUrl?: string;
}

/** One inbound guest message plus the number it arrived on (→ hotel). */
export interface ParsedWhatsAppInbound {
  inbound: InboundMessage;
  phoneNumberId: string;
  /** Present for voice messages: the caller downloads the media and fills inbound.audio. */
  audioMediaId?: string;
  audioMime?: string;
}

export function encodeSenderId(phoneNumberId: string, waId: string): string {
  return `${phoneNumberId}|${waId}`;
}

export function decodeSenderId(senderId: string): { phoneNumberId: string; waId: string } {
  const sep = senderId.indexOf('|');
  if (sep === -1) return { phoneNumberId: '', waId: senderId };
  return { phoneNumberId: senderId.slice(0, sep), waId: senderId.slice(sep + 1) };
}

/**
 * Verify Meta's X-Hub-Signature-256 header: 'sha256=' + HMAC-SHA256(appSecret, rawBody).
 * Constant-time comparison; anything malformed is simply invalid.
 */
export function verifySignature(
  rawBody: string,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  if (given.length !== expected.length || given.length === 0) return false;
  return timingSafeEqual(expected, given);
}

/** The Bearer token is only ever sent to Meta-owned media hosts. */
function isMetaHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      new URL(url).protocol === 'https:' &&
      ['facebook.com', 'fbcdn.net', 'fbsbx.com', 'whatsapp.net'].some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}

// Raw webhook shapes (only the fields we read; everything is optional on purpose).
interface RawWaMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: unknown };
  audio?: { id?: unknown; mime_type?: unknown };
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;

  constructor(
    private readonly cfg: WhatsAppAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(senderId: string, parts: OutboundPart[]): Promise<void> {
    const { phoneNumberId, waId } = decodeSenderId(senderId);
    for (const part of parts) {
      if (part.delayMs > 0) await new Promise((r) => setTimeout(r, part.delayMs));
      await this.post(phoneNumberId, {
        messaging_product: 'whatsapp',
        to: waId,
        type: 'text',
        text: { body: part.text },
      });
    }
  }

  /** Mark the inbound message read and show a typing indicator while the reply cooks. */
  async typing(senderId: string, inboundId?: string): Promise<void> {
    if (!inboundId) return;
    const { phoneNumberId } = decodeSenderId(senderId);
    await this.post(phoneNumberId, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: inboundId,
      typing_indicator: { type: 'text' },
    });
  }

  /**
   * Defensive parse of an inbound webhook body. Status events (delivered/read)
   * and anything malformed yield no messages — never throws.
   */
  parseWebhook(body: unknown): ParsedWhatsAppInbound[] {
    const out: ParsedWhatsAppInbound[] = [];
    const entries = (body as { entry?: unknown } | null)?.entry;
    if (!Array.isArray(entries)) return out;
    for (const entry of entries) {
      const changes = (entry as { changes?: unknown } | null)?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const value = (change as { value?: unknown } | null)?.value as
          | { metadata?: { phone_number_id?: unknown }; messages?: unknown }
          | null
          | undefined;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (typeof phoneNumberId !== 'string' || !Array.isArray(value?.messages)) continue;
        for (const raw of value.messages as RawWaMessage[]) {
          const parsed = this.parseMessage(raw, phoneNumberId);
          if (parsed) out.push(parsed);
        }
      }
    }
    return out;
  }

  private parseMessage(m: RawWaMessage, phoneNumberId: string): ParsedWhatsAppInbound | null {
    if (typeof m?.from !== 'string' || typeof m?.id !== 'string') return null;
    const base: InboundMessage = {
      channel: 'whatsapp',
      senderId: encodeSenderId(phoneNumberId, m.from),
      inboundId: m.id,
    };
    if (m.type === 'text' && typeof m.text?.body === 'string') {
      return { inbound: { ...base, text: m.text.body }, phoneNumberId };
    }
    if (m.type === 'audio' && typeof m.audio?.id === 'string') {
      return {
        inbound: base,
        phoneNumberId,
        audioMediaId: m.audio.id,
        audioMime: typeof m.audio.mime_type === 'string' ? m.audio.mime_type : 'audio/ogg',
      };
    }
    // Images, documents, stickers, ... — let the bot answer politely instead of ignoring.
    return {
      inbound: { ...base, text: `[unsupported message type: ${m.type ?? 'unknown'}]` },
      phoneNumberId,
    };
  }

  /** Two-step media download: GET metadata → GET binary, both with the Bearer token. */
  async downloadMedia(mediaId: string): Promise<Buffer | null> {
    try {
      const metaRes = await this.fetchFn(`${GRAPH_BASE}/${encodeURIComponent(mediaId)}`, {
        headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
      });
      if (!metaRes.ok) {
        console.warn(`WhatsApp media metadata failed: HTTP ${metaRes.status}`);
        return null;
      }
      const meta = (await metaRes.json()) as { url?: unknown };
      if (typeof meta.url !== 'string') return null;
      // Defense-in-depth: the Bearer token goes only to Meta-owned hosts, even
      // though meta.url comes from Meta's own API response.
      if (!isMetaHost(meta.url)) {
        console.warn('WhatsApp media URL points outside Meta domains — refusing to download');
        return null;
      }
      const binRes = await this.fetchFn(meta.url, {
        headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
        redirect: 'error',
      });
      if (!binRes.ok) {
        console.warn(`WhatsApp media download failed: HTTP ${binRes.status}`);
        return null;
      }
      return Buffer.from(await binRes.arrayBuffer());
    } catch (err) {
      console.warn(
        `WhatsApp media download failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      return null;
    }
  }

  private async post(phoneNumberId: string, body: unknown): Promise<void> {
    const isD360 = this.cfg.provider === 'd360';
    const base = this.cfg.baseUrl ?? (isD360 ? D360_BASE : GRAPH_BASE);
    // 360dialog scopes the number to the API key → path is just /messages; Meta needs the id.
    const url = isD360
      ? `${base}/messages`
      : `${base}/${encodeURIComponent(phoneNumberId)}/messages`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isD360) headers['D360-API-KEY'] = this.cfg.accessToken;
    else headers.Authorization = `Bearer ${this.cfg.accessToken}`;

    const res = await this.fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      // Status only — never the token, never the guest's number.
      throw new Error(`WhatsApp send failed: HTTP ${res.status}`);
    }
  }
}
