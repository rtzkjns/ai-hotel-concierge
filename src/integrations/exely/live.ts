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
      query.childAges ?? [],
    )) as ExelySearchResponse;

    const nights = Math.max(
      1,
      Math.round((Date.parse(query.checkOut) - Date.parse(query.checkIn)) / DAY_MS),
    );

    // `include: roomTypeShortContent|ratePlanShortContent` fills this block with the real names;
    // without the lookup the guest is told the room is called «2 взрослых на основных местах».
    const raw = data as unknown as {
      content?: {
        roomTypes?: Array<{ id?: unknown; name?: unknown }>;
        ratePlans?: Array<{ id?: unknown; name?: unknown }>;
      };
    };
    const nameById = (list?: Array<{ id?: unknown; name?: unknown }>): Record<string, string> =>
      Object.fromEntries(
        (list ?? [])
          .filter((x) => x?.id !== undefined && typeof x?.name === 'string' && x.name !== '')
          .map((x) => [String(x.id), x.name as string]),
      );
    const roomTypeNames = nameById(raw.content?.roomTypes);
    const ratePlanNames = nameById(raw.content?.ratePlans);

    let offers = (data.roomStays ?? []).map((rs) =>
      normalizeRoomStay(rs, nights, roomTypeNames, ratePlanNames),
    );
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

function normalizeRoomStay(
  rs: ExelyRoomStay,
  nights: number,
  roomTypeNames: Record<string, string> = {},
  ratePlanNames: Record<string, string> = {},
): RoomOffer {
  const roomType = rs.roomType ?? {};
  const total = rs.total ?? {};
  // "null if unknown": a roomStay without any price must never surface as 0 KZT.
  const hasPrice = total.priceBeforeTax !== undefined || total.taxAmount !== undefined;
  const totalPrice = hasPrice ? (total.priceBeforeTax ?? 0) + (total.taxAmount ?? 0) : null;
  const placements = (roomType.placements ?? rs.placements ?? [])
    .filter((p) => p.code !== undefined)
    .map((p) => String(p.code));
  return {
    roomType:
      roomType.name ??
      (roomType.id !== undefined ? roomTypeNames[String(roomType.id)] : undefined) ??
      rs.fullPlacementsName ??
      'Room',
    available: (rs.availability ?? 1) > 0,
    pricePerNight: totalPrice === null ? null : Math.round(totalPrice / nights),
    currency: rs.currencyCode ?? 'KZT',
    roomTypeId: roomType.id !== undefined ? String(roomType.id) : null,
    ratePlanId: rs.ratePlan?.id !== undefined ? String(rs.ratePlan.id) : null,
    ratePlanName:
      rs.ratePlan?.name ??
      (rs.ratePlan?.id !== undefined ? (ratePlanNames[String(rs.ratePlan.id)] ?? null) : null),
    totalPrice,
    checksum: rs.checksum ?? null,
    placements,
    bookingFormLink: rs.bookingFormLink ?? null,
    discounts: (rs.availableDiscounts ?? [])
      .map((d) => (d as { name?: string; title?: string })?.name ?? (d as { title?: string })?.title)
      .filter((n): n is string => typeof n === 'string' && n.trim() !== ''),
    cancellationPolicy: rs.cancellationPolicy
      ? {
          freeCancellationPossible: rs.cancellationPolicy.freeCancellationPossible ?? false,
          freeCancellationDeadline: rs.cancellationPolicy.freeCancellationDeadlineLocal ?? null,
          penaltyAmount: rs.cancellationPolicy.penaltyAmount ?? null,
        }
      : null,
  };
}
