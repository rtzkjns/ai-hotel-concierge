// Live availability from Exely Connect Search.
// Port of kazzhol-portal src/Integrations/Exely/AvailabilityProvider.php::availability().
import type { ExelyHttp } from './http';
import type { AvailabilityProvider } from './provider';
import type {
  AvailabilityQuery,
  AvailabilityResult,
  ExelyRoomStay,
  ExelySearchResponse,
  RoomOffer,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export type PropertyIdResolver = (propertyKey: string) => string | undefined;

export class LiveAvailabilityProvider implements AvailabilityProvider {
  constructor(
    private readonly http: ExelyHttp,
    private readonly propertyIdResolver: PropertyIdResolver,
  ) {}

  async checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    const base = {
      property: query.property,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      source: 'exely' as const,
    };
    const propertyId = this.propertyIdResolver(query.property);
    if (!propertyId) {
      return { ...base, offers: [], unavailableReason: 'property_not_wired' };
    }

    const data = (await this.http.search(
      propertyId,
      query.checkIn,
      query.checkOut,
      query.guests,
    )) as ExelySearchResponse;

    const nights = Math.max(
      1,
      Math.round((Date.parse(query.checkOut) - Date.parse(query.checkIn)) / DAY_MS),
    );

    let offers = (data.roomStays ?? []).map((rs) => normalizeRoomStay(rs, nights));
    if (query.roomType) {
      const needle = query.roomType.toLowerCase();
      offers = offers.filter((o) => o.roomType.toLowerCase().includes(needle));
    }
    offers.sort(
      (a, b) => (a.totalPrice ?? Number.MAX_SAFE_INTEGER) - (b.totalPrice ?? Number.MAX_SAFE_INTEGER),
    );

    const result: AvailabilityResult = { ...base, offers };
    if (data.warnings !== undefined) result.warnings = data.warnings;
    return result;
  }
}

function normalizeRoomStay(rs: ExelyRoomStay, nights: number): RoomOffer {
  const roomType = rs.roomType ?? {};
  const total = rs.total ?? {};
  const totalPrice = (total.priceBeforeTax ?? 0) + (total.taxAmount ?? 0);
  const placements = (roomType.placements ?? rs.placements ?? [])
    .filter((p) => p.code !== undefined)
    .map((p) => String(p.code));
  return {
    roomType: roomType.name ?? rs.fullPlacementsName ?? 'Room',
    available: (rs.availability ?? 1) > 0,
    pricePerNight: Math.round(totalPrice / nights),
    currency: rs.currencyCode ?? 'KZT',
    roomTypeId: roomType.id !== undefined ? String(roomType.id) : null,
    ratePlanId: rs.ratePlan?.id !== undefined ? String(rs.ratePlan.id) : null,
    ratePlanName: rs.ratePlan?.name ?? null,
    totalPrice,
    checksum: rs.checksum ?? null,
    placements,
    bookingFormLink: rs.bookingFormLink ?? null,
  };
}
