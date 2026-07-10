import { describe, it, expect, vi } from 'vitest';
import { buildBooking, ExelyReservation } from '../src/integrations/exely/reservation';
import type { RoomOffer } from '../src/integrations/exely/types';

const offer: RoomOffer = {
  roomType: 'Comfort Double',
  available: true,
  pricePerNight: 40000,
  currency: 'KZT',
  roomTypeId: '42',
  ratePlanId: '7',
  ratePlanName: 'Best Available Rate',
  totalPrice: 120000,
  checksum: 'chk-1',
  placements: ['DBL', 'EXB'],
  bookingFormLink: 'https://book.example/comfort',
};

const guest = { first: 'Aida', last: 'Bekova', phone: '+77001234567', email: 'aida@example.com' };

describe('buildBooking', () => {
  it('builds a BookingRq matching the Exely Reservation shape', () => {
    const booking = buildBooking(
      '801',
      offer,
      '2026-08-10T14:00:00',
      '2026-08-13T12:00:00',
      2,
      guest,
      'Late arrival',
    );

    expect(booking).toEqual({
      propertyId: '801',
      roomStays: [
        {
          stayDates: {
            arrivalDateTime: '2026-08-10T14:00:00',
            departureDateTime: '2026-08-13T12:00:00',
          },
          ratePlan: { id: '7' },
          roomType: { id: '42', placements: [{ code: 'DBL' }, { code: 'EXB' }] },
          guests: [{ firstName: 'Aida', lastName: 'Bekova' }],
          guestCount: { adultCount: 2 },
          checksum: 'chk-1',
        },
      ],
      customer: {
        firstName: 'Aida',
        lastName: 'Bekova',
        contacts: {
          phones: [{ phoneNumber: '+77001234567' }],
          emails: [{ emailAddress: 'aida@example.com' }],
        },
        comment: 'Late arrival',
      },
    });
  });

  it('truncates the comment to 500 chars and enforces at least 1 adult', () => {
    const booking = buildBooking('801', offer, 'a', 'd', 0, guest, 'x'.repeat(600));
    expect(booking.customer.comment).toHaveLength(500);
    expect(booking.roomStays[0].guestCount.adultCount).toBe(1);
  });
});

function fakeHttp() {
  return { resPost: vi.fn(), resGet: vi.fn() };
}

const booking = buildBooking('801', offer, '2026-08-10T14:00:00', '2026-08-13T12:00:00', 2, guest);

describe('ExelyReservation.place', () => {
  it('runs verify then create and returns the booking number', async () => {
    const http = fakeHttp();
    http.resPost
      .mockResolvedValueOnce({ booking: { createBookingToken: 'tok-1' } })
      .mockResolvedValueOnce({
        booking: { number: 'KZ-77', status: 'confirmed', total: { priceBeforeTax: 120000 } },
      });
    const reservation = new ExelyReservation(http);

    const result = await reservation.place(booking);

    expect(result).toEqual({
      ok: true,
      number: 'KZ-77',
      status: 'confirmed',
      total: 120000,
      warnings: [],
    });
    expect(http.resPost).toHaveBeenNthCalledWith(1, '/v1/bookings/verify', { booking });
    expect(http.resPost).toHaveBeenNthCalledWith(2, '/v1/bookings', {
      booking: { ...booking, createBookingToken: 'tok-1' },
    });
  });

  it('does NOT create when verify returns no createBookingToken', async () => {
    const http = fakeHttp();
    http.resPost.mockResolvedValueOnce({ booking: { warnings: [{ code: 'w1' }] } });
    const reservation = new ExelyReservation(http);

    const result = await reservation.place(booking);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('verify: no createBookingToken');
    expect(result.warnings).toEqual([{ code: 'w1' }]);
    expect(http.resPost).toHaveBeenCalledTimes(1); // never reached create
  });

  it('degrades any thrown error (e.g. HTTP 403) into ok:false instead of rethrowing', async () => {
    const http = fakeHttp();
    http.resPost.mockRejectedValue(
      new Error('Exely POST /api/reservation/v1/bookings/verify → HTTP 403: scope disabled'),
    );
    const reservation = new ExelyReservation(http);

    const result = await reservation.place(booking);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('403');
  });
});

describe('ExelyReservation cancel/get', () => {
  it('cancels with a reason via the cancel endpoint', async () => {
    const http = fakeHttp();
    http.resPost.mockResolvedValue({});
    const reservation = new ExelyReservation(http);

    await reservation.cancel('KZ-77', 'guest asked');
    expect(http.resPost).toHaveBeenCalledWith('/v1/bookings/KZ-77/cancel', {
      reason: 'guest asked',
    });

    await reservation.cancel('KZ-77');
    expect(http.resPost).toHaveBeenLastCalledWith('/v1/bookings/KZ-77/cancel', {});
  });

  it('fetches a booking by number', async () => {
    const http = fakeHttp();
    http.resGet.mockResolvedValue({ booking: { number: 'KZ-77', status: 'confirmed' } });
    const reservation = new ExelyReservation(http);

    const result = await reservation.get('KZ-77');
    expect(http.resGet).toHaveBeenCalledWith('/v1/bookings/KZ-77');
    expect(result).toEqual({ booking: { number: 'KZ-77', status: 'confirmed' } });
  });
});
