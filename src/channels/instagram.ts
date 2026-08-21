// Instagram Direct (DM) adapter — "Instagram API with Instagram Login" (2026):
// host graph.instagram.com, Graph v26.0 (v23/v24 are sunset). One adapter serves
// all hotel IG accounts: senderId = `${igAccountId}|${igsid}`, so replies go back
// from the same account the guest wrote to (mirrors the WhatsApp multi-number design).
import { safeCut } from '../style/engine';
import type { ChannelAdapter, InboundMessage, OutboundPart } from './types';

// Instagram Login path (owner just needs a Professional IG account — no Facebook Page).
const IG_API_BASE = 'https://graph.instagram.com/v26.0';
// Instagram caps a single text DM at 1000 BYTES (not chars) — matters for RU/KK/ZH.
const IG_TEXT_MAX_BYTES = 1000;

export interface InstagramConfig {
  /** Fallback token for accounts without a per-account token (single-account / back-compat). */
  accessToken?: string;
  /** property key → the hotel's Instagram professional account id. */
  igIds: Record<string, string>;
  /**
   * property key → that account's OWN access token. "Instagram API with Instagram Login"
   * issues a SEPARATE token per account, so each hotel must send with its own; falls back
   * to accessToken when a per-account token isn't supplied.
   */
  tokens?: Record<string, string>;
  /** Override the API base (host + version). Defaults to graph.instagram.com/v26.0. */
  baseUrl?: string;
}

interface RawIgMessaging {
  sender?: { id?: unknown };
  recipient?: { id?: unknown };
  message?: { mid?: unknown; text?: unknown; is_echo?: unknown; attachments?: unknown };
  read?: unknown;
  delivery?: unknown;
}

/**
 * Attachments are NOT all the same, and collapsing them into one «I can't open that» reply was a
 * real complaint from the hotel managers: guests send story reviews and photos of problems, and
 * the bot answered every one of them with «send it as text». Each kind now reaches the model as a
 * described event so it can react like a manager would.
 */
const ATTACHMENT_PLACEHOLDER: Record<string, string> = {
  story_mention:
    '[гость упомянул отель в своей истории (сторис) — обычно это отзыв или благодарность]',
  share: '[гость переслал публикацию или историю]',
  ig_reel: '[гость прислал reels]',
  image: '[гость прислал фотографию]',
  video: '[гость прислал видео]',
  audio: '[гость прислал голосовое или аудио]',
  file: '[гость прислал файл]',
};
const STORY_REPLY_PLACEHOLDER = '[гость ответил на историю (сторис) отеля]';
const UNSUPPORTED_PLACEHOLDER = '[гость прислал вложение]';

/** Attachment kind → a human-readable event line for the model. */
function describeAttachments(raw: unknown): string {
  const list = Array.isArray(raw) ? raw : [];
  const kinds = list
    .map((a) => (a as { type?: unknown })?.type)
    .filter((t): t is string => typeof t === 'string');
  const described = kinds.map((k) => ATTACHMENT_PLACEHOLDER[k]).filter(Boolean);
  return described.length > 0 ? described[0] : UNSUPPORTED_PLACEHOLDER;
}

export function encodeIgSenderId(igId: string, psid: string): string {
  return `${igId}|${psid}`;
}

export function decodeIgSenderId(senderId: string): { igId: string; psid: string } {
  const sep = senderId.indexOf('|');
  if (sep === -1) return { igId: '', psid: senderId };
  return { igId: senderId.slice(0, sep), psid: senderId.slice(sep + 1) };
}

/** Паузы перед повторами отправки. Первый элемент — попытка без паузы. */
const SEND_DELAYS_MS = [0, 2_000, 8_000, 20_000];

export class InstagramAdapter implements ChannelAdapter {
  readonly channel = 'instagram' as const;
  /** igAccountId → property key, to tag inbound messages with their hotel. */
  private readonly propertyByIgId: Record<string, string>;
  /** igAccountId → that account's access token (per-account for Instagram Login). */
  private readonly tokenByIgId: Record<string, string>;
  /** First configured account id — the send fallback when a webhook carries no recipient id. */
  private readonly firstIgId: string;
  private readonly base: string;

  constructor(
    private readonly cfg: InstagramConfig,
    private readonly fetchFn: typeof fetch = fetch,
    /** Пауза между повторами — в тестах подменяется, чтобы не спать. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    // Each hotel's igId may hold MULTIPLE comma-separated ids (the Instagram Login `id` AND the
    // Business `user_id`), because a webhook's recipient.id can arrive as either — mapping both
    // guarantees the DM routes to the right hotel and replies with that hotel's token.
    const pairs = Object.entries(cfg.igIds).flatMap(([property, raw]) =>
      String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((id) => ({ id, property })),
    );
    this.propertyByIgId = Object.fromEntries(pairs.map((p) => [p.id, p.property]));
    this.tokenByIgId = Object.fromEntries(
      pairs.map((p) => [p.id, cfg.tokens?.[p.property] ?? cfg.accessToken ?? '']),
    );
    this.firstIgId = pairs[0]?.id ?? '';
    this.base = cfg.baseUrl ?? IG_API_BASE;
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
        if (m?.message?.is_echo === true) continue; // разбираются отдельно, см. parseEchoes
        const psid = m?.sender?.id;
        if (typeof psid !== 'string') continue;
        // recipient.id = the hotel's IG account that received the DM → property.
        const igId = typeof m?.recipient?.id === 'string' ? m.recipient.id : '';
        const text = m?.message?.text;
        let content: string | undefined;
        if (typeof text === 'string' && text.trim() !== '') {
          content = text;
        } else if (Array.isArray(m?.message?.attachments) && m.message.attachments.length > 0) {
          content = describeAttachments(m.message.attachments);
        }
        // A reply to OUR story carries text plus story context — tell the model, so it answers
        // about that story instead of asking the guest what they mean.
        const replyToStory = (m?.message as { reply_to?: { story?: unknown } } | undefined)?.reply_to
          ?.story;
        if (replyToStory !== undefined && content !== undefined) {
          content = `${STORY_REPLY_PLACEHOLDER} ${content}`.trim();
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

  /**
   * Эхо исходящих сообщений аккаунта.
   *
   * Instagram помечает как is_echo и наши собственные отправки, и ответ живого менеджера,
   * написанный из приложения Instagram. Различить их можно только по тексту — поэтому
   * возвращаем всё, а решает вызывающий, сверив с последней репликой бота. Без этого
   * менеджер отвечает гостю, а бот продолжает говорить поверх него: два голоса в одном чате.
   */
  parseEchoes(body: unknown): Array<{ igId: string; psid: string; text: string }> {
    const out: Array<{ igId: string; psid: string; text: string }> = [];
    const entries = (body as { entry?: unknown[] })?.entry;
    if (!Array.isArray(entries)) return out;
    for (const entry of entries as Array<{ id?: unknown; messaging?: unknown }>) {
      const messaging = entry?.messaging;
      if (!Array.isArray(messaging)) continue;
      for (const m of messaging as RawIgMessaging[]) {
        if (m?.message?.is_echo !== true) continue;
        const text = m?.message?.text;
        // Получатель эха — гость: сообщение ушло ОТ аккаунта отеля К нему.
        const psid = m?.recipient?.id;
        const igId = m?.sender?.id ?? entry?.id;
        if (typeof text !== 'string' || !text.trim()) continue;
        if (typeof psid !== 'string' || typeof igId !== 'string') continue;
        out.push({ igId, psid, text });
      }
    }
    return out;
  }

  async send(senderId: string, parts: OutboundPart[]): Promise<void> {
    const { igId, psid } = decodeIgSenderId(senderId);
    for (const part of parts) {
      if (part.delayMs > 0) await new Promise((r) => setTimeout(r, part.delayMs));
      // Instagram caps a single text DM at 1000 BYTES — split byte-aware so a
      // Cyrillic/Chinese reply (2-3 bytes/char) isn't rejected mid-message.
      for (const chunk of chunkTextByBytes(part.text, IG_TEXT_MAX_BYTES)) {
        await this.post(igId, { recipient: { id: psid }, message: { text: chunk } });
      }
    }
  }

  /**
   * Meta периодически отвечает «API access blocked» — временной блокировкой на всплеск
   * запросов, которая снимается сама. Такой отказ НЕ значит, что сообщение доставлено,
   * поэтому повтор безопасен и обязателен: без него ответ гостю теряется навсегда, а он
   * остаётся сидеть перед молчащим чатом. Именно так мы уже потеряли два ответа подряд.
   */
  private static transient(status: number, body: string): boolean {
    if (status === 429 || status >= 500) return true;
    return status === 400 && /API access blocked|rate limit|too many/i.test(body);
  }

  /** One POST to a specific IG account's messages endpoint. Retries a transient refusal. */
  private async post(igId: string, body: unknown): Promise<void> {
    const account = igId || this.firstIgId;
    const token = this.tokenByIgId[account] ?? this.cfg.accessToken ?? '';
    let last = '';
    for (let attempt = 0; attempt < SEND_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await this.sleep(SEND_DELAYS_MS[attempt]);
      const res = await this.fetchFn(`${this.base}/${encodeURIComponent(account)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return;
      // Текст Meta обязан дойти до журнала: «HTTP 400» одинаково выглядит и когда истекло
      // 24-часовое окно переписки, и когда токен протух, и когда ссылку сочли подозрительной.
      // Без него причину недоставленного подтверждения брони пришлось бы угадывать.
      const detail = await res.text().catch(() => '');
      const meta = /"message"\s*:\s*"([^"]+)"/.exec(detail)?.[1];
      last = `HTTP ${res.status}${meta ? ` — ${meta}` : ''}`;
      if (!InstagramAdapter.transient(res.status, detail)) break;
    }
    throw new Error(`Instagram send failed: ${last}`);
  }
}

const UTF8 = new TextEncoder();
const byteLen = (s: string): number => UTF8.encode(s).length;

/**
 * Split so each chunk's UTF-8 byte length ≤ maxBytes (Instagram's text-DM cap),
 * preferring the last space before the limit so words aren't cut mid-token.
 * Byte-aware because RU/KK (2 bytes) and ZH (3 bytes) chars would overflow a
 * naive char count and get the whole send rejected by Meta.
 */
function chunkTextByBytes(text: string, maxBytes: number): string[] {
  if (byteLen(text) <= maxBytes) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (byteLen(rest) > maxBytes) {
    // Largest char-prefix that still fits in maxBytes (binary search on length).
    let lo = 1;
    let hi = rest.length;
    let fit = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (byteLen(rest.slice(0, mid)) <= maxBytes) {
        fit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const window = rest.slice(0, fit);
    const sp = window.lastIndexOf(' ');
    // Ссылку рвать нельзя: половина адреса в одном сообщении — это потерянная бронь.
    const cut = safeCut(rest, sp > fit * 0.6 ? sp : fit);
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
