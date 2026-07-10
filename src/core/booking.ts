// Booking orchestration: re-search → (verify → create) via Exely Reservation,
// or degrade to the guest-facing bookingFormLink + a saved lead when direct
// booking is disabled, unavailable (HTTP 403), or the offer disappeared.
import { track } from './events';
import type { AvailabilityProvider } from '../integrations/exely/provider';
import type { PropertyIdResolver } from '../integrations/exely/live';
import { buildBooking, type ExelyReservation } from '../integrations/exely/reservation';
import type { RoomOffer } from '../integrations/exely/types';
import type { Booking, BookingLead } from '../types';

// The hotels' fixed check-in/check-out times (Asia/Almaty local).
const CHECK_IN_TIME = 'T14:00:00';
const CHECK_OUT_TIME = 'T12:00:00';

/** The subset of Store the booking service needs (structural, for easy faking). */
export interface BookingStore {
  saveBooking(b: Booking): void;
  updateBookingStatus(exelyNumber: string, status: string): void;
  saveLead(lead: BookingLead): void;
  recordEvent(
    type: string,
    data?: { conversationId?: string; property?: string; channel?: string; payload?: unknown },
  ): void;
  listBookings(): Booking[];
}

export interface BookingServiceDeps {
  store: BookingStore;
  provider: AvailabilityProvider;
  reservation?: ExelyReservation;
  bookingEnabled: boolean;
  propertyIdResolver: PropertyIdResolver;
}

export interface CreateBookingArgs {
  conversationId: string;
  property: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  guests: number;
  roomTypeId: string;
  ratePlanId: string;
  guestFirstName: string;
  guestLastName: string;
  guestPhone: string;
  guestEmail?: string;
  comment?: string;
  upsellAccepted?: string[];
}

export type CreateBookingResult =
  | { mode: 'confirmed'; number: string; total: number | null; currency: string }
  | { mode: 'link'; bookingFormLink: string | null; reason: string };

export interface CancelBookingResult {
  ok: boolean;
  error?: string;
}

export interface BookingStatusResult {
  source: 'exely' | 'local';
  status: string | null;
}

export class BookingService {
  constructor(private readonly deps: BookingServiceDeps) {}

  async createBooking(args: CreateBookingArgs): Promise<CreateBookingResult> {
    const { store, provider, reservation, bookingEnabled, propertyIdResolver } = this.deps;

    // Always re-search: prices change and a stale checksum is rejected by Exely.
    const availability = await provider.checkAvailability({
      property: args.property,
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      guests: args.guests,
    });
    const offer = availability.offers.find(
      (o) =>
        o.checksum !== null && o.roomTypeId === args.roomTypeId && o.ratePlanId === args.ratePlanId,
    );
    const propertyId = propertyIdResolver(args.property);

    let reason: string;
    if (!bookingEnabled || !reservation) {
      reason = 'booking_disabled';
    } else if (!propertyId) {
      reason = 'property_not_wired';
    } else if (!offer) {
      reason = 'offer_not_found';
    } else {
      const booking = buildBooking(
        propertyId,
        offer,
        `${args.checkIn}${CHECK_IN_TIME}`,
        `${args.checkOut}${CHECK_OUT_TIME}`,
        args.guests,
        {
          first: args.guestFirstName,
          last: args.guestLastName,
          phone: args.guestPhone,
          email: args.guestEmail,
        },
        args.comment ?? '',
      );
      const placed = await reservation.place(booking);
      if (placed.ok && placed.number) {
        const total = placed.total ?? offer.totalPrice ?? undefined;
        const upsellTaken = (args.upsellAccepted?.length ?? 0) > 0;
        store.saveBooking({
          conversationId: args.conversationId,
          property: args.property,
          exelyNumber: placed.number,
          status: placed.status ?? 'confirmed',
          checkIn: args.checkIn,
          checkOut: args.checkOut,
          guests: args.guests,
          roomType: offer.roomType,
          ratePlanId: offer.ratePlanId ?? undefined,
          total,
          currency: offer.currency,
          guestName: `${args.guestFirstName} ${args.guestLastName}`,
          guestPhone: args.guestPhone,
          upsellOffered: upsellTaken,
          upsellAccepted: upsellTaken,
          createdAt: new Date().toISOString(),
        });
        track(store, 'booking_created', {
          conversationId: args.conversationId,
          property: args.property,
          payload: { number: placed.number, total: total ?? null },
        });
        return {
          mode: 'confirmed',
          number: placed.number,
          total: total ?? null,
          currency: offer.currency,
        };
      }
      reason = placed.error ?? 'reservation_failed';
    }

    // Degraded path: save a lead; the bot sends the personal payment link
    // (bookingFormLink) and promises confirmation by the team.
    this.saveLinkLead(args, offer, reason);
    track(store, 'booking_link_sent', {
      conversationId: args.conversationId,
      property: args.property,
      payload: { reason },
    });
    return { mode: 'link', bookingFormLink: offer?.bookingFormLink ?? null, reason };
  }

  async cancelBooking(exelyNumber: string, reason = ''): Promise<CancelBookingResult> {
    const { store, reservation, bookingEnabled } = this.deps;
    if (bookingEnabled && reservation) {
      try {
        await reservation.cancel(exelyNumber, reason);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    store.updateBookingStatus(exelyNumber, 'cancelled');
    track(store, 'booking_cancelled', { payload: { exelyNumber, reason } });
    return { ok: true };
  }

  async bookingStatus(exelyNumber: string): Promise<BookingStatusResult> {
    const { store, reservation, bookingEnabled } = this.deps;
    if (bookingEnabled && reservation) {
      try {
        const raw = (await reservation.get(exelyNumber)) as {
          booking?: { status?: string };
          status?: string;
        };
        return { source: 'exely', status: raw.booking?.status ?? raw.status ?? null };
      } catch {
        // Fall through to the local record — status lookups must never crash the bot.
      }
    }
    const local = store.listBookings().find((b) => b.exelyNumber === exelyNumber);
    return { source: 'local', status: local?.status ?? null };
  }

  private saveLinkLead(
    args: CreateBookingArgs,
    offer: RoomOffer | undefined,
    reason: string,
  ): void {
    const details = [
      `direct booking unavailable (${reason})`,
      `ratePlanId=${args.ratePlanId}`,
      `roomTypeId=${args.roomTypeId}`,
      offer?.bookingFormLink ? `link=${offer.bookingFormLink}` : null,
      args.upsellAccepted?.length ? `upsell=${args.upsellAccepted.join(',')}` : null,
      args.comment ? `comment: ${args.comment}` : null,
    ]
      .filter((s): s is string => s !== null)
      .join('; ');
    this.deps.store.saveLead({
      conversationId: args.conversationId,
      kind: 'booking',
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      guests: args.guests,
      roomType: offer?.roomType ?? args.roomTypeId,
      contactName: `${args.guestFirstName} ${args.guestLastName}`,
      contactPhone: args.guestPhone,
      specialRequests: details,
      createdAt: new Date().toISOString(),
    });
  }
}
