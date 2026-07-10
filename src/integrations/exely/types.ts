export interface AvailabilityQuery {
  property: string; // property key, e.g. 'astana'
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  guests: number;
  roomType?: string;
}

export interface RoomOffer {
  roomType: string;
  available: boolean;
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
}

export interface AvailabilityResult {
  property: string;
  checkIn: string;
  checkOut: string;
  offers: RoomOffer[];
  source: 'stub' | 'exely'; // provenance; never present 'stub' as live truth
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
  availableDiscounts?: unknown[];
  placements?: ExelyPlacement[];
  fullPlacementsName?: string;
}

export interface ExelySearchResponse {
  roomStays?: ExelyRoomStay[];
  warnings?: unknown[];
}
