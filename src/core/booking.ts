// Booking orchestration: re-search → (verify → create) via Exely Reservation,
// or degrade to the guest-facing bookingFormLink + a saved lead when direct
// booking is disabled, unavailable (HTTP 403), or the offer disappeared.
import { track } from './events';
import type { AvailabilityProvider } from '../integrations/exely/provider';
import type { PropertyIdResolver } from '../integrations/exely/live';
import {
  buildBooking,
  COMMENT_MAX_CHARS,
  type ReservationClient,
} from '../integrations/exely/reservation';
import type { CancellationPolicy, RoomOffer } from '../integrations/exely/types';
import type { Booking, BookingLead, Language } from '../types';
import { localizeBookingLink } from '../integrations/exely/bookingLink';

// The Kazzhol hotels' fixed check-in/check-out times (Asia/Almaty local), confirmed by the
// owner as identical across every property: check-in 15:00, check-out 12:00.
const CHECK_IN_TIME = 'T15:00:00';
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
  propertyIdResolver: PropertyIdResolver;
  /**
   * Single-cabinet (legacy) reservation client + flag. Used when the per-property
   * resolvers below are not supplied.
   */
  reservation?: ReservationClient;
  bookingEnabled?: boolean;
  /**
   * Multi-cabinet: resolve the reservation client / booking flag per hotel, so
   * each property books against its own Exely account. When present, these win
   * over the single-cabinet fields above.
   */
  reservationFor?: (property: string) => ReservationClient | undefined;
  bookingEnabledFor?: (property: string) => boolean;
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
  /** Ages of children on the stay, if any — hotels price children by age. */
  childAges?: number[];
  /** Guest's language — the booking form must open in it, not in Russian. */
  language?: Language | null;
}

export type CreateBookingResult =
  | {
      mode: 'confirmed';
      number: string;
      total: number | null; // tax-inclusive
      currency: string;
      // Receipt fields so the bot can print a manager-style confirmation IN CHAT. On the direct
      // API path the guest may receive NO automatic email (the hotel is notified; guest email is
      // unverified — confirm with a real test booking once write-scope lands), so the chat message
      // is treated as the authoritative confirmation and the prompt never promises an email.
      checkIn: string;
      checkOut: string;
      roomType: string;
      ratePlanName: string | null;
      guests: number;
      cancellation: CancellationPolicy | null;
      /** Code the guest quotes to change or cancel; null when the back-end issues none. */
      cancellationCode?: string | null;
      /** Короткий номер, по которому бронь ищут сотрудники отеля. */
      hotelNumber?: string | null;
      /** Ваучер Exely — и доказательство брони, и то, что можно открыть глазами. */
      voucherUrl?: string | null;
    }
  | { mode: 'link'; bookingFormLink: string | null; reason: string };

export interface CancelBookingResult {
  ok: boolean;
  error?: string;
  /** true when the PMS was NOT reached — staff must cancel by hand (lead saved). */
  localOnly?: boolean;
}

export interface BookingStatusResult {
  source: 'exely' | 'local';
  status: string | null;
}

export class BookingService {
  constructor(private readonly deps: BookingServiceDeps) {}

  /** The reservation client for a hotel — per-cabinet resolver wins over the legacy single one. */
  private reservationFor(property: string): ReservationClient | undefined {
    return this.deps.reservationFor ? this.deps.reservationFor(property) : this.deps.reservation;
  }

  private bookingEnabledFor(property: string): boolean {
    return this.deps.bookingEnabledFor
      ? this.deps.bookingEnabledFor(property)
      : (this.deps.bookingEnabled ?? false);
  }

  /** Resolve which hotel a stored booking belongs to (for cancel/status routing). */
  private propertyOfBooking(exelyNumber: string): string | undefined {
    return this.deps.store.listBookings().find((b) => b.exelyNumber === exelyNumber)?.property;
  }

  /**
   * Собирает заявку для страницы подтверждения, ничего не оформляя.
   *
   * Цену и название номера берём живым поиском, а не из памяти диалога: гость увидит на
   * странице ровно то, что стоит в системе отеля сейчас. Оформление произойдёт позже, по
   * нажатию кнопки, и тогда поиск повторится ещё раз — между показом и нажатием номер
   * может уйти, и признать это честнее, чем подтвердить бронь, которой нет.
   */
  async prepareConfirmation(args: {
    property: string;
    checkIn: string;
    checkOut: string;
    guests: number;
    roomTypeId: string;
    ratePlanId: string;
    childAges?: number[];
    language?: Language | null;
  }): Promise<
    | { ok: true; offer: RoomOffer; bookingFormLink: string | null }
    | { ok: false; reason: string }
  > {
    try {
      const availability = await this.deps.provider.checkAvailability({
        property: args.property,
        checkIn: args.checkIn,
        checkOut: args.checkOut,
        guests: args.guests,
        childAges: args.childAges,
      });
      const offer =
        availability.offers.find(
          (o) => o.roomTypeId === args.roomTypeId && o.ratePlanId === args.ratePlanId,
        ) ?? availability.offers.find((o) => o.roomTypeId === args.roomTypeId);
      if (!offer) return { ok: false, reason: 'offer_not_found' };
      return {
        ok: true,
        offer,
        bookingFormLink: localizeBookingLink(
          offer.bookingFormLink,
          args.language,
          offer.roomTypeId ?? args.roomTypeId,
        ),
      };
    } catch {
      return { ok: false, reason: 'availability_unavailable' };
    }
  }

  async createBooking(args: CreateBookingArgs): Promise<CreateBookingResult> {
    const { store, provider, propertyIdResolver } = this.deps;
    const reservation = this.reservationFor(args.property);
    const bookingEnabled = this.bookingEnabledFor(args.property);

    // Always re-search: prices change and a stale checksum is rejected by Exely. Include
    // childAges so a family stay re-prices with the children, matching the search the guest saw.
    // Exely can time out or 5xx. WITHOUT this catch the throw escapes createBooking entirely and
    // the degraded path below (lead + booking link) never runs: the guest gets a generic error and
    // the hotel never learns a booking was attempted. A booking request must NEVER be lost silently.
    let availability: Awaited<ReturnType<typeof provider.checkAvailability>>;
    try {
      availability = await provider.checkAvailability({
        property: args.property,
        checkIn: args.checkIn,
        checkOut: args.checkOut,
        guests: args.guests,
        childAges: args.childAges,
      });
    } catch (err) {
      this.saveLinkLead(args, undefined, 'availability_unavailable');
      track(store, 'booking_link_sent', {
        conversationId: args.conversationId,
        property: args.property,
        payload: {
          reason: 'availability_unavailable',
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return { mode: 'link', bookingFormLink: null, reason: 'availability_unavailable' };
    }
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
      // Idempotency: if this conversation already holds a live booking for this exact stay,
      // return it instead of creating a duplicate — guards a double «подтверждаю» or the model
      // calling create_booking twice (each call would otherwise mint a NEW Exely number and a
      // second real charge). Match on conversation + hotel + dates + room.
      const existing = store
        .listBookings()
        .find(
          (bk) =>
            bk.conversationId === args.conversationId &&
            bk.property === args.property &&
            bk.checkIn === args.checkIn &&
            bk.checkOut === args.checkOut &&
            bk.roomType === offer.roomType &&
            bk.status !== 'cancelled' &&
            !!bk.exelyNumber,
        );
      if (existing) {
        return {
          mode: 'confirmed',
          number: existing.exelyNumber,
          total: existing.total ?? offer.totalPrice ?? null,
          currency: existing.currency ?? offer.currency,
          checkIn: existing.checkIn,
          checkOut: existing.checkOut,
          roomType: existing.roomType,
          ratePlanName: offer.ratePlanName,
          guests: existing.guests,
          cancellation: offer.cancellationPolicy ?? null,
        };
      }

      // Accepted upsells must reach the hotel: Exely has no upsell field we can set from here,
      // so they travel in the customer comment. Reserve the upsell tag's length before slicing
      // the guest text, so a long guest request never clips the tag (it MUST reach the hotel).
      const upsellNote = args.upsellAccepted?.length
        ? `[upsell: ${args.upsellAccepted.join(', ')}] `
        : '';
      const guestRoom = Math.max(0, COMMENT_MAX_CHARS - upsellNote.length);
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
        `${upsellNote}${(args.comment ?? '').slice(0, guestRoom)}`,
        args.childAges,
      );
      const placed = await reservation.place(booking);
      if (placed.ok && placed.number) {
        // A real booking is never free — treat a 0/absent remote total as unknown and fall back
        // to the searched offer price, so a receipt never reads «итого 0 ₸».
        const total =
          placed.total && placed.total > 0
            ? placed.total
            : offer.totalPrice && offer.totalPrice > 0
              ? offer.totalPrice
              : null;
        const upsellTaken = (args.upsellAccepted?.length ?? 0) > 0;
        // The prompt mandates exactly one upsell offer per booking flow, so a
        // completed booking counts as one offer; acceptance is tracked per item.
        track(store, 'upsell_offered', {
          conversationId: args.conversationId,
          property: args.property,
        });
        for (const item of args.upsellAccepted ?? []) {
          track(store, 'upsell_accepted', {
            conversationId: args.conversationId,
            property: args.property,
            payload: { item },
          });
        }
        // The remote booking already exists and the guest holds a real number — a failure of
        // the LOCAL mirror write must NEVER make us tell the guest it failed (that triggers a
        // retry → a second real booking). Record it for staff reconciliation and still confirm.
        try {
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
            total: total ?? undefined,
            currency: offer.currency,
            guestName: `${args.guestFirstName} ${args.guestLastName}`,
            guestPhone: args.guestPhone,
            // Без кода бронь нельзя ни перечитать, ни изменить — а перечитать её
            // единственный способ убедиться, что она вообще существует.
            cancellationCode: placed.cancellationCode,
            hotelNumber: placed.hotelNumber,
            upsellOffered: true,
            upsellAccepted: upsellTaken,
            createdAt: new Date().toISOString(),
          });
        } catch (err) {
          track(store, 'booking_save_failed', {
            conversationId: args.conversationId,
            property: args.property,
            payload: {
              number: placed.number,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
        track(store, 'booking_created', {
          conversationId: args.conversationId,
          property: args.property,
          payload: { number: placed.number, total: total ?? null },
        });
        return {
          mode: 'confirmed',
          number: placed.number,
          total,
          currency: offer.currency,
          checkIn: args.checkIn,
          checkOut: args.checkOut,
          roomType: offer.roomType,
          ratePlanName: offer.ratePlanName,
          guests: args.guests,
          cancellation: offer.cancellationPolicy ?? null,
          cancellationCode: placed.cancellationCode ?? null,
          hotelNumber: placed.hotelNumber ?? null,
          voucherUrl: placed.voucherUrl ?? null,
        };
      }
      reason = placed.error ?? 'reservation_failed';
    }

    // Degraded path: save a lead; the bot sends the personal payment link
    // (bookingFormLink) and promises confirmation by the team.
    // The link is the ONLY booking path in production, so when it is missing the model must be
    // told precisely why — otherwise `reason` stays 'booking_disabled' (write-scope is off by
    // design) and masks a genuinely missing link, and the bot promises a link it cannot send.
    // Localise the form and pin the priced room type — Exely always emits a Russian link, and for
    // variant room types it emits a room-type the offer does not match (guest sees «недоступен»).
    const bookingFormLink = localizeBookingLink(
      offer?.bookingFormLink ?? null,
      args.language,
      offer?.roomTypeId ?? args.roomTypeId,
    );
    // Keep an already-specific reason; only 'booking_disabled' (write-scope off BY DESIGN, so it
    // is the normal case in production) hides the fact that no link came back at all.
    const effectiveReason =
      bookingFormLink || reason !== 'booking_disabled'
        ? reason
        : offer
          ? 'offer_without_link'
          : 'no_offer_no_link';

    this.saveLinkLead(args, offer, effectiveReason);
    track(store, 'booking_link_sent', {
      conversationId: args.conversationId,
      property: args.property,
      payload: { reason: effectiveReason, hasLink: bookingFormLink !== null },
    });
    return { mode: 'link', bookingFormLink, reason: effectiveReason };
  }

  async cancelBooking(exelyNumber: string, reason = ''): Promise<CancelBookingResult> {
    const { store } = this.deps;
    // Route to the cabinet that owns this booking (falls back to the legacy client).
    const property = this.propertyOfBooking(exelyNumber);
    const reservation = property ? this.reservationFor(property) : this.deps.reservation;
    const bookingEnabled = property
      ? this.bookingEnabledFor(property)
      : (this.deps.bookingEnabled ?? false);
    // A back-end that cannot cancel remotely (the booking engine) must not be asked to try:
    // the call would fail and the guest would be told the cancellation failed, when in fact
    // it simply needs a person. Route it to staff instead.
    const remote = bookingEnabled && !!reservation && reservation.supportsCancel !== false;
    if (remote && reservation) {
      try {
        await reservation.cancel(exelyNumber, reason);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    } else {
      // No PMS access: the booking may still stand in Edelweiss (e.g. it was
      // made via bookingFormLink). Leave a lead so staff cancel it by hand.
      store.saveLead({
        conversationId: '',
        kind: 'generic',
        specialRequests: `CANCELLATION REQUEST (manual): booking ${exelyNumber}${reason ? `, reason: ${reason}` : ''} — PMS access disabled, cancel in Edelweiss/Exely by hand`,
        createdAt: new Date().toISOString(),
      });
    }
    store.updateBookingStatus(exelyNumber, 'cancelled');
    track(store, 'booking_cancelled', { payload: { exelyNumber, reason, remote } });
    return { ok: true, localOnly: !remote };
  }

  async bookingStatus(exelyNumber: string): Promise<BookingStatusResult> {
    const { store } = this.deps;
    const property = this.propertyOfBooking(exelyNumber);
    const reservation = property ? this.reservationFor(property) : this.deps.reservation;
    const bookingEnabled = property
      ? this.bookingEnabledFor(property)
      : (this.deps.bookingEnabled ?? false);
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
