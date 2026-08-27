import { describe, it, expect, vi } from 'vitest';
import {
  buildIbeBooking,
  DEFAULT_INTEGRATION_KEY,
  describeErrors,
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
          arrivalDateTime: '2026-12-26T15:00:00',
          departureDateTime: '2026-12-27T12:00:00',
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

const res = (body: Record<string, unknown>) =>
  (body.hotel_reservations as Array<Record<string, any>>)[0];
const stayOf = (body: Record<string, unknown>) => res(body).room_stays[0];

const AT_ARRIVAL = { code: '3052', payment_system_code: 'AT_ARRIVAL', require_prepayment: false };

describe('сборка запроса к движку', () => {
  it('переводит дату в формат движка — ISO с «T» он не принимает', () => {
    expect(ibeDateTime('2026-12-26T15:00:00')).toBe('2026-12-26 15:00:00');
  });

  it('кладёт отель, номер, тариф и даты туда, где их ждёт движок', () => {
    const body = buildIbeBooking('801', rq(), 'ru-ru');
    expect(res(body).hotel_ref.code).toBe('801');
    const stay = stayOf(body);
    expect(stay.rate_plans[0].code).toBe('349868');
    expect(stay.room_types[0].code).toBe('6154');
    expect(stay.stay_dates).toEqual({
      start_date: '2026-12-26 15:00:00',
      end_date: '2026-12-27 12:00:00',
    });
  });

  it('ГАРАНТИЯ ЛЕЖИТ В ПОЛЕ guarantee, а не guarantee_info', () => {
    // Ровно эта опечатка стоила нам недели фантомных броней: guarantee_info — имя поля в
    // ОТВЕТЕ, движок молча выбрасывает его из запроса и создаёт бронь без гарантии оплаты,
    // которая навсегда остаётся unconfirmed и до отеля не доходит. При этом возвращается
    // настоящий на вид номер брони.
    const body = buildIbeBooking('801', rq(), 'ru-ru', { guarantee: AT_ARRIVAL });
    expect(res(body).guarantee).toMatchObject({ code: '3052' });
    expect(res(body).guarantee_info).toBeUndefined();
  });

  it('шлёт обе ссылки возврата — без них движок отказывает', () => {
    const g = buildIbeBooking('801', rq(), 'ru-ru', { guarantee: AT_ARRIVAL }).hotel_reservations;
    const guarantee = (g as Array<Record<string, any>>)[0].guarantee;
    expect(guarantee.success_url).toMatch(/^https:\/\//);
    expect(guarantee.decline_url).toMatch(/^https:\/\//);
  });

  it('без выбранного способа оплаты гарантию не выдумывает', () => {
    expect(res(buildIbeBooking('801', rq(), 'ru-ru')).guarantee).toBeUndefined();
  });

  it('подписывает бронь каналом продаж отеля', () => {
    // Пустой point_of_sale принимается, но оставляет бронь без принадлежности к каналу.
    const body = buildIbeBooking('801', rq(), 'ru-ru', { integrationKey: DEFAULT_INTEGRATION_KEY });
    expect(body.point_of_sale).toMatchObject({
      integration_key: `${DEFAULT_INTEGRATION_KEY}.801`,
    });
    expect(buildIbeBooking('801', rq(), 'ru-ru').point_of_sale).toEqual({});
  });

  it('двухместный номер — это ОДНО размещение на двоих, а не два по одному', () => {
    const stay = stayOf(buildIbeBooking('801', rq(), 'ru-ru'));
    expect(stay.room_types[0].placements).toEqual([{ code: '36257', index: 1, kind: 'adult' }]);
    expect(stay.guest_count_info.guest_counts).toEqual([
      { age_qualifying_code: 'adult', count: 2, index: 1, placement_index: 1 },
    ]);
  });

  it('когда мест хватает на каждого — раздаёт по гостю на место', () => {
    const stay = stayOf(
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

  // Бронь гостьи Камиллы (WhatsApp, 2026-08-27) упала с «Invalid adult placement #10017731».
  // Причина: Family room отдаёт ДВА разных места — основное на двоих (kind adult, capacity 2)
  // и дополнительное на одного (kind extra_adult, capacity 1). Мы объявляли оба «adult»,
  // и движок отвергал второе. Вид места приходит от движка, выдумывать его нельзя.
  it('дополнительное место объявляется своим видом, а не «adult»', () => {
    const stay = stayOf(
      buildIbeBooking(
        '801',
        rq({
          roomType: {
            id: '142471',
            placements: [
              { code: '324362', index: 1, kind: 'adult', capacity: 2 },
              { code: '10017731', index: 2, kind: 'extra_adult', capacity: 1 },
            ],
          },
          guestCount: { adultCount: 3 },
        }),
        'ru-ru',
      ),
    );
    expect(stay.room_types[0].placements).toEqual([
      { code: '324362', index: 1, kind: 'adult' },
      { code: '10017731', index: 2, kind: 'extra_adult' },
    ]);
  });

  it('троих взрослых раскладывает по вместимости: 2 в основное, 1 в дополнительное', () => {
    const stay = stayOf(
      buildIbeBooking(
        '801',
        rq({
          roomType: {
            id: '142471',
            placements: [
              { code: '324362', index: 1, kind: 'adult', capacity: 2 },
              { code: '10017731', index: 2, kind: 'extra_adult', capacity: 1 },
            ],
          },
          guestCount: { adultCount: 3 },
        }),
        'ru-ru',
      ),
    );
    expect(stay.guest_count_info.guest_counts).toEqual([
      { age_qualifying_code: 'adult', count: 2, index: 1, placement_index: 1 },
      { age_qualifying_code: 'adult', count: 1, index: 2, placement_index: 2 },
    ]);
  });

  it('не сажает в место больше, чем оно вмещает', () => {
    const stay = stayOf(
      buildIbeBooking(
        '801',
        rq({
          roomType: { id: '6154', placements: [{ code: '36257', index: 1, kind: 'adult', capacity: 2 }] },
          guestCount: { adultCount: 2 },
        }),
        'ru-ru',
      ),
    );
    const total = stay.guest_count_info.guest_counts.reduce(
      (n: number, g: { count: number }) => n + g.count,
      0,
    );
    expect(total).toBe(2);
    expect(stay.guest_count_info.guest_counts[0].count).toBeLessThanOrEqual(2);
  });

  // Раскладку гостей присылает сам движок. Повторяем её дословно — оба прежних дефекта
  // («Invalid adult placement», «More guests than it allows») родились из самодеятельности.
  const FAMILY = {
    id: '6156',
    placements: [
      { code: '8504', index: 1, kind: 'adult', capacity: 2 },
      { code: '80887', index: 2, kind: 'extra_adult', capacity: 1 },
    ],
  };

  it('ребёнок объявляется ребёнком, с возрастом и возрастной группой', () => {
    const stay = stayOf(
      buildIbeBooking(
        '801',
        rq({
          roomType: FAMILY,
          guestCount: { adultCount: 2, childCount: 1, childAges: [7] },
          guests: [
            { firstName: 'А', lastName: 'А' },
            { firstName: 'Б', lastName: 'Б' },
            { firstName: 'В', lastName: 'В' },
          ],
          seats: [
            { index: 1, kind: 'adult' },
            { index: 1, kind: 'adult' },
            { index: 2, kind: 'extra_adult', age: 7, ageGroup: 297 },
          ],
        }),
        'ru-ru',
      ),
    );
    expect(stay.guest_count_info.guest_counts).toEqual([
      { age_qualifying_code: 'adult', count: 2, index: 1, placement_index: 1 },
      { age_qualifying_code: 'child', count: 1, index: 2, placement_index: 2, age: 7, age_group: 297 },
    ]);
  });

  it('взрослого не превращает в ребёнка: без возраста — обычное место', () => {
    const stay = stayOf(
      buildIbeBooking(
        '801',
        rq({
          roomType: FAMILY,
          guestCount: { adultCount: 3 },
          guests: [
            { firstName: 'А', lastName: 'А' },
            { firstName: 'Б', lastName: 'Б' },
            { firstName: 'В', lastName: 'В' },
          ],
          seats: [
            { index: 1, kind: 'adult' },
            { index: 1, kind: 'adult' },
            { index: 2, kind: 'extra_adult' },
          ],
        }),
        'ru-ru',
      ),
    );
    expect(stay.guest_count_info.guest_counts).toEqual([
      { age_qualifying_code: 'adult', count: 2, index: 1, placement_index: 1 },
      { age_qualifying_code: 'adult', count: 1, index: 2, placement_index: 2 },
    ]);
  });

  it('двоих детей разного возраста не сливает в одну запись', () => {
    const stay = stayOf(
      buildIbeBooking(
        '801',
        rq({
          roomType: {
            id: '6156',
            placements: [
              { code: '8504', index: 1, kind: 'adult', capacity: 2 },
              { code: '80887', index: 2, kind: 'extra_adult', capacity: 2 },
            ],
          },
          guestCount: { adultCount: 2, childCount: 2, childAges: [3, 9] },
          guests: Array.from({ length: 4 }, (_, i) => ({ firstName: `Г${i}`, lastName: 'Г' })),
          seats: [
            { index: 1, kind: 'adult' },
            { index: 1, kind: 'adult' },
            { index: 2, kind: 'extra_adult', age: 3, ageGroup: 296 },
            { index: 2, kind: 'extra_adult', age: 9, ageGroup: 297 },
          ],
        }),
        'ru-ru',
      ),
    );
    const kids = stay.guest_count_info.guest_counts.filter(
      (g: { age_qualifying_code: string }) => g.age_qualifying_code === 'child',
    );
    expect(kids).toHaveLength(2);
    expect(kids.map((k: { age: number }) => k.age).sort()).toEqual([3, 9]);
  });

  it('каждый гость садится ровно туда, куда его посчитали', () => {
    const stay = stayOf(
      buildIbeBooking(
        '801',
        rq({
          roomType: FAMILY,
          guestCount: { adultCount: 2, childCount: 1, childAges: [7] },
          guests: [
            { firstName: 'А', lastName: 'А' },
            { firstName: 'Б', lastName: 'Б' },
            { firstName: 'В', lastName: 'В' },
          ],
          seats: [
            { index: 1, kind: 'adult' },
            { index: 1, kind: 'adult' },
            { index: 2, kind: 'extra_adult', age: 7, ageGroup: 297 },
          ],
        }),
        'ru-ru',
      ),
    );
    expect(stay.guests.map((g: { placement: { index: number } }) => g.placement.index)).toEqual([1, 1, 2]);
  });

  it('число посаженных всегда равно числу гостей — иначе движок скажет «больше, чем вмещает»', () => {
    for (const seats of [
      [{ index: 1, kind: 'adult' }],
      [{ index: 1, kind: 'adult' }, { index: 1, kind: 'adult' }],
      [{ index: 1, kind: 'adult' }, { index: 1, kind: 'adult' }, { index: 2, kind: 'extra_adult', age: 5, ageGroup: 296 }],
    ]) {
      const stay = stayOf(
        buildIbeBooking(
          '801',
          rq({
            roomType: FAMILY,
            guestCount: { adultCount: 2 },
            guests: seats.map((_, i) => ({ firstName: `Г${i}`, lastName: 'Г' })),
            seats,
          }),
          'ru-ru',
        ),
      );
      const placed = stay.guest_count_info.guest_counts.reduce(
        (n: number, g: { count: number }) => n + g.count,
        0,
      );
      expect(placed).toBe(seats.length);
    }
  });

  it('переносит имя, телефон и почту гостя — ради этого всё и затевалось', () => {
    const body = buildIbeBooking('801', rq(), 'ru-ru');
    expect(res(body).customer.first_name).toBe('Асель');
    expect(res(body).customer.contact_info.phones[0].phone_number).toBe('+77015554433');
    expect(res(body).customer.contact_info.emails[0].email_address).toBe('a@example.com');
    expect(res(body).customer.comment).toBe('поздний заезд');
    expect(stayOf(body).guests[0]).toMatchObject({ first_name: 'Асель', last_name: 'Нурланова' });
  });

  it('не отправляет пустую почту — движок считает её невалидной', () => {
    const base = rq();
    base.customer.contacts.emails = [{ emailAddress: '' }];
    expect(res(buildIbeBooking('801', base, 'ru-ru')).customer.contact_info.emails).toEqual([]);
  });
});

describe('выбор способа оплаты', () => {
  it('берёт оплату при заселении — гостю не нужна карта, чтобы забронировать', () => {
    expect(
      pickGuarantee([
        { code: '5020186', payment_system_code: 'HALYKBANK', require_prepayment: true },
        AT_ARRIVAL,
      ])?.code,
    ).toBe('3052');
  });

  it('если оплаты при заселении нет — берёт любой способ без предоплаты', () => {
    expect(
      pickGuarantee([
        { code: '99', payment_system_code: 'HALYKBANK', require_prepayment: true },
        { code: '77', payment_system_code: 'TLPAYMENTS', require_prepayment: false },
      ])?.code,
    ).toBe('77');
  });

  it('без вариантов возвращает ничего, а не выдуманный код', () => {
    expect(pickGuarantee([])).toBeUndefined();
    expect(pickGuarantee(undefined)).toBeUndefined();
  });
});

describe('разбор отказов', () => {
  it('доносит текст движка до журнала', () => {
    expect(
      describeErrors({ errors: [{ message: 'emails is empty', location: 'customer.emails' }] }),
    ).toBe('emails is empty (customer.emails)');
  });

  it('не молчит, когда движок не назвал причину', () => {
    expect(describeErrors({})).toContain('не назвал причину');
  });
});

/** Отвечает по очереди на availability → verify → create → readback. */
function fakeFetch(replies: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const r = replies[calls.length - 1] ?? { body: {} };
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body ?? {},
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const AVAILABLE = {
  room_stays: [
    {
      room_types: [{ code: '6154', placements: [{ code: '10128397' }] }],
      rate_plans: [{ code: '349868' }],
    },
  ],
};
const VERIFIED = { hotel_reservations: [{ guarantee_options: [AT_ARRIVAL] }] };
const CREATED = {
  hotel_reservations: [
    {
      number: '20261226-801-1261650447',
      cancellation_code: 'WZ1FDN1',
      status: 'unconfirmed',
      guarantee_info: {
        status: 'accepted',
        guarantees: [{ code: '3052', payment_url: 'https://kz-ibe.test/bg/payment?session=abc' }],
      },
    },
  ],
};
const READ_CONFIRMED = {
  hotel_reservations: [{ status: 'confirmed', total: { price_after_tax: 46750 } }],
};

type Reply = { status?: number; body?: unknown };
const happy = (): Reply[] => [
  { body: AVAILABLE },
  { body: VERIFIED },
  { body: CREATED },
  { body: {} }, // GET payment_url
  { body: READ_CONFIRMED },
];

describe('оформление брони', () => {
  it('идёт по всем четырём шагам и возвращает номер', async () => {
    const { impl, calls } = fakeFetch(happy());
    const out = await new IbeReservation('801', { fetchImpl: impl }).place(rq());

    expect(calls.map((c) => c.url.split('/').pop()?.split('?')[0])).toEqual([
      'hotel_availability',
      'verify_reservation',
      'hotel_reservation_2',
      'payment', // GET по payment_url
      'read_reservation_2',
    ]);
    // Место берётся из каталога движка, а не из поиска Exely — коды у них разные.
    expect(calls[2].body.hotel_reservations[0].room_stays[0].room_types[0].placements).toEqual([
      { code: '10128397', index: 1, kind: 'adult' },
    ]);
    expect(out).toMatchObject({
      ok: true,
      number: '20261226-801-1261650447',
      cancellationCode: 'WZ1FDN1',
      status: 'confirmed',
      total: 46750,
    });
  });

  it('ОБЯЗАТЕЛЬНО открывает payment_url — без него бронь остаётся неподтверждённой', async () => {
    // Контрольный опыт на живом движке: та же бронь без этого шага через двадцать секунд
    // всё ещё unconfirmed, с ним — confirmed.
    const { impl, calls } = fakeFetch(happy());
    await new IbeReservation('801', { fetchImpl: impl }).place(rq());
    expect(calls.some((c) => c.url === 'https://kz-ibe.test/bg/payment?session=abc')).toBe(true);
  });

  it('бронь считается оформленной ТОЛЬКО по чтению из системы отеля', async () => {
    // Ответ на создание уже дважды возвращал номер брони, которой не существовало.
    const replies = happy();
    replies[4] = { body: { hotel_reservations: [{ status: 'unconfirmed' }] } };
    const { impl } = fakeFetch(replies);
    const out = await new IbeReservation('801', { fetchImpl: impl }).place(rq());
    expect(out.ok).toBe(false);
    expect(out.error).toContain('unconfirmed');
    // Номер сообщаем — сотрудникам он нужен, чтобы разобраться с повисшей бронью.
    expect(out.number).toBe('20261226-801-1261650447');
  });

  it('бронь не читается обратно — это тоже не успех', async () => {
    const replies = happy();
    replies[4] = { body: {} };
    const { impl } = fakeFetch(replies);
    expect((await new IbeReservation('801', { fetchImpl: impl }).place(rq())).ok).toBe(false);
  });

  it('движок ответил без номера — это НЕ бронь, и мы так и говорим', async () => {
    const replies = happy();
    replies[2] = { body: { hotel_reservations: [{}], errors: [{ message: 'emails is empty' }] } };
    const { impl } = fakeFetch(replies);
    const out = await new IbeReservation('801', { fetchImpl: impl }).place(rq());
    expect(out.ok).toBe(false);
    expect(out.error).toContain('emails is empty');
  });

  it('номер разобрали, пока гость думал — не выдумываем бронь', async () => {
    const { impl, calls } = fakeFetch([{ body: { room_stays: [] } }]);
    const out = await new IbeReservation('801', { fetchImpl: impl }).place(rq());
    expect(out.ok).toBe(false);
    expect(out.error).toContain('недоступен');
    expect(calls).toHaveLength(1);
  });

  it('способ оплаты не предложен — бронь не создаём', async () => {
    const { impl, calls } = fakeFetch([{ body: AVAILABLE }, { body: { hotel_reservations: [{}] } }]);
    const out = await new IbeReservation('801', { fetchImpl: impl }).place(rq());
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('на отказ движка отвечает ok:false, а не падает — иначе гость теряет и ссылку', async () => {
    const { impl } = fakeFetch([{ status: 500 }]);
    const out = await new IbeReservation('801', { fetchImpl: impl }).place(rq());
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toContain('500');
  });

  it('сеть отвалилась — тоже ok:false', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await new IbeReservation('801', { fetchImpl: impl }).place(rq())).toMatchObject({
      ok: false,
      error: 'ECONNRESET',
    });
  });

  it('честно признаёт, что отменить бронь не умеет', async () => {
    const client = new IbeReservation('801');
    expect(client.supportsCancel).toBe(false);
    await expect(client.cancel()).rejects.toThrow();
  });
});

describe('номер, по которому бронь ищут в отеле', () => {
  /** Отдаёт ваучер с заданным заголовком; сам ваучер — последний вызов. */
  function withVoucher(title: string) {
    const replies = happy();
    replies[4] = {
      body: { hotel_reservations: [{ status: 'confirmed', order_url: 'https://secure.exely.test/v/1' }] },
    };
    const calls: string[] = [];
    const impl = vi.fn(async (url: string, init: any) => {
      calls.push(String(url));
      const i = calls.length - 1;
      if (String(url).startsWith('https://secure.exely.test')) {
        return { ok: true, status: 200, text: async () => title } as unknown as Response;
      }
      const r = replies[i] ?? { body: {} };
      return {
        ok: (r.status ?? 200) < 400,
        status: r.status ?? 200,
        json: async () => r.body ?? {},
        text: async () => '',
      } as unknown as Response;
    });
    return impl as unknown as typeof fetch;
  }

  it('берёт короткий номер из ваучера', async () => {
    const impl = withVoucher('<title>Подтверждение бронирования. Бронирование № 683546</title>');
    const out = await new IbeReservation('801', {
      fetchImpl: impl,
      voucherRetryDelaysMs: [0],
    }).place(rq());
    expect(out.hotelNumber).toBe('683546');
    expect(out.voucherUrl).toBe('https://secure.exely.test/v/1');
  });

  it('НЕ принимает служебный номер за короткий', async () => {
    // Пока Exely не присвоил короткий номер, ваучер показывает служебный. Без проверки
    // «дальше не цифра и не дефис» гость получал «номер брони 20270210» — такого нет.
    const impl = withVoucher('<title>Бронирование № 20270210-801-1261781092</title>');
    const out = await new IbeReservation('801', {
      fetchImpl: impl,
      voucherRetryDelaysMs: [0],
    }).place(rq());
    expect(out.ok).toBe(true);
    expect(out.hotelNumber).toBeUndefined();
  });
});
