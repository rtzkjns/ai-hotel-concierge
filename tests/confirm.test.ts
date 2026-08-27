import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import {
  CONFIRMATION_TTL_MS,
  humanDate,
  maskPhone,
  newConfirmationToken,
  nightsWord,
  guestConfirmation,
  registerConfirmRoutes,
  type ConfirmationData,
  type ConfirmDeps,
} from '../src/server/confirm';
import type { CreateBookingResult } from '../src/core/booking';
import type { BookingLead } from '../src/types';

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
  cancellationCode: 'ABC1234',
};

const FAILED: CreateBookingResult = {
  mode: 'link',
  bookingFormLink: 'https://kazzhol.com/ru/booking',
  reason: 'offer_not_found',
};

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
    settleConfirmation(token: string, number: string, from: string) {
      const r = rows.get(token);
      if (!r || r.bookingNumber !== from) return false;
      r.bookingNumber = number;
      return true;
    },
    releaseConfirmation(token: string, from: string) {
      const r = rows.get(token);
      if (r && r.bookingNumber === from) r.bookingNumber = null;
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
  const saveRequest = vi.fn((_lead: BookingLead) => undefined);
  const notifyStaff = vi.fn(async (_text: string, _property?: string) => undefined);
  const notifyGuest = vi.fn(async (_id: string, _text: string) => undefined);
  const app = Fastify();
  registerConfirmRoutes(app, { store, createBooking, saveRequest, notifyStaff, notifyGuest });
  const token = newConfirmationToken();
  store.saveConfirmation({
    token,
    data,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
  return { app, store, token, createBooking, saveRequest, notifyStaff, notifyGuest };
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

  it('до нажатия НЕ говорит, что бронь уже оформлена', async () => {
    const { app, token } = build();
    const html = (await app.inject({ method: 'GET', url: `/b/${token}` })).body;
    expect(html).not.toMatch(/бронирование оформлено/i);
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
  it('принимает отправку формы так, как её шлёт браузер', async () => {
    // Кнопка уходит как application/x-www-form-urlencoded. Без разбора этого типа
    // Fastify отвечает 415, и гость видит ошибку вместо брони — так и случилось в бою.
    const { app, token } = build();
    const res = await app.inject({
      method: 'POST',
      url: `/b/${token}/confirm`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Бронирование оформлено');
  });

  it('оформляет бронь ровно на том номере и тарифе, что видел гость', async () => {
    const { app, token, createBooking } = build();
    const res = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });

    expect(res.body).toContain('Бронирование оформлено');
    expect(createBooking).toHaveBeenCalledOnce();
    expect(createBooking.mock.calls[0][0]).toMatchObject({
      property: 'almaty',
      roomTypeId: '6154',
      ratePlanId: '349868',
      guestFirstName: 'Асель',
      guestPhone: '+77015554433',
      guestEmail: 'a@example.com',
    });
  });

  it('сообщает отелю номер брони и код отмены', async () => {
    const { app, token, notifyStaff } = build();
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });

    expect(notifyStaff).toHaveBeenCalledOnce();
    const text = notifyStaff.mock.calls[0][0];
    expect(text).toContain('20260915-801-1261607589');
    expect(text).toContain('ABC1234');
    expect(text).toContain('Асель Нурланова');
    expect(notifyStaff.mock.calls[0][1]).toBe('almaty');
  });

  it('второе нажатие НЕ оформляет вторую бронь', async () => {
    // Гость обновляет страницу или жмёт дважды — это деньги, повтора быть не должно.
    const { app, token, createBooking } = build();
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    const again = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });

    expect(createBooking).toHaveBeenCalledOnce();
    expect(again.body).toContain('Бронирование оформлено');
  });

  it('после оформления ссылка показывает номер брони, а не кнопку', async () => {
    const { app, token } = build();
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    const page = await app.inject({ method: 'GET', url: `/b/${token}` });
    expect(page.body).toContain('Бронирование оформлено');
    expect(page.body).not.toContain('Подтвердить бронирование');
  });

  it('оформленную бронь показывает даже когда срок ссылки вышел', async () => {
    // Гость возвращается за номером брони через неделю — он должен его увидеть.
    const { app, store, token } = build();
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    store.rows.get(token)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    const page = await app.inject({ method: 'GET', url: `/b/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Бронирование оформлено');
  });
});

describe('когда бронь оформить не удалось', () => {
  it('не выдаёт неудачу за оформленную бронь', async () => {
    // Ровно эта ложь однажды и ушла гостю. Тест существует, чтобы она не вернулась.
    const { app, token } = build(FAILED);
    const html = (await app.inject({ method: 'POST', url: `/b/${token}/confirm` })).body;
    expect(html).not.toMatch(/бронирование оформлено/i);
    expect(html).toContain('Не получилось оформить');
  });

  it('отдаёт заявку людям со всем, что нужно менеджеру', async () => {
    const { app, token, saveRequest, notifyStaff, store } = build(FAILED);
    const res = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });

    const code = /KZ-[A-Z0-9]{6}/.exec(res.body)?.[0];
    expect(code, 'гостю нужен код заявки').toBeTruthy();
    expect(saveRequest).toHaveBeenCalledOnce();
    const lead = saveRequest.mock.calls[0][0];
    expect(lead).toMatchObject({ kind: 'booking', contactPhone: '+77015554433' });
    expect(lead.specialRequests).toContain('a@example.com');
    expect(lead.specialRequests).toContain('offer_not_found');
    expect(notifyStaff).toHaveBeenCalledOnce();
    expect(notifyStaff.mock.calls[0][0]).toContain(code!);
    expect(store.events.some((e) => e.type === 'confirmation_failed')).toBe(true);
  });

  it('повтор не плодит заявки отелю', async () => {
    const { app, token, saveRequest, notifyStaff } = build(FAILED);
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    expect(saveRequest).toHaveBeenCalledOnce();
    expect(notifyStaff).toHaveBeenCalledOnce();
  });

  it('оставляет гостю форму отеля как рабочий путь', async () => {
    const { app, token } = build(FAILED);
    const html = (await app.inject({ method: 'POST', url: `/b/${token}/confirm` })).body;
    expect(html).toContain(DATA.bookingFormLink!);
  });
});

describe('подтверждение гостю в чат', () => {
  it('уходит гостю в его же переписку после оформления', async () => {
    // Гость закрывает вкладку — на руках у него должно остаться сообщение с номером брони,
    // а не только страница, которую он больше не откроет.
    const { app, token, notifyGuest } = build();
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    await new Promise((r) => setTimeout(r, 0));

    expect(notifyGuest).toHaveBeenCalledOnce();
    const [convoId, text] = notifyGuest.mock.calls[0];
    expect(convoId).toBe('c-1');
    // Служебных идентификаторов гостю не даём: полное подтверждение с номером и кодом
    // ему присылает Exely письмом от имени отеля.
    expect(text).toContain('Kazzhol Almaty');
    expect(text).not.toContain('20260915-801-1261607589');
    expect(text).not.toContain('ABC1234');
  });

  it('не даёт гостю и короткий номер Exely', async () => {
    const { app, token, notifyGuest } = build({ ...CONFIRMED, hotelNumber: '683546' });
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyGuest.mock.calls[0][1]).not.toContain('683546');
  });

  it('несёт всё, что нужно на заселении', () => {
    const text = guestConfirmation(DATA, {
      number: '20260915-801-1261607589',
      hotelNumber: '683546',
      total: 59500,
      currency: 'KZT',
      roomType: 'Standard Double Room',
    });
    expect(text).toContain('Kazzhol Almaty');
    expect(text).toContain('Standard Double Room');
    expect(text).toContain('15 сентября');
    expect(text).toContain('16 сентября');
    expect(text).toContain('15:00');
    expect(text).toContain('12:00');
    expect(text).toContain('Асель Нурланова');
    expect(text).toContain(`${(59500).toLocaleString('ru-RU')} ₸`);
    // Ни ссылок, ни служебных слов — это сообщение от менеджера, а не квитанция.
    expect(text).not.toContain('http');
  });

  it('не обещает бронь, когда её не оформили', async () => {
    const { app, token, notifyGuest } = build(FAILED);
    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyGuest).not.toHaveBeenCalled();
  });
});

describe('дорешивание номера Exely', () => {
  it('запускается, когда короткого номера ещё нет', async () => {
    // Иначе у сотрудников на руках остаётся только служебный номер, по которому
    // бронь не находится — с этой жалобы всё и началось.
    const store = memoryStore();
    const resolveHotelNumber = vi.fn();
    const app = Fastify();
    registerConfirmRoutes(app, {
      store,
      createBooking: async () => ({ ...CONFIRMED, voucherUrl: 'https://secure.exely.test/v/1' }),
      saveRequest: vi.fn(),
      notifyStaff: vi.fn(async () => undefined),
      resolveHotelNumber,
    });
    const token = newConfirmationToken();
    store.saveConfirmation({
      token,
      data: DATA,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
    });

    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    expect(resolveHotelNumber).toHaveBeenCalledOnce();
    expect(resolveHotelNumber.mock.calls[0][0]).toMatchObject({
      number: '20260915-801-1261607589',
      voucherUrl: 'https://secure.exely.test/v/1',
      property: 'almaty',
    });
  });

  it('не запускается, когда номер уже известен', async () => {
    const store = memoryStore();
    const resolveHotelNumber = vi.fn();
    const app = Fastify();
    registerConfirmRoutes(app, {
      store,
      createBooking: async () => ({
        ...CONFIRMED,
        hotelNumber: '683546',
        voucherUrl: 'https://secure.exely.test/v/1',
      }),
      saveRequest: vi.fn(),
      notifyStaff: vi.fn(async () => undefined),
      resolveHotelNumber,
    });
    const token = newConfirmationToken();
    store.saveConfirmation({
      token,
      data: DATA,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
    });

    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    expect(resolveHotelNumber).not.toHaveBeenCalled();
  });
});

// Гость нажимает «Подтвердить» дважды — на медленной связи это обычное дело, тем более
// что ждать приходится до пятнадцати секунд, пока Exely присвоит номер ваучера.
// Раньше это давало ДВЕ настоящие брони в отеле: токен столбился уже после движка.
describe('двойное нажатие «Подтвердить»', () => {
  it('создаёт РОВНО одну бронь при двух одновременных запросах', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const store = memoryStore();
    // Движок отвечает не мгновенно — именно в этом окне и возникала вторая бронь.
    const createBooking = vi.fn(async () => { started += 1; await gate; return CONFIRMED; });
    const app = Fastify();
    registerConfirmRoutes(app, {
      store,
      createBooking,
      saveRequest: vi.fn(),
      notifyStaff: vi.fn(async () => undefined),
    });
    const token = newConfirmationToken();
    store.saveConfirmation({
      token,
      data: DATA,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
    });

    const first = app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    // Второй запрос уходит, пока первый ещё внутри движка.
    await new Promise((r) => setTimeout(r, 5));
    const second = await app.inject({ method: 'POST', url: `/b/${token}/confirm` });
    release();
    const firstRes = await first;

    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(started).toBe(1);
    expect(firstRes.statusCode).toBe(200);
    // Второму показываем состояние, а не вторую бронь и не ошибку.
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Оформляем');
  });

  it('снимает метку «оформляем», если оформление рухнуло, — токен не мертвеет', async () => {
    const store = memoryStore();
    const createBooking = vi.fn(async () => { throw new Error('движок упал'); });
    const notifyStaff = vi.fn(async () => undefined);
    const app = Fastify();
    registerConfirmRoutes(app, { store, createBooking, saveRequest: vi.fn(), notifyStaff });
    const token = newConfirmationToken();
    store.saveConfirmation({
      token,
      data: DATA,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
    });

    await app.inject({ method: 'POST', url: `/b/${token}/confirm` });

    expect(store.rows.get(token)!.bookingNumber).toBeNull();
    // Персонал обязан узнать: бронь могла создаться на стороне отеля.
    expect(notifyStaff).toHaveBeenCalled();
    expect(store.events.some((e) => e.type === 'confirmation_crashed')).toBe(true);
  });
});
