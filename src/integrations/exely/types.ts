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
}

export interface AvailabilityResult {
  property: string;
  checkIn: string;
  checkOut: string;
  offers: RoomOffer[];
  source: 'stub' | 'exely'; // provenance; never present 'stub' as live truth
}
