import { describe, it, expect, vi } from 'vitest';
import { auditBookingHeldInventory } from '../src/core/bookingAudit';
import type { AvailabilityResult, RoomOffer } from '../src/integrations/exely/types';

const offer = (availableCount: number | null): RoomOffer => ({
  roomType: 'Standard Double Room',
  available: (availableCount ?? 1) > 0,
  availableCount,
  pricePerNight: 46750,
  currency: 'KZT',
  roomTypeId: '6154',
  ratePlanId: '349868',
  ratePlanName: 'Best Available Rate',
  totalPrice: 46750,
  checksum: 'c',
  placements: ['36257'],
  bookingFormLink: null,
});

const args = {
  property: 'almaty',
  hotelName: 'Hotel Kazzhol Almaty',
  checkIn: '2027-04-12',
  checkOut: '2027-04-13',
  guests: 2,
  roomTypeId: '6154',
  roomType: 'Standard Double Room',
  countBefore: 10,
  bookingNumber: '683759',
  conversationId: 'c-1',
};

function build(offers: RoomOffer[] | Error) {
  const checkAvailability = vi.fn(async (): Promise<AvailabilityResult> => {
    if (offers instanceof Error) throw offers;
    return {
      property: 'almaty',
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      offers,
      source: 'exely',
    };
  });
  const recordEvent = vi.fn();
  const notifyStaff = vi.fn(async (_text: string, _property?: string) => undefined);
  return {
    deps: { provider: { checkAvailability }, recordEvent, notifyStaff, wait: async () => undefined },
    recordEvent,
    notifyStaff,
  };
}

describe('сверка склада после брони', () => {
  it('остаток упал — бронь заняла номер, людей не тревожим', async () => {
    const { deps, recordEvent, notifyStaff } = build([offer(9)]);
    expect(await auditBookingHeldInventory(deps, args)).toBe('held');
    expect(recordEvent).toHaveBeenCalledWith('booking_inventory_held', expect.anything());
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('остаток не сдвинулся — зовём людей, пока гость не приехал', async () => {
    // Ровно этим фантомные брони и отличались: движок отдавал номер, склад не менялся.
    const { deps, recordEvent, notifyStaff } = build([offer(10)]);
    expect(await auditBookingHeldInventory(deps, args)).toBe('not_held');
    expect(recordEvent).toHaveBeenCalledWith('booking_inventory_not_held', expect.anything());
    expect(notifyStaff).toHaveBeenCalledOnce();
    const text = notifyStaff.mock.calls[0][0];
    expect(text).toContain('683759');
    expect(text).toContain('могла не занять');
    // Сотрудник должен знать, что гость уже получил подтверждение.
    expect(text).toContain('Гостю уже сказано');
  });

  it('категория исчезла из выдачи — это тоже занятый номер', async () => {
    const { deps } = build([]);
    expect(await auditBookingHeldInventory(deps, args)).toBe('held');
  });

  it('поиск недоступен — молчим, а не пугаем ложной тревогой', async () => {
    const { deps, notifyStaff, recordEvent } = build(new Error('timeout'));
    expect(await auditBookingHeldInventory(deps, args)).toBe('unknown');
    expect(notifyStaff).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('остаток неизвестен — тоже молчим', async () => {
    const { deps, notifyStaff } = build([offer(null)]);
    expect(await auditBookingHeldInventory(deps, args)).toBe('unknown');
    expect(notifyStaff).not.toHaveBeenCalled();
  });
});
