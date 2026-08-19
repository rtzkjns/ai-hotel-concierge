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
} from '../src/server/confirm';
import type { BookingLead } from '../src/types';

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

function build(data: ConfirmationData = DATA, ttlMs = CONFIRMATION_TTL_MS) {
  const store = memoryStore();
  const saveRequest = vi.fn((_lead: BookingLead) => undefined);
  const notifyStaff = vi.fn(async (_text: string, _property?: string) => undefined);
  const app = Fastify();
  registerConfirmRoutes(app, { store, saveRequest, notifyStaff });
  const token = newConfirmationToken();
  store.saveConfirmation({
    token,
    data,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
  return { app, store, token, saveRequest, notifyStaff };
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

describe('страница заявки', () => {
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
    expect(html).toContain('Отправить заявку');
    // И ни одного поля для ввода.
    expect(html).not.toContain('<input');
  });

  it('НЕ обещает, что бронь уже оформлена', async () => {
    // Оформить бронь программно нельзя. Ложное «подтверждено» здесь однажды стояло —
    // гость получил его, а брони в отеле не было. Больше никогда.
    const { app, token } = build();
    const html = (await app.inject({ method: 'GET', url: `/b/${token}` })).body;
    expect(html).not.toMatch(/бронирование подтвержд|бронь оформлен|номер за вами/i);
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
    const { app, token } = build(DATA, -1000);
    expect((await app.inject({ method: 'GET', url: `/b/${token}` })).statusCode).toBe(410);
  });
});

describe('нажатие кнопки', () => {
  it('принимает отправку формы так, как её шлёт браузер', async () => {
    // Кнопка уходит как application/x-www-form-urlencoded. Без разбора этого типа
    // Fastify отвечает 415, и гость видит ошибку вместо заявки — так и случилось в бою.
    const { app, token } = build();
    const res = await app.inject({
      method: 'POST',
      url: `/b/${token}/confirm`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Заявка принята');
  });

  it('кладёт заявку в панель со всем, что нужно менеджеру', async () => {
    const { app, token, saveRequest } = build();
    const res = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });

    expect(res.statusCode).toBe(200);
    expect(saveRequest).toHaveBeenCalledOnce();
    const lead = saveRequest.mock.calls[0][0];
    expect(lead).toMatchObject({
      kind: 'booking',
      checkIn: '2026-09-15',
      checkOut: '2026-09-16',
      guests: 2,
      roomType: 'Standard Double Room',
      contactName: 'Асель Нурланова',
      contactPhone: '+77015554433',
    });
    // Менеджер заносит бронь в Edelweiss руками — почта и тариф ему нужны на месте,
    // доспрашивать гостя он не должен.
    expect(lead.specialRequests).toContain('a@example.com');
    expect(lead.specialRequests).toContain('Best Available Rate');
  });

  it('уведомляет отель и даёт гостю код заявки', async () => {
    const { app, token, notifyStaff } = build();
    const res = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });

    const code = /KZ-[A-Z0-9]{6}/.exec(res.body)?.[0];
    expect(code, 'на странице должен быть код заявки').toBeTruthy();
    expect(notifyStaff).toHaveBeenCalledOnce();
    const text = notifyStaff.mock.calls[0][0];
    expect(text).toContain(code!);
    expect(text).toContain('Асель Нурланова');
    expect(text).toContain('+77015554433');
    expect(notifyStaff.mock.calls[0][1]).toBe('almaty');
  });

  it('страница результата не выдаёт заявку за оформленную бронь', async () => {
    const { app, token } = build();
    const html = (await app.inject({ method: 'POST', url: `/b/${token}/confirm` })).body;
    expect(html).toContain('отель свяжется');
    expect(html).not.toMatch(/бронирование подтвержд|бронь оформлен|номер брони/i);
  });

  it('второе нажатие НЕ создаёт вторую заявку', async () => {
    // Гость обновляет страницу или жмёт дважды — отель не должен получить дубль.
    const { app, token, saveRequest, notifyStaff } = build();
    const first = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    const again = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });

    expect(saveRequest).toHaveBeenCalledOnce();
    expect(notifyStaff).toHaveBeenCalledOnce();
    const code = /KZ-[A-Z0-9]{6}/.exec(first.body)![0];
    expect(again.body).toContain(code);
  });

  it('после отправки ссылка показывает код заявки, а не кнопку', async () => {
    const { app, token } = build();
    const posted = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    const code = /KZ-[A-Z0-9]{6}/.exec(posted.body)![0];
    const page = await app.inject({ method: 'GET', url: `/b/${token}` });
    expect(page.body).toContain(code);
    expect(page.body).not.toContain('Отправить заявку');
  });

  it('отправленную заявку показывает даже когда срок ссылки вышел', async () => {
    // Гость возвращается за номером заявки через неделю — он должен его увидеть.
    const { app, store, token } = build();
    const posted = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    const code = /KZ-[A-Z0-9]{6}/.exec(posted.body)![0];
    store.rows.get(token)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    const page = await app.inject({ method: 'GET', url: `/b/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(code);
  });

  it('записывает событие заявки для отчётов', async () => {
    const { app, store, token } = build();
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    expect(store.events.some((e) => e.type === 'booking_requested')).toBe(true);
  });
});
