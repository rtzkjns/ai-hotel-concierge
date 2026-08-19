import { describe, it, expect, vi } from 'vitest';
import {
  buildIbeBooking,
  ibeDateTime,
  IbeReservation,
  pickGuarantee,
} from '../src/integrations/exely/ibeBooking';
import type { BookingRq } from '../src/integrations/exely/reservation';

function rq(overrides: Partial<BookingRq['roomStays'][0]> = {}): BookingRq {
  return {
    propertyId: '801',
    roomStays: [
      {
        stayDates: {
          arrivalDateTime: '2026-09-15T15:00:00',
          departureDateTime: '2026-09-16T12:00:00',
        },
        ratePlan: { id: '349868' },
        roomType: { id: '6154', placements: [{ code: '36257' }] },
        guests: [{ firstName: 'Асель', lastName: 'Нурланова' }],
        guestCount: { adultCount: 2 },
        checksum: 'abc',
        ...overrides,
      },
    ],
    customer: {
      firstName: 'Асель',
      lastName: 'Нурланова',
      contacts: {
        phones: [{ phoneNumber: '+77015554433' }],
        emails: [{ emailAddress: 'a@example.com' }],
      },
      comment: 'поздний заезд',
    },
  };
}

/** Достаёт первое размещение из собранного тела — читается легче, чем цепочка индексов. */
function firstStay(body: Record<string, unknown>): Record<string, any> {
  return (body.hotel_reservations as any[])[0].room_stays[0];
}

describe('сборка запроса к движку', () => {
  it('переводит дату в формат движка — ISO с «T» он не принимает', () => {
    expect(ibeDateTime('2026-09-15T15:00:00')).toBe('2026-09-15 15:00:00');
  });

  it('кладёт отель, номер, тариф и даты туда, где их ждёт движок', () => {
    const body = buildIbeBooking('801', rq(), 'ru-ru');
    const res = (body.hotel_reservations as any[])[0];
    expect(res.hotel_ref.code).toBe('801');
    const stay = firstStay(body);
    expect(stay.rate_plans[0].code).toBe('349868');
    expect(stay.room_types[0].code).toBe('6154');
    expect(stay.stay_dates).toEqual({
      start_date: '2026-09-15 15:00:00',
      end_date: '2026-09-16 12:00:00',
    });
  });

  it('двухместный номер — это ОДНО размещение на двоих, а не два по одному', () => {
    // Движок отвергает разбиение двухместного размещения на два счётчика по гостю.
    const stay = firstStay(buildIbeBooking('801', rq(), 'ru-ru'));
    expect(stay.room_types[0].placements).toEqual([{ code: '36257', index: 1, kind: 'adult' }]);
    expect(stay.guest_count_info.guest_counts).toEqual([
      { age_qualifying_code: 'adult', count: 2, index: 1, placement_index: 1 },
    ]);
  });

  it('когда мест хватает на каждого — раздаёт по гостю на место', () => {
    const stay = firstStay(
      buildIbeBooking(
        '801',
        rq({ roomType: { id: '6154', placements: [{ code: 'a1' }, { code: 'a2' }] } }),
        'ru-ru',
      ),
    );
    expect(stay.guest_count_info.guest_counts).toEqual([
      { age_qualifying_code: 'adult', count: 1, index: 1, placement_index: 1 },
      { age_qualifying_code: 'adult', count: 1, index: 2, placement_index: 2 },
    ]);
  });

  it('переносит имя, телефон и почту гостя — ради этого всё и затевалось', () => {
    const body = buildIbeBooking('801', rq(), 'ru-ru');
    const res = (body.hotel_reservations as any[])[0];
    expect(res.customer.first_name).toBe('Асель');
    expect(res.customer.contact_info.phones[0].phone_number).toBe('+77015554433');
    expect(res.customer.contact_info.emails[0].email_address).toBe('a@example.com');
    expect(res.customer.comment).toBe('поздний заезд');
    expect(firstStay(body).guests[0]).toMatchObject({ first_name: 'Асель', last_name: 'Нурланова' });
  });

  it('не отправляет пустую почту — движок считает её невалидной', () => {
    const base = rq();
    base.customer.contacts.emails = [{ emailAddress: '' }];
    const res = (buildIbeBooking('801', base, 'ru-ru').hotel_reservations as any[])[0];
    expect(res.customer.contact_info.emails).toEqual([]);
  });

  it('добавляет способ оплаты только когда он выбран', () => {
    const without = (buildIbeBooking('801', rq(), 'ru-ru').hotel_reservations as any[])[0];
    expect(without.guarantee_info).toBeUndefined();
    const withCode = (buildIbeBooking('801', rq(), 'ru-ru', '3052').hotel_reservations as any[])[0];
    expect(withCode.guarantee_info).toEqual({ code: '3052' });
  });
});

describe('выбор способа оплаты', () => {
  it('берёт оплату при заселении — гостю не нужна карта, чтобы забронировать', () => {
    expect(
      pickGuarantee([
        { code: '5020186', payment_system_code: 'HALYKBANK', require_prepayment: true },
        { code: '3052', payment_system_code: 'AT_ARRIVAL', require_prepayment: false },
      ]),
    ).toBe('3052');
  });

  it('если оплаты при заселении нет — берёт любой способ без предоплаты', () => {
    expect(
      pickGuarantee([
        { code: '99', payment_system_code: 'HALYKBANK', require_prepayment: true },
        { code: '77', payment_system_code: 'TLPAYMENTS', require_prepayment: false },
      ]),
    ).toBe('77');
  });

  it('без вариантов возвращает ничего, а не выдуманный код', () => {
    expect(pickGuarantee([])).toBeUndefined();
    expect(pickGuarantee(undefined)).toBeUndefined();
  });
});

/** Отвечает на verify и на создание брони — по порядку вызовов. */
function fakeFetch(replies: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const r = replies[calls.length - 1] ?? { body: {} };
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

/** Ответ поиска движка: коды мест у него свои, числовые. */
const AVAILABLE = {
  room_stays: [
    {
      room_types: [{ code: '6154', placements: [{ code: '10128397' }] }],
      rate_plans: [{ code: '349868' }],
    },
  ],
};

const VERIFIED = {
  hotel_reservations: [
    {
      status: 'unconfirmed',
      guarantee_options: [
        { code: '3052', payment_system_code: 'AT_ARRIVAL', require_prepayment: false },
      ],
    },
  ],
};

describe('оформление брони через движок', () => {
  it('сначала проверяет, потом создаёт — и возвращает номер брони', async () => {
    const { impl, calls } = fakeFetch([
      { body: AVAILABLE },
      { body: VERIFIED },
      {
        body: {
          hotel_reservations: [
            {
              number: '20260915-801-1261607589',
              cancellation_code: 'WZ1FDN1',
              status: 'unconfirmed',
              total: { price_after_tax: 59500, currency: 'KZT' },
            },
          ],
        },
      },
    ]);
    const res = await new IbeReservation('801', { fetchImpl: impl }).place(rq());

    expect(calls[0].url).toContain('hotel_availability');
    expect(calls[1].url).toContain('verify_reservation');
    expect(calls[2].url).toContain('hotel_reservation_2');
    // Место берётся из каталога движка, а не из поиска Exely — коды у них разные.
    expect(calls[2].body.hotel_reservations[0].room_stays[0].room_types[0].placements).toEqual([
      { code: '10128397', index: 1, kind: 'adult' },
    ]);
    // Способ оплаты берётся из ответа verify, а не зашит в код: коды разные у каждого отеля.
    expect(calls[2].body.hotel_reservations[0].guarantee_info).toEqual({ code: '3052' });
    expect(res).toMatchObject({
      ok: true,
      number: '20260915-801-1261607589',
      cancellationCode: 'WZ1FDN1',
      total: 59500,
    });
  });

  it('движок ответил без номера — это НЕ бронь, и мы так и говорим', async () => {
    const { impl } = fakeFetch([
      { body: AVAILABLE },
      { body: VERIFIED },
      { body: { hotel_reservations: [{}] } },
    ]);
    const res = await new IbeReservation('801', { fetchImpl: impl }).place(rq());
    expect(res.ok).toBe(false);
    expect(res.number).toBeUndefined();
  });

  it('на отказ движка отвечает ok:false, а не падает — иначе гость теряет и ссылку', async () => {
    const { impl } = fakeFetch([{ status: 500, body: {} }]);
    const res = await new IbeReservation('801', { fetchImpl: impl }).place(rq());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('500');
  });

  it('сеть отвалилась — тоже ok:false', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const res = await new IbeReservation('801', { fetchImpl: impl }).place(rq());
    expect(res).toMatchObject({ ok: false, error: 'ECONNRESET' });
  });

  it('нулевую сумму не выдаёт за цену — настоящая бронь не бывает бесплатной', async () => {
    const { impl } = fakeFetch([
      { body: AVAILABLE },
      { body: VERIFIED },
      { body: { hotel_reservations: [{ number: 'X-1', total: { price_after_tax: 0 } }] } },
    ]);
    const res = await new IbeReservation('801', { fetchImpl: impl }).place(rq());
    expect(res.total).toBeUndefined();
  });

  it('номер разобрали, пока гость думал — не выдумываем бронь', async () => {
    const { impl, calls } = fakeFetch([{ body: { room_stays: [] } }]);
    const res = await new IbeReservation('801', { fetchImpl: impl }).place(rq());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('недоступен');
    // И, главное, до создания брони дело не дошло.
    expect(calls).toHaveLength(1);
  });

  it('честно признаёт, что отменить бронь не умеет', async () => {
    const client = new IbeReservation('801');
    expect(client.supportsCancel).toBe(false);
    await expect(client.cancel()).rejects.toThrow();
  });
});
