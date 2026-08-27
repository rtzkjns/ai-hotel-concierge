// Exely Reservation API v1 client (creates real bookings in Edelweiss, like the
// hotel's own site). Port of kazzhol-portal src/Integrations/Exely/Reservation.php.
// Flow: Search (checksum+ratePlan+roomType+placements) → verify (createBookingToken)
// → create (number). verify() never creates a booking; create() DOES.
//
// NOTE: the Reservation scope currently returns HTTP 403 for this account
// (not enabled hotel-side) — place()/cancel() degrade to ok:false, never throw.
import type { RoomOffer } from './types';

export const COMMENT_MAX_CHARS = 500;

/** The subset of ExelyHttp the Reservation API needs (structural, for easy faking). */
export interface ReservationHttp {
  resPost(path: string, body: unknown): Promise<unknown>;
  resGet(path: string): Promise<unknown>;
}

export interface GuestInfo {
  first: string;
  last: string;
  phone: string;
  email?: string;
}

export interface BookingRq {
  propertyId: string;
  roomStays: Array<{
    stayDates: { arrivalDateTime: string; departureDateTime: string };
    ratePlan: { id: string };
    roomType: {
      id: string;
      // index/kind/capacity приходят от движка (hotel_availability) и обязательны для
      // дополнительных мест: extra_adult нельзя объявлять «adult». У пути Exely Search
      // их нет — тогда работает прежняя раскладка.
      placements: Array<{ code: string; index?: number; kind?: string; capacity?: number }>;
    };
    guests: Array<{ firstName: string; lastName: string }>;
    guestCount: { adultCount: number; childCount?: number; childAges?: number[] };
    /**
     * Раскладка гостей ПО СЛОВАМ ДВИЖКА — по одной записи на человека.
     * Движок в ответе на поиск сам говорит, кого куда сажать; мы это повторяем, а не
     * выводим заново. Оба прежних дефекта («Invalid adult placement», «More guests than
     * it allows») родились именно из самодеятельности. Пусто — значит движка не
     * спрашивали (путь Exely Search), тогда работает прежняя раскладка.
     */
    seats?: Array<{ index: number; kind: string; age?: number; ageGroup?: number }>;
    checksum: string;
    services?: Array<{ id: string }>;
  }>;
  customer: {
    firstName: string;
    lastName: string;
    contacts: {
      phones: Array<{ phoneNumber: string }>;
      emails: Array<{ emailAddress: string }>;
    };
    comment: string;
  };
}

interface VerifiedBooking {
  createBookingToken?: string;
  warnings?: unknown[];
}

interface CreatedBooking {
  number?: string;
  status?: string;
  total?: { priceBeforeTax?: number; taxAmount?: number };
  warnings?: unknown[];
}

export interface PlaceResult {
  ok: boolean;
  number?: string;
  status?: string;
  total?: number;
  warnings?: unknown[];
  error?: string;
  /** Code the guest quotes to change or cancel the stay (booking-engine path). */
  cancellationCode?: string;
  /**
   * The short number hotel staff search by. The long `number` above is labelled «служебный
   * номер» in the hotel's own paperwork, and quoting it is why staff could not find bookings.
   */
  hotelNumber?: string;
  /** Exely's guest voucher — proof the booking exists, and something staff can open. */
  voucherUrl?: string;
}

/**
 * What BookingService needs from a booking back-end. An interface rather than the class,
 * so the Reservation API and the booking engine are interchangeable — the engine is what
 * actually works today, but the moment Exely opens the documented write scope the swap is
 * one line in the router and nothing else changes.
 */
export interface ReservationClient {
  place(booking: BookingRq): Promise<PlaceResult>;
  cancel(number: string, reason?: string): Promise<unknown>;
  get(number: string): Promise<unknown>;
  /** false when the back-end cannot cancel remotely — staff must do it by hand. */
  readonly supportsCancel?: boolean;
}

/**
 * Build the BookingRq for verify/create from a freshly searched offer.
 * The offer MUST come straight from Search — its checksum goes stale when prices change.
 */
export function buildBooking(
  propertyId: string,
  offer: RoomOffer,
  arrivalDateTime: string,
  departureDateTime: string,
  adults: number,
  guest: GuestInfo,
  comment = '',
  childAges: number[] = [],
): BookingRq {
  const childCount = childAges.length;
  return {
    propertyId,
    roomStays: [
      {
        stayDates: { arrivalDateTime, departureDateTime },
        ratePlan: { id: offer.ratePlanId ?? '' },
        roomType: {
          id: offer.roomTypeId ?? '',
          placements: offer.placements.map((code) => ({ code })),
        },
        guests: [{ firstName: guest.first, lastName: guest.last }],
        guestCount:
          childCount > 0
            ? { adultCount: Math.max(1, adults), childCount, childAges }
            : { adultCount: Math.max(1, adults) },
        checksum: offer.checksum ?? '',
      },
    ],
    customer: {
      firstName: guest.first,
      lastName: guest.last,
      contacts: {
        phones: [{ phoneNumber: guest.phone }],
        emails: [{ emailAddress: guest.email ?? '' }],
      },
      comment: comment.slice(0, COMMENT_MAX_CHARS),
    },
  };
}

export class ExelyReservation {
  constructor(private readonly http: ReservationHttp) {}

  /** POST /v1/bookings/verify — validation + createBookingToken. Creates nothing. */
  async verify(booking: BookingRq): Promise<VerifiedBooking> {
    const res = (await this.http.resPost('/v1/bookings/verify', { booking })) as {
      booking?: VerifiedBooking;
    };
    return res.booking ?? {};
  }

  /** POST /v1/bookings — creates a REAL booking in Edelweiss. */
  async create(booking: BookingRq, createBookingToken: string): Promise<CreatedBooking> {
    const res = (await this.http.resPost('/v1/bookings', {
      booking: { ...booking, createBookingToken },
    })) as { booking?: CreatedBooking };
    return res.booking ?? {};
  }

  /** GET /v1/bookings/{number} */
  get(number: string): Promise<unknown> {
    return this.http.resGet(`/v1/bookings/${encodeURIComponent(number)}`);
  }

  /** POST /v1/bookings/{number}/cancel */
  cancel(number: string, reason = ''): Promise<unknown> {
    return this.http.resPost(
      `/v1/bookings/${encodeURIComponent(number)}/cancel`,
      reason !== '' ? { reason } : {},
    );
  }

  /**
   * Full verify → create flow for one booking. Creates nothing when verify
   * returns no createBookingToken. Any thrown error (including the current
   * account-wide HTTP 403) becomes ok:false — this path must never crash the bot.
   */
  async place(booking: BookingRq): Promise<PlaceResult> {
    try {
      const verified = await this.verify(booking);
      const token = verified.createBookingToken;
      if (!token) {
        return {
          ok: false,
          error: 'verify: no createBookingToken',
          warnings: verified.warnings ?? [],
        };
      }
      const created = await this.create(booking, token);
      // The guest pays the tax-inclusive total — never quote priceBeforeTax on a receipt.
      const t = created.total;
      const total =
        t && (t.priceBeforeTax !== undefined || t.taxAmount !== undefined)
          ? (t.priceBeforeTax ?? 0) + (t.taxAmount ?? 0)
          : undefined;
      return {
        ok: Boolean(created.number),
        number: created.number,
        status: created.status,
        total,
        warnings: created.warnings ?? [],
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
