import { describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_SERVICE_WINDOW_MS,
  isWithinServiceWindow,
  WhatsAppAdapter,
} from '../src/channels/whatsapp';

const NOW = new Date('2026-08-14T12:00:00Z');

describe('24-часовое окно WhatsApp', () => {
  it('окно = ровно 24 часа', () => {
    expect(CUSTOMER_SERVICE_WINDOW_MS).toBe(86_400_000);
  });

  it('гость писал час назад — свободный текст можно, бот может написать первым', () => {
    expect(isWithinServiceWindow('2026-08-14T11:00:00Z', NOW)).toBe(true);
  });

  it('гость писал 23 часа 59 минут назад — ещё можно', () => {
    expect(isWithinServiceWindow('2026-08-13T12:01:00Z', NOW)).toBe(true);
  });

  it('гость писал 25 часов назад — окно закрыто, нужен шаблон', () => {
    expect(isWithinServiceWindow('2026-08-13T11:00:00Z', NOW)).toBe(false);
  });

  it('гость не писал никогда — окна нет (старая переписка не помогает)', () => {
    expect(isWithinServiceWindow(null, NOW)).toBe(false);
    expect(isWithinServiceWindow(undefined, NOW)).toBe(false);
    expect(isWithinServiceWindow('мусор', NOW)).toBe(false);
  });
});

describe('WhatsAppAdapter.sendTemplate', () => {
  it('шлёт корректный payload шаблона с параметрами', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const a = new WhatsAppAdapter(
      { accessToken: 'k', phoneNumberIds: { almaty: '111' }, provider: 'd360' },
      fetchFn as unknown as typeof fetch,
    );

    await a.sendTemplate('111|77010000001', 'booking_followup_ru', 'ru', ['Айгуль']);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body.type).toBe('template');
    expect(body.to).toBe('77010000001');
    expect(body.template.name).toBe('booking_followup_ru');
    expect(body.template.language.code).toBe('ru');
    expect(body.template.components[0].parameters[0].text).toBe('Айгуль');
  });

  it('шаблон без параметров идёт без components', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const a = new WhatsAppAdapter(
      { accessToken: 'k', phoneNumberIds: { almaty: '111' }, provider: 'd360' },
      fetchFn as unknown as typeof fetch,
    );

    await a.sendTemplate('111|77010000001', 'hello_ru', 'ru');

    const body = JSON.parse((fetchFn.mock.calls[0][1] as { body: string }).body);
    expect(body.template.components).toBeUndefined();
  });
});
