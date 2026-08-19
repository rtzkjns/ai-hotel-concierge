/**
 * Booking through Exely's own booking engine (IBE) — the path the hotel's website uses.
 *
 * Why this exists: the documented Reservation API answers HTTP 403 «You cannot consume this
 * service» on all three Kazzhol cabinets, so `ExelyReservation.place()` can never create
 * anything. Without it the guest who already gave dates, room, name and phone in chat had to
 * retype all of it on the booking form. This client talks to the same endpoints kazzhol.com's
 * embedded booking form talks to, so the guest confirms once and the booking lands in
 * Edelweiss for real.
 *
 * It is deliberately shaped like ExelyReservation (`place`/`cancel`/`get`) so BookingService —
 * with its re-search, idempotency guard, lead saving and event tracking — works unchanged.
 *
 * Two honest limitations, both handled rather than hidden:
 *  - These endpoints are internal to TravelLine and undocumented, so they may change without
 *    notice. Every failure degrades to the booking link instead of throwing; the bot never
 *    tells a guest a booking exists unless the engine returned a number.
 *  - There is no cancellation endpoint here, so `supportsCancel` is false and BookingService
 *    routes cancellations to staff. Never claim to a guest that a cancellation went through.
 */

import type { BookingRq, PlaceResult, ReservationClient } from './reservation';

export const IBE_BASE_URL = 'https://ibe.hopenapi.com/ApiWebDistribution/BookingForm';

/** Refuse to hang the whole reply on a slow engine — the link fallback is always ready. */
const TIMEOUT_MS = 20_000;

export interface IbeDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** IBE locale, e.g. 'ru-ru'. Drives the language of the confirmation e-mail it sends. */
  language?: string;
}

interface GuaranteeOption {
  code?: string;
  payment_system_code?: string;
  require_prepayment?: boolean;
  name?: string;
}

interface IbeReservationBody {
  status?: string;
  number?: string;
  cancellation_code?: string;
  guarantee_options?: GuaranteeOption[];
  total?: { price_after_tax?: number; price_before_tax?: number; currency?: string };
}

interface IbeRoomStay {
  room_types?: Array<{ code?: string; placements?: Array<{ code?: string | number }> }>;
  rate_plans?: Array<{ code?: string }>;
}

interface IbeResponse {
  hotel_reservations?: IbeReservationBody[];
  room_stays?: IbeRoomStay[];
  error?: unknown;
  errors?: unknown;
}

/** «2026-09-15T15:00:00» → «2026-09-15 15:00:00»: the engine rejects the ISO «T». */
export function ibeDateTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

/**
 * Translate the Reservation-API request shape into the engine's.
 *
 * The placement mapping is the subtle part. A double room is normally ONE placement of
 * capacity two, and the engine then wants a single guest_count of two adults pinned to it —
 * splitting that into two counts is rejected. Only when the room really exposes a placement
 * per adult do we hand out one adult each.
 */
export function buildIbeBooking(
  propertyId: string,
  b: BookingRq,
  language: string,
  guaranteeCode?: string,
): Record<string, unknown> {
  const roomStays = b.roomStays.map((rs) => {
    const placements = rs.roomType.placements.map((p, i) => ({
      code: String(p.code),
      index: i + 1,
      kind: 'adult',
    }));
    if (placements.length === 0) placements.push({ code: '', index: 1, kind: 'adult' });
    const adults = Math.max(1, rs.guestCount.adultCount);

    const guestCounts =
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
              placement_index: placements[0].index,
            },
          ];

    return {
      guest_count_info: { guest_counts: guestCounts },
      rate_plans: [{ code: rs.ratePlan.id }],
      room_types: [{ code: rs.roomType.id, placements }],
      stay_dates: {
        start_date: ibeDateTime(rs.stayDates.arrivalDateTime),
        end_date: ibeDateTime(rs.stayDates.departureDateTime),
      },
      // Every guest sits in the first placement unless the room hands out one each; the
      // engine only needs the lead guest, the rest are taken at check-in.
      guests: rs.guests.map((g, i) => ({
        first_name: g.firstName,
        last_name: g.lastName,
        middle_name: '',
        placement: { index: placements[Math.min(i, placements.length - 1)].index },
      })),
    };
  });

  const hotelReservation: Record<string, unknown> = {
    hotel_ref: { code: propertyId },
    room_stays: roomStays,
  };
  if (guaranteeCode) hotelReservation.guarantee_info = { code: guaranteeCode };

  return {
    currency: 'KZT',
    language,
    point_of_sale: {},
    include_extra_stay_options: true,
    include_guarantee_options: true,
    hotel_reservations: [
      {
        ...hotelReservation,
        customer: {
          first_name: b.customer.firstName,
          last_name: b.customer.lastName,
          middle_name: '',
          comment: b.customer.comment ?? '',
          confirm_sms: false,
          contact_info: {
            emails: b.customer.contacts.emails
              .filter((e) => e.emailAddress)
              .map((e) => ({ email_address: e.emailAddress })),
            phones: b.customer.contacts.phones
              .filter((p) => p.phoneNumber)
              .map((p) => ({ phone_number: p.phoneNumber, tech_type: '' })),
          },
        },
      },
    ],
  };
}

/**
 * Pick how the guest pays. Default is «при заселении»: it needs no card, no redirect and no
 * payment page, so the guest really does just press one button. Prepaid options exist but
 * would leave a half-finished booking if the guest never reached the bank — not something to
 * hand a bot without a human watching.
 */
export function pickGuarantee(options: GuaranteeOption[] | undefined): string | undefined {
  if (!options?.length) return undefined;
  const atArrival = options.find((o) => o.payment_system_code === 'AT_ARRIVAL');
  if (atArrival?.code) return atArrival.code;
  const free = options.find((o) => o.require_prepayment === false);
  return free?.code ?? options[0]?.code;
}

export class IbeReservation implements ReservationClient {
  /** The engine exposes no cancellation call — staff cancel in Edelweiss. */
  readonly supportsCancel = false;

  constructor(
    private readonly propertyId: string,
    private readonly deps: IbeDeps = {},
  ) {}

  private async call(path: string, body: unknown): Promise<IbeResponse> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const base = this.deps.baseUrl ?? IBE_BASE_URL;
    const res = await doFetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ibe ${path}: HTTP ${res.status}`);
    return (await res.json()) as IbeResponse;
  }

  /**
   * Спрашивает у движка коды мест размещения для выбранного номера.
   *
   * Без этого шага бронь не оформить. Поиск Exely отдаёт места символьно («AdultBed-2»), а
   * движок ждёт свой числовой код («10128397») и на чужой отвечает «code is invalid». Коды
   * номера и тарифа при этом у них общие, так что ищем по ним.
   *
   * Побочная польза: это ещё и живая проверка, что номер не разобрали, пока гость думал.
   */
  async placementsFor(
    propertyId: string,
    stay: BookingRq['roomStays'][number],
  ): Promise<string[] | null> {
    const res = await this.call('hotel_availability', {
      language: this.deps.language ?? 'ru-ru',
      currency: 'KZT',
      criterions: [
        {
          hotels: [{ code: propertyId }],
          guests: [
            { age_qualifying_code: 'adult', count: Math.max(1, stay.guestCount.adultCount) },
          ],
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
    const codes = match?.room_types?.[0]?.placements
      ?.map((p) => String(p.code ?? ''))
      .filter((c) => c !== '');
    return codes?.length ? codes : null;
  }

  /** Validates and prices the stay. Creates nothing — safe to call freely. */
  async verify(propertyId: string, b: BookingRq): Promise<IbeReservationBody> {
    const res = await this.call(
      'verify_reservation',
      buildIbeBooking(propertyId, b, this.deps.language ?? 'ru-ru'),
    );
    return res.hotel_reservations?.[0] ?? {};
  }

  /** Creates a REAL booking in the hotel's system. */
  async place(b: BookingRq): Promise<PlaceResult> {
    try {
      // Verify first, exactly as the website does: it rejects a stale price or a sold-out
      // room BEFORE anything is created, and it tells us which payment methods this rate
      // actually allows — the codes differ per hotel, so they must not be hard-coded.
      const propertyId = b.propertyId || this.propertyId;

      // Подменяем места на те, что понимает движок. Делаем это до verify: без них
      // проверка всё равно упадёт на «code is invalid».
      const roomStays = [];
      for (const stay of b.roomStays) {
        const placements = await this.placementsFor(propertyId, stay);
        if (!placements) {
          return { ok: false, error: 'ibe: номер недоступен на эти даты' };
        }
        roomStays.push({ ...stay, roomType: { ...stay.roomType, placements: placements.map((code) => ({ code })) } });
      }
      const resolved: BookingRq = { ...b, roomStays };

      const verified = await this.verify(propertyId, resolved);
      const guarantee = pickGuarantee(verified.guarantee_options);

      const res = await this.call(
        'hotel_reservation_2',
        buildIbeBooking(propertyId, resolved, this.deps.language ?? 'ru-ru', guarantee),
      );
      const created = res.hotel_reservations?.[0];
      if (!created?.number) {
        return { ok: false, error: 'ibe: движок не вернул номер брони' };
      }
      const total = created.total?.price_after_tax ?? created.total?.price_before_tax;
      return {
        ok: true,
        number: created.number,
        status: created.status ?? 'unconfirmed',
        total: typeof total === 'number' && total > 0 ? total : undefined,
        cancellationCode: created.cancellation_code,
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

  async get(): Promise<unknown> {
    throw new Error('ibe: чтение брони через движок недоступно');
  }
}
