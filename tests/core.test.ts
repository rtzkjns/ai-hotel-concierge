import { describe, it, expect, vi, afterEach } from 'vitest';
import { maskPII } from '../src/core/pii';
import { RateLimiter, isSpam } from '../src/core/rateLimit';
import { startRetention } from '../src/core/retention';
import { track, metricsSummary } from '../src/core/events';
import { detectLanguage } from '../src/core/language';
import { Store } from '../src/store';

describe('maskPII', () => {
  it('masks a formatted phone keeping first 2 and last 2 digits', () => {
    expect(maskPII('+7 776 412 63 53')).toBe('+7 7•• ••• •• 53');
  });

  it('masks a phone inside a sentence', () => {
    expect(maskPII('позвоните на +7 776 412 63 53 завтра')).toBe(
      'позвоните на +7 7•• ••• •• 53 завтра',
    );
  });

  it('masks a bare 12-digit IIN completely', () => {
    expect(maskPII('ИИН 990101300123')).toBe('ИИН ••••');
  });

  it('masks a bare 11-digit run completely', () => {
    expect(maskPII('87767412653')).toBe('••••');
  });

  it('masks emails keeping first char and domain', () => {
    expect(maskPII('пишите на aibek@example.com')).toBe('пишите на a***@example.com');
  });

  it('does not mangle dates', () => {
    expect(maskPII('заезд 2026-08-10, выезд 2026-08-12')).toBe(
      'заезд 2026-08-10, выезд 2026-08-12',
    );
  });

  it('does not mangle prices and short digit runs', () => {
    expect(maskPII('итого 147050 KZT за 2 ночи')).toBe('итого 147050 KZT за 2 ночи');
  });

  it('does not mangle booking numbers with letters', () => {
    expect(maskPII('бронь EX-10250042')).toBe('бронь EX-10250042');
  });
});

describe('RateLimiter', () => {
  it('allows up to maxPerMinute and blocks the next call', () => {
    let t = 0;
    const limiter = new RateLimiter(20, () => t);
    for (let i = 0; i < 20; i++) {
      expect(limiter.allow('guest')).toBe(true);
    }
    expect(limiter.allow('guest')).toBe(false);
    // Other keys are independent.
    expect(limiter.allow('other')).toBe(true);
  });

  it('slides the window: old hits expire after a minute', () => {
    let t = 0;
    const limiter = new RateLimiter(2, () => t);
    expect(limiter.allow('k')).toBe(true);
    t = 30_000;
    expect(limiter.allow('k')).toBe(true);
    t = 40_000;
    expect(limiter.allow('k')).toBe(false);
    t = 61_000; // first hit (t=0) is now outside the window
    expect(limiter.allow('k')).toBe(true);
  });
});

describe('isSpam', () => {
  it('flags oversized messages', () => {
    expect(isSpam([], 'x'.repeat(4001))).toBe(true);
    expect(isSpam([], 'x'.repeat(4000))).toBe(false);
  });

  it('flags a message repeated in the last 3 user texts', () => {
    expect(isSpam(['hi', 'ping', 'ping', 'ping'], 'ping')).toBe(true);
    expect(isSpam(['ping', 'ping'], 'ping')).toBe(false); // only 2 previous repeats
    expect(isSpam(['ping', 'pong', 'ping'], 'ping')).toBe(false);
  });
});

describe('startRetention', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('purges immediately, then every 24h, until stopped', () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const job = startRetention({ purgeOlderThan: (d) => calls.push(d) }, 30);
    expect(calls).toEqual([30]);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(calls).toEqual([30, 30]);
    job.stop();
    vi.advanceTimersByTime(48 * 60 * 60 * 1000);
    expect(calls).toEqual([30, 30]);
  });

  it('defaults to 90 days', () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const job = startRetention({ purgeOlderThan: (d) => calls.push(d) });
    expect(calls).toEqual([90]);
    job.stop();
  });
});

describe('events', () => {
  it('track records an event through the store', () => {
    const store = new Store(':memory:');
    track(store, 'message_in', { conversationId: 'telegram:1', channel: 'telegram' });
    const [event] = store.listEvents(new Date(Date.now() - 60_000).toISOString());
    expect(event.type).toBe('message_in');
    expect(event.conversationId).toBe('telegram:1');
  });

  it('metricsSummary aggregates today\'s events', () => {
    const store = new Store(':memory:');
    track(store, 'message_in', { conversationId: 'telegram:1', payload: { language: 'ru' } });
    track(store, 'message_in', { conversationId: 'telegram:1', payload: { language: 'ru' } });
    track(store, 'message_in', { conversationId: 'whatsapp:2', payload: { language: 'kk' } });
    track(store, 'booking_created', { conversationId: 'whatsapp:2' });
    track(store, 'escalation', { conversationId: 'telegram:1' });
    track(store, 'upsell_offered', {});
    track(store, 'upsell_offered', {});
    track(store, 'upsell_accepted', {});
    for (const ms of [100, 200, 300, 400, 1000]) {
      track(store, 'reply_timing', { payload: { ms } });
    }

    const summary = metricsSummary(store);
    expect(summary.messagesToday).toBe(3);
    expect(summary.dialogsToday).toBe(2);
    expect(summary.bookingsToday).toBe(1);
    expect(summary.escalationsToday).toBe(1);
    expect(summary.byLanguage).toEqual({ ru: 2, kk: 1 });
    expect(summary.upsellOffered).toBe(2);
    expect(summary.upsellAccepted).toBe(1);
    expect(summary.p50ReplyMs).toBe(300);
    expect(summary.p95ReplyMs).toBe(1000);
  });

  it('metricsSummary is all zeros with no events', () => {
    const store = new Store(':memory:');
    const summary = metricsSummary(store);
    expect(summary.messagesToday).toBe(0);
    expect(summary.dialogsToday).toBe(0);
    expect(summary.byLanguage).toEqual({});
    expect(summary.p50ReplyMs).toBe(0);
    expect(summary.p95ReplyMs).toBe(0);
  });
});

describe('detectLanguage', () => {
  it('detects Kazakh by specific letters', () => {
    expect(detectLanguage('сәлем')).toBe('kk');
  });

  it('Kazakh letters win over Cyrillic in mixed text', () => {
    expect(detectLanguage('Сәлеметсіз бе! Здравствуйте')).toBe('kk');
  });

  it('detects Russian', () => {
    expect(detectLanguage('привет')).toBe('ru');
  });

  it('detects English', () => {
    expect(detectLanguage('hello')).toBe('en');
  });

  it('detects Chinese even for two characters', () => {
    expect(detectLanguage('你好')).toBe('zh');
  });

  it('returns null for too-short or ambiguous input', () => {
    expect(detectLanguage('ок')).toBe(null);
    expect(detectLanguage('123 !!')).toBe(null);
    expect(detectLanguage('')).toBe(null);
  });
});
