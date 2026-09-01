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
  /**
   * Backoff (ms) between retries when the gateway returns a TRANSIENT error (5xx / 429). 360dialog
   * throws intermittent HTTP 500s and Meta rate-limits; without a retry these surface as false
   * "ответ гостю НЕ доставлен" alarms in the staff chat when the message would send a moment later.
   * Defaults to [400, 1200, 3000]. Tests pass [] to disable sleeping.
   */
  sendRetryDelaysMs?: number[];
}

/** One inbound guest message plus the number it arrived on (→ hotel). */
export interface ParsedWhatsAppInbound {
  inbound: InboundMessage;
  phoneNumberId: string;
  /** Present for voice messages: the caller downloads the media and fills inbound.audio. */
  audioMediaId?: string;
  audioMime?: string;
}

/**
 * Coexistence only: a message the hotel STAFF sent to a guest from the WhatsApp
 * Business app, mirrored back to us by Meta (value.message_echoes). Recorded for the
 * staff-console transcript — it is NOT a guest message and never reaches the engine.
 */
export interface WhatsAppEcho {
  phoneNumberId: string;
  /** The guest this staff message was sent to (wa_id). */
  guestWaId: string;
  text?: string;
  echoId?: string;
}

/** A Coexistence/account lifecycle event (field=account_update), e.g. PARTNER_REMOVED. */
export interface WhatsAppAccountUpdate {
  phoneNumberId?: string;
  event: string;
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
/** Что именно не сошлось — для журнала. Хэши, не секреты: их можно писать в лог. */
export function signatureDebug(
  rawBody: string,
  header: string | undefined,
  appSecret: string,
): string {
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const given = header?.startsWith('sha256=') ? header.slice('sha256='.length) : '(нет заголовка)';
  return `тело ${rawBody.length} байт, ждали ${expected.slice(0, 12)}…, пришло ${given.slice(0, 12)}…`;
}

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

/**
 * WhatsApp's customer-service window: 24 hours from the guest's LAST inbound message. Inside it
 * the bot may send any free-form text (including writing first); outside it Meta rejects free-form
 * and only an approved template may be sent. The window is not about whether a conversation
 * exists — an old chat is just as closed as a brand-new number.
 */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** True when free-form text is still allowed for this guest. */
export function isWithinServiceWindow(
  lastInboundAt: string | number | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastInboundAt) return false;
  const last = new Date(lastInboundAt).getTime();
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < CUSTOMER_SERVICE_WINDOW_MS;
}

const META_MEDIA_DOMAINS = ['facebook.com', 'fbcdn.net', 'fbsbx.com', 'whatsapp.net'];
const D360_MEDIA_DOMAINS = ['360dialog.io', '360dialog.com'];

/**
 * The API credential is only ever sent to hosts owned by the CURRENT provider: Meta's CDN on the
 * Cloud API path, 360dialog's gateway on the d360 path. A media URL outside them is refused.
 */
export function isAllowedMediaHost(url: string, isD360: boolean): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname;
    const allowed = isD360 ? [...D360_MEDIA_DOMAINS, ...META_MEDIA_DOMAINS] : META_MEDIA_DOMAINS;
    return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
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

  /**
   * Send an APPROVED template. This is the only thing WhatsApp allows outside the 24-hour
   * customer-service window: free-form text is rejected by Meta once the window has closed, no
   * matter how long the conversation has existed. Templates re-open the window, after which
   * `send()` works normally again.
   */
  async sendTemplate(
    senderId: string,
    templateName: string,
    languageCode: string,
    bodyParams: string[] = [],
  ): Promise<void> {
    const { phoneNumberId, waId } = decodeSenderId(senderId);
    const components =
      bodyParams.length > 0
        ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
        : undefined;
    await this.post(phoneNumberId, {
      messaging_product: 'whatsapp',
      to: waId,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {}),
      },
    });
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

  /** Yields each webhook change `value` object defensively (shared by the parsers below). */
  private *iterChangeValues(body: unknown): Generator<Record<string, unknown>> {
    const entries = (body as { entry?: unknown } | null)?.entry;
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const changes = (entry as { changes?: unknown } | null)?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const value = (change as { value?: unknown } | null)?.value;
        if (value && typeof value === 'object') yield value as Record<string, unknown>;
      }
    }
  }

  /**
   * Coexistence: staff→guest messages sent from the WhatsApp Business app, mirrored
   * to us as echoes (value.message_echoes / value.smb_message_echoes). Defensive —
   * anything malformed yields nothing.
   */
  parseSmbEchoes(body: unknown): WhatsAppEcho[] {
    const out: WhatsAppEcho[] = [];
    for (const value of this.iterChangeValues(body)) {
      const echoes = value.message_echoes ?? value.smb_message_echoes;
      const phoneNumberId = (value.metadata as { phone_number_id?: unknown } | undefined)?.phone_number_id;
      if (!Array.isArray(echoes) || typeof phoneNumberId !== 'string') continue;
      for (const raw of echoes as Array<RawWaMessage & { to?: unknown }>) {
        if (typeof raw.to !== 'string') continue;
        out.push({
          phoneNumberId,
          guestWaId: raw.to,
          text: typeof raw.text?.body === 'string' ? raw.text.body : undefined,
          echoId: typeof raw.id === 'string' ? raw.id : undefined,
        });
      }
    }
    return out;
  }

  /** Coexistence/account lifecycle events (field=account_update), e.g. PARTNER_REMOVED. */
  parseAccountUpdates(body: unknown): WhatsAppAccountUpdate[] {
    const out: WhatsAppAccountUpdate[] = [];
    for (const value of this.iterChangeValues(body)) {
      if (typeof value.event !== 'string') continue;
      const phoneNumberId = (value.metadata as { phone_number_id?: unknown } | undefined)?.phone_number_id;
      out.push({
        event: value.event,
        phoneNumberId: typeof phoneNumberId === 'string' ? phoneNumberId : undefined,
      });
    }
    return out;
  }

  /**
   * Two-step media download: GET metadata → GET binary.
   *
   * The provider matters: on 360dialog the number lives behind THEIR gateway and the Bearer token
   * is meaningless — media must be fetched from waba-v2.360dialog.io with the D360-API-KEY header.
   * Hardcoding Meta's host made every voice note silently unreadable on the d360 path.
   */
  async downloadMedia(mediaId: string): Promise<Buffer | null> {
    const isD360 = this.cfg.provider === 'd360';
    const base = this.cfg.baseUrl ?? (isD360 ? D360_BASE : GRAPH_BASE);
    const authHeaders: Record<string, string> = isD360
      ? { 'D360-API-KEY': this.cfg.accessToken }
      : { Authorization: `Bearer ${this.cfg.accessToken}` };
    try {
      const metaRes = await this.fetchFn(`${base}/${encodeURIComponent(mediaId)}`, {
        headers: authHeaders,
      });
      if (!metaRes.ok) {
        console.warn(`WhatsApp media metadata failed: HTTP ${metaRes.status}`);
        return null;
      }
      const meta = (await metaRes.json()) as { url?: unknown };
      if (typeof meta.url !== 'string') return null;
      // Defense-in-depth: the credential goes only to the provider's own hosts, even though the
      // url comes from that provider's API response.
      if (!isAllowedMediaHost(meta.url, isD360)) {
        console.warn('WhatsApp media URL points outside the provider domains — refusing to download');
        return null;
      }
      const binRes = await this.fetchFn(meta.url, {
        headers: authHeaders,
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

    // Transient 5xx/429 (360dialog HTTP 500 spikes, Meta rate limits) are the #1 cause of false
    // "ответ гостю НЕ доставлен" alarms — the message delivers on a retry a moment later. Retry a
    // few times with backoff; a 4xx (bad payload / expired token) is real and never retried.
    const delays = this.cfg.sendRetryDelaysMs ?? [400, 1200, 3000];
    let lastStatus = 0;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (res.ok) return;
      lastStatus = res.status;
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt >= delays.length) break;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    // Status only — never the token, never the guest's number.
    throw new Error(`WhatsApp send failed: HTTP ${lastStatus}`);
  }
}
