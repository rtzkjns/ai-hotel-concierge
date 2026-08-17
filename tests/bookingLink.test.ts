import { describe, expect, it } from 'vitest';
import { localizeBookingLink } from '../src/integrations/exely/bookingLink';

// Реальная ссылка, которую Exely вернул на живом Search (propertyId 801, 2026-09-13→15, 2 взрослых).
const REAL =
  'https://kazzhol.com/ru/booking?room-type=6154&hotel_id=801&tl-lng=ru&tl-cur=KZT&tl-adults=2&tl-children-age=&tl-room=5052704&tl-offer=349868&tl-nights=2&tl-date=2026-09-13&utm_source=connectivity-hub';

describe('localizeBookingLink', () => {
  it('казахский: путь /kz/ и tl-lng=kk (НЕ kz — на kz движок падает в английский)', () => {
    const u = new URL(localizeBookingLink(REAL, 'kk')!);
    expect(u.pathname).toBe('/kz/booking');
    expect(u.searchParams.get('tl-lng')).toBe('kk');
  });

  it('китайский: путь /cn/ и tl-lng=zh-CN', () => {
    const u = new URL(localizeBookingLink(REAL, 'zh')!);
    expect(u.pathname).toBe('/cn/booking');
    expect(u.searchParams.get('tl-lng')).toBe('zh-CN');
  });

  it('английский: путь /en/ и tl-lng=en', () => {
    const u = new URL(localizeBookingLink(REAL, 'en')!);
    expect(u.pathname).toBe('/en/booking');
    expect(u.searchParams.get('tl-lng')).toBe('en');
  });

  it('русский остаётся русским', () => {
    const u = new URL(localizeBookingLink(REAL, 'ru')!);
    expect(u.pathname).toBe('/ru/booking');
    expect(u.searchParams.get('tl-lng')).toBe('ru');
  });

  it('язык не задан — считаем русским, ссылка не ломается', () => {
    expect(localizeBookingLink(REAL, null)).toContain('/ru/booking');
  });

  it('параметры предложения сохраняются полностью', () => {
    const u = new URL(localizeBookingLink(REAL, 'kk')!);
    expect(u.searchParams.get('hotel_id')).toBe('801');
    expect(u.searchParams.get('tl-offer')).toBe('349868');
    expect(u.searchParams.get('tl-date')).toBe('2026-09-13');
    expect(u.searchParams.get('tl-nights')).toBe('2');
    expect(u.searchParams.get('tl-adults')).toBe('2');
    expect(u.searchParams.get('tl-cur')).toBe('KZT');
  });

  it('room-type подменяется на реально оплаченный тип номера', () => {
    // Баг Exely: в ссылке room-type=6154, а предложение — 5052704 → форма пишет «недоступен».
    const u = new URL(localizeBookingLink(REAL, 'ru', '5052704')!);
    expect(u.searchParams.get('room-type')).toBe('5052704');
  });

  it('без roomTypeId ссылка не трогается в этой части', () => {
    const u = new URL(localizeBookingLink(REAL, 'ru')!);
    expect(u.searchParams.get('room-type')).toBe('6154');
  });

  it('пустая ссылка остаётся пустой', () => {
    expect(localizeBookingLink(null, 'kk')).toBeNull();
    expect(localizeBookingLink(undefined, 'kk')).toBeNull();
  });

  it('непарсящаяся ссылка отдаётся как есть — гость не остаётся без ссылки', () => {
    expect(localizeBookingLink('не-url', 'en')).toBe('не-url');
  });
});
