import { describe, expect, it } from 'vitest';
import { localizeBookingLink } from '../src/integrations/exely/bookingLink';

// Реальная ссылка, которую Exely вернул на живом Search (propertyId 801, 2026-09-13→15, 2 взрослых).
const REAL =
  'https://kazzhol.com/ru/booking?room-type=6154&hotel_id=801&tl-lng=ru&tl-cur=KZT&tl-adults=2&tl-children-age=&tl-room=5052704&tl-offer=349868&tl-nights=2&tl-date=2026-09-13&utm_source=connectivity-hub';

describe('localizeBookingLink', () => {
  it('ведёт на саму форму брони, а не на страницу отеля без формы', () => {
    // kazzhol.com/ru/booking показывает выбор отеля и плавающую корзину — формы там нет,
    // и гость упирался в пустую страницу. Движок живёт на отдельном адресе.
    const u = new URL(localizeBookingLink(REAL, 'ru')!);
    expect(u.hostname).toBe('kz-ibe.hopenapi.com');
    expect(u.pathname).toContain('/booking2/hotel/');
  });

  it('казахский: движок открывается на казахском (kk, НЕ kz — на kz он падает в английский)', () => {
    expect(new URL(localizeBookingLink(REAL, 'kk')!).searchParams.get('language')).toBe('kk');
  });

  it('китайский', () => {
    expect(new URL(localizeBookingLink(REAL, 'zh')!).searchParams.get('language')).toBe('zh-CN');
  });

  it('английский', () => {
    expect(new URL(localizeBookingLink(REAL, 'en')!).searchParams.get('language')).toBe('en');
  });

  it('русский остаётся русским', () => {
    expect(new URL(localizeBookingLink(REAL, 'ru')!).searchParams.get('language')).toBe('ru');
  });

  it('язык не задан — считаем русским, ссылка не ломается', () => {
    expect(localizeBookingLink(REAL, null)).toContain('language=ru');
  });

  it('параметры предложения сохраняются полностью', () => {
    const u = new URL(localizeBookingLink(REAL, 'kk')!);
    expect(u.searchParams.get('providerId')).toBe('801');
    expect(u.searchParams.get('ratePlans')).toBe('349868');
    expect(u.searchParams.get('date')).toBe('2026-09-13');
    expect(u.searchParams.get('nights')).toBe('2');
    expect(u.searchParams.get('adults')).toBe('2');
    expect(u.searchParams.get('currency')).toBe('KZT');
  });


  it('открывается та категория, которую назвали гостю', () => {
    // Баг Exely: в ссылке room-type=6154, а предложение — 5052704 → форма пишет «недоступен».
    const u = new URL(localizeBookingLink(REAL, 'ru', '5052704')!);
    expect(u.searchParams.get('roomTypes')).toBe('5052704');
  });

  it('без явной категории берётся та, что стоит в самом предложении', () => {
    const u = new URL(localizeBookingLink(REAL, 'ru')!);
    expect(u.searchParams.get('roomTypes')).toBe('5052704');
  });

  it('пустая ссылка остаётся пустой', () => {
    expect(localizeBookingLink(null, 'kk')).toBeNull();
    expect(localizeBookingLink(undefined, 'kk')).toBeNull();
  });

  it('непарсящаяся ссылка отдаётся как есть — гость не остаётся без ссылки', () => {
    expect(localizeBookingLink('не-url', 'en')).toBe('не-url');
  });
});
