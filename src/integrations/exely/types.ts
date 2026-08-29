export interface AvailabilityQuery {
  property: string; // property key, e.g. 'astana'
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  guests: number; // number of adults
  /** Ages of children on the stay, if any — hotels price children by age. */
  childAges?: number[];
  roomType?: string;
}

export interface CancellationPolicy {
  freeCancellationPossible: boolean;
  freeCancellationDeadline: string | null; // ISO local, e.g. '2026-09-13T14:59'
  penaltyAmount: number | null;
}

export interface RoomOffer {
  roomType: string;
  available: boolean;
  /** Сколько номеров этой категории свободно. Падение на единицу после брони —
   *  сильнейшее доказательство, что бронь настоящая: считает его Search, а не движок. */
  availableCount?: number | null;
  pricePerNight: number | null; // KZT; null if unknown
  currency: string; // 'KZT'
  notes?: string;
  // Live-booking fields (from Exely Search). The stub fills the null/[] equivalents.
  roomTypeId: string | null;
  ratePlanId: string | null;
  ratePlanName: string | null;
  totalPrice: number | null; // whole stay, priceBeforeTax + taxAmount
  checksum: string | null; // required by the Reservation API; stale after prices change
  placements: string[]; // placement codes, e.g. ['adult-1', 'adult-2']
  bookingFormLink: string | null; // guest-facing payment/booking page
  /** Names of discounts Exely already applied to this offer (early-booking, long-stay, …). Live. */
  discounts?: string[];
  /** Cancellation terms for this rate, straight from Search — used in the booking receipt. */
  cancellationPolicy?: CancellationPolicy | null;
}

export interface AvailabilityResult {
  property: string;
  checkIn: string;
  checkOut: string;
  offers: RoomOffer[];
  // provenance; never present 'stub'/'manual' as live truth.
  // 'manual' = a hotel with no availability API — offers is empty, staff confirm by hand.
  source: 'stub' | 'exely' | 'manual';
  /** Set when the query could not even reach Exely (e.g. hotel not wired to the API). */
  unavailableReason?: 'property_not_wired';
  /** Non-fatal warnings passed through from the Exely Search response. */
  warnings?: unknown[];
}

// --- Raw Exely Search response shapes (only the fields we read) --------------

export interface ExelyPlacement {
  code?: string | number;
}

export interface ExelyRoomStay {
  roomType?: { id?: string | number; name?: string; placements?: ExelyPlacement[] };
  ratePlan?: { id?: string | number; name?: string };
  total?: { priceBeforeTax?: number; taxAmount?: number };
  currencyCode?: string;
  availability?: number;
  checksum?: string;
  bookingFormLink?: string;
  availableDiscounts?: Array<{ name?: string; title?: string } | unknown>;
  cancellationPolicy?: {
    freeCancellationPossible?: boolean;
    freeCancellationDeadlineLocal?: string;
    penaltyAmount?: number;
  };
  placements?: ExelyPlacement[];
  fullPlacementsName?: string;
}

export interface ExelySearchResponse {
  roomStays?: ExelyRoomStay[];
  warnings?: unknown[];
}
