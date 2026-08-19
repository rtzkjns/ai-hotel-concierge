import { describe, it, expect, vi } from 'vitest';
import { BookingService } from '../src/core/booking';
import { ExelyReservation } from '../src/integrations/exely/reservation';
import type { AvailabilityResult, RoomOffer } from '../src/integrations/exely/types';
import type { Booking, BookingLead } from '../src/types';

const offer: RoomOffer = {
  roomType: 'Comfort Double',
  available: true,
  pricePerNight: 40000,
  currency: 'KZT',
  roomTypeId: '42',
  ratePlanId: '7',
  ratePlanName: 'Best Available Rate',
  totalPrice: 120000,
  checksum: 'chk-fresh',
  placements: ['DBL'],
  bookingFormLink: 'https://book.example/comfort',
};

function fakeStore() {
  const bookings: Booking[] = [];
  const leads: BookingLead[] = [];
  const events: string[] = [];
  return {
    bookings,
    leads,
    events,
    saveBooking: vi.fn((b: Booking) => bookings.push(b)),
    updateBookingStatus: vi.fn(),
    saveLead: vi.fn((l: BookingLead) => leads.push(l)),
    recordEvent: vi.fn((type: string) => events.push(type)),
    listBookings: () => bookings,
  };
}

function fakeProvider(offers: RoomOffer[]) {
  return {
    checkAvailability: vi.fn(
      async (): Promise<AvailabilityResult> => ({
        property: 'almaty',
        checkIn: '2026-08-10',
        checkOut: '2026-08-13',
        offers,
        source: 'exely',
      }),
    ),
  };
}

const resolver = (key: string): string | undefined => (key === 'almaty' ? '801' : undefined);

const args = {
  conversationId: 'telegram:1',
  property: 'almaty',
  checkIn: '2026-08-10',
  checkOut: '2026-08-13',
  guests: 2,
  roomTypeId: '42',
  ratePlanId: '7',
  guestFirstName: 'Aida',
  guestLastName: 'Bekova',
  guestPhone: '+77001234567',
  guestEmail: 'aida@example.com',
  comment: 'Late arrival',
};

describe('BookingService.createBooking', () => {
  it('re-searches, places the booking and saves it as confirmed', async () => {
    const http = { resPost: vi.fn(), resGet: vi.fn() };
    http.resPost
      .mockResolvedValueOnce({ booking: { createBookingToken: 'tok-1' } })
      .mockResolvedValueOnce({
        booking: { number: 'KZ-77', status: 'confirmed', total: { priceBeforeTax: 120000 } },
      });
    const store = fakeStore();
    const provider = fakeProvider([offer]);
    const service = new BookingService({
      store,
      provider,
      reservation: new ExelyReservation(http),
      bookingEnabled: true,
      propertyIdResolver: resolver,
    });

    const result = await service.createBooking(args);

    expect(result).toEqual({
      mode: 'confirmed',
      number: 'KZ-77',
      total: 120000, // tax-inclusive
      currency: 'KZT',
      checkIn: '2026-08-10',
      checkOut: '2026-08-13',
      roomType: 'Comfort Double',
      ratePlanName: 'Best Available Rate',
      guests: 2,
      cancellation: null,
      // Этот бэкенд кода отмены не выдаёт — гость его и не получит.
      cancellationCode: null,
    });

    // Fresh availability was re-searched — never a stale checksum.
    expect(provider.checkAvailability).toHaveBeenCalledWith({
      property: 'almaty',
      checkIn: '2026-08-10',
      checkOut: '2026-08-13',
      guests: 2,
    });

    // Verify request carries the freshly searched offer verbatim.
    const [, verifyPayload] = http.resPost.mock.calls[0] as [string, { booking: unknown }];
    const booking = verifyPayload.booking as {
      propertyId: string;
      roomStays: Array<{
        checksum: string;
        ratePlan: { id: string };
        roomType: { id: string; placements: Array<{ code: string }> };
        guestCount: { adultCount: number };
      }>;
    };
    expect(booking.propertyId).toBe('801');
    expect(booking.roomStays[0].checksum).toBe('chk-fresh');
    expect(booking.roomStays[0].ratePlan.id).toBe('7');
    expect(booking.roomStays[0].roomType.id).toBe('42');
    expect(booking.roomStays[0].roomType.placements).toEqual([{ code: 'DBL' }]);
    expect(booking.roomStays[0].guestCount.adultCount).toBe(2);

    expect(store.saveBooking).toHaveBeenCalledTimes(1);
    const saved = store.bookings[0];
    expect(saved.exelyNumber).toBe('KZ-77');
    expect(saved.status).toBe('confirmed');
    expect(saved.total).toBe(120000);
    expect(store.events).toContain('booking_created');
    expect(store.saveLead).not.toHaveBeenCalled();
  });

  it('falls back to the booking link when Exely returns 403 on verify', async () => {
    const http = {
      resPost: vi.fn().mockRejectedValue(
        new Error('Exely POST /api/reservation/v1/bookings/verify → HTTP 403: scope disabled'),
      ),
      resGet: vi.fn(),
    };
    const store = fakeStore();
    const service = new BookingService({
      store,
      provider: fakeProvider([offer]),
      reservation: new ExelyReservation(http),
      bookingEnabled: true,
      propertyIdResolver: resolver,
    });

    const result = await service.createBooking(args);

    expect(result.mode).toBe('link');
    if (result.mode === 'link') {
      expect(result.bookingFormLink).toBe('https://book.example/comfort');
      expect(result.reason).toContain('403');
    }
    expect(store.saveBooking).not.toHaveBeenCalled();
    expect(store.saveLead).toHaveBeenCalledTimes(1);
    expect(store.leads[0].kind).toBe('booking');
    expect(store.leads[0].contactPhone).toBe('+77001234567');
    expect(store.events).toContain('booking_link_sent');
    expect(store.events).not.toContain('booking_created');
  });

  it('never calls the Reservation API when bookingEnabled is false', async () => {
    const http = { resPost: vi.fn(), resGet: vi.fn() };
    const store = fakeStore();
    const service = new BookingService({
      store,
      provider: fakeProvider([offer]),
      reservation: new ExelyReservation(http),
      bookingEnabled: false,
      propertyIdResolver: resolver,
    });

    const result = await service.createBooking(args);

    expect(result.mode).toBe('link');
    expect(http.resPost).not.toHaveBeenCalled();
    expect(http.resGet).not.toHaveBeenCalled();
    expect(store.saveLead).toHaveBeenCalledTimes(1);
    expect(store.events).toContain('booking_link_sent');
  });

  it('falls back to link mode when no matching bookable offer is found', async () => {
    const http = { resPost: vi.fn(), resGet: vi.fn() };
    const store = fakeStore();
    const service = new BookingService({
      store,
      provider: fakeProvider([{ ...offer, checksum: null }]), // not bookable
      reservation: new ExelyReservation(http),
      bookingEnabled: true,
      propertyIdResolver: resolver,
    });

    const result = await service.createBooking(args);

    expect(result.mode).toBe('link');
    if (result.mode === 'link') expect(result.reason).toBe('offer_not_found');
    expect(http.resPost).not.toHaveBeenCalled();
    expect(store.saveLead).toHaveBeenCalledTimes(1);
  });
});

describe('BookingService.cancelBooking', () => {
  it('cancels remotely and updates the local status', async () => {
    const http = { resPost: vi.fn().mockResolvedValue({}), resGet: vi.fn() };
    const store = fakeStore();
    const service = new BookingService({
      store,
      provider: fakeProvider([]),
      reservation: new ExelyReservation(http),
      bookingEnabled: true,
      propertyIdResolver: resolver,
    });

    const result = await service.cancelBooking('KZ-77', 'guest asked');

    expect(result.ok).toBe(true);
    expect(http.resPost).toHaveBeenCalledWith('/v1/bookings/KZ-77/cancel', {
      reason: 'guest asked',
    });
    expect(store.updateBookingStatus).toHaveBeenCalledWith('KZ-77', 'cancelled');
    expect(store.events).toContain('booking_cancelled');
  });

  it('routes cancel to the cabinet that owns the stored booking (multi-cabinet)', async () => {
    const almatyHttp = { resPost: vi.fn().mockResolvedValue({}), resGet: vi.fn() };
    const astanaHttp = { resPost: vi.fn().mockResolvedValue({}), resGet: vi.fn() };
    const store = fakeStore();
    // A booking that lives in the Astana cabinet.
    store.bookings.push({
      conversationId: 'wa:1',
      property: 'astana',
      exelyNumber: 'AST-9',
      status: 'confirmed',
      checkIn: '2026-08-10',
      checkOut: '2026-08-12',
      guests: 2,
      roomType: 'Standard',
      total: 50000,
      currency: 'KZT',
      guestName: 'A B',
      guestPhone: '+7700',
      upsellOffered: false,
      upsellAccepted: false,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    const reservations: Record<string, ExelyReservation> = {
      almaty: new ExelyReservation(almatyHttp),
      astana: new ExelyReservation(astanaHttp),
    };
    const service = new BookingService({
      store,
      provider: fakeProvider([]),
      reservationFor: (p) => reservations[p],
      bookingEnabledFor: (p) => p === 'astana',
      propertyIdResolver: (p) => (p === 'astana' ? '900' : undefined),
    });

    const result = await service.cancelBooking('AST-9', 'guest asked');

    expect(result.ok).toBe(true);
    expect(astanaHttp.resPost).toHaveBeenCalledWith('/v1/bookings/AST-9/cancel', {
      reason: 'guest asked',
    });
    expect(almatyHttp.resPost).not.toHaveBeenCalled(); // wrong cabinet never touched
    expect(store.updateBookingStatus).toHaveBeenCalledWith('AST-9', 'cancelled');
  });

  it('reports the error and keeps the local status when the remote cancel fails', async () => {
    const http = {
      resPost: vi.fn().mockRejectedValue(new Error('Exely POST → HTTP 403: nope')),
      resGet: vi.fn(),
    };
    const store = fakeStore();
    const service = new BookingService({
      store,
      provider: fakeProvider([]),
      reservation: new ExelyReservation(http),
      bookingEnabled: true,
      propertyIdResolver: resolver,
    });

    const result = await service.cancelBooking('KZ-77', 'guest asked');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('403');
    expect(store.updateBookingStatus).not.toHaveBeenCalled();
  });
});

describe('BookingService.bookingStatus', () => {
  it('asks Exely when booking is enabled', async () => {
    const http = {
      resPost: vi.fn(),
      resGet: vi.fn().mockResolvedValue({ booking: { number: 'KZ-77', status: 'confirmed' } }),
    };
    const store = fakeStore();
    const service = new BookingService({
      store,
      provider: fakeProvider([]),
      reservation: new ExelyReservation(http),
      bookingEnabled: true,
      propertyIdResolver: resolver,
    });

    const result = await service.bookingStatus('KZ-77');
    expect(result).toEqual({ source: 'exely', status: 'confirmed' });
  });

  it('falls back to the local bookings table when disabled', async () => {
    const store = fakeStore();
    store.bookings.push({
      conversationId: 'telegram:1',
      property: 'almaty',
      exelyNumber: 'KZ-77',
      status: 'confirmed',
      checkIn: '2026-08-10',
      checkOut: '2026-08-13',
      guests: 2,
      roomType: 'Comfort Double',
      createdAt: new Date().toISOString(),
    });
    const service = new BookingService({
      store,
      provider: fakeProvider([]),
      bookingEnabled: false,
      propertyIdResolver: resolver,
    });

    const result = await service.bookingStatus('KZ-77');
    expect(result).toEqual({ source: 'local', status: 'confirmed' });

    const missing = await service.bookingStatus('NOPE');
    expect(missing).toEqual({ source: 'local', status: null });
  });
});

describe('BookingService.createBooking — Round-2 hardening', () => {
  function confirmedHttp() {
    const http = { resPost: vi.fn(), resGet: vi.fn() };
    http.resPost
      .mockResolvedValueOnce({ booking: { createBookingToken: 'tok-1' } })
      .mockResolvedValueOnce({
        booking: {
          number: 'KZ-77',
          status: 'confirmed',
          total: { priceBeforeTax: 100000, taxAmount: 20000 },
        },
      });
    return http;
  }
  function svc(http: ReturnType<typeof confirmedHttp>, store = fakeStore()) {
    return {
      store,
      service: new BookingService({
        store,
        provider: fakeProvider([offer]),
        reservation: new ExelyReservation(http),
        bookingEnabled: true,
        propertyIdResolver: resolver,
      }),
    };
  }

  it('sends the owner-confirmed 15:00 check-in / 12:00 check-out to Exely', async () => {
    const http = confirmedHttp();
    await svc(http).service.createBooking(args);
    const [, payload] = http.resPost.mock.calls[0] as [
      string,
      { booking: { roomStays: Array<{ stayDates: { arrivalDateTime: string; departureDateTime: string } }> } },
    ];
    expect(payload.booking.roomStays[0].stayDates.arrivalDateTime).toBe('2026-08-10T15:00:00');
    expect(payload.booking.roomStays[0].stayDates.departureDateTime).toBe('2026-08-13T12:00:00');
  });

  it('is idempotent: a repeated confirmation returns the SAME booking, no second remote create', async () => {
    const http = confirmedHttp();
    const { service, store } = svc(http);
    const first = await service.createBooking(args);
    const second = await service.createBooking(args); // guest double-taps «подтверждаю»
    expect(first.mode).toBe('confirmed');
    expect(second.mode).toBe('confirmed');
    if (first.mode === 'confirmed' && second.mode === 'confirmed') {
      expect(second.number).toBe(first.number);
    }
    expect(http.resPost).toHaveBeenCalledTimes(2); // verify+create ONCE, not twice
    expect(store.saveBooking).toHaveBeenCalledTimes(1);
  });

  it('still confirms (never loses the number) when saveBooking throws after a real create', async () => {
    const http = confirmedHttp();
    const store = fakeStore();
    store.saveBooking = vi.fn(() => {
      throw new Error('db locked');
    });
    const { service } = svc(http, store);
    const result = await service.createBooking(args);
    expect(result.mode).toBe('confirmed');
    if (result.mode === 'confirmed') expect(result.number).toBe('KZ-77');
    expect(store.events).toContain('booking_save_failed');
  });

  it('threads childAges into the re-search and childCount into the Exely booking', async () => {
    const http = confirmedHttp();
    const store = fakeStore();
    const provider = fakeProvider([offer]);
    const service = new BookingService({
      store,
      provider,
      reservation: new ExelyReservation(http),
      bookingEnabled: true,
      propertyIdResolver: resolver,
    });
    await service.createBooking({ ...args, childAges: [7] });
    expect(provider.checkAvailability).toHaveBeenCalledWith(expect.objectContaining({ childAges: [7] }));
    const [, payload] = http.resPost.mock.calls[0] as [
      string,
      { booking: { roomStays: Array<{ guestCount: { adultCount: number; childCount?: number } }> } },
    ];
    expect(payload.booking.roomStays[0].guestCount.childCount).toBe(1);
  });

  it('reserves the upsell tag so a long guest comment never clips it', async () => {
    const http = confirmedHttp();
    await svc(http).service.createBooking({
      ...args,
      comment: 'x'.repeat(600),
      upsellAccepted: ['early_checkin'],
    });
    const [, payload] = http.resPost.mock.calls[0] as [string, { booking: { customer: { comment: string } } }];
    const comment = payload.booking.customer.comment;
    expect(comment).toContain('[upsell: early_checkin]'); // tag survived
    expect(comment.length).toBeLessThanOrEqual(500);
  });

  it('falls back to the offer price when Exely returns a zero total (never «итого 0»)', async () => {
    const http = { resPost: vi.fn(), resGet: vi.fn() };
    http.resPost
      .mockResolvedValueOnce({ booking: { createBookingToken: 'tok-1' } })
      .mockResolvedValueOnce({
        booking: { number: 'KZ-77', status: 'confirmed', total: { priceBeforeTax: 0, taxAmount: 0 } },
      });
    const result = await svc(http).service.createBooking(args);
    expect(result.mode).toBe('confirmed');
    if (result.mode === 'confirmed') expect(result.total).toBe(120000); // offer.totalPrice, not 0
  });
});
