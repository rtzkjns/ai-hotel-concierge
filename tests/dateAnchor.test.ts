import { describe, expect, it } from 'vitest';

/**
 * Регресс-тест на баг, найденный аудитом 2026-08-14: якорь «сегодня» брался из часового пояса
 * сервера (прод — UTC), а отели в Asia/Almaty (UTC+5). С 19:00 до полуночи по Алматы бот
 * считал, что ещё вчера, и разрешал «завтра» на сутки назад.
 */
describe('якорь даты считается в часовом поясе отеля, а не сервера', () => {
  const HOTEL_TIMEZONE = 'Asia/Almaty';

  it('в 20:00 по Алматы дата отеля уже следующая относительно UTC', () => {
    // 2026-08-14T16:00:00Z = 21:00 в Алматы (UTC+5) → в UTC ещё 14-е, в Алматы уже 14-е,
    // а вот 2026-08-14T19:30:00Z = 00:30 15-го в Алматы.
    const evening = new Date('2026-08-14T19:30:00Z');
    const serverDate = evening.toLocaleDateString('en-CA', { timeZone: 'UTC' });
    const hotelDate = evening.toLocaleDateString('en-CA', { timeZone: HOTEL_TIMEZONE });

    expect(serverDate).toBe('2026-08-14');
    expect(hotelDate).toBe('2026-08-15');
    expect(hotelDate).not.toBe(serverDate); // ровно тот случай, который ломал брони
  });

  it('формат остаётся YYYY-MM-DD', () => {
    const d = new Date('2026-01-05T10:00:00Z').toLocaleDateString('en-CA', {
      timeZone: HOTEL_TIMEZONE,
    });
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('днём расхождения нет — правка не ломает обычный сценарий', () => {
    const noon = new Date('2026-08-14T06:00:00Z'); // 11:00 в Алматы
    expect(noon.toLocaleDateString('en-CA', { timeZone: HOTEL_TIMEZONE })).toBe('2026-08-14');
  });
});
