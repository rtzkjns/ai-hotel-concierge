import type { AvailabilityProvider } from './provider';
import type { AvailabilityQuery, AvailabilityResult, RoomOffer } from './types';

// Deterministic fake catalogue so development & tests are stable.
// Base prices are intentionally round and obviously-fake (NOT real Kazzhol rates).
const BASE: Record<string, number> = { Standard: 25000, Comfort: 32000, Suite: 48000 };

export class StubAvailabilityProvider implements AvailabilityProvider {
  async checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    const roomTypes = query.roomType ? [query.roomType] : Object.keys(BASE);
    const offers: RoomOffer[] = roomTypes.map((roomType) => ({
      roomType,
      available: true,
      pricePerNight: BASE[roomType] ?? 30000,
      currency: 'KZT',
      notes: 'STUB DATA — not real availability',
    }));
    return {
      property: query.property,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      offers,
      source: 'stub',
    };
  }
}
