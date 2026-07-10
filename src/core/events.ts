import type { StoredEvent } from '../types';

export interface EventData {
  conversationId?: string;
  property?: string;
  channel?: string;
  payload?: unknown;
}

interface EventSink {
  recordEvent(type: string, data?: EventData): void;
}

interface EventSource {
  listEvents(sinceIso: string): StoredEvent[];
}

/** Thin analytics wrapper so call sites read as track(store, 'booking_created', ...). */
export function track(store: EventSink, type: string, data?: EventData): void {
  store.recordEvent(type, data ?? {});
}

export interface MetricsSummary {
  dialogsToday: number;
  messagesToday: number;
  bookingsToday: number;
  escalationsToday: number;
  byLanguage: Record<string, number>;
  upsellOffered: number;
  upsellAccepted: number;
  p50ReplyMs: number;
  p95ReplyMs: number;
}

export function metricsSummary(store: EventSource, now = new Date()): MetricsSummary {
  const startOfDayIso = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const events = store.listEvents(startOfDayIso);

  const dialogs = new Set<string>();
  const byLanguage: Record<string, number> = {};
  const replyTimings: number[] = [];
  let messagesToday = 0;
  let bookingsToday = 0;
  let escalationsToday = 0;
  let upsellOffered = 0;
  let upsellAccepted = 0;

  for (const event of events) {
    switch (event.type) {
      case 'message_in': {
        messagesToday++;
        if (event.conversationId) dialogs.add(event.conversationId);
        const language = (event.payload as { language?: string } | undefined)?.language;
        if (language) byLanguage[language] = (byLanguage[language] ?? 0) + 1;
        break;
      }
      case 'booking_created':
        bookingsToday++;
        break;
      case 'escalation':
        escalationsToday++;
        break;
      case 'upsell_offered':
        upsellOffered++;
        break;
      case 'upsell_accepted':
        upsellAccepted++;
        break;
      case 'reply_timing': {
        const ms = (event.payload as { ms?: number } | undefined)?.ms;
        if (typeof ms === 'number') replyTimings.push(ms);
        break;
      }
    }
  }

  replyTimings.sort((a, b) => a - b);
  return {
    dialogsToday: dialogs.size,
    messagesToday,
    bookingsToday,
    escalationsToday,
    byLanguage,
    upsellOffered,
    upsellAccepted,
    p50ReplyMs: percentile(replyTimings, 0.5),
    p95ReplyMs: percentile(replyTimings, 0.95),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
