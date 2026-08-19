import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import {
  CONFIRMATION_TTL_MS,
  humanDate,
  maskPhone,
  newConfirmationToken,
  nightsWord,
  registerConfirmRoutes,
  type ConfirmationData,
  type ConfirmDeps,
} from '../src/server/confirm';
import type { CreateBookingResult } from '../src/core/booking';

const DATA: ConfirmationData = {
  property: 'almaty',
  hotelName: 'Kazzhol Almaty',
  checkIn: '2026-09-15',
  checkOut: '2026-09-16',
  nights: 1,
  guests: 2,
  roomType: 'Standard Double Room',
  roomTypeId: '6154',
  ratePlanId: '349868',
  ratePlanName: 'Best Available Rate',
  totalPrice: 59500,
  currency: 'KZT',
  guestFirstName: 'Асель',
  guestLastName: 'Нурланова',
  guestPhone: '+77015554433',
  guestEmail: 'a@example.com',
  conversationId: 'c-1',
  bookingFormLink: 'https://kazzhol.com/ru/booking?room-type=6154',
};

const CONFIRMED: CreateBookingResult = {
  mode: 'confirmed',
  number: '20260915-801-1261607589',
  total: 59500,
  currency: 'KZT',
  checkIn: '2026-09-15',
  checkOut: '2026-09-16',
  roomType: 'Standard Double Room',
  ratePlanName: 'Best Available Rate',
  guests: 2,
  cancellation: null,
};

/** Хранилище заявок в памяти — та же логика «застолбить один раз», что и в SQLite. */
function memoryStore() {
  const rows = new Map<
    string,
    { data: unknown; expiresAt: string; bookingNumber: string | null }
  >();
  const events: Array<{ type: string; payload?: unknown }> = [];
  return {
    rows,
    events,
    saveConfirmation(rec: { token: string; data: unknown; expiresAt: string }) {
      rows.set(rec.token, { data: rec.data, expiresAt: rec.expiresAt, bookingNumber: null });
    },
    findConfirmation(token: string) {
      return rows.get(token) ?? null;
    },
    claimConfirmation(token: string, number: string) {
      const r = rows.get(token);
      if (!r || r.bookingNumber) return false;
      r.bookingNumber = number;
      return true;
    },
    recordEvent(type: string, data?: { payload?: unknown }) {
      events.push({ type, payload: data?.payload });
    },
  };
}

function build(
  booked: CreateBookingResult = CONFIRMED,
  data: ConfirmationData = DATA,
  ttlMs = CONFIRMATION_TTL_MS,
) {
  const store = memoryStore();
  const createBooking = vi.fn(async (_args: Parameters<ConfirmDeps['createBooking']>[0]) => booked);
  const notifyStaff = vi.fn(async (_text: string, _property?: string) => undefined);
  const app = Fastify();
  registerConfirmRoutes(app, { store, createBooking, notifyStaff });
  const token = newConfirmationToken();
  store.saveConfirmation({
    token,
    data,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
  return { app, store, token, createBooking, notifyStaff };
}

describe('оформление текста заявки', () => {
  it('показывает дату по-человечески, а не в ISO', () => {
    expect(humanDate('2026-09-15')).toBe('15 сентября');
  });

  it('склоняет ночи', () => {
    expect(nightsWord(1)).toBe('ночь');
    expect(nightsWord(3)).toBe('ночи');
    expect(nightsWord(5)).toBe('ночей');
    expect(nightsWord(11)).toBe('ночей');
  });

  it('прячет середину телефона — ссылку могут переслать кому угодно', () => {
    const masked = maskPhone('+77015554433');
    expect(masked).not.toContain('555');
    expect(masked).toContain('33');
  });

  it('выдаёт непредсказуемый токен', () => {
    expect(newConfirmationToken()).not.toBe(newConfirmationToken());
    expect(newConfirmationToken().length).toBeGreaterThan(16);
  });
});

describe('страница подтверждения', () => {
  it('показывает данные гостя заполненными и одну кнопку', async () => {
    const { app, token } = build();
    const res = await app.inject({ method: 'GET', url: `/b/${token}` });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    // Ради этого всё и делалось: гость видит свои данные, а не пустую форму.
    expect(html).toContain('Standard Double Room');
    expect(html).toContain('15 сентября');
    expect(html).toContain('Асель');
    // Русская локаль разделяет разряды неразрывным пробелом — сверяем так же.
    expect(html).toContain(`${(59500).toLocaleString('ru-RU')} ₸`);
    expect(html).toContain('Подтвердить бронирование');
    // И ни одного поля для ввода.
    expect(html).not.toContain('<input');
  });

  it('не показывает телефон целиком', async () => {
    const { app, token } = build();
    const html = (await app.inject({ method: 'GET', url: `/b/${token}` })).body;
    expect(html).not.toContain('+77015554433');
  });

  it('чужой или выдуманный токен ничего не открывает', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/b/подобранный-токен' });
    expect(res.statusCode).toBe(410);
    expect(res.body).not.toContain('Асель');
  });

  it('протухшую заявку не показывает — цена в ней уже неправда', async () => {
    const { app, token } = build(CONFIRMED, DATA, -1000);
    expect((await app.inject({ method: 'GET', url: `/b/${token}` })).statusCode).toBe(410);
  });
});

describe('нажатие кнопки', () => {
  it('оформляет настоящую бронь и показывает её номер', async () => {
    const { app, token, createBooking, notifyStaff } = build();
    const res = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('20260915-801-1261607589');
    expect(res.body).toContain('Бронирование подтверждено');
    // Оформляем ровно тот номер и тариф, что видел гость.
    expect(createBooking).toHaveBeenCalledOnce();
    expect(createBooking.mock.calls[0][0]).toMatchObject({
      property: 'almaty',
      roomTypeId: '6154',
      ratePlanId: '349868',
      guestFirstName: 'Асель',
      guestPhone: '+77015554433',
    });
    // Отель обязан узнать о брони — гость мог и не дойти.
    expect(notifyStaff).toHaveBeenCalledOnce();
    expect(notifyStaff.mock.calls[0][0]).toContain('20260915-801-1261607589');
  });

  it('второе нажатие НЕ оформляет вторую бронь', async () => {
    // Гость обновляет страницу или жмёт дважды — это деньги, повтора быть не должно.
    const { app, token, createBooking } = build();
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    const again = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });

    expect(createBooking).toHaveBeenCalledOnce();
    expect(again.statusCode).toBe(200);
    expect(again.body).toContain('20260915-801-1261607589');
  });

  it('после оформления ссылка показывает номер брони, а не кнопку', async () => {
    const { app, token } = build();
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    const page = await app.inject({ method: 'GET', url: `/b/${token}` });
    expect(page.body).toContain('20260915-801-1261607589');
    expect(page.body).not.toContain('Подтвердить бронирование');
  });

  it('оформленную бронь показывает даже когда срок ссылки вышел', async () => {
    // Гость возвращается за номером брони через неделю — он должен его увидеть.
    const { app, store, token } = build();
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    store.rows.get(token)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    const page = await app.inject({ method: 'GET', url: `/b/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('20260915-801-1261607589');
  });

  it('номер ушёл, пока гость думал — не врём, а зовём человека', async () => {
    const { app, token, notifyStaff, store } = build({
      mode: 'link',
      bookingFormLink: 'https://kazzhol.com/ru/booking',
      reason: 'offer_not_found',
    });
    const res = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });

    expect(res.body).not.toContain('Бронирование подтверждено');
    expect(res.body).toContain('администратор');
    expect(notifyStaff).toHaveBeenCalledOnce();
    expect(notifyStaff.mock.calls[0][0]).toContain('не оформилась');
    expect(store.events.some((e) => e.type === 'confirmation_failed')).toBe(true);
    // Заявка не помечена оформленной — повтор возможен.
    expect(store.rows.get(token)!.bookingNumber).toBeNull();
  });
});
