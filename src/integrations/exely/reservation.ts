// Exely Reservation API v1 client (creates real bookings in Edelweiss, like the
// hotel's own site). Port of kazzhol-portal src/Integrations/Exely/Reservation.php.
// Flow: Search (checksum+ratePlan+roomType+placements) → verify (createBookingToken)
// → create (number). verify() never creates a booking; create() DOES.
//
// NOTE: the Reservation scope currently returns HTTP 403 for this account
// (not enabled hotel-side) — place()/cancel() degrade to ok:false, never throw.
import type { RoomOffer } from './types';

const COMMENT_MAX_CHARS = 500;

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
    roomType: { id: string; placements: Array<{ code: string }> };
    guests: Array<{ firstName: string; lastName: string }>;
    guestCount: { adultCount: number };
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
  total?: { priceBeforeTax?: number };
  warnings?: unknown[];
}

export interface PlaceResult {
  ok: boolean;
  number?: string;
  status?: string;
  total?: number;
  warnings?: unknown[];
  error?: string;
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
): BookingRq {
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
        guestCount: { adultCount: Math.max(1, adults) },
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
      return {
        ok: Boolean(created.number),
        number: created.number,
        status: created.status,
        total: created.total?.priceBeforeTax,
        warnings: created.warnings ?? [],
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
