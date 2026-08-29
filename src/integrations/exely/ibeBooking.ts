/**
 * Booking through Exely's own booking engine — the path the hotel's website uses.
 *
 * The documented Reservation API answers HTTP 403 on every Kazzhol cabinet and Exely has
 * refused to open it, so this is the only way a booking made in chat can reach the hotel.
 * These endpoints are the ones kazzhol.com's embedded form calls; they are internal to
 * TravelLine and undocumented, so everything here was recovered by driving that form and
 * comparing requests.
 *
 * FOUR STEPS, ALL REQUIRED — a booking that skips any of them is not a booking:
 *   1. hotel_availability   — the engine's own numeric placement code for the room.
 *   2. verify_reservation   — validates, and lists which payment methods the rate allows.
 *   3. hotel_reservation_2  — creates the reservation and returns a payment_url.
 *   4. GET payment_url      — flips it from «unconfirmed» to «confirmed».
 * Then read_reservation_2 reads it back, and ONLY a readback saying «confirmed» is treated
 * as success.
 *
 * That last rule is the point of this file. An earlier version sent the guarantee under
 * `guarantee_info` — which is the RESPONSE field name; the request field is `guarantee`.
 * The engine silently discarded the unknown key and happily returned a reservation number
 * for a booking with no payment guarantee, which never reached the hotel and never mailed
 * the guest. We shipped it, because a number in a 200 response looked like proof. It is
 * not. Both mistakes are now impossible to repeat quietly: step 4 is verified by step 5,
 * and place() cannot return ok:true without it.
 */

import type { BookingRq, PlaceResult, ReservationClient } from './reservation';
import { activeTenant } from '../../tenant';

/** Region host for Kazakhstan properties — RegionMap/host answers this for code 801. */
export const IBE_BASE_URL = 'https://kz-ibe.hopenapi.com/ApiWebDistribution/BookingForm';

/** Refuse to hang the whole reply on a slow engine — the booking link is always ready. */
const TIMEOUT_MS = 20_000;

/**
 * Sales channel this booking is attributed to. The hotel's site sends its integration key
 * here; an empty point_of_sale is accepted but leaves the booking unattributed.
 */
export const DEFAULT_INTEGRATION_KEY = 'BE-INT-kazzhol-mediacorporation-kz_2024-11-06';

/** Where the engine sends the guest after a card payment. Unused for pay-at-hotel, required anyway. */
// Guest-visible: the browser is redirected here after paying/declining. From the tenant brand so a
// second tenant's guest isn't bounced to kazzhol.com. For Kazzhol this is kazzhol.com/ru/booking.
const RETURN_URL = `https://${activeTenant.brand.website}/ru/booking`;

export interface IbeDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** IBE locale, e.g. 'ru-ru'. Drives the language of the confirmation e-mail it sends. */
  language?: string;
  /** Integration key without the property suffix. Defaults to Kazzhol's when unset. */
  integrationKey?: string;
  /** Post-payment guest redirect URL. Defaults to the tenant brand's /ru/booking when unset. */
  returnUrl?: string;
  /** Паузы между попытками достать номер из ваучера. В тестах — [0], чтобы не спать. */
  voucherRetryDelaysMs?: number[];
}

interface GuaranteeOption {
  code?: string;
  payment_system_code?: string;
  require_prepayment?: boolean;
  name?: string;
}

interface IbeReservationBody {
  status?: string;
  order_url?: string;
  number?: string;
  cancellation_code?: string;
  guarantee_options?: GuaranteeOption[];
  guarantee_info?: {
    status?: string;
    guarantees?: Array<{ code?: string; payment_system_code?: string; payment_url?: string }>;
  };
  total?: { price_after_tax?: number; price_before_tax?: number; currency?: string };
}

interface IbeRoomStay {
  room_types?: Array<{
    code?: string;
    placements?: Array<{
      code?: string | number;
      index?: number;
      kind?: string;
      capacity?: number;
    }>;
  }>;
  rate_plans?: Array<{ code?: string }>;
  /** Движок сам расписывает, кого куда сажать — это эталон, а не подсказка. */
  guests?: Array<{
    placement?: { index?: number; kind?: string; age_group?: number };
    age?: number;
    age_group?: number;
    count?: number;
  }>;
}

interface IbeResponse {
  hotel_reservations?: IbeReservationBody[];
  room_stays?: IbeRoomStay[];
  errors?: unknown;
}

/** «2026-09-15T15:00:00» → «2026-09-15 15:00:00»: the engine rejects the ISO «T». */
export function ibeDateTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

/** Собирает жалобы движка в одну строку — иначе любой отказ выглядит одинаково. */
export function describeErrors(res: IbeResponse): string {
  const list = Array.isArray(res.errors) ? res.errors : [];
  const parts = list
    .map((e) => {
      const o = e as { message?: string; location?: string };
      return o.message ? `${o.message}${o.location ? ` (${o.location})` : ''}` : null;
    })
    .filter((s): s is string => s !== null);
  return parts.length ? parts.join('; ') : 'движок не назвал причину';
}

/**
 * Pick how the guest pays. Default is «при заселении»: it needs no card and no redirect to a
 * bank, so nothing is left half-finished if the guest closes the chat. Prepaid options exist
 * but would strand a booking mid-payment with no human watching.
 */
/**
 * Берём ТОЛЬКО тот способ оплаты, который мы способны довести до конца сами.
 *
 * Раньше в крайнем случае брался options[0] — то есть подошла бы и гарантия банковской
 * картой. Карты у нас нет: бронь создалась бы и навсегда осталась неподтверждённой, а
 * гостю мы бы сказали «оформлено». Найдено на тарифе «Long Stay» (заезды от 30 ночей
 * в Алматы и Park), где оплаты при заселении нет вовсе.
 *
 * Ничего не подошло — пусть гость дооформит на форме отеля, где карту ввести можно.
 */
export function pickGuarantee(options: GuaranteeOption[] | undefined): GuaranteeOption | undefined {
  if (!options?.length) return undefined;
  return (
    options.find((o) => o.payment_system_code === 'AT_ARRIVAL') ??
    options.find((o) => o.require_prepayment === false)
  );
}

/**
 * Translate the Reservation-API request shape into the engine's.
 *
 * The placement mapping is the subtle part. A double room is normally ONE placement of
 * capacity two, and the engine then wants a single guest_count of two adults pinned to it —
 * splitting that into two counts is rejected. Only when the room really exposes a placement
 * per adult do we hand out one each.
 */
export function buildIbeBooking(
  propertyId: string,
  b: BookingRq,
  language: string,
  opts: { guarantee?: GuaranteeOption; integrationKey?: string; returnUrl?: string } = {},
): Record<string, unknown> {
  const returnUrl = opts.returnUrl ?? RETURN_URL;
  const roomStays = b.roomStays.map((rs) => {
    // Вид места приходит от движка и выдумывать его нельзя. Family room отдаёт основное
    // место (kind adult, вместимость 2) и дополнительное (kind extra_adult, вместимость 1);
    // объявив второе «adult», мы получали «Invalid adult placement #10017731» и теряли бронь.
    const placements = rs.roomType.placements.map((p, i) => ({
      code: String(p.code),
      index: p.index ?? i + 1,
      kind: p.kind ?? 'adult',
    }));
    const adults = Math.max(1, rs.guestCount.adultCount);

    // Раскладка по вместимости — тоже со слов движка. Без неё троих взрослых сажало в место
    // на двоих. Если вместимость неизвестна (путь Exely Search, символьные коды) — прежнее
    // поведение: либо по гостю на место, либо все в первое.
    const capacities = rs.roomType.placements.map((p) => p.capacity);
    // Пустой список мест проходил every() вырожденно, раскладка выходила пустой, и движок
    // получал бронь без единого гостя. Требуем, чтобы места вообще были.
    const byCapacity =
      capacities.length > 0 && capacities.every((c) => typeof c === 'number' && c > 0);

    let guestCounts: Array<{
      age_qualifying_code: string;
      count: number;
      index: number;
      placement_index: number;
      age?: number;
      age_group?: number;
    }>;

    // Движок прислал готовую раскладку — повторяем её дословно. Это единственная ветка,
    // которая правильно селит детей: ребёнок занимает дополнительное место, но объявляется
    // своим возрастом и возрастной группой, иначе отель не узнает, что едет ребёнок.
    if (rs.seats?.length) {
      const merged = new Map<string, (typeof guestCounts)[number]>();
      for (const seat of rs.seats) {
        // Именно isFinite, а не typeof: NaN — тоже number, и с ним ребёнок уезжал
        // в движок как «child» с возрастом null.
        const isChild = Number.isFinite(seat.age);
        const key = `${seat.index}|${isChild ? 'child' : 'adult'}|${seat.age ?? ''}|${seat.ageGroup ?? ''}`;
        const hit = merged.get(key);
        if (hit) {
          hit.count += 1;
          continue;
        }
        merged.set(key, {
          age_qualifying_code: isChild ? 'child' : 'adult',
          count: 1,
          index: merged.size + 1,
          placement_index: seat.index,
          ...(isChild ? { age: seat.age } : {}),
          ...(isChild && seat.ageGroup !== undefined ? { age_group: seat.ageGroup } : {}),
        });
      }
      guestCounts = [...merged.values()];
    } else if (byCapacity) {
      guestCounts = [];
      let left = adults;
      for (const [i, p] of placements.entries()) {
        if (left <= 0) break;
        const take = Math.min(left, capacities[i] as number);
        guestCounts.push({
          age_qualifying_code: 'adult',
          count: take,
          index: guestCounts.length + 1,
          placement_index: p.index,
        });
        left -= take;
      }
      // Мест не хватило на всех — движок откажет честнее, чем мы молча потеряем гостя.
      if (left > 0 && guestCounts.length > 0) {
        guestCounts[guestCounts.length - 1].count += left;
      }
    } else {
      guestCounts =
        placements.length >= adults
          ? placements.slice(0, adults).map((p, i) => ({
              age_qualifying_code: 'adult',
              count: 1,
              index: i + 1,
              placement_index: p.index,
            }))
          : [
              {
                age_qualifying_code: 'adult',
                count: adults,
                index: 1,
                placement_index: placements[0]?.index ?? 1,
              },
            ];
    }

    // Гостя надо посадить в то же место, в которое мы его посчитали.
    const seatByGuest: number[] = [];
    for (const g of guestCounts) {
      for (let n = 0; n < g.count; n += 1) seatByGuest.push(g.placement_index);
    }

    return {
      advanced_services: [],
      guest_count_info: { guest_counts: guestCounts },
      rate_plans: [{ code: rs.ratePlan.id }],
      room_types: [{ code: rs.roomType.id, placements, preferences: [] }],
      services: [],
      stay_dates: {
        start_date: ibeDateTime(rs.stayDates.arrivalDateTime),
        end_date: ibeDateTime(rs.stayDates.departureDateTime),
      },
      // Достаточно ведущего гостя: остальных отель записывает при заселении.
      guests: rs.guests.map((g, i) => ({
        first_name: g.firstName,
        last_name: g.lastName,
        middle_name: '',
        placement: {
          index:
            seatByGuest[i] ?? placements[Math.min(i, placements.length - 1)]?.index ?? 1,
        },
      })),
    };
  });

  const reservation: Record<string, unknown> = {
    hotel_ref: { code: propertyId },
    room_stays: roomStays,
    services: [],
    transfers: [],
    customer: {
      first_name: b.customer.firstName,
      last_name: b.customer.lastName,
      middle_name: '',
      comment: b.customer.comment ?? '',
      confirm_sms: false,
      subscribe_email: false,
      contact_info: {
        emails: b.customer.contacts.emails
          .filter((e) => e.emailAddress)
          .map((e) => ({ email_address: e.emailAddress })),
        phones: b.customer.contacts.phones
          .filter((p) => p.phoneNumber)
          .map((p) => ({ phone_number: p.phoneNumber, tech_type: '' })),
      },
    },
  };

  // ЭТО поле называется `guarantee`, а не `guarantee_info`. Ошибка в имени не вызывает
  // отказа: движок молча выбрасывает неизвестный ключ и создаёт бронь без гарантии оплаты,
  // которая до отеля не доходит. Именно так мы однажды и отгрузили пустышки.
  if (opts.guarantee?.code) {
    reservation.guarantee = {
      code: opts.guarantee.code,
      success_url: returnUrl,
      decline_url: returnUrl,
    };
  }

  const key = opts.integrationKey;
  return {
    currency: 'KZT',
    language,
    include_extra_stay_options: false,
    point_of_sale: key
      ? { source_url: returnUrl, integration_key: `${key}.${propertyId}` }
      : {},
    hotel_reservations: [reservation],
  };
}

/**
 * Вытаскивает короткий номер брони из HTML ваучера.
 *
 * «Бронирование № 683546» — то же число, что в теме письма гостю и в поиске отеля.
 * Проверка «дальше не цифра и не дефис» обязательна: пока Exely не присвоил короткий
 * номер, в заголовке стоит служебный (20270210-801-…), и без неё отсюда возвращались
 * первые восемь его цифр — номер, которого не существует.
 */
export function parseVoucherNumber(html: string): string | undefined {
  return /Бронирование\s*№\s*(\d{4,9})(?![\d-])/.exec(html)?.[1];
}

/** Тянет короткий номер, повторяя попытки: Exely присваивает его асинхронно. */
export async function fetchVoucherNumber(
  orderUrl: string,
  opts: { fetchImpl?: typeof fetch; delaysMs?: number[] } = {},
): Promise<string | undefined> {
  const doFetch = opts.fetchImpl ?? fetch;
  for (const waitMs of opts.delaysMs ?? [0, 6_000, 9_000]) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    try {
      const res = await doFetch(orderUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) continue;
      const found = parseVoucherNumber(await res.text());
      if (found) return found;
    } catch {
      // Ваучер — удобство, а не условие брони: молча пробуем ещё раз.
    }
  }
  return undefined;
}

export class IbeReservation implements ReservationClient {
  /** Отмену движок не отдаёт — бронь снимает сотрудник в Edelweiss. */
  readonly supportsCancel = false;

  constructor(
    private readonly propertyId: string,
    private readonly deps: IbeDeps = {},
  ) {}

  private get language(): string {
    return this.deps.language ?? 'ru-ru';
  }

  private async call(path: string, body: unknown): Promise<IbeResponse> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const base = this.deps.baseUrl ?? IBE_BASE_URL;
    const res = await doFetch(`${base}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        accept: 'application/json, text/plain, */*',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ibe ${path}: HTTP ${res.status}`);
    return (await res.json()) as IbeResponse;
  }

  /**
   * Спрашивает у движка коды мест размещения для выбранного номера.
   *
   * Поиск Exely отдаёт места символьно («AdultBed-2»), а движок ждёт свой числовой код и на
   * чужой отвечает «code is invalid». Коды номера и тарифа у них общие, поэтому ищем по ним.
   * Побочная польза: это живая проверка, что номер не разобрали, пока гость думал.
   */
  async placementsFor(
    propertyId: string,
    stay: BookingRq['roomStays'][number],
  ): Promise<{
    placements: BookingRq['roomStays'][number]['roomType']['placements'];
    seats: NonNullable<BookingRq['roomStays'][number]['seats']>;
  } | null> {
    // Детей обязательно называем здесь: спросив места только под взрослых, мы получали
    // набор на меньшую компанию и ловили «More guests have been assigned to room than
    // it allows». Возраст влияет и на цену, и на то, какое место ребёнку разрешено.
    const guests: Array<Record<string, unknown>> = [
      { age_qualifying_code: 'adult', count: Math.max(1, stay.guestCount.adultCount) },
    ];
    for (const age of stay.guestCount.childAges ?? []) {
      guests.push({ age_qualifying_code: 'child', count: 1, age });
    }
    const res = await this.call('hotel_availability', {
      language: this.language,
      currency: 'KZT',
      criterions: [
        {
          hotels: [{ code: propertyId }],
          guests,
          start_date: ibeDateTime(stay.stayDates.arrivalDateTime),
          end_date: ibeDateTime(stay.stayDates.departureDateTime),
        },
      ],
    });
    const stays = res.room_stays ?? [];
    const sameRoom = (s: IbeRoomStay): boolean => s.room_types?.[0]?.code === stay.roomType.id;
    // Тариф уточняет выбор, но если именно его уже нет — берём тот же номер по другому
    // тарифу, а не отказываем гостю совсем.
    const match =
      stays.find((s) => sameRoom(s) && s.rate_plans?.[0]?.code === stay.ratePlan.id) ??
      stays.find(sameRoom);
    // Отдаём место целиком, а не один код: без вида (kind) движок отвергает дополнительные
    // места, без вместимости мы сажаем в них лишних гостей.
    const found = match?.room_types?.[0]?.placements
      ?.map((p, i) => ({
        code: String(p.code ?? ''),
        index: p.index ?? i + 1,
        kind: p.kind ?? 'adult',
        capacity: p.capacity,
      }))
      .filter((p) => p.code !== '');
    if (!found?.length) return null;

    // Готовая раскладка от движка — по записи на человека. Её и повторим.
    const seats: NonNullable<BookingRq['roomStays'][number]['seats']> = [];
    for (const g of match?.guests ?? []) {
      const index = g.placement?.index;
      if (typeof index !== 'number') continue;
      for (let n = 0; n < Math.max(1, g.count ?? 1); n += 1) {
        seats.push({
          index,
          kind: g.placement?.kind ?? 'adult',
          age: g.age,
          ageGroup: g.age_group ?? g.placement?.age_group,
        });
      }
    }
    return { placements: found, seats };
  }

  /**
   * Достаёт номер брони, который видят сотрудники отеля, и ссылку на ваучер.
   *
   * Это оказалось причиной жалобы «брони не видно». Длинный номер вида
   * 20261218-801-1261642948 в самом ваучере подписан «Служебный номер»; человеческий номер
   * брони — шестизначный (683546), он стоит в заголовке ваучера, по нему отель и ищет.
   * Мы всё время называли сотрудникам служебный.
   *
   * Exely присваивает его АСИНХРОННО: первые секунд сорок ваучер показывает в заголовке всё
   * тот же служебный номер. Поэтому мало подождать — надо ещё и не принять служебный номер за
   * короткий: без проверки «дальше не цифра и не дефис» regex откусывал от 20270210-801-…
   * первые восемь цифр и выдавал гостю «номер брони 20270210», которого не существует.
   * Держать гостя минуту ради этого нельзя, поэтому ждём недолго и спокойно возвращаем
   * undefined — бронь от этого не перестаёт существовать, а звать её есть чем.
   */
  voucherNumber(orderUrl: string): Promise<string | undefined> {
    return fetchVoucherNumber(orderUrl, {
      fetchImpl: this.deps.fetchImpl,
      delaysMs: this.deps.voucherRetryDelaysMs,
    });
  }

  /** Читает бронь обратно. Единственный независимый способ узнать, существует ли она. */
  async read(number: string, cancellationCode: string): Promise<IbeReservationBody | null> {
    const res = await this.call('read_reservation_2', {
      language: this.language,
      hotel_reservation_refs: [
        { number, verification: { cancellation_code: cancellationCode } },
      ],
    });
    return res.hotel_reservations?.[0] ?? null;
  }

  /**
   * Проходит по ссылке оплаты. Для оплаты при заселении платить нечего, но БЕЗ этого шага
   * бронь навсегда остаётся «unconfirmed» — проверено контрольным опытом: та же бронь без
   * него через двадцать секунд всё ещё unconfirmed, с ним — confirmed.
   */
  private async settle(paymentUrl: string): Promise<void> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    await doFetch(paymentUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => undefined);
  }

  /** Creates a REAL booking and confirms it. Returns ok only when a readback says so. */
  async place(b: BookingRq): Promise<PlaceResult> {
    try {
      const propertyId = b.propertyId || this.propertyId;

      // Места движка вместо символьных из поиска Exely — иначе «code is invalid».
      const roomStays: BookingRq['roomStays'] = [];
      for (const stay of b.roomStays) {
        const occupancy = await this.placementsFor(propertyId, stay);
        if (!occupancy) return { ok: false, error: 'ibe: номер недоступен на эти даты' };
        roomStays.push({
          ...stay,
          roomType: { ...stay.roomType, placements: occupancy.placements },
          seats: occupancy.seats,
        });
      }
      const resolved: BookingRq = { ...b, roomStays };
      const integrationKey = this.deps.integrationKey ?? DEFAULT_INTEGRATION_KEY;
      const returnUrl = this.deps.returnUrl;

      // Какие способы оплаты допускает этот тариф — коды разные у каждого отеля,
      // поэтому спрашиваем, а не зашиваем.
      const verified = await this.call('verify_reservation', {
        ...buildIbeBooking(propertyId, resolved, this.language, { integrationKey, returnUrl }),
        include_guarantee_options: true,
      });
      const guarantee = pickGuarantee(verified.hotel_reservations?.[0]?.guarantee_options);
      if (!guarantee?.code) {
        return { ok: false, error: `ibe: нет доступного способа оплаты — ${describeErrors(verified)}` };
      }

      const res = await this.call(
        'hotel_reservation_2',
        buildIbeBooking(propertyId, resolved, this.language, { guarantee, integrationKey, returnUrl }),
      );
      const created = res.hotel_reservations?.[0];
      if (!created?.number || !created.cancellation_code) {
        return { ok: false, error: `ibe: бронь не создана — ${describeErrors(res)}` };
      }

      const paymentUrl = created.guarantee_info?.guarantees?.[0]?.payment_url;
      if (paymentUrl) await this.settle(paymentUrl);

      // Итог решает ЧТЕНИЕ, а не ответ на создание. Номер в ответе однажды уже оказался
      // номером несуществующей брони, и гостю было сказано, что всё готово.
      const back = await this.read(created.number, created.cancellation_code);
      if (back?.status !== 'confirmed') {
        return {
          ok: false,
          error: `ibe: бронь ${created.number} осталась в статусе «${back?.status ?? 'неизвестно'}»`,
          number: created.number,
        };
      }

      const total = back.total?.price_after_tax ?? back.total?.price_before_tax;
      const voucherUrl = back.order_url;
      // Живой ваучер — ещё одно независимое подтверждение: у несуществующей брони он 403.
      const hotelNumber = voucherUrl ? await this.voucherNumber(voucherUrl) : undefined;
      return {
        ok: true,
        number: created.number,
        status: back.status,
        total: typeof total === 'number' && total > 0 ? total : undefined,
        cancellationCode: created.cancellation_code,
        hotelNumber,
        voucherUrl,
        warnings: [],
      };
    } catch (err) {
      // Never throw: BookingService turns ok:false into the booking link, which always works.
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async cancel(): Promise<unknown> {
    throw new Error('ibe: отмена через движок недоступна — снимает бронь сотрудник');
  }

  async get(number: string): Promise<unknown> {
    throw new Error(`ibe: чтение брони ${number} требует кода отмены`);
  }
}
